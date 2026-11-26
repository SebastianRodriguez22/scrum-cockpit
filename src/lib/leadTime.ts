// Cálculo de Lead/Cycle Time a partir del historial de estados de un work item.
// El historial se trae on-demand (1 request por item) porque es pesado y sólo
// hace falta en los paneles de Lead Time y Trabajo no planeado del Evolutivo.
// Se guarda en memoria y en disco (recortado), así al reabrir la app sólo se
// pide lo que cambió.
import { load, type Store } from "@tauri-apps/plugin-store";
import { getWorkItemUpdates, type WorkItemUpdate } from "./azureDevOps";
import type { AzureConfig, WorkItem } from "../types";

/** Estado inicial especial: la creación del item (usa System.CreatedDate). */
export const CREATED_SENTINEL = "__created__";
export const CREATED_LABEL = "Creación";

export interface StateChange {
  state: string;
  date: string; // ISO
}

const eqState = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Fecha real (ISO) de una revisión, o null si no es confiable.
 * OJO: `revisedDate` de la última revisión (la vigente) viene como
 * "9999-01-01" en ADO, lo que reventaba los cálculos (millones de días). La
 * fecha real del cambio es el nuevo valor de System.ChangedDate de esa
 * revisión; caemos a revisedDate sólo si no estuviera.
 */
export function updateDate(u: WorkItemUpdate): string | null {
  const changed = u.fields?.["System.ChangedDate"]?.newValue;
  const date = typeof changed === "string" ? changed : u.revisedDate;
  if (!date) return null;
  const t = new Date(date).getTime();
  // Descartar fechas centinela/absurdas (año 9999) por las dudas.
  if (Number.isNaN(t) || new Date(date).getUTCFullYear() > 9000) return null;
  return date;
}

