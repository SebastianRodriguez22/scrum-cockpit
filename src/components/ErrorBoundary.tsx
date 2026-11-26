// Si una vista falla al dibujarse, React deja la pantalla en blanco. Esto
// atrapa el error y lo muestra (con su detalle) en lugar de romper toda la app.
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Nombre de lo que falló, para el mensaje */
  label?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Error en", this.props.label ?? "la vista", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="m-4 p-4 rounded-xl border border-red-500/40 bg-red-950/30 text-sm space-y-2">
        <p className="text-red-300 font-semibold">⚠️ Falló {this.props.label ?? "esta vista"}</p>
        <p className="text-red-200 font-mono break-all select-text">{error.message || String(error)}</p>
        {error.stack && (
          <pre className="text-[11px] text-slate-400 whitespace-pre-wrap max-h-48 overflow-y-auto select-text">
            {error.stack}
          </pre>
        )}
        <button
          onClick={() => this.setState({ error: null })}
          className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700"
        >
          Reintentar
        </button>
      </div>
    );
  }
}
