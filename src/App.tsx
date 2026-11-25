import { useEffect, useState } from "react";
import { resolveConfig, useStore } from "./store/useStore";
import { startPolling, stopPolling, syncNow } from "./lib/poller";
import { relativeTime } from "./lib/format";
import { DEFAULT_LOOKBACK_DAYS } from "./types";
import Setup from "./views/Setup";
import TabBar from "./components/TabBar";
import Board from "./views/Board";
import Feed from "./views/Feed";
import Metrics from "./views/Metrics";
import Evolution from "./views/Evolution";

type View = "feed" | "board" | "metrics" | "evolution";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "feed", label: "Actividad", icon: "📡" },
  { id: "board", label: "Board", icon: "🗂️" },
  { id: "metrics", label: "Métricas", icon: "📊" },
  { id: "evolution", label: "Evolutivo", icon: "📈" },
];

export default function App() {
  const configLoaded = useStore((s) => s.configLoaded);
  const config = useStore((s) => s.config);
  const envPat = useStore((s) => s.envPat);
  const activeTabId = useStore((s) => s.activeTabId);
  const loadPersisted = useStore((s) => s.loadPersisted);

  const [view, setView] = useState<View>("feed");
  // Setup abierto sobre la app: "edit" = configurar la pestaña activa,
  // "add" = abrir otro proyecto en una pestaña nueva.
  const [setupMode, setSetupMode] = useState<"edit" | "add" | null>(null);

  useEffect(() => {
    loadPersisted();
  }, [loadPersisted]);

  // Arrancar / detener el poller de la pestaña activa (con PAT resuelto desde env).
  // Al cambiar de pestaña o de config se detiene el anterior y arranca el nuevo.
  // Mientras se edita la config de la pestaña activa, no se consulta.
  const editing = setupMode === "edit";
  useEffect(() => {
    const effective = resolveConfig(config, envPat);
    if (activeTabId && effective && effective.pat && !editing) {
      startPolling(activeTabId, effective);
      return () => stopPolling();
    }
  }, [activeTabId, config, envPat, editing]);

  if (!configLoaded) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">Cargando…</div>
    );
  }

  // Sin proyectos abiertos: Setup a pantalla completa para abrir el primero.
  if (!config) {
    return <Setup mode="add" onDone={() => setSetupMode(null)} />;
  }

  // Si falta el token de la org de la pestaña activa, esa pestaña muestra el
  // Setup (que explica qué variable definir), pero las pestañas siguen visibles
  // para poder pasar a otro proyecto. El PAT nunca se pide ni se guarda en disco.
  const shownSetup = setupMode ?? (!envPat ? "edit" : null);
  const canCancel = setupMode !== null && !(setupMode === "edit" && !envPat);

  return (
    <div className="h-full flex flex-col bg-slate-950">
      <TabBar
        adding={setupMode === "add"}
        onAdd={() => setSetupMode("add")}
        onSelect={() => setSetupMode(null)}
      />
      {shownSetup ? (
        <div className="flex-1 min-h-0">
          <Setup
            // key: al pasar de "editar" a "agregar" el formulario arranca de cero
            key={`${shownSetup}-${activeTabId}`}
            mode={shownSetup}
            onDone={() => setSetupMode(null)}
            onCancel={canCancel ? () => setSetupMode(null) : undefined}
          />
        </div>
      ) : (
        <>
          <TopBar view={view} onView={setView} onSettings={() => setSetupMode("edit")} />
          {/* key por pestaña: al cambiar de proyecto las vistas se montan de nuevo,
              así ningún panel abierto (comentarios, lead time) muestra datos del anterior */}
          <div className="flex-1 min-h-0" key={activeTabId ?? "none"}>
            {view === "feed" && <Feed />}
            {view === "board" && <Board />}
            {view === "metrics" && <Metrics />}
            {view === "evolution" && <Evolution />}
          </div>
          <StatusBar />
        </>
      )}
    </div>
  );
}

function TopBar({
  view,
  onView,
  onSettings,
}: {
  view: View;
  onView: (v: View) => void;
  onSettings: () => void;
}) {
  const config = useStore((s) => s.config);
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800 bg-slate-900">
      <span className="font-bold text-white mr-3 select-none">Scrum Cockpit</span>
      {NAV.map((n) => (
        <button
          key={n.id}
          onClick={() => onView(n.id)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === n.id
              ? "bg-sky-600 text-white"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          }`}
        >
          <span className="mr-1">{n.icon}</span>
          {n.label}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-3">
        <LookbackSelect />
        <span className="text-xs text-slate-500">
          {config?.org}/{config?.project}
        </span>
        <button
          onClick={onSettings}
          className="text-slate-400 hover:text-slate-200 text-sm"
          title="Configuración"
        >
          ⚙️
        </button>
      </div>
    </div>
  );
}

// Presets de la ventana de datos, en meses → días. Controla qué tan atrás se
// traen items de ADO (System.ChangedDate), así que aplica a todas las pestañas.
const LOOKBACK_PRESETS = [
  { months: 2, days: 60 },
  { months: 3, days: 90 },
  { months: 4, days: 120 },
  { months: 6, days: 180 },
  { months: 12, days: 365 },
];

/** Selector "traer sprints de los últimos N meses" en la barra superior. */
function LookbackSelect() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const status = useStore((s) => s.status);
  const current = config?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  // Si el valor guardado no coincide con un preset, lo mostramos igual (≈ meses).
  const isPreset = LOOKBACK_PRESETS.some((p) => p.days === current);

  return (
    <label className="flex items-center gap-1 text-xs text-slate-500" title="Cuántos meses de actividad traer (afecta todas las pestañas)">
      <span>Últimos</span>
      <select
        className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50"
        value={current}
        disabled={!config || status === "syncing"}
        onChange={(e) => {
          if (!config) return;
          void saveConfig({ ...config, lookbackDays: Number(e.target.value) });
        }}
      >
        {!isPreset && <option value={current}>≈{Math.round(current / 30)} meses</option>}
        {LOOKBACK_PRESETS.map((p) => (
          <option key={p.days} value={p.days}>
            {p.months} meses
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusBar() {
  const status = useStore((s) => s.status);
  const lastSync = useStore((s) => s.lastSync);
  const error = useStore((s) => s.error);
  const itemCount = useStore((s) => Object.keys(s.items).length);

  const dot =
    status === "error"
      ? "bg-red-500"
      : status === "syncing"
        ? "bg-amber-400 animate-pulse"
        : "bg-emerald-500";

  const label =
    status === "error"
      ? "Error de conexión"
      : status === "syncing"
        ? "Sincronizando…"
        : lastSync
          ? `Actualizado ${relativeTime(lastSync)}`
          : "Listo";

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-t border-slate-800 bg-slate-900 text-xs">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-600">·</span>
      <span className="text-slate-500">{itemCount} items</span>
      {error && (
        <span className="text-red-400 truncate max-w-md" title={error}>
          {error}
        </span>
      )}
      <button
        onClick={() => void syncNow()}
        className="ml-auto text-slate-400 hover:text-slate-200"
        disabled={status === "syncing"}
      >
        ↻ Actualizar ahora
      </button>
    </div>
  );
}
