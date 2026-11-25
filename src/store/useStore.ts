// Estado global (Zustand) + persistencia con el plugin-store de Tauri.
//
// Multi-proyecto: la app maneja varias pestañas (ProjectTab), una por proyecto
// de Azure DevOps. Para no reescribir las vistas, los campos "de datos" del
// estado (config, items, feed, iterations, status, ...) siempre reflejan la
// pestaña ACTIVA. Las pestañas inactivas guardan una foto de sus datos en
// `tabCache`, así volver a una pestaña es instantáneo.
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { AzureConfig, FeedEvent, ProjectTab, WorkItem } from "../types";
import type { Iteration, IterationDates } from "../lib/azureDevOps";
import { getEnvPat } from "../lib/env";
import { useFilters } from "./useFilters";

const STORE_FILE = "scrum-cockpit.json";
const MAX_FEED = 500;

// Claves de persistencia. Formato multi-pestaña:
//   tabs            -> ProjectTab[] (config sin PAT)
//   activeTabId     -> id de la pestaña activa
//   feed:<tabId>    -> FeedEvent[] de esa pestaña
//   watermark:<id>  -> ISO del último chequeo de esa pestaña
// Las claves viejas de un solo proyecto ("config", "feed", "watermark") se
// migran a la primera pestaña y se dejan intactas, para que volver a una
// versión anterior de la app siga funcionando.
const TABS_KEY = "tabs";
const ACTIVE_KEY = "activeTabId";
const LEGACY_CONFIG_KEY = "config";
const LEGACY_FEED_KEY = "feed";
const LEGACY_WATERMARK_KEY = "watermark";
const feedKey = (tabId: string) => `feed:${tabId}`;
const watermarkKey = (tabId: string) => `watermark:${tabId}`;

let tauriStore: Store | null = null;
async function getStore(): Promise<Store> {
  if (!tauriStore) {
    tauriStore = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return tauriStore;
}

function newTabId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Nunca persistimos el token: se lee siempre de la variable de entorno. */
function withoutPat(cfg: AzureConfig): AzureConfig {
  return { ...cfg, pat: "" };
}

export type SyncStatus = "idle" | "syncing" | "ok" | "error";

/**
 * Devuelve el config con el PAT resuelto exclusivamente desde la variable de
 * entorno. El token nunca se persiste ni se ingresa por pantalla, así que lo
 * inyectamos en tiempo de ejecución y descartamos cualquier valor guardado.
 */
export function resolveConfig(
  config: AzureConfig | null,
  envPat: string | null,
): AzureConfig | null {
  if (!config) return null;
  return { ...config, pat: envPat?.trim() || "" };
}

/** Datos propios de una pestaña (lo que cambia al pasar de un proyecto a otro). */
export interface TabData {
  items: Record<number, WorkItem>;
  feed: FeedEvent[];
  iterations: Iteration[];
  iterationDates: Record<string, IterationDates>; // todas las iteraciones (por IterationPath)
  status: SyncStatus;
  lastSync: string | null;
  error: string | null;
  watermark: string | null;
}

function emptyTabData(): TabData {
  return {
    items: {},
    feed: [],
    iterations: [],
    iterationDates: {},
    status: "idle",
    lastSync: null,
    error: null,
    watermark: null,
  };
}

/** Extrae del estado actual los datos de la pestaña activa (para guardarlos en cache). */
function snapshotOf(s: TabData): TabData {
  return {
    items: s.items,
    feed: s.feed,
    iterations: s.iterations,
    iterationDates: s.iterationDates,
    status: s.status,
    lastSync: s.lastSync,
    error: s.error,
    watermark: s.watermark,
  };
}

/** Lee del disco lo persistido de una pestaña (feed + watermark). */
async function loadPersistedTabData(tabId: string): Promise<TabData> {
  const store = await getStore();
  return {
    ...emptyTabData(),
    feed: (await store.get<FeedEvent[]>(feedKey(tabId))) ?? [],
    watermark: (await store.get<string>(watermarkKey(tabId))) ?? null,
  };
}

interface AppState extends TabData {
  // Config de la pestaña activa (null = no hay pestañas => Setup)
  config: AzureConfig | null;
  envPat: string | null; // PAT detectado en variable de entorno
  configLoaded: boolean;

  // Pestañas
  tabs: ProjectTab[];
  activeTabId: string | null;
  /** Datos en memoria de las pestañas inactivas */
  tabCache: Record<string, TabData>;

  // Acciones
  loadPersisted: () => Promise<void>;
  /** Guarda la config de la pestaña activa (o crea la primera si no hay ninguna) */
  saveConfig: (cfg: AzureConfig) => Promise<void>;
  /** Cierra la pestaña activa */
  clearConfig: () => Promise<void>;
  /** Abre una pestaña nueva con ese proyecto y la deja activa. Devuelve su id. */
  addTab: (cfg: AzureConfig) => Promise<string>;
  /** Cambia la pestaña activa */
  switchTab: (tabId: string) => Promise<void>;
  /** Cierra una pestaña y borra sus datos guardados */
  closeTab: (tabId: string) => Promise<void>;

  /** Datos actuales de una pestaña (activa o en cache); null si no está cargada */
  getTabData: (tabId: string) => TabData | null;
  /**
   * Aplica cambios a los datos de UNA pestaña concreta, esté activa o no.
   * Es la única vía de escritura del poller: así un resultado que llega tarde
   * cae en su pestaña y nunca en la que el usuario está mirando ahora.
   * Se descarta (devuelve false) si la pestaña se cerró o si su config cambió
   * desde `baseConfig` (p. ej. se editó la ventana de fecha a mitad de carga).
   */
  patchTab: (
    tabId: string,
    baseConfig: AzureConfig,
    fn: (current: TabData) => Partial<TabData>,
  ) => boolean;
}

/** Mapa id -> item a partir de una lista */
export function toItemMap(items: WorkItem[]): Record<number, WorkItem> {
  const map: Record<number, WorkItem> = {};
  for (const it of items) map[it.id] = it;
  return map;
}

/** Suma eventos nuevos al feed (sin duplicados, más nuevos primero, con tope) */
export function mergeFeed(feed: FeedEvent[], events: FeedEvent[]): FeedEvent[] {
  const existing = new Set(feed.map((e) => e.id));
  const fresh = events.filter((e) => !existing.has(e.id));
  if (fresh.length === 0) return feed;
  return [...fresh, ...feed]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_FEED);
}

