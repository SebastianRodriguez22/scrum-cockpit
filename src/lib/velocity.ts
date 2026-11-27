// Velocidad por sprint con promedio móvil, para planificar.
//
// - Entregado: lo que está completo hoy (Ready for test en adelante) entre los
//   items del sprint con el Compromiso elegido. Lo que no se terminó suele
//   pasar al sprint siguiente, así que queda contado donde se completó.
// - Sólo los sprints cerrados (ya terminaron) entran al promedio; el actual y
//   los futuros se comparan contra él.
// - Si se conoce la capacidad (días-persona, ver capacity.ts), también se
//   calcula el ritmo (completado por día-persona). Así un sprint con medio
//   equipo de vacaciones no baja la expectativa, y lo esperado para el sprint
//   actual / próximo se ajusta a quiénes van a estar.
import { isDone } from "./workItemStatus";
import type { WorkItem } from "../types";

export interface VelocitySprint {
  path: string;
  label: string;
  /** ISO */
  start: string;
  /** ISO */
  finish: string;
  items: WorkItem[];
}

export type SprintPhase = "closed" | "current" | "future";

export interface VelocityRow {
  path: string;
  label: string;
  start: string;
  phase: SprintPhase;
  /** Alcance con el Compromiso elegido (lo que hay hoy en el sprint) */
  scope: number;
  /** Completado */
  delivered: number;
  /** Promedio móvil de lo entregado en los últimos N sprints cerrados (hasta este) */
  movingAvg: number | null;
  /** Días-persona disponibles (null si no se conoce) */
  personDays: number | null;
  /** Completado por día-persona (sólo sprints cerrados con capacidad) */
  rate: number | null;
  /** Lo esperable según el ritmo promedio y la capacidad del sprint */
  expected: number | null;
}

export interface VelocitySummary {
  /** Sprints cerrados que entran al promedio */
  count: number;
  avg: number;
  min: number;
  max: number;
  /** Variación relativa (desvío / promedio), 0 si no hay datos */
  variability: number;
  /**
   * Ritmo promedio (completado por día-persona) de los mismos sprints; null si
   * a alguno le falta la capacidad. Con ritmo, la variabilidad se mide sobre él.
   */
  rate: number | null;
}

const endOfDayMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999).getTime();
};
const startOfDayMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
};

export function phaseOf(start: string, finish: string, now: number): SprintPhase {
  if (endOfDayMs(finish) < now) return "closed";
  if (startOfDayMs(start) > now) return "future";
  return "current";
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function buildVelocity(
  sprints: VelocitySprint[],
  opts: {
    include: (it: WorkItem) => boolean;
    valueOf: (it: WorkItem) => number;
    /** Cuántos sprints cerrados promediar */
    window: number;
    now?: number;
    /** Días-persona de cada sprint, si se conocen */
    personDaysOf?: (path: string) => number | null;
  },
): { rows: VelocityRow[]; summary: VelocitySummary } {
  const now = opts.now ?? Date.now();
  const sum = (xs: WorkItem[]) => xs.reduce((s, it) => s + opts.valueOf(it), 0);

  const ordered = [...sprints].sort((a, b) => a.start.localeCompare(b.start));
  const closedDelivered: number[] = [];
  const closedDays: (number | null)[] = [];
  const rows: VelocityRow[] = ordered.map((s) => {
    const items = s.items.filter(opts.include);
    const phase = phaseOf(s.start, s.finish, now);
    const delivered = sum(items.filter(isDone));
    const pd = opts.personDaysOf?.(s.path) ?? null;
    const personDays = pd != null && pd > 0 ? pd : null;
    let movingAvg: number | null = null;
    if (phase === "closed") {
      closedDelivered.push(delivered);
      closedDays.push(personDays);
      movingAvg = mean(closedDelivered.slice(-opts.window));
    }
    return {
      path: s.path,
      label: s.label,
      start: s.start,
      phase,
      scope: sum(items),
      delivered,
      movingAvg,
      personDays,
      rate: phase === "closed" && personDays ? delivered / personDays : null,
      expected: null,
    };
  });

  const lastN = closedDelivered.slice(-opts.window);
  const lastDays = closedDays.slice(-opts.window);
  const avg = mean(lastN);
  // Ritmo ponderado: total completado / total de días-persona
  const allDays = lastN.length > 0 && lastDays.every((d) => d != null);
  const totalDays = allDays ? lastDays.reduce((a, b) => a + (b ?? 0), 0) : 0;
  const rate = allDays && totalDays > 0 ? lastN.reduce((a, b) => a + b, 0) / totalDays : null;

  // Variabilidad: sobre el ritmo si se conoce (descuenta vacaciones), si no sobre lo completado
  const series = rate != null ? lastN.map((x, i) => x / (lastDays[i] as number)) : lastN;
  const m = mean(series);
  const sd = series.length ? Math.sqrt(mean(series.map((x) => (x - m) ** 2))) : 0;

  for (const r of rows) {
    if (rate != null && r.personDays != null) r.expected = rate * r.personDays;
  }
  return {
    rows,
    summary: {
      count: lastN.length,
      avg,
      min: lastN.length ? Math.min(...lastN) : 0,
      max: lastN.length ? Math.max(...lastN) : 0,
      variability: m > 0 ? sd / m : 0,
      rate,
    },
  };
}
