// Trae (on-demand) la Capacity de Azure DevOps de los sprints pedidos y los
// miembros del equipo. Se cachea 10 minutos por org/proyecto/equipo; `refresh`
// fuerza volver a leer (p. ej. después de cargar vacaciones en Azure).
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveConfig, useStore } from "../store/useStore";
import { getSprintCapacity, getTeamMemberNames, type SprintCapacity } from "./azureDevOps";
import type { AzureConfig } from "../types";

const TTL_MS = 10 * 60 * 1000;
interface Entry<T> {
  at: number;
  promise: Promise<T>;
}
const capCache = new Map<string, Entry<SprintCapacity | null>>();
const membersCache = new Map<string, Entry<string[]>>();

const teamKey = (cfg: AzureConfig) =>
  `${cfg.org.toLowerCase()}/${cfg.project.toLowerCase()}/${(cfg.team ?? "").trim().toLowerCase()}`;

function cached<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>, force: boolean): Promise<T> {
  const hit = map.get(key);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = load();
  const entry = { at: Date.now(), promise };
  map.set(key, entry);
  // Si falla, no dejarlo en caché (sin borrar una lectura más nueva)
  promise.catch(() => {
    if (map.get(key) === entry) map.delete(key);
  });
  return promise;
}

export interface CapacityState {
  /** Capacity por path de sprint (minúsculas); null = el sprint no es del equipo */
  byPath: Map<string, SprintCapacity | null>;
  teamMembers: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** true cuando ya se intentó leer todo lo pedido */
  ready: boolean;
  /** Paths (minúsculas) que no están entre las iteraciones del equipo */
  notInTeam: Set<string>;
  /** Equipo cuya capacidad se lee ("" = equipo por defecto del proyecto) */
  team: string;
}

export function useCapacity(paths: string[], enabled = true): CapacityState {
  const config = useStore((s) => s.config);
  const envPat = useStore((s) => s.envPat);
  const iterations = useStore((s) => s.iterations);
  const [byPath, setByPath] = useState<Map<string, SprintCapacity | null>>(new Map());
  const [teamMembers, setTeamMembers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [force, setForce] = useState(false);

  const key = paths.map((p) => p.toLowerCase()).sort().join("|");
  const idOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of iterations) m.set(it.path.toLowerCase(), it.id);
    return m;
  }, [iterations]);

  useEffect(() => {
    if (!enabled) return;
    const eff = resolveConfig(config, envPat);
    if (!eff || !eff.pat) return;
    let alive = true;
    const wanted = key ? key.split("|") : [];
    setLoading(true);
    setError(null);
    const tk = teamKey(eff);
    const members = cached(membersCache, tk, () => getTeamMemberNames(eff), force).catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
      return [] as string[];
    });
    const caps = Promise.all(
      wanted.map(async (path) => {
        const id = idOf.get(path);
        if (!id) return [path, null] as const;
        try {
          const cap = await cached(capCache, `${tk}/${id}`, () => getSprintCapacity(eff, id), force);
          return [path, cap] as const;
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : String(e));
          return [path, null] as const;
        }
      }),
    );
    void Promise.all([members, caps]).then(([m, c]) => {
      if (!alive) return;
      setTeamMembers(m);
      setByPath(new Map(c));
      setLoading(false);
      setReady(true);
      setForce(false);
    });
    return () => {
      alive = false;
    };
    // `force` se lee pero no dispara: lo dispara `nonce`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, idOf, config, envPat, nonce]);

  const refresh = useCallback(() => {
    setForce(true);
    setNonce((n) => n + 1);
  }, []);

  const notInTeam = useMemo(
    () => new Set((key ? key.split("|") : []).filter((p) => !idOf.has(p))),
    [key, idOf],
  );
  const team = resolveConfig(config, envPat)?.team?.trim() ?? "";

  return { byPath, teamMembers, loading, error, refresh, ready, notInTeam, team };
}
