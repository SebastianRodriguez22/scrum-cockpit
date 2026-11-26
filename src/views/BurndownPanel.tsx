// Burndown del sprint, sólo con los items de Compromiso "Mandatorio".
// Completo = Ready for test en adelante (mismos estados que el resto de la app).
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveConfig, useStore } from "../store/useStore";
import type { WorkItem } from "../types";
import type { WorkItemUpdate } from "../lib/azureDevOps";
import { fetchUpdates } from "../lib/leadTime";
import { defaultCutoff } from "../lib/unplanned";
import { buildBurndown, type BurndownDay } from "../lib/burndown";
import { isDone } from "../lib/workItemStatus";
import { ItemRow } from "./Metrics";

export interface BurndownSprint {
  path: string;
  label: string;
  items: WorkItem[];
}

type Metric = "points" | "items";

const isMandatory = (it: WorkItem) =>
  typeof it.commitment === "string" && it.commitment.trim().toLowerCase() === "mandatorio";
const fmtDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function BurndownPanel({
  sprints,
  currentPath,
}: {
  sprints: BurndownSprint[];
  currentPath?: string;
}) {
  const config = useStore((s) => s.config);
  const envPat = useStore((s) => s.envPat);
  const iterations = useStore((s) => s.iterations);
  const iterationDates = useStore((s) => s.iterationDates);
  const cutoffs = useStore((s) => s.planningCutoffs);

  const [open, setOpen] = useState(true);
  const [metric, setMetric] = useState<Metric>("points");
  const [picked, setPicked] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Map<number, WorkItemUpdate[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  // Fechas de inicio y fin de cada sprint (equipo + árbol de iteraciones)
  const datesOf = useMemo(() => {
    const m = new Map<string, { start?: string; finish?: string }>();
    const put = (path: string, start?: string, finish?: string) => {
      const k = path.toLowerCase();
      const prev = m.get(k) ?? {};
      m.set(k, { start: start ?? prev.start, finish: finish ?? prev.finish });
    };
    for (const it of iterations) put(it.path, it.attributes?.startDate, it.attributes?.finishDate);
    for (const [path, d] of Object.entries(iterationDates)) put(path, d.startDate, d.finishDate);
    return (path: string) => m.get(path.toLowerCase());
  }, [iterations, iterationDates]);

  // Sprints con fechas y al menos un item Mandatorio
  const options = useMemo(
    () =>
      sprints.filter((s) => {
        const d = datesOf(s.path);
        return d?.start && d?.finish && s.items.some(isMandatory);
      }),
    [sprints, datesOf],
  );

  const sprint =
    options.find((s) => s.path === picked) ??
    options.find((s) => s.path === currentPath) ??
    options[0];
  const mandatory = useMemo(() => sprint?.items.filter(isMandatory) ?? [], [sprint]);

  // Historial de los items Mandatorio del sprint elegido (sale del caché si ya está)
  useEffect(() => {
    if (!open || loadingRef.current) return;
    const missing = mandatory.filter((it) => !updates.has(it.id));
    if (missing.length === 0) return;
    const eff = resolveConfig(config, envPat);
    if (!eff || !eff.pat) {
      setError("No hay conexión configurada.");
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    fetchUpdates(eff, missing)
      .then((fetched) => setUpdates((prev) => new Map([...prev, ...fetched])))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [open, mandatory, updates, config, envPat]);

  const valueOf = useMemo(
    () => (it: WorkItem) => (metric === "points" ? it.storyPoints ?? 0 : 1),
    [metric],
  );
  const [hover, setHover] = useState<number | null>(null);

  const ready = mandatory.length > 0 && mandatory.every((it) => updates.has(it.id));

  const burndown = useMemo(() => {
    if (!sprint || !ready) return null;
    const d = datesOf(sprint.path)!;
    const startDay = defaultCutoff(d.start!);
    return buildBurndown({
      items: mandatory,
      updates,
      sprintPath: sprint.path,
      startDay,
      finishDay: defaultCutoff(d.finish!),
      cutoffDay: cutoffs[sprint.path] ?? startDay,
      valueOf,
    });
  }, [sprint, ready, mandatory, updates, datesOf, cutoffs, valueOf]);

  const unit = metric === "points" ? "pts" : "items";
  const lastPast = burndown ? [...burndown.days].reverse().find((d) => d.remaining != null) : undefined;
  const lastIdx = burndown && lastPast ? burndown.days.indexOf(lastPast) : -1;
  const behind = lastPast ? (lastPast.remaining ?? 0) - lastPast.ideal : 0;
  const daysLeft = burndown && lastIdx >= 0 ? burndown.days.length - 1 - lastIdx : 0;
  // Día que muestra la lista: el que está bajo el cursor o, si no, el último con datos
  const shownDay = burndown ? (hover != null ? burndown.days[hover] : lastPast) : undefined;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left p-4 flex items-center gap-3">
        <span className="text-slate-600">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-semibold text-slate-300">📉 Burndown de Mandatorios</span>
        <span className="text-xs text-slate-500">completo = Ready for test en adelante</span>
        {burndown && lastPast && (
          <span className={`ml-auto text-sm font-semibold ${behind > 0.05 ? "text-amber-300" : "text-emerald-300"}`}>
            {behind > 0.05 ? `▲ ${fmtNum(behind)} ${unit} atrasado` : "✓ en línea"}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-800 p-4 space-y-3">
          {options.length === 0 ? (
            <p className="text-sm text-slate-500">
              No hay sprints con fechas en Azure DevOps e items con Compromiso "Mandatorio" en la ventana
              actual (y los filtros elegidos).
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500"
                  value={sprint?.path}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {options.map((s) => (
                    <option key={s.path} value={s.path}>
                      {s.label}
                      {s.path === currentPath ? " (actual)" : ""}
                    </option>
                  ))}
                </select>
                <Toggle active={metric === "points"} onClick={() => setMetric("points")}>
                  Story points
                </Toggle>
                <Toggle active={metric === "items"} onClick={() => setMetric("items")}>
                  Cantidad
                </Toggle>
              </div>

              {loading && <p className="text-sm text-slate-400">Cargando historial…</p>}
              {error && <p className="text-sm text-red-400">{error}</p>}

              {burndown && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Stat label={`Mandatorio (${unit})`} value={fmtNum(lastPast?.scope ?? burndown.planned)} tone="text-slate-200" />
                    <Stat label="Completo" value={fmtNum(lastPast?.done ?? 0)} tone="text-emerald-300" />
                    <Stat label="Restante" value={fmtNum(lastPast?.remaining ?? 0)} tone="text-sky-300" />
                    <Stat label="Días hábiles restantes" value={String(daysLeft)} tone="text-slate-200" />
                  </div>
                  <div className="flex flex-col lg:flex-row gap-4">
                    <div className="flex-1 min-w-0">
                      <Chart days={burndown.days} unit={unit} hover={hover} onHover={setHover} />
                    </div>
                    {shownDay && (
                      <DayDetail day={shownDay} unit={unit} valueOf={valueOf} pinned={hover == null} />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500">
                    La línea ideal parte de lo que quedaba por hacer al cierre de la planning ({fmtNum(burndown.plannedRemaining)}
                    {" "}de {fmtNum(burndown.planned)} {unit} comprometidos, según la fecha de corte de Trabajo no planeado) y
                    baja hasta 0 el último día hábil. Se usa el Compromiso y los
                    puntos actuales de cada item; no incluye items que se sacaron del sprint.
                  </p>
                  <ItemList items={mandatory} />
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Gráfico ------------------------------------------------------------------

const W = 720;
const H = 240;
const PAD = { l: 36, r: 12, t: 12, b: 26 };

function Chart({
  days,
  unit,
  hover,
  onHover: setHover,
}: {
  days: BurndownDay[];
  unit: string;
  hover: number | null;
  onHover: (i: number | null) => void;
}) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.scope, d.ideal)));
  const step = days.length > 1 ? (W - PAD.l - PAD.r) / (days.length - 1) : 0;
  const x = (i: number) => PAD.l + i * step;
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
      .filter(Boolean)
      .join(" ");
  const ticks = niceTicks(max);
  const labelEvery = Math.ceil(days.length / 10);
  const h = hover != null ? days[hover] : null;

  return (
    <div className="relative">
      <div className="flex gap-4 text-[11px] text-slate-400 mb-1">
        <Legend color="bg-sky-400">Restante</Legend>
        <Legend color="bg-slate-500" dashed>
          Ideal
        </Legend>
        <Legend color="bg-slate-300/60">Alcance</Legend>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-slate-800" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-slate-500" fontSize={10}>
              {t}
            </text>
          </g>
        ))}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" className="fill-slate-500" fontSize={10}>
              {fmtDay(d.day)}
            </text>
          ) : null,
        )}
        <polyline points={line(days.map((d) => d.scope))} fill="none" className="stroke-slate-300/50" strokeWidth={1.5} />
        <polyline
          points={line(days.map((d) => d.ideal))}
          fill="none"
          className="stroke-slate-500"
          strokeWidth={2}
          strokeDasharray="5 4"
        />
        <polyline
          points={line(days.map((d) => d.remaining))}
          fill="none"
          className="stroke-sky-400"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {days.map((d, i) =>
          d.remaining == null ? null : (
            <circle key={d.day} cx={x(i)} cy={y(d.remaining)} r={hover === i ? 4.5 : 3} className="fill-sky-400 stroke-slate-900" strokeWidth={2} />
          ),
        )}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="stroke-slate-600" strokeWidth={1} />
        )}
        {days.map((d, i) => (
          <rect
            key={d.day}
            x={x(i) - Math.max(step, 12) / 2}
            y={0}
            width={Math.max(step, 12)}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {h && hover != null && (
        <div
          className="absolute top-6 pointer-events-none bg-slate-950/95 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 whitespace-nowrap"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: hover > days.length / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <p className="text-slate-100 font-medium mb-0.5">{fmtDay(h.day)}</p>
          {h.remaining != null ? (
            <>
              <p>Restante: {fmtNum(h.remaining)} {unit}</p>
              <p>Completo: {fmtNum(h.done)} {unit}</p>
            </>
          ) : (
            <p className="text-slate-500">día futuro</p>
          )}
          <p>Ideal: {fmtNum(h.ideal)} {unit}</p>
          <p>Alcance: {fmtNum(h.scope)} {unit}</p>
        </div>
      )}
    </div>
  );
}

function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function Legend({ color, dashed, children }: { color: string; dashed?: boolean; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-4 h-0.5 ${dashed ? "border-t-2 border-dashed border-slate-500" : color}`} />
      {children}
    </span>
  );
}

// --- Detalle del día bajo el cursor -------------------------------------------

function DayDetail({
  day,
  unit,
  valueOf,
  pinned,
}: {
  day: BurndownDay;
  unit: string;
  valueOf: (it: WorkItem) => number;
  pinned: boolean;
}) {
  const future = day.remaining == null;
  const pending = [...day.pending].sort((a, b) => valueOf(b.item) - valueOf(a.item) || a.item.id - b.item.id);
  return (
    <div className="lg:w-80 shrink-0 bg-slate-800/40 rounded-lg p-3 flex flex-col max-h-80">
      <p className="text-xs text-slate-400 mb-2">
        <span className="text-slate-200 font-medium">Restantes al {fmtDay(day.day)}</span>
        {!future && (
          <span>
            {" "}· {pending.length} items · {fmtNum(day.remaining ?? 0)} {unit}
          </span>
        )}
        {pinned && <span className="text-slate-600"> (pasá el cursor por el gráfico)</span>}
      </p>
      {future ? (
        <p className="text-xs text-slate-500">Día futuro.</p>
      ) : (
        <div className="overflow-y-auto space-y-1 min-h-0">
          {pending.length === 0 && <p className="text-xs text-emerald-300">✓ Nada pendiente</p>}
          {pending.map(({ item, state }) => (
            <div key={item.id} className="text-xs flex items-baseline gap-1.5">
              <span className="text-slate-500 tabular-nums shrink-0">{item.id}</span>
              <span className="text-slate-300 truncate flex-1" title={item.title}>
                {item.title}
              </span>
              <span className="text-slate-500 shrink-0" title="Estado ese día">
                {state ?? "—"}
              </span>
              <span className="text-slate-400 tabular-nums shrink-0 w-10 text-right">
                {fmtNum(valueOf(item))} {unit === "pts" ? "pts" : ""}
              </span>
            </div>
          ))}
          {day.completed.length > 0 && (
            <div className="pt-2 mt-1 border-t border-slate-700/60 space-y-1">
              <p className="text-[11px] text-emerald-400">Completados ese día</p>
              {day.completed.map((item) => (
                <div key={item.id} className="text-xs flex items-baseline gap-1.5">
                  <span className="text-slate-500 tabular-nums shrink-0">{item.id}</span>
                  <span className="text-slate-400 truncate flex-1" title={item.title}>
                    {item.title}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Lista de items -----------------------------------------------------------

function ItemList({ items }: { items: WorkItem[] }) {
  const [show, setShow] = useState(false);
  const pending = items.filter((it) => !isDone(it));
  const done = items.filter(isDone);
  return (
    <div>
      <button onClick={() => setShow((s) => !s)} className="text-xs text-slate-400 hover:text-slate-200">
        {show ? "▾" : "▸"} Items Mandatorio: {pending.length} pendientes, {done.length} completos
      </button>
      {show && (
        <div className="mt-2 space-y-1 max-h-72 overflow-y-auto">
          {[...pending, ...done].map((it) => (
            <div key={it.id} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <ItemRow item={it} />
              </div>
              <span className={`text-xs w-32 text-right shrink-0 truncate ${isDone(it) ? "text-emerald-400" : "text-slate-400"}`}>
                {it.state}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${tone}`}>{value}</p>
    </div>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
        active ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}