/** Línea de tiempo de transiciones de estado (de la más vieja a la más nueva). */
export function stateTimeline(updates: WorkItemUpdate[]): StateChange[] {
  const out: StateChange[] = [];
  for (const u of updates) {
    const nv = u.fields?.["System.State"]?.newValue;
    if (typeof nv !== "string") continue;
    const date = updateDate(u);
    if (!date) continue;
    out.push({ state: nv, date });
  }
  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/** Primer instante (ms) en que el item entró a `state`, o null si nunca. */
function firstEntryMs(timeline: StateChange[], state: string): number | null {
  for (const c of timeline) {
    if (eqState(c.state, state)) {
      const t = new Date(c.date).getTime();
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/**
 * Días entre que el item entró a `fromState` (o su creación) y la primera vez
 * que alcanzó CUALQUIERA de los `toStates` después de ese momento. null si no
 * aplica (nunca pasó por el inicial, o ninguno de los finales lo siguió).
 */
export function leadTimeDays(
  timeline: StateChange[],
  createdDate: string,
  fromState: string,
  toStates: string[],
): number | null {
  if (toStates.length === 0) return null;
  const startMs =
    fromState === CREATED_SENTINEL ? new Date(createdDate).getTime() : firstEntryMs(timeline, fromState);
  if (startMs == null || Number.isNaN(startMs)) return null;

  let endMs: number | null = null;
  for (const c of timeline) {
    if (!toStates.some((ts) => eqState(c.state, ts))) continue;
    const t = new Date(c.date).getTime();
    if (!Number.isNaN(t) && t >= startMs) {
      endMs = t;
      break;
    }
  }
  if (endMs == null) return null;
  return (endMs - startMs) / 86400000;
}

// Caché de sesión del historial COMPLETO de cada item, compartido por los paneles
// que lo necesitan (Lead Time, Trabajo no planeado) y alimentado también por el
// poller (que ya trae el historial de lo que cambia). La clave incluye org y
// proyecto: con varias pestañas, el item 123 de una organización no es el 123
// de otra. Cada entrada recuerda el ChangedDate del item: si el item cambió
// desde entonces, su historial se vuelve a pedir.
interface CachedUpdates {
  changedDate: string;
  updates: WorkItemUpdate[];
  /** Cuándo se guardó (ms), para limpiar lo viejo del disco */
  savedAt: number;
}
const updatesCache = new Map<string, CachedUpdates>();
const cacheKey = (cfg: AzureConfig, id: number) =>
  `${cfg.org.toLowerCase()}/${cfg.project.toLowerCase()}/${id}`;

/** Consultas simultáneas a Azure DevOps al traer historiales */
const CONCURRENCY = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Copia en disco -----------------------------------------------------------
// Archivo aparte de la config (puede crecer). Sólo se guardan los campos que
// usan estos paneles, para que pese poco. Lo que no se usó en DISK_MAX_AGE_DAYS
// se borra al arrancar.
const DISK_FILE = "history-cache.json";
const DISK_MAX_AGE_DAYS = 120;
/** Campos del historial que se conservan (estado, sprint y fecha del cambio) */
const KEPT_FIELDS = ["System.State", "System.IterationPath", "System.ChangedDate"];

let disk: Store | null = null;
let diskReady: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Abre el archivo (una sola vez), limpia lo viejo y carga el resto en memoria */
function ensureDisk(): Promise<void> {
  if (!diskReady) {
    diskReady = (async () => {
      try {
        const store = await load(DISK_FILE, { autoSave: false, defaults: {} });
        const oldest = Date.now() - DISK_MAX_AGE_DAYS * 86400000;
        const stale: string[] = [];
        for (const [key, value] of await store.entries<CachedUpdates>()) {
          if (!value || typeof value.savedAt !== "number" || value.savedAt < oldest) {
            stale.push(key);
          } else if (!updatesCache.has(key)) {
            updatesCache.set(key, value); // lo de memoria (más nuevo) tiene prioridad
          }
        }
        for (const key of stale) await store.delete(key);
        if (stale.length) await store.save();
        disk = store;
      } catch {
        disk = null; // sin disco, sigue funcionando sólo en memoria
      }
    })();
  }
  return diskReady;
}

/** Agrupa las escrituras: guarda el archivo 2 s después del último cambio */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void disk?.save().catch(() => {});
  }, 2000);
}

/** Historial recortado a lo que usan Lead Time y Trabajo no planeado */
export function trimUpdates(updates: WorkItemUpdate[]): WorkItemUpdate[] {
  const out: WorkItemUpdate[] = [];
  for (const u of updates) {
    const fields: NonNullable<WorkItemUpdate["fields"]> = {};
    for (const f of KEPT_FIELDS) if (u.fields?.[f]) fields[f] = u.fields[f];
    // Revisiones que sólo tocan otros campos no aportan nada (salvo la creación)
    const useful = u.rev === 1 || "System.State" in fields || "System.IterationPath" in fields;
    if (!useful) continue;
    out.push({
      id: u.id,
      rev: u.rev,
      revisedBy: u.revisedBy?.displayName ? { displayName: u.revisedBy.displayName } : undefined,
      revisedDate: u.revisedDate,
      fields,
    });
  }
  return out;
}

function putCache(key: string, entry: CachedUpdates): void {
  updatesCache.set(key, entry);
  void ensureDisk().then(async () => {
    if (!disk) return;
    await disk.set(key, entry);
    scheduleSave();
  });
}

/** Guarda en el caché un historial ya traído (lo usa el poller) */
export function rememberUpdates(cfg: AzureConfig, item: WorkItem, updates: WorkItemUpdate[]): void {
  putCache(cacheKey(cfg, item.id), {
    changedDate: item.changedDate,
    updates: trimUpdates(updates),
    savedAt: Date.now(),
  });
}

/** Historial de un item con hasta 2 reintentos (p. ej. si Azure limita por exceso de pedidos) */
async function getUpdatesWithRetry(cfg: AzureConfig, id: number): Promise<WorkItemUpdate[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getWorkItemUpdates(cfg, id);
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/**
 * Trae el historial de cambios de cada item: lo que está en caché (y no cambió)
 * sale al instante; el resto se pide a Azure con hasta CONCURRENCY consultas a
 * la vez. `onProgress(done, total)` permite mostrar avance en la UI. Si falla un
 * item, queda con historial vacío (no se cachea, para reintentar luego).
 */
export async function fetchUpdates(
  cfg: AzureConfig,
  items: WorkItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, WorkItemUpdate[]>> {
  await ensureDisk();
  const result = new Map<number, WorkItemUpdate[]>();
  const pending: WorkItem[] = [];
  for (const it of items) {
    const cached = updatesCache.get(cacheKey(cfg, it.id));
    if (cached && cached.changedDate === it.changedDate) result.set(it.id, cached.updates);
    else pending.push(it);
  }
  let done = result.size;
  onProgress?.(done, items.length);

  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const it = pending[next++];
      try {
        const updates = await getUpdatesWithRetry(cfg, it.id);
        rememberUpdates(cfg, it, updates);
        result.set(it.id, trimUpdates(updates)); // igual que lo que sale del caché
      } catch {
        result.set(it.id, []);
      }
      onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  return result;
}

/**
 * Línea de tiempo de estados de cada item (para Lead Time), sobre el mismo
 * historial cacheado.
 */
export async function fetchTimelines(
  cfg: AzureConfig,
  items: WorkItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, StateChange[]>> {
  const updates = await fetchUpdates(cfg, items, onProgress);
  const result = new Map<number, StateChange[]>();
  for (const [id, u] of updates) result.set(id, stateTimeline(u));
  return result;
}
