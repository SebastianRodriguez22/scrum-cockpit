// Fechas de inicio y fin de cada sprint, juntando las iteraciones del equipo y
// el árbol de iteraciones del proyecto (que incluye sprints viejos). La
// búsqueda no distingue mayúsculas.
import { useMemo } from "react";
import { useStore } from "../store/useStore";

export interface SprintDates {
  start?: string;
  finish?: string;
}

export function useSprintDates(): (path: string) => SprintDates | undefined {
  const iterations = useStore((s) => s.iterations);
  const iterationDates = useStore((s) => s.iterationDates);
  return useMemo(() => {
    const m = new Map<string, SprintDates>();
    const put = (path: string, start?: string, finish?: string) => {
      const k = path.toLowerCase();
      const prev = m.get(k) ?? {};
      m.set(k, { start: start ?? prev.start, finish: finish ?? prev.finish });
    };
    for (const it of iterations) put(it.path, it.attributes?.startDate, it.attributes?.finishDate);
    for (const [path, d] of Object.entries(iterationDates)) put(path, d.startDate, d.finishDate);
    return (path: string) => m.get(path.toLowerCase());
  }, [iterations, iterationDates]);
}
