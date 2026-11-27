import { useEffect, useMemo, useRef, useState } from "react";
import { resolveConfig, useStore } from "../store/useStore";
import { useFilters } from "../store/useFilters";
import { applyFilters } from "../lib/selectors";
import { useWindowedItems } from "../lib/useWindowedItems";
import { lastPathSegment } from "../lib/format";
import type { WorkItem } from "../types";
import { Avatar } from "../components/common";
import FilterBar from "../components/FilterBar";
import MultiSelect from "../components/MultiSelect";
import { TRACKED_TYPES } from "../lib/azureDevOps";
import { ItemRow } from "./Metrics";
import { countBy, isBug, isDone, priorityLabel, sumPoints } from "../lib/workItemStatus";
import {
  CREATED_LABEL,
  CREATED_SENTINEL,
  fetchTimelines,
  fetchUpdates,
  leadTimeDays,
  type StateChange,
} from "../lib/leadTime";
import type { WorkItemUpdate } from "../lib/azureDevOps";
import { defaultCutoff, isUnplanned, sprintEntry, type SprintEntry } from "../lib/unplanned";
import BurndownPanel from "./BurndownPanel";
import VelocityPanel from "./VelocityPanel";
import ErrorBoundary from "../components/ErrorBoundary";

const SIN_SPRINT = "(sin sprint)";

// Orden lógico del campo Compromiso (lo demás va al final, por cantidad).
const COMMITMENT_ORDER = ["mandatorio", "comprometido", "deseable"];
const commitmentRank = (v: string) => {
  const i = COMMITMENT_ORDER.indexOf(v.trim().toLowerCase());
  return i === -1 ? COMMITMENT_ORDER.length : i;
};

interface SprintBucket {
  path: string; // iterationPath (clave) o SIN_SPRINT
  label: string; // último segmento
  startDate?: string;
  items: WorkItem[];
  totalPoints: number;
  donePoints: number;
  bugsTotal: number;
  bugsDone: number;
  usCount: number;
}

