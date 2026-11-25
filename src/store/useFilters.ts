// Estado de los filtros compartidos por Board / Feed / Métricas.
//
// Multi-pestaña: cada pestaña recuerda sus propios filtros (en memoria, durante
// la sesión). Al cambiar de pestaña se guardan los de la actual y se restauran
// los de la nueva; un sprint o una persona de un proyecto no aplican a otro.
import { create } from "zustand";

export type GroupBy = "boardColumn" | "state" | "assignedTo";

/** Valores de filtro (lo que se guarda por pestaña) */
export interface FilterValues {
  search: string;
  type: string | null; // "User Story" | "Bug" | "Task" | null
  assignee: string | null; // displayName o "__unassigned__"
  iterations: string[]; // iterationPaths seleccionados (multiselección); vacío = todos
  dateFrom: string | null; // "YYYY-MM-DD" — filtra por última actividad (changedDate)
  dateTo: string | null; // "YYYY-MM-DD"
  groupBy: GroupBy;
}

interface FilterState extends FilterValues {
  /** Pestaña a la que pertenecen los filtros actuales */
  tabId: string | null;
  /** Filtros guardados de las pestañas inactivas */
  savedByTab: Record<string, FilterValues>;

  setSearch: (v: string) => void;
  setType: (v: string | null) => void;
  setAssignee: (v: string | null) => void;
  setIterations: (v: string[]) => void;
  setDateFrom: (v: string | null) => void;
  setDateTo: (v: string | null) => void;
  setGroupBy: (v: GroupBy) => void;
  reset: () => void;
  /** Cambia a los filtros de otra pestaña (guardando los de la actual) */
  switchTab: (tabId: string | null) => void;
  /** Olvida los filtros de una pestaña cerrada */
  forgetTab: (tabId: string) => void;
}

export const UNASSIGNED = "__unassigned__";

function defaultFilters(): FilterValues {
  return {
    search: "",
    type: null,
    assignee: null,
    iterations: [],
    dateFrom: null,
    dateTo: null,
    groupBy: "boardColumn",
  };
}

function valuesOf(s: FilterValues): FilterValues {
  return {
    search: s.search,
    type: s.type,
    assignee: s.assignee,
    iterations: s.iterations,
    dateFrom: s.dateFrom,
    dateTo: s.dateTo,
    groupBy: s.groupBy,
  };
}

export const useFilters = create<FilterState>((set, get) => ({
  ...defaultFilters(),
  tabId: null,
  savedByTab: {},

  setSearch: (search) => set({ search }),
  setType: (type) => set({ type }),
  setAssignee: (assignee) => set({ assignee }),
  setIterations: (iterations) => set({ iterations }),
  setDateFrom: (dateFrom) => set({ dateFrom }),
  setDateTo: (dateTo) => set({ dateTo }),
  setGroupBy: (groupBy) => set({ groupBy }),
  reset: () =>
    set({
      search: "",
      type: null,
      assignee: null,
      iterations: [],
      dateFrom: null,
      dateTo: null,
    }),

  switchTab: (tabId) => {
    const s = get();
    if (s.tabId === tabId) return;
    const saved = { ...s.savedByTab };
    if (s.tabId) saved[s.tabId] = valuesOf(s);
    const next = (tabId && saved[tabId]) || defaultFilters();
    if (tabId) delete saved[tabId];
    set({ ...next, tabId, savedByTab: saved });
  },

  forgetTab: (tabId) => {
    const saved = { ...get().savedByTab };
    delete saved[tabId];
    set({ savedByTab: saved });
  },
}));
