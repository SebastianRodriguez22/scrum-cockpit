// Trabajo no planeado: items que entraron a un sprint después de la planning.
//
// Para cada item se mira su historial (updates) y se busca la ÚLTIMA vez que su
// IterationPath pasó a ser el sprint en el que está hoy. Si eso ocurrió después
// de la fecha de corte de la planning (por defecto, el día de inicio del
// sprint; editable por sprint), el item cuenta como no planeado.
import type { WorkItemUpdate } from "./azureDevOps";
import { updateDate } from "./leadTime";

export interface SprintEntry {
  /** Cuándo entró el item al sprint (ISO) */
  date: string;
  /** Quién lo puso en el sprint (o lo creó ahí) */
  by?: string;
  /** true si entró al sprint en el momento de crearse */
  atCreation: boolean;
}

const samePath = (a: unknown, b: string) =>
  typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Última entrada del item al sprint `sprintPath`, según su historial. Si el
 * historial no registra el cambio de IterationPath (p. ej. el sprint se
 * renombró), se asume que entró al crearse.
 */
export function sprintEntry(
  updates: WorkItemUpdate[],
  sprintPath: string,
  createdDate: string,
  createdBy?: string,
): SprintEntry {
  const ordered = [...updates].sort((a, b) => a.rev - b.rev);
  let entry: SprintEntry | null = null;
  for (const u of ordered) {
    const f = u.fields?.["System.IterationPath"];
    if (!f || !samePath(f.newValue, sprintPath) || samePath(f.oldValue, sprintPath)) continue;
    const atCreation = u.rev === 1;
    const date = atCreation ? createdDate : updateDate(u);
    if (!date) continue;
    entry = { date, by: u.revisedBy?.displayName, atCreation };
  }
  return entry ?? { date: createdDate, by: createdBy, atCreation: true };
}

/** "YYYY-MM-DD" del inicio del sprint (tal cual lo define Azure DevOps) */
export function defaultCutoff(sprintStartIso: string): string {
  return sprintStartIso.slice(0, 10);
}

/**
 * Fin del día de corte, en hora local: lo que entra hasta las 23:59 de ese día
 * cuenta como planeado.
 */
export function cutoffEndMs(cutoffDay: string): number {
  const [y, m, d] = cutoffDay.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999).getTime();
}

/** ¿Entró al sprint después del corte de la planning? */
export function isUnplanned(entry: SprintEntry, cutoffDay: string): boolean {
  return new Date(entry.date).getTime() > cutoffEndMs(cutoffDay);
}