export default function Evolution() {
  const windowed = useWindowedItems();
  const iterations = useStore((s) => s.iterations);
  const filters = useFilters();

  const items = useMemo(() => applyFilters(windowed, filters), [windowed, filters]);

  // Sprint ACTUAL según ADO (timeFrame "current"), no el más reciente por fecha.
  const currentPath = useMemo(
    () => iterations.find((it) => it.attributes?.timeFrame === "current")?.path,
    [iterations],
  );

  // path -> startDate (para ordenar sprints cronológicamente)
  const startDates = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of iterations) if (it.attributes?.startDate) m.set(it.path, it.attributes.startDate);
    return m;
  }, [iterations]);

  const sprints = useMemo<SprintBucket[]>(() => {
    const groups = new Map<string, WorkItem[]>();
    for (const it of items) {
      const key = it.iterationPath || SIN_SPRINT;
      const arr = groups.get(key);
      if (arr) arr.push(it);
      else groups.set(key, [it]);
    }
    const buckets: SprintBucket[] = [...groups.entries()].map(([path, list]) => {
      const bugs = list.filter((i) => i.type === "Bug");
      return {
        path,
        label: path === SIN_SPRINT ? SIN_SPRINT : lastPathSegment(path),
        startDate: startDates.get(path),
        items: list,
        totalPoints: sumPoints(list),
        donePoints: sumPoints(list.filter(isDone)),
        bugsTotal: bugs.length,
        bugsDone: bugs.filter(isDone).length,
        usCount: list.filter((i) => i.type === "User Story").length,
      };
    });
    // Más reciente primero: por startDate si lo hay, si no por nombre.
    return buckets.sort((a, b) => {
      if (a.startDate && b.startDate) return b.startDate.localeCompare(a.startDate);
      if (a.startDate) return -1;
      if (b.startDate) return 1;
      return b.label.localeCompare(a.label);
    });
  }, [items, startDates]);

  return (
    <div className="flex flex-col h-full">
      <FilterBar />
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-5xl mx-auto space-y-4">
          {sprints.length === 0 ? (
            <p className="text-sm text-slate-500">Sin items en la ventana actual.</p>
          ) : (
            <>
              <BugCounters
                last30Items={windowed}
                currentSprint={sprints.find((s) => s.path === currentPath) ?? sprints[0]}
                isCurrent={sprints.some((s) => s.path === currentPath)}
              />

              <ErrorBoundary label="el burndown">
                <BurndownPanel sprints={sprints} currentPath={currentPath} />
              </ErrorBoundary>

              <ErrorBoundary label="la velocidad">
                <VelocityPanel sprints={sprints} />
              </ErrorBoundary>

              <Panel title="Story points por sprint (hecho vs. restante)">
                <SprintBarChart sprints={[...sprints].reverse()} metric="points" />
              </Panel>

              <Panel title="Bugs resueltos por sprint (resueltos vs. total)">
                <SprintBarChart sprints={[...sprints].reverse()} metric="bugs" />
              </Panel>

              <Panel title="Evolución por persona (por sprint)">
                <PersonSprintMatrix sprints={sprints} />
              </Panel>

              <Panel title="Bugs cargados por persona (origen del problema)">
                <CreatedBugsByPerson items={items} />
              </Panel>

              <UnplannedPanel sprints={sprints} />

              <LeadTimePanel items={items} />

              {sprints.map((s) => (
                <SprintCard key={s.path} sprint={s} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Alto del área de barras en vh: escala con la pantalla y, a diferencia del % que
// usaba antes, es una altura definida (no depende del padre flex → ahora sí se ve).
const CHART_VH = 24;

/**
 * Columnas verticales: porción hecha (verde) sobre el total (gris) por sprint.
 * `metric` elige qué medir: story points o bugs (hechos vs. total).
 */
function SprintBarChart({
  sprints,
  metric,
}: {
  sprints: SprintBucket[];
  metric: "points" | "bugs";
}) {
  const pick = (s: SprintBucket) =>
    metric === "points"
      ? { total: s.totalPoints, done: s.donePoints, unit: "pts" }
      : { total: s.bugsTotal, done: s.bugsDone, unit: "bugs" };
  const max = Math.max(1, ...sprints.map((s) => pick(s).total));
  return (
    <div className="flex items-end gap-3 overflow-x-auto pb-1">
      {sprints.map((s) => {
        const { total, done, unit } = pick(s);
        const totalVh = (total / max) * CHART_VH;
        const doneVh = (done / max) * CHART_VH;
        return (
          <div key={s.path} className="flex flex-col items-center gap-1 min-w-14 flex-1">
            <span className="text-[10px] text-slate-500 tabular-nums">{total}</span>
            <div
              className="relative w-8 bg-slate-700/60 rounded-t"
              style={{ height: `max(${totalVh}vh, ${total ? 4 : 2}px)` }}
              title={`${s.label}: ${done}/${total} ${unit} hechos`}
            >
              <div
                className="absolute bottom-0 left-0 w-full bg-emerald-500/80 rounded-t"
                style={{ height: `${doneVh}vh` }}
              />
            </div>
            <span
              className="text-[10px] text-slate-400 text-center w-full truncate"
              title={s.label}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SprintCard({ sprint }: { sprint: SprintBucket }) {
  const [open, setOpen] = useState(false);
  const pct = sprint.totalPoints
    ? Math.round((sprint.donePoints / sprint.totalPoints) * 100)
    : 0;

  const byPerson = useMemo(() => {
    // story points + bugs resueltos por persona
    const m = new Map<string, { points: number; count: number; bugsDone: number }>();
    for (const it of sprint.items) {
      const name = it.assignedTo || "Sin asignar";
      const cur = m.get(name) ?? { points: 0, count: 0, bugsDone: 0 };
      cur.points += it.storyPoints ?? 0;
      cur.count += 1;
      if (isBug(it) && isDone(it)) cur.bugsDone += 1;
      m.set(name, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].points - a[1].points || b[1].count - a[1].count);
  }, [sprint]);

  const byPriority = useMemo(
    () =>
      [...countBy(sprint.items, (it) => priorityLabel(it.priority)).entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      ),
    [sprint],
  );
  const byCommitment = useMemo(
    () =>
      [
        ...countBy(
          sprint.items.filter((it) => it.commitment),
          (it) => it.commitment as string,
        ).entries(),
      ].sort((a, b) => commitmentRank(a[0]) - commitmentRank(b[0]) || b[1] - a[1]),
    [sprint],
  );
  const bySeverity = useMemo(
    () =>
      [
        ...countBy(
          sprint.items.filter((it) => it.severity),
          (it) => it.severity as string,
        ).entries(),
      ].sort((a, b) => a[0].localeCompare(b[0])),
    [sprint],
  );

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left p-4 flex items-center gap-3"
      >
        <span className="text-slate-600">{open ? "▾" : "▸"}</span>
        <span className="font-semibold text-slate-200">{sprint.label}</span>
        <span className="text-xs text-slate-500">{sprint.items.length} items</span>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Metric value={`${sprint.usCount}`} label="US" tone="text-blue-300" />
          <Metric
            value={`${sprint.bugsDone}/${sprint.bugsTotal}`}
            label="bugs"
            tone="text-red-300"
          />
          <Metric
            value={`${sprint.donePoints}/${sprint.totalPoints}`}
            label={`pts (${pct}%)`}
            tone="text-emerald-300"
          />
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-800 p-4 grid md:grid-cols-2 gap-4">
          {/* Story points + bugs resueltos por persona */}
          <div className="md:col-span-2">
            <h4 className="text-xs font-semibold text-slate-400 mb-2">
              Story points y bugs resueltos por persona
            </h4>
            <div className="space-y-1.5">
              {byPerson.map(([name, v]) => (
                <div key={name} className="flex items-center gap-2 text-sm">
                  <Avatar name={name === "Sin asignar" ? undefined : name} size={22} />
                  <span className="text-slate-300 w-40 truncate">{name}</span>
                  <div className="flex-1 bg-slate-800 rounded h-3.5 overflow-hidden">
                    <div
                      className="bg-sky-500/70 h-full"
                      style={{
                        width: `${(v.points / (byPerson[0]?.[1].points || 1)) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-slate-400 w-28 text-right tabular-nums">
                    {v.points} pts
                    {v.bugsDone > 0 && (
                      <span className="text-red-300"> · {v.bugsDone} 🐞</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <DistList title="Prioridades" rows={byPriority} />
          {byCommitment.length > 0 && <DistList title="Compromiso" rows={byCommitment} />}
          {bySeverity.length > 0 && <DistList title="Severidad (bugs)" rows={bySeverity} />}

          <div className="md:col-span-2">
            <h4 className="text-xs font-semibold text-slate-400 mb-2">Items del sprint</h4>
            <div className="max-h-60 overflow-y-auto space-y-1">
              {[...sprint.items]
                .sort((a, b) => (b.storyPoints ?? 0) - (a.storyPoints ?? 0))
                .map((it) => (
                  <ItemRow key={it.id} item={it} />
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className={`font-bold ${tone}`}>{value}</span>
      <span className="text-[11px] text-slate-500">{label}</span>
    </span>
  );
}

function DistList({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div>
      <h4 className="text-xs font-semibold text-slate-400 mb-2">{title}</h4>
      <div className="space-y-1.5">
        {rows.map(([k, n]) => (
          <div key={k} className="flex items-center gap-2 text-sm">
            <span className="text-slate-300 w-28 truncate" title={k}>
              {k}
            </span>
            <div className="flex-1 bg-slate-800 rounded h-3.5 overflow-hidden">
              <div className="bg-violet-500/70 h-full" style={{ width: `${(n / max) * 100}%` }} />
            </div>
            <span className="text-slate-400 w-6 text-right tabular-nums">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Tarjetas: bugs resueltos en el último mes y en el sprint actual.
 * El contador de 30 días usa `last30Items` = todos los items de la ventana SIN
 * los filtros del FilterBar (no debe moverse al elegir un sprint ni un rango de
 * fechas; es una métrica fija de "últimos 30 días"). `currentSprint` es el
 * sprint ACTUAL (timeFrame de ADO); `isCurrent` distingue actual de fallback.
 */
function BugCounters({
  last30Items,
  currentSprint,
  isCurrent,
}: {
  last30Items: WorkItem[];
  currentSprint?: SprintBucket;
  isCurrent: boolean;
}) {
  const lastMonth = useMemo(() => {
    const cutoff = Date.now() - 30 * 86400000;
    return last30Items.filter(
      (it) => isBug(it) && isDone(it) && new Date(it.changedDate).getTime() >= cutoff,
    ).length;
  }, [last30Items]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-500">🐞 Bugs resueltos · últimos 30 días</p>
        <p className="text-2xl font-bold mt-1 text-red-300">{lastMonth}</p>
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-500">
          🐞 Bugs resueltos · {isCurrent ? "sprint actual" : "último sprint"}
          {currentSprint && <span className="text-slate-600"> ({currentSprint.label})</span>}
        </p>
        <p className="text-2xl font-bold mt-1 text-red-300">
          {currentSprint ? `${currentSprint.bugsDone}/${currentSprint.bugsTotal}` : "—"}
        </p>
      </div>
    </div>
  );
}

type PersonMetric = "points" | "bugs";

/** Matriz persona × sprint: puntos hechos o bugs resueltos por persona, por sprint. */
function PersonSprintMatrix({ sprints }: { sprints: SprintBucket[] }) {
  const [metric, setMetric] = useState<PersonMetric>("points");
  // Todos los sprints filtrados (la ventana de meses ya acota la cantidad);
  // scroll horizontal si hay muchos. Así Total y Promedio cuadran con lo visible.
  const cols = sprints;
  // Denominador del promedio: cantidad de sprints filtrados (excluye "sin sprint").
  const sprintCount = useMemo(() => cols.filter((s) => s.path !== SIN_SPRINT).length, [cols]);

  const { persons, values, totals } = useMemo(() => {
    // persona -> (sprintPath -> valor)
    const map = new Map<string, Map<string, number>>();
    const tot = new Map<string, number>();
    for (const s of cols) {
      for (const it of s.items) {
        if (!it.assignedTo) continue;
        const v =
          metric === "points"
            ? isDone(it)
              ? it.storyPoints ?? 0
              : 0
            : isBug(it) && isDone(it)
              ? 1
              : 0;
        if (v === 0) continue;
        let row = map.get(it.assignedTo);
        if (!row) map.set(it.assignedTo, (row = new Map()));
        row.set(s.path, (row.get(s.path) ?? 0) + v);
        tot.set(it.assignedTo, (tot.get(it.assignedTo) ?? 0) + v);
      }
    }
    const people = [...map.keys()].sort((a, b) => (tot.get(b) ?? 0) - (tot.get(a) ?? 0));
    return { persons: people, values: map, totals: tot };
  }, [cols, metric]);

  const max = Math.max(1, ...persons.map((p) => totals.get(p) ?? 0));

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Toggle active={metric === "points"} onClick={() => setMetric("points")}>
          Puntos hechos
        </Toggle>
        <Toggle active={metric === "bugs"} onClick={() => setMetric("bugs")}>
          Bugs resueltos
        </Toggle>
      </div>

      {persons.length === 0 ? (
        <p className="text-sm text-slate-500">Sin datos en los sprints visibles.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-separate border-spacing-y-1">
            <thead>
              <tr className="text-[11px] text-slate-500">
                <th className="text-left font-medium px-2">Persona</th>
                {cols.map((s) => (
                  <th key={s.path} className="text-right font-medium px-2 whitespace-nowrap">
                    {s.label}
                  </th>
                ))}
                <th className="text-right font-medium px-2">Total</th>
                <th className="text-right font-medium px-2 whitespace-nowrap">Prom./sprint</th>
              </tr>
            </thead>
            <tbody>
              {persons.map((name) => {
                const row = values.get(name)!;
                const total = totals.get(name) ?? 0;
                return (
                  <tr key={name} className="bg-slate-800/40">
                    <td className="px-2 py-1 rounded-l-lg">
                      <div className="flex items-center gap-2">
                        <Avatar name={name} size={20} />
                        <span className="text-slate-300 truncate max-w-36">{name}</span>
                      </div>
                    </td>
                    {cols.map((s) => {
                      const v = row.get(s.path) ?? 0;
                      return (
                        <td
                          key={s.path}
                          className={`px-2 py-1 text-right tabular-nums ${
                            v ? "text-slate-200" : "text-slate-600"
                          }`}
                        >
                          {v || "·"}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1 text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-1.5 bg-sky-500/70 rounded"
                          style={{ width: `${(total / max) * 4}rem` }}
                        />
                        <span className="font-semibold text-sky-300 tabular-nums w-8 text-right">
                          {total}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-1 rounded-r-lg text-right tabular-nums font-medium text-emerald-300">
                      {sprintCount ? (total / sprintCount).toFixed(1) : "0"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Bugs cargados (creados) por persona, con buscador de nombres y detalle desplegable. */
function CreatedBugsByPerson({ items }: { items: WorkItem[] }) {
  const [query, setQuery] = useState("");
  const [openName, setOpenName] = useState<string | null>(null);

  const rows = useMemo(() => {
    const bugs = items.filter(isBug);
    const m = new Map<string, WorkItem[]>();
    for (const it of bugs) {
      const name = it.createdBy || "Desconocido";
      const arr = m.get(name);
      if (arr) arr.push(it);
      else m.set(name, [it]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter(([name]) => name.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  const max = Math.max(1, ...rows.map((r) => r[1].length));

  if (rows.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No hay bugs cargados en la ventana actual (o el portable es anterior a esta versión y no
        trae el campo "Creado por").
      </p>
    );
  }

  return (
    <div>
      <input
        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 w-64 outline-none focus:border-sky-500 mb-3"
        placeholder="Filtrar por nombre…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="text-sm text-slate-500">Sin coincidencias.</p>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(([name, bugs]) => (
            <div key={name}>
              <button
                onClick={() => setOpenName((o) => (o === name ? null : name))}
                className="w-full flex items-center gap-2 text-sm text-left"
              >
                <span className="text-slate-600 w-3">{openName === name ? "▾" : "▸"}</span>
                <Avatar name={name === "Desconocido" ? undefined : name} size={22} />
                <span className="text-slate-300 w-44 truncate">{name}</span>
                <div className="flex-1 bg-slate-800 rounded h-3.5 overflow-hidden">
                  <div
                    className="bg-red-500/70 h-full"
                    style={{ width: `${(bugs.length / max) * 100}%` }}
                  />
                </div>
                <span className="text-slate-400 w-16 text-right tabular-nums">
                  {bugs.length} 🐞
                </span>
              </button>
              {openName === name && (
                <div className="ml-5 mt-1 mb-2 max-h-52 overflow-y-auto space-y-1">
                  {[...bugs]
                    .sort((a, b) => b.createdDate.localeCompare(a.createdDate))
                    .map((it) => (
                      <ItemRow key={it.id} item={it} />
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmtDays = (d: number) => (d < 1 ? `${Math.round(d * 24)} h` : `${d.toFixed(1)} d`);

/**
 * Lead/Cycle Time: cuánto tarda un item entre un estado inicial y uno final.
 * Colapsado por defecto; al abrirlo trae el historial de estados (on-demand).
 */
function LeadTimePanel({ items }: { items: WorkItem[] }) {
  const config = useStore((s) => s.config);
  const envPat = useStore((s) => s.envPat);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [timelines, setTimelines] = useState<Map<number, StateChange[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(CREATED_SENTINEL);
  const [to, setTo] = useState<string[]>([]); // estados finales (multiselección)
  const [types, setTypes] = useState<string[]>([]); // tipos a mostrar; vacío = todos
  const fetchedRef = useRef(false);

  // Al abrir por primera vez, traer los historiales de los items filtrados.
  useEffect(() => {
    if (!open || fetchedRef.current) return;
    const eff = resolveConfig(config, envPat);
    if (!eff || !eff.pat) {
      setError("No hay conexión configurada.");
      return;
    }
    fetchedRef.current = true;
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: items.length });
    fetchTimelines(eff, items, (done, total) => setProgress({ done, total }))
      .then(setTimelines)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, config, envPat, items]);

  // Estados observados en los historiales (para poblar los selectores).
  const states = useMemo(() => {
    const set = new Set<string>();
    if (timelines) for (const tl of timelines.values()) for (const c of tl) set.add(c.state);
    for (const it of items) if (it.state) set.add(it.state);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [timelines, items]);

  // Default de los estados finales: los "done" presentes, si no el último.
  useEffect(() => {
    if (to.length || states.length === 0) return;
    const prefer = ["Ready for test", "Done", "Closed", "Resolved"];
    const matched = states.filter((s) => prefer.some((p) => p.toLowerCase() === s.toLowerCase()));
    setTo(matched.length ? matched : [states[states.length - 1]]);
  }, [states, to]);

  const result = useMemo(() => {
    if (!timelines || to.length === 0) return null;
    const typeSet = types.length ? new Set(types) : null;
    const rows: { item: WorkItem; days: number }[] = [];
    for (const it of items) {
      if (typeSet && !typeSet.has(it.type)) continue;
      const tl = timelines.get(it.id);
      if (!tl) continue;
      const d = leadTimeDays(tl, it.createdDate, from, to);
      if (d != null && d >= 0) rows.push({ item: it, days: d });
    }
    rows.sort((a, b) => b.days - a.days);
    const days = rows.map((r) => r.days);
    // Promedio de lead time por sprint (agrupando los items que hicieron la transición).
    const bySprintMap = new Map<string, number[]>();
    for (const { item, days: d } of rows) {
      const label = item.iterationPath ? lastPathSegment(item.iterationPath) : SIN_SPRINT;
      const arr = bySprintMap.get(label);
      if (arr) arr.push(d);
      else bySprintMap.set(label, [d]);
    }
    const bySprint = [...bySprintMap.entries()]
      .map(([label, ds]) => ({
        label,
        avg: ds.reduce((s, d) => s + d, 0) / ds.length,
        count: ds.length,
      }))
      .sort((a, b) => b.avg - a.avg);
    return {
      rows,
      count: rows.length,
      avg: days.length ? days.reduce((s, d) => s + d, 0) / days.length : 0,
      med: median(days),
      max: days.length ? days[0] : 0,
      bySprint,
    };
  }, [timelines, items, from, to, types]);

  const maxDays = result?.max || 1;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left p-4 flex items-center gap-3"
      >
        <span className="text-slate-600">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-semibold text-slate-300">⏱️ Lead / Cycle Time</span>
        <span className="text-xs text-slate-500">tiempo entre dos estados</span>
        {result && (
          <span className="ml-auto text-sm text-sky-300 font-semibold">
            prom. {fmtDays(result.avg)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-800 p-4 space-y-3">
          {loading && (
            <p className="text-sm text-slate-400">
              Cargando historial… {progress.done}/{progress.total}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {timelines && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-400">Mostrar</span>
                <MultiSelect label="Tipo" options={TRACKED_TYPES} selected={types} onChange={setTypes} />
                <span className="text-slate-400">desde</span>
                <StateSelect value={from} onChange={setFrom} states={states} includeCreated />
                <span className="text-slate-400">hasta</span>
                <MultiSelect label="Estado" options={states} selected={to} onChange={setTo} />
              </div>

              {result && result.count === 0 ? (
                <p className="text-sm text-slate-500">
                  Ningún item (de los filtrados) hizo esa transición.
                </p>
              ) : (
                result && (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Stat label="Items" value={String(result.count)} tone="text-slate-200" />
                      <Stat label="Promedio" value={fmtDays(result.avg)} tone="text-sky-300" />
                      <Stat label="Mediana" value={fmtDays(result.med)} tone="text-emerald-300" />
                      <Stat label="Máximo" value={fmtDays(result.max)} tone="text-amber-300" />
                    </div>

                    {result.bySprint.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-slate-400 mb-2">
                          Promedio por sprint
                        </h4>
                        <div className="space-y-1.5">
                          {result.bySprint.map((s) => (
                            <div key={s.label} className="flex items-center gap-2 text-sm">
                              <span className="text-slate-300 w-40 truncate" title={s.label}>
                                {s.label}
                              </span>
                              <div className="flex-1 bg-slate-800 rounded h-3.5 overflow-hidden">
                                <div
                                  className="bg-sky-500/70 h-full"
                                  style={{
                                    width: `${(s.avg / (result.bySprint[0]?.avg || 1)) * 100}%`,
                                  }}
                                />
                              </div>
                              <span className="text-slate-400 w-24 text-right tabular-nums">
                                {fmtDays(s.avg)}
                                <span className="text-slate-600"> · {s.count}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="max-h-72 overflow-y-auto space-y-1">
                      {result.rows.map(({ item, days }) => (
                        <div key={item.id} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <ItemRow item={item} />
                          </div>
                          <div className="w-24 bg-slate-800 rounded h-2 overflow-hidden shrink-0">
                            <div
                              className="bg-sky-500/70 h-full"
                              style={{ width: `${(days / maxDays) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-400 w-14 text-right tabular-nums shrink-0">
                            {fmtDays(days)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type UnplannedMetric = "items" | "points";

interface ClassifiedItem {
  item: WorkItem;
  entry: SprintEntry;
  unplanned: boolean;
}

interface UnplannedRow {
  sprint: SprintBucket;
  /** "YYYY-MM-DD" del inicio del sprint; null si Azure no tiene la fecha */
  startDay: string | null;
  /** Fecha de corte vigente (la editada o el inicio del sprint) */
  cutoff: string | null;
  custom: boolean;
  classified: ClassifiedItem[];
  unplannedValue: number;
  totalValue: number;
}

/** Trabajo no planeado sólo mira User Stories (no bugs ni tasks) */
const storiesOf = (s: SprintBucket) => s.items.filter((it) => it.type === "User Story");

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });

/**
 * Trabajo no planeado: items que entraron al sprint después de la planning.
 * Colapsado por defecto; al abrirlo trae el historial de cada item (on-demand,
 * compartido con Lead Time). La fecha de corte es editable por sprint, porque
 * a veces la planning se atrasa unos días.
 */
function UnplannedPanel({ sprints }: { sprints: SprintBucket[] }) {
  const config = useStore((s) => s.config);
  const envPat = useStore((s) => s.envPat);
  const iterations = useStore((s) => s.iterations);
  const iterationDates = useStore((s) => s.iterationDates);
  const cutoffs = useStore((s) => s.planningCutoffs);
  const setPlanningCutoff = useStore((s) => s.setPlanningCutoff);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [updates, setUpdates] = useState<Map<number, WorkItemUpdate[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<UnplannedMetric>("items");
  const [openSprint, setOpenSprint] = useState<string | null>(null);
  const loadingRef = useRef(false);

  // Inicio de cada sprint: árbol de iteraciones del proyecto (incluye sprints
  // viejos) y, si falta, las iteraciones del equipo.
  const startOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of iterations) if (it.attributes?.startDate) m.set(it.path.toLowerCase(), it.attributes.startDate);
    for (const [path, d] of Object.entries(iterationDates))
      if (d.startDate) m.set(path.toLowerCase(), d.startDate);
    return (path: string) => m.get(path.toLowerCase()) ?? null;
  }, [iterations, iterationDates]);

  const datedSprints = useMemo(
    () => sprints.filter((s) => s.path !== SIN_SPRINT && startOf(s.path) && storiesOf(s).length > 0),
    [sprints, startOf],
  );
  const undatedCount = sprints.filter((s) => s.path !== SIN_SPRINT).length - datedSprints.length;

  // Con el panel abierto, traer el historial de los items de esos sprints que
  // todavía no tenemos (al abrir, o si cambian los filtros / llegan sprints).
  // Lo ya traído queda en el caché de sesión compartido con Lead Time.
  useEffect(() => {
    if (!open || loadingRef.current) return;
    const missing = datedSprints.flatMap(storiesOf).filter((it) => !updates?.has(it.id));
    if (missing.length === 0) {
      if (!updates) setUpdates(new Map());
      return;
    }
    const eff = resolveConfig(config, envPat);
    if (!eff || !eff.pat) {
      setError("No hay conexión configurada.");
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: missing.length });
    fetchUpdates(eff, missing, (done, total) => setProgress({ done, total }))
      .then((fetched) => setUpdates((prev) => new Map([...(prev ?? []), ...fetched])))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [open, config, envPat, datedSprints, updates]);

  const rows = useMemo<UnplannedRow[]>(() => {
    if (!updates) return [];
    const valueOf = (it: WorkItem) => (metric === "points" ? it.storyPoints ?? 0 : 1);
    return datedSprints.map((s) => {
      const start = startOf(s.path)!;
      const startDay = defaultCutoff(start);
      const cutoff = cutoffs[s.path] ?? startDay;
      const classified = storiesOf(s)
        .filter((it) => updates.has(it.id))
        .map((it) => {
          const entry = sprintEntry(updates.get(it.id)!, s.path, it.createdDate, it.createdBy);
          return { item: it, entry, unplanned: isUnplanned(entry, cutoff) };
        });
      const sum = (xs: ClassifiedItem[]) => xs.reduce((acc, c) => acc + valueOf(c.item), 0);
      return {
        sprint: s,
        startDay,
        cutoff,
        custom: Boolean(cutoffs[s.path]),
        classified,
        unplannedValue: sum(classified.filter((c) => c.unplanned)),
        totalValue: sum(classified),
      };
    });
  }, [updates, datedSprints, startOf, cutoffs, metric]);

  const summary = useMemo(() => {
    const withData = rows.filter((r) => r.totalValue > 0);
    const pcts = withData.map((r) => r.unplannedValue / r.totalValue);
    const unplannedItems = rows.flatMap((r) => r.classified.filter((c) => c.unplanned));
    return {
      sprints: withData.length,
      avgPct: pcts.length ? (pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100 : 0,
      unplannedCount: unplannedItems.length,
      unplannedValue: rows.reduce((a, r) => a + r.unplannedValue, 0),
      analyzed: rows.reduce((a, r) => a + r.classified.length, 0),
    };
  }, [rows]);

  const unit = metric === "points" ? "pts" : "US";

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left p-4 flex items-center gap-3"
      >
        <span className="text-slate-600">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-semibold text-slate-300">🚨 Trabajo no planeado</span>
        <span className="text-xs text-slate-500">US que entraron al sprint después de la planning</span>
        {updates && summary.sprints > 0 && (
          <span className="ml-auto text-sm text-amber-300 font-semibold">
            prom. {Math.round(summary.avgPct)}%
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-800 p-4 space-y-3">
          {loading && (
            <p className="text-sm text-slate-400">
              Cargando historial… {progress.done}/{progress.total}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {!loading && datedSprints.length === 0 && (
            <p className="text-sm text-slate-500">
              No hay sprints con fecha de inicio en Azure DevOps y User Stories dentro de la
              ventana actual (y los filtros elegidos).
            </p>
          )}

          {updates && rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Toggle active={metric === "items"} onClick={() => setMetric("items")}>
                  Cantidad de US
                </Toggle>
                <Toggle active={metric === "points"} onClick={() => setMetric("points")}>
                  Story points
                </Toggle>
                <span className="text-xs text-slate-500 ml-auto">
                  Fecha de corte: lo que entra después de ese día cuenta como no planeado.
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Sprints analizados" value={String(summary.sprints)} tone="text-slate-200" />
                <Stat label="No planeado (prom.)" value={`${Math.round(summary.avgPct)}%`} tone="text-amber-300" />
                <Stat
                  label={`No planeado (${unit})`}
                  value={String(summary.unplannedValue)}
                  tone="text-amber-300"
                />
                <Stat
                  label="US no planeadas / analizadas"
                  value={`${summary.unplannedCount}/${summary.analyzed}`}
                  tone="text-slate-200"
                />
              </div>

              <div className="space-y-1.5">
                {rows.map((r) => {
                  const pct = r.totalValue ? (r.unplannedValue / r.totalValue) * 100 : 0;
                  const unplannedList = r.classified.filter((c) => c.unplanned);
                  const isOpen = openSprint === r.sprint.path;
                  return (
                    <div key={r.sprint.path} className="bg-slate-800/40 rounded-lg">
                      <div className="flex items-center gap-2 text-sm px-2 py-1.5">
                        <button
                          onClick={() => setOpenSprint(isOpen ? null : r.sprint.path)}
                          className="flex items-center gap-2 w-36 shrink-0 text-left"
                          disabled={unplannedList.length === 0}
                          title={unplannedList.length ? "Ver items no planeados" : undefined}
                        >
                          <span className="text-slate-600 w-3">
                            {unplannedList.length ? (isOpen ? "▾" : "▸") : ""}
                          </span>
                          <span className="text-slate-300 truncate" title={r.sprint.label}>
                            {r.sprint.label}
                          </span>
                        </button>
                        <label className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
                          corte
                          <input
                            type="date"
                            value={r.cutoff ?? ""}
                            onChange={(e) =>
                              void setPlanningCutoff(
                                r.sprint.path,
                                // Volver a la fecha de inicio = sacar el override
                                e.target.value && e.target.value !== r.startDay ? e.target.value : null,
                              )
                            }
                            className={`bg-slate-900 border rounded px-1.5 py-0.5 text-xs [color-scheme:dark] outline-none focus:border-sky-500 ${
                              r.custom ? "border-amber-500/60 text-amber-200" : "border-slate-700 text-slate-200"
                            }`}
                            title={`Inicio del sprint: ${r.startDay}`}
                          />
                          {r.custom && (
                            <button
                              onClick={() => void setPlanningCutoff(r.sprint.path, null)}
                              className="text-slate-500 hover:text-slate-200"
                              title="Volver al inicio del sprint"
                            >
                              ↺
                            </button>
                          )}
                        </label>
                        <div className="flex-1 bg-sky-500/50 rounded h-3.5 overflow-hidden flex justify-end min-w-16">
                          <div className="bg-amber-500/90 h-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-slate-400 w-32 text-right tabular-nums shrink-0">
                          {r.unplannedValue}/{r.totalValue} {unit}
                          <span className="text-amber-300 font-medium"> · {Math.round(pct)}%</span>
                        </span>
                      </div>
                      {isOpen && (
                        <div className="px-3 pb-2 space-y-1 max-h-60 overflow-y-auto">
                          {[...unplannedList]
                            .sort((a, b) => a.entry.date.localeCompare(b.entry.date))
                            .map(({ item, entry }) => (
                              <div key={item.id} className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                  <ItemRow item={item} />
                                </div>
                                <span className="text-xs text-slate-400 w-48 text-right shrink-0 truncate">
                                  {entry.atCreation ? "creado" : "agregado"} {fmtDay(entry.date)}
                                  {entry.by && <span className="text-slate-500"> · {entry.by}</span>}
                                </span>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-600">
                <span className="inline-block w-2 h-2 rounded-sm bg-sky-500/50 mr-1" />planeado
                <span className="inline-block w-2 h-2 rounded-sm bg-amber-500/90 mx-1 ml-3" />no planeado
                {undatedCount > 0 && ` · ${undatedCount} sprint(s) sin fecha de inicio en Azure no se analizan.`}
                {" "}No incluye items que se sacaron del sprint.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StateSelect({
  value,
  onChange,
  states,
  includeCreated = false,
}: {
  value: string;
  onChange: (v: string) => void;
  states: string[];
  includeCreated?: boolean;
}) {
  return (
    <select
      className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {includeCreated && <option value={CREATED_SENTINEL}>{CREATED_LABEL}</option>}
      {states.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${tone}`}>{value}</p>
    </div>
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
        active ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}
