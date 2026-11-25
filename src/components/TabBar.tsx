// Barra de pestañas estilo navegador: una pestaña por proyecto abierto.
import { useStore } from "../store/useStore";
import type { ProjectTab } from "../types";

interface Props {
  /** Se está agregando un proyecto (muestra la pestaña "Nuevo proyecto") */
  adding: boolean;
  onAdd: () => void;
  /** Al elegir una pestaña existente (sale del modo agregar si estaba) */
  onSelect: () => void;
}

/** Título de la pestaña: el proyecto; si hay dos con el mismo nombre, se suma la org */
function tabTitle(tab: ProjectTab, all: ProjectTab[]): string {
  const name = tab.config.project;
  const repeated = all.some(
    (t) => t.id !== tab.id && t.config.project.toLowerCase() === name.toLowerCase(),
  );
  return repeated ? `${name} · ${tab.config.org}` : name;
}

export default function TabBar({ adding, onAdd, onSelect }: Props) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const status = useStore((s) => s.status);
  const switchTab = useStore((s) => s.switchTab);
  const closeTab = useStore((s) => s.closeTab);

  return (
    <div className="flex items-end gap-0.5 px-2 pt-1.5 bg-slate-950 border-b border-slate-800 overflow-x-auto select-none">
      {tabs.map((tab) => {
        const active = !adding && tab.id === activeTabId;
        const title = tabTitle(tab, tabs);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            title={`${tab.config.org} / ${tab.config.project}`}
            onClick={() => {
              onSelect();
              void switchTab(tab.id);
            }}
            onAuxClick={(e) => {
              // Clic con la rueda cierra la pestaña, como en el navegador
              if (e.button === 1) void closeTab(tab.id);
            }}
            className={`group flex items-center gap-2 min-w-0 max-w-56 pl-3 pr-1.5 py-1.5 rounded-t-lg text-sm cursor-pointer border border-b-0 transition-colors ${
              active
                ? "bg-slate-900 border-slate-800 text-white -mb-px pb-[7px]"
                : "bg-transparent border-transparent text-slate-400 hover:bg-slate-900/60 hover:text-slate-200"
            }`}
          >
            {active && (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  status === "error"
                    ? "bg-red-500"
                    : status === "syncing"
                      ? "bg-amber-400 animate-pulse"
                      : "bg-emerald-500"
                }`}
              />
            )}
            <span className="truncate">{title}</span>
            <button
              type="button"
              aria-label={`Cerrar ${title}`}
              title="Cerrar pestaña"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
              className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-slate-100 hover:bg-slate-700 ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              ×
            </button>
          </div>
        );
      })}

      {adding && (
        <div className="flex items-center gap-2 max-w-56 px-3 py-1.5 rounded-t-lg text-sm border border-b-0 bg-slate-900 border-slate-800 text-white -mb-px pb-[7px]">
          <span className="truncate">Nuevo proyecto</span>
        </div>
      )}

      <button
        type="button"
        onClick={onAdd}
        title="Abrir otro proyecto"
        aria-label="Abrir otro proyecto"
        className="ml-1 mb-1 w-7 h-7 shrink-0 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 text-lg leading-none"
      >
        +
      </button>
    </div>
  );
}
