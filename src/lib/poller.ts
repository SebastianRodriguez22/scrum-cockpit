// Motor de polling: carga inicial + ciclos incrementales contra Azure DevOps.
//
// Multi-pestaña: sólo la pestaña activa consulta Azure. Cada ciclo queda atado
// a la pestaña (y a la config) con la que arrancó: todo lo que escribe pasa por
// `patchTab`, así que si el usuario cambia de pestaña a mitad de una consulta,
// el resultado cae en la pestaña correcta (o se descarta si se cerró o se
// reconfiguró) y nunca se mezcla con el proyecto que se está mirando.
import { mergeFeed, toItemMap, useStore, type TabData } from "../store/useStore";
import {
  getAllIterationDates,
  getIterations,
  getWorkItems,
  getWorkItemUpdates,
  queryAllIds,
  queryChangedIds,
} from "./azureDevOps";
import { updatesToEvents } from "./feedEvents";
import type { AzureConfig, FeedEvent, WorkItem } from "../types";

/** Una ejecución del poller: qué pestaña, con qué config (con PAT) y contra qué config guardada */
interface Run {
  tabId: string;
  /** Config efectiva (con el PAT resuelto) para llamar a la API */
  cfg: AzureConfig;
  /** Config guardada de la pestaña al arrancar; si cambia, se descartan los resultados */
  base: AzureConfig;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Ejecución vigente (la de la pestaña activa) */
let current: Run | null = null;
// Ciclos en curso / pedidos pendientes, por pestaña. Si llega un pedido de
// sync mientras hay un tick en curso, lo encolamos para que "Actualizar ahora"
// no se pierda silenciosamente.
const ticking = new Set<string>();
const rerunPending = new Set<string>();
// Cargas iniciales en curso, por pestaña (con la config con la que arrancaron)
const loading = new Map<string, AzureConfig>();

export function isPolling(): boolean {
  return timer !== null;
}

/** Escrituras de una ejecución, dirigidas siempre a su pestaña */
function writerFor(run: Run) {
  const patch = (fn: (d: TabData) => Partial<TabData>) =>
    useStore.getState().patchTab(run.tabId, run.base, fn);
  return {
    /** true si la pestaña sigue existiendo con la misma config */
    alive: () => patch(() => ({})),
    data: () => useStore.getState().getTabData(run.tabId),
    setItems: (items: WorkItem[]) => patch(() => ({ items: toItemMap(items) })),
    mergeItems: (items: WorkItem[]) =>
      patch((d) => ({ items: { ...d.items, ...toItemMap(items) } })),
    addEvents: (events: FeedEvent[]) =>
      events.length > 0 && patch((d) => ({ feed: mergeFeed(d.feed, events) })),
    setIterations: (iterations: TabData["iterations"]) => patch(() => ({ iterations })),
    setIterationDates: (iterationDates: TabData["iterationDates"]) =>
      patch(() => ({ iterationDates })),
    setStatus: (status: TabData["status"]) => patch(() => ({ status })),
    setError: (error: string | null) =>
      patch((d) => ({ error, status: error ? "error" : d.status })),
    setLastSync: (lastSync: string) => patch(() => ({ lastSync })),
    setWatermark: (watermark: string) => patch(() => ({ watermark })),
  };
}

/** Carga inicial: trae todos los items + siembra el feed con la actividad reciente */
async function fullSync(run: Run): Promise<void> {
  const w = writerFor(run);
  const { cfg } = run;
  const ids = await queryAllIds(cfg);
  const items = await getWorkItems(cfg, ids);
  if (!w.setItems(items)) return; // pestaña cerrada o reconfigurada

  getIterations(cfg)
    .then(w.setIterations)
    .catch(() => {});

  // Fechas de todas las iteraciones (incl. sprints viejos) para la ventana por meses.
  getAllIterationDates(cfg)
    .then(w.setIterationDates)
    .catch(() => {});

  // Sembrar feed con los 30 items modificados más recientemente
  const recent = [...items]
    .sort((a, b) => new Date(b.changedDate).getTime() - new Date(a.changedDate).getTime())
    .slice(0, 30);
  for (const it of recent) {
    if (!w.alive()) return;
    try {
      const updates = await getWorkItemUpdates(cfg, it.id);
      w.addEvents(updatesToEvents(it.id, it.type, it.title, updates));
    } catch {
      /* item individual que falla no corta la carga */
    }
  }
  w.setWatermark(new Date().toISOString());
}

/** Ciclo incremental: detecta cambios desde el watermark y actualiza items + feed */
async function tick(run: Run): Promise<void> {
  const { tabId, cfg } = run;
  if (ticking.has(tabId)) {
    rerunPending.add(tabId);
    return;
  }
  ticking.add(tabId);
  const w = writerFor(run);
  w.setStatus("syncing");
  try {
    const since = w.data()?.watermark ?? undefined;
    const checkpoint = new Date().toISOString();
    const changedIds = await queryChangedIds(cfg, since);

    if (changedIds.length > 0) {
      const items = await getWorkItems(cfg, changedIds);
      if (!w.mergeItems(items)) return; // pestaña cerrada o reconfigurada

      // La WIQL filtra por día (no acepta hora), así que `changedIds` puede
      // incluir items ya vistos en ciclos anteriores del mismo día. Afinamos
      // con el watermark de precisión completa para no re-pedir el historial
      // (una llamada por item) de cosas que no cambiaron desde el último tick.
      const sinceMs = since ? new Date(since).getTime() : 0;
      const fresh = items
        .filter((i) => new Date(i.changedDate).getTime() > sinceMs)
        .sort((a, b) => new Date(b.changedDate).getTime() - new Date(a.changedDate).getTime());

      // Limitar a 50 detalles por ciclo para no saturar
      for (const it of fresh.slice(0, 50)) {
        if (!w.alive()) return;
        try {
          const updates = await getWorkItemUpdates(cfg, it.id);
          w.addEvents(updatesToEvents(it.id, it.type, it.title, updates));
        } catch {
          /* noop */
        }
      }
    }

    w.setWatermark(checkpoint);
    w.setLastSync(new Date().toISOString());
    w.setStatus("ok");
    w.setError(null);
  } catch (e) {
    w.setError(e instanceof Error ? e.message : String(e));
  } finally {
    ticking.delete(tabId);
    // Atender un pedido que llegó mientras estábamos sincronizando (con la
    // config vigente de esa pestaña, si todavía es la activa)
    if (rerunPending.delete(tabId) && current?.tabId === tabId) {
      void tick(current);
    }
  }
}

/** Monta el intervalo para la ejecución vigente y dispara un ciclo ya */
function arm(run: Run): void {
  if (timer !== null) clearInterval(timer);
  const intervalMs = Math.max(10, run.cfg.pollIntervalSec) * 1000;
  timer = setInterval(() => void tick(run), intervalMs);
  void tick(run);
}

/**
 * Arranca el polling de una pestaña. Hace carga inicial si esa pestaña todavía
 * no tiene items (si ya los tiene, en memoria, sigue incremental desde ahí).
 */
export async function startPolling(tabId: string, cfg: AzureConfig): Promise<void> {
  stopPolling();
  const base = useStore.getState().tabs.find((t) => t.id === tabId)?.config;
  if (!base) return;
  const run: Run = { tabId, cfg, base };
  current = run;
  const w = writerFor(run);

  const hasItems = Object.keys(w.data()?.items ?? {}).length > 0;
  if (!hasItems) {
    // Si ya hay una carga inicial en curso para esta misma pestaña y config
    // (p. ej. se fue y volvió rápido), no la duplicamos: al terminar, arma el
    // intervalo si la pestaña sigue activa.
    if (loading.get(tabId) === base) return;
    loading.set(tabId, base);
    w.setStatus("syncing");
    try {
      await fullSync(run);
    } catch (e) {
      w.setError(e instanceof Error ? e.message : String(e));
      return; // no arrancar el intervalo si la carga inicial falló
    } finally {
      if (loading.get(tabId) === base) loading.delete(tabId);
    }
    w.setLastSync(new Date().toISOString());
    w.setStatus("ok");
    // Si mientras cargábamos se cambió de pestaña o de config, este arranque
    // quedó obsoleto: no montamos el intervalo (lo hará el arranque vigente).
    if (current?.tabId !== tabId || current.base !== base) return;
    arm(current);
    return;
  }

  arm(run);
}

export function stopPolling(): void {
  current = null;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Fuerza un ciclo manual ya mismo (de la pestaña activa) */
export async function syncNow(): Promise<void> {
  if (current) await tick(current);
}
