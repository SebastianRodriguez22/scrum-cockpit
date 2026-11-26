// Burndown de un sprint reconstruido día a día desde el historial de cada item.
//
// - Un item cuenta en el alcance desde que entró al sprint (última entrada,
//   igual que Trabajo no planeado).
// - Un item está completo un día si al final de ese día su estado es uno de
//   los que el equipo considera terminado (Ready for test en adelante).
// - La línea ideal arranca con lo que quedaba por hacer al cierre de la
//   planning (fecha de corte): lo comprometido menos lo que ya estaba completo
//   (p. ej. US arrastradas que ya estaban en testing). Baja en línea recta
//   hasta 0 el último día hábil del sprint, como el burndown de Azure DevOps.
import type { WorkItemUpdate } from "./azureDevOps";
import { updateDate } from "./leadTime";
import { cutoffEndMs, sprintEntry } from "./unplanned";
import { DONE_STATES } from "./workItemStatus";
import type { WorkItem } from "../types";

export interface BurndownDay {
  /** "YYYY-MM-DD" */
  day: string;
  /** Alcance (pts o items) en el sprint al final del día */
  scope: number;
  /** Completado al final del día */
  done: number;
  /** Restante = alcance - completado; null para días futuros */
  remaining: number | null;
  /** Línea ideal */
  ideal: number;
  /** Items en el sprint sin completar al final del día, con su estado de ese día */
  pending: { item: WorkItem; state: string | null }[];
  /** Items que pasaron a completos ese día */
  completed: WorkItem[];
}

export interface Burndown {
  days: BurndownDay[];
  /** Alcance comprometido al cierre de la planning */
  planned: number;
  /** Lo que quedaba por hacer al cierre de la planning (inicio de la línea ideal) */
  plannedRemaining: number;
  /** Índice del día de hoy en `days` (o -1 si hoy no cae en el sprint) */
  todayIndex: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

/**
 * Días hábiles (lunes a viernes) entre `startDay` y `finishDay`, inclusive. El
 * primer día se incluye siempre, aunque caiga en fin de semana.
 */
export function workingDays(startDay: string, finishDay: string): string[] {
  const out: string[] = [];
  const end = parseDay(finishDay).getTime();
  for (let d = parseDay(startDay); d.getTime() <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
    const wd = d.getDay();
    if (out.length === 0 || (wd !== 0 && wd !== 6)) out.push(toDay(d));
  }
  return out;
}

/** Estado del item en el instante `ms` según su historial (null si todavía no existía) */
export function stateAt(updates: WorkItemUpdate[], createdDate: string, ms: number): string | null {
  let state: string | null = null;
  for (const u of [...updates].sort((a, b) => a.rev - b.rev)) {
    const nv = u.fields?.["System.State"]?.newValue;
    if (typeof nv !== "string") continue;
    const date = u.rev === 1 ? createdDate : updateDate(u);
    if (!date) continue;
    if (new Date(date).getTime() > ms) break;
    state = nv;
  }
  return state;
}

const isDoneState = (s: string | null) => s != null && DONE_STATES.has(s.trim().toLowerCase());

export function buildBurndown(opts: {
  items: WorkItem[];
  updates: Map<number, WorkItemUpdate[]>;
  sprintPath: string;
  startDay: string;
  finishDay: string;
  /** Fecha de corte de la planning ("YYYY-MM-DD") */
  cutoffDay: string;
  valueOf: (it: WorkItem) => number;
  now?: number;
}): Burndown {
  const { items, updates, sprintPath, startDay, finishDay, cutoffDay, valueOf } = opts;
  const now = opts.now ?? Date.now();
  const days = workingDays(startDay, finishDay);
  const todayDay = toDay(new Date(now));

  const tracked = items.map((it) => {
    const ups = updates.get(it.id) ?? [];
    return {
      it,
      ups,
      value: valueOf(it),
      enteredMs: new Date(sprintEntry(ups, sprintPath, it.createdDate, it.createdBy).date).getTime(),
    };
  });

  // Foto del sprint en un instante: qué items estaban y en qué estado
  const snapshot = (ms: number) => {
    const inSprint = tracked
      .filter((t) => t.enteredMs <= ms)
      .map((t) => ({ t, state: stateAt(t.ups, t.it.createdDate, ms) }));
    const done = inSprint.filter((x) => isDoneState(x.state));
    const sum = (xs: typeof inSprint) => xs.reduce((s, x) => s + x.t.value, 0);
    return {
      scope: sum(inSprint),
      done: sum(done),
      doneIds: new Set(done.map((x) => x.t.it.id)),
      pending: inSprint.filter((x) => !isDoneState(x.state)).map((x) => ({ item: x.t.it, state: x.state })),
    };
  };

  // Si la planning se cerró antes del inicio, el punto de partida es el inicio
  const planningDay = cutoffDay > startDay ? cutoffDay : startDay;
  const atPlanning = snapshot(Math.min(cutoffEndMs(planningDay), now));
  const planned = atPlanning.scope;
  const plannedRemaining = atPlanning.scope - atPlanning.done;
  const last = Math.max(1, days.length - 1);

  // Completos antes del primer día (para saber qué se completó el día 1)
  let prevDone = snapshot(cutoffEndMs(days[0] ?? startDay) - 86400000).doneIds;
  const out: BurndownDay[] = days.map((day, i) => {
    const future = day > todayDay;
    const snap = snapshot(future ? now : Math.min(cutoffEndMs(day), now));
    const completed = future ? [] : tracked.filter((t) => snap.doneIds.has(t.it.id) && !prevDone.has(t.it.id)).map((t) => t.it);
    if (!future) prevDone = snap.doneIds;
    return {
      day,
      scope: snap.scope,
      done: snap.done,
      remaining: future ? null : snap.scope - snap.done,
      ideal: Math.max(0, plannedRemaining * (1 - i / last)),
      pending: future ? [] : snap.pending,
      completed,
    };
  });

  return { days: out, planned, plannedRemaining, todayIndex: days.indexOf(todayDay) };
}