export const useStore = create<AppState>((set, get) => {
  /**
   * Deja activa la pestaña `tabId`: guarda en cache los datos de la actual y
   * trae los de la nueva (de memoria si ya estaban, si no del disco).
   */
  async function activate(tabId: string | null, tabs: ProjectTab[]): Promise<void> {
    const s = get();
    const cache = { ...s.tabCache };
    if (s.activeTabId && s.activeTabId !== tabId && tabs.some((t) => t.id === s.activeTabId)) {
      cache[s.activeTabId] = snapshotOf(s);
    }
    const target = tabId ? tabs.find((t) => t.id === tabId) : undefined;
    let data: TabData;
    if (!target) {
      data = emptyTabData();
    } else if (cache[target.id]) {
      data = cache[target.id];
      delete cache[target.id];
    } else {
      data = await loadPersistedTabData(target.id);
    }
    const store = await getStore();
    await store.set(ACTIVE_KEY, target?.id ?? null);
    // Filtros de la pestaña nueva, en el mismo momento que sus datos
    useFilters.getState().switchTab(target?.id ?? null);
    set({
      ...data,
      tabs,
      tabCache: cache,
      activeTabId: target?.id ?? null,
      config: target?.config ?? null,
    });
  }

  return {
    ...emptyTabData(),
    config: null,
    envPat: null,
    configLoaded: false,
    tabs: [],
    activeTabId: null,
    tabCache: {},

    loadPersisted: async () => {
      const store = await getStore();
      let tabs = await store.get<ProjectTab[]>(TABS_KEY);
      let activeTabId = (await store.get<string>(ACTIVE_KEY)) ?? null;

      if (!Array.isArray(tabs)) {
        // Migración desde el formato de un solo proyecto (versión original).
        tabs = [];
        const legacy = await store.get<AzureConfig>(LEGACY_CONFIG_KEY);
        if (legacy) {
          const id = newTabId();
          tabs = [{ id, config: withoutPat(legacy) }];
          await store.set(feedKey(id), (await store.get<FeedEvent[]>(LEGACY_FEED_KEY)) ?? []);
          await store.set(watermarkKey(id), (await store.get<string>(LEGACY_WATERMARK_KEY)) ?? null);
          activeTabId = id;
        }
        await store.set(TABS_KEY, tabs);
        await store.set(ACTIVE_KEY, activeTabId);
        await store.save();
      }

      if (!activeTabId || !tabs.some((t) => t.id === activeTabId)) {
        activeTabId = tabs[0]?.id ?? null;
      }
      const active = tabs.find((t) => t.id === activeTabId);
      const data = active ? await loadPersistedTabData(active.id) : emptyTabData();
      const envPat = await getEnvPat();
      useFilters.getState().switchTab(activeTabId);
      set({
        ...data,
        tabs,
        activeTabId,
        tabCache: {},
        config: active?.config ?? null,
        envPat,
        configLoaded: true,
      });
    },

    saveConfig: async (cfg) => {
      const { tabs, activeTabId } = get();
      if (!activeTabId || !tabs.some((t) => t.id === activeTabId)) {
        // No hay pestaña activa: es la primera configuración.
        await get().addTab(cfg);
        return;
      }
      const store = await getStore();
      const persisted = withoutPat(cfg);
      const nextTabs = tabs.map((t) => (t.id === activeTabId ? { ...t, config: persisted } : t));
      await store.set(TABS_KEY, nextTabs);
      // Resetear el watermark y los items para que el poller haga una carga
      // inicial limpia con la nueva config / ventana de fecha (lookbackDays).
      await store.set(watermarkKey(activeTabId), null);
      await store.save();
      set({ tabs: nextTabs, config: persisted, items: {}, watermark: null });
    },

    clearConfig: async () => {
      const { activeTabId } = get();
      if (activeTabId) await get().closeTab(activeTabId);
    },

    addTab: async (cfg) => {
      const store = await getStore();
      const id = newTabId();
      const tabs = [...get().tabs, { id, config: withoutPat(cfg) }];
      await store.set(TABS_KEY, tabs);
      await store.set(feedKey(id), []);
      await store.set(watermarkKey(id), null);
      await activate(id, tabs);
      await store.save();
      return id;
    },

    switchTab: async (tabId) => {
      const { activeTabId, tabs } = get();
      if (tabId === activeTabId || !tabs.some((t) => t.id === tabId)) return;
      await activate(tabId, tabs);
      await (await getStore()).save();
    },

    closeTab: async (tabId) => {
      const { tabs, activeTabId, tabCache } = get();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      const store = await getStore();
      const nextTabs = tabs.filter((t) => t.id !== tabId);
      await store.set(TABS_KEY, nextTabs);
      await store.delete(feedKey(tabId));
      await store.delete(watermarkKey(tabId));
      useFilters.getState().forgetTab(tabId);

      if (tabId === activeTabId) {
        // Pasar a la vecina (la de la derecha, o la de la izquierda si era la última).
        const neighbor = nextTabs[Math.min(idx, nextTabs.length - 1)];
        // Sacamos la pestaña cerrada del estado antes de activar otra, para que
        // `activate` no la guarde en cache.
        set({ activeTabId: null });
        await activate(neighbor?.id ?? null, nextTabs);
      } else {
        const cache = { ...tabCache };
        delete cache[tabId];
        set({ tabs: nextTabs, tabCache: cache });
      }
      await store.save();
    },

    getTabData: (tabId) => {
      const s = get();
      if (s.activeTabId === tabId) return snapshotOf(s);
      return s.tabCache[tabId] ?? null;
    },

    patchTab: (tabId, baseConfig, fn) => {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.config !== baseConfig) return false;

      let patch: Partial<TabData>;
      if (s.activeTabId === tabId) {
        patch = fn(snapshotOf(s));
        set(patch);
      } else {
        const current = s.tabCache[tabId];
        if (!current) return false;
        patch = fn(current);
        set({ tabCache: { ...s.tabCache, [tabId]: { ...current, ...patch } } });
      }

      // Persistir (sin bloquear) lo que va a disco, en las claves de ESA pestaña
      if (patch.feed !== undefined || patch.watermark !== undefined) {
        void getStore().then((store) => {
          if (patch.feed !== undefined) void store.set(feedKey(tabId), patch.feed);
          if (patch.watermark !== undefined) void store.set(watermarkKey(tabId), patch.watermark);
        });
      }
      return true;
    },
  };
});
