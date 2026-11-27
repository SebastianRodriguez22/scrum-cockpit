// Días-persona disponibles en un sprint, a partir de la pestaña Capacity de
// Azure DevOps: días hábiles (lunes a viernes) menos los feriados del equipo,
// por cada persona, menos sus días libres (vacaciones, licencias).
//
// Quiénes cuentan: si en Capacity hay personas con horas por día cargadas,
// sólo esas (así se excluye a quien no desarrolla, p. ej. PO). Si no, las
// personas que figuran en Capacity; si Capacity está vacío, el equipo.
import type { DayOffRange, SprintCapacity } from "./azureDevOps";

export interface PersonOff {
  name: string;
  days: number;
}

export interface SprintAvailability {
  /** Días hábiles del sprint sin contar feriados del equipo */
  workingDays: number;
  /** Feriados del equipo que caen en días hábiles */
  teamDaysOff: number;
  /** Personas que cuentan */
  people: number;
  /** Días-persona disponibles */
  personDays: number;
  /** Personas con días libres en el sprint */
  peopleOff: PersonOff[];
  /** true si hay algo cargado en Capacity (feriados, días libres u horas) */
  hasData: boolean;
}

const DAY_MS = 86400000;
/** "YYYY-MM-DD" de cada día entre dos fechas ISO (inclusive), sin depender de la zona horaria */
function daysBetween(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const s = Date.UTC(...ymd(startIso));
  const e = Date.UTC(...ymd(endIso));
  for (let t = s; t <= e && out.length < 800; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function ymd(iso: string): [number, number, number] {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return [y, (m ?? 1) - 1, d ?? 1];
}
const isWeekday = (day: string) => {
  const wd = new Date(Date.UTC(...ymd(day))).getUTCDay();
  return wd !== 0 && wd !== 6;
};

/** Días ("YYYY-MM-DD") cubiertos por una lista de rangos */
export function expandDays(ranges: DayOffRange[]): Set<string> {
  const out = new Set<string>();
  for (const r of ranges) if (r?.start && r?.end) for (const d of daysBetween(r.start, r.end)) out.add(d);
  return out;
}

/** Feriados del equipo de un sprint, como set de días */
export function teamDaysOffSet(capacity: SprintCapacity | null | undefined): Set<string> {
  return expandDays(capacity?.teamDaysOff ?? []);
}

export function sprintAvailability(opts: {
  start: string;
  finish: string;
  capacity: SprintCapacity | null | undefined;
  teamMembers: string[];
}): SprintAvailability {
  const { capacity } = opts;
  const teamOff = teamDaysOffSet(capacity);
  const weekdays = daysBetween(opts.start, opts.finish).filter(isWeekday);
  const working = weekdays.filter((d) => !teamOff.has(d));
  const workingSet = new Set(working);

  const loaded = capacity?.members ?? [];
  const withHours = loaded.filter((m) => m.capacityPerDay > 0);
  // Personas que cuentan, con sus días libres (por nombre)
  const offByName = new Map(loaded.map((m) => [m.name.toLowerCase(), m.daysOff]));
  // Sin distinguir mayúsculas: la misma persona puede venir escrita distinto
  // en el equipo y en Capacity (gana como figura en el equipo)
  const unique = (xs: string[]) => {
    const m = new Map<string, string>();
    for (const n of xs.map((x) => x.trim()).filter(Boolean)) if (!m.has(n.toLowerCase())) m.set(n.toLowerCase(), n);
    return [...m.values()];
  };
  // Las personas cargadas en Capacity del sprint (con horas, si se cargaron);
  // sólo si Capacity está vacío, los miembros del equipo.
  const names =
    withHours.length > 0
      ? unique(withHours.map((m) => m.name))
      : loaded.length > 0
        ? unique(loaded.map((m) => m.name))
        : unique(opts.teamMembers);

  const peopleOff: PersonOff[] = [];
  let personDays = 0;
  for (const name of names) {
    const off = expandDays(offByName.get(name.toLowerCase()) ?? []);
    const days = [...off].filter((d) => workingSet.has(d)).length;
    if (days > 0) peopleOff.push({ name, days });
    personDays += working.length - days;
  }

  return {
    workingDays: working.length,
    teamDaysOff: weekdays.length - working.length,
    people: names.length,
    personDays,
    peopleOff: peopleOff.sort((a, b) => b.days - a.days),
    hasData: teamOff.size > 0 || loaded.some((m) => m.daysOff.length > 0 || m.capacityPerDay > 0),
  };
}
