// Velocidad por sprint con promedio móvil, filtrada por Compromiso (por defecto
// Mandatorio + Comprometido), y comparación del sprint actual / próximos contra
// ese promedio para la planning.
import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import type { WorkItem } from "../types";
import { DEFAULT_LOOKBACK_DAYS } from "../types";
import { useSprintDates } from "../lib/useSprintDates";
import { buildVelocity, type VelocityRow, type VelocitySprint } from "../lib/velocity";
import { useCapacity } from "../lib/useCapacity";
import { sprintAvailability, type SprintAvailability } from "../lib/capacity";

export interface VelocityInputSprint {
  path: string;
  label: string;
  items: WorkItem[];
}

type Metric = "points" | "items";

const DEFAULT_COMMITMENTS = ["mandatorio", "comprometido"];
const commitmentOf = (it: WorkItem) =>
  typeof it.commitment === "string" ? it.commitment.trim() : "";
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export default function VelocityPanel({ sprints }: { sprints: VelocityInputSprint[] }) {
  const datesOf = useSprintDates();
  const lookbackDays = useStore((s) => s.config?.lookbackDays) ?? DEFAULT_LOOKBACK_DAYS;
  const [open, setOpen] = useState(true);
  const [metric, setMetric] = useState<Metric>("points");
  const [windowSize, setWindowSize] = useState(3);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(DEFAULT_COMMITMENTS));

  // Sprints con fechas de inicio y fin
  const dated = useMemo<VelocitySprint[]>(
    () =>
      sprints.flatMap((s) => {
        const d = datesOf(s.path);
        return d?.start && d?.finish ? [{ ...s, start: d.start, finish: d.finish }] : [];
      }),
    [sprints, datesOf],
  );

  // Valores de Compromiso presentes (Mandatorio y Comprometido primero)
  const commitments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of dated) for (const it of s.items) {
      const c = commitmentOf(it);
      if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
    }
    const rank = (k: string) => {
      const i = ["mandatorio", "comprometido", "deseable"].indexOf(k);
      return i === -1 ? 99 : i;
    };
    return [...seen.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].localeCompare(b[1]));
  }, [dated]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key); // al menos uno elegido
      } else next.add(key);
      return next;
    });

  // Capacidad (pestaña Capacity de Azure DevOps): días-persona por sprint
  const datedPaths = useMemo(() => dated.map((s) => s.path), [dated]);
  const cap = useCapacity(datedPaths, open);
  const availability = useMemo(() => {
    const m = new Map<string, SprintAvailability>();
    if (!cap.ready) return m;
    for (const s of dated) {
      const a = sprintAvailability({
        start: s.start,
        finish: s.finish,
        capacity: cap.byPath.get(s.path.toLowerCase()),
        teamMembers: cap.teamMembers,
      });
      if (a.people > 0) m.set(s.path, a);
    }
    return m;
  }, [dated, cap.ready, cap.byPath, cap.teamMembers]);

  const { rows, summary } = useMemo(
    () =>
      buildVelocity(dated, {
        include: (it) => selected.has(commitmentOf(it).toLowerCase()),
        valueOf: (it) => (metric === "points" ? it.storyPoints ?? 0 : 1),
        window: windowSize,
        personDaysOf: (path) => availability.get(path)?.personDays ?? null,
      }),
    [dated, selected, metric, windowSize, availability],
  );
  const withCapacity = rows.filter((r) => availability.get(r.path)?.hasData).length;

  const unit = metric === "points" ? "pts" : "items";
  const visible = rows.filter((r) => r.scope > 0 || r.phase === "closed");
  const current = rows.find((r) => r.phase === "current");
  const nextUp = rows.find((r) => r.phase === "future" && (r.scope > 0 || r.expected != null));
  /** Contra qué se compara la carga de un sprint: lo esperable por capacidad o el promedio */
  const targetOf = (r: VelocityRow) => r.expected ?? summary.avg;
  const stability =
    summary.count < 2
      ? null
      : summary.variability < 0.15
        ? { text: "estable", tone: "text-emerald-300" }
        : summary.variability < 0.3
          ? { text: "moderada", tone: "text-sky-300" }
          : { text: "variable", tone: "text-amber-300" };
  const selectedNames = commitments.filter(([k]) => selected.has(k)).map(([, v]) => v);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left p-4 flex items-center gap-3">
        <span className="text-slate-600">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-semibold text-slate-300">🚀 Velocidad</span>
        <span className="text-xs text-slate-500">completado por sprint y promedio móvil</span>
        {summary.count > 0 && (
          <span className="ml-auto text-sm text-sky-300 font-semibold">
            prom. {fmtNum(Math.round(summary.avg * 10) / 10)} {unit}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-800 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Compromiso:</span>
            {commitments.map(([key, name]) => (
              <Toggle key={key} active={selected.has(key)} onClick={() => toggle(key)}>
                {name}
              </Toggle>
            ))}
            <span className="w-px h-5 bg-slate-700 mx-1" />
            <Toggle active={metric === "points"} onClick={() => setMetric("points")}>
              Story points
            </Toggle>
            <Toggle active={metric === "items"} onClick={() => setMetric("items")}>
              Cantidad
            </Toggle>
            <span className="w-px h-5 bg-slate-700 mx-1" />
            <span className="text-xs text-slate-500">Promediar últimos</span>
            {[3, 5].map((n) => (
              <Toggle key={n} active={windowSize === n} onClick={() => setWindowSize(n)}>
                {n}
              </Toggle>
            ))}
          </div>

          {summary.count === 0 ? (
            <p className="text-sm text-slate-500">
              No hay sprints cerrados con items {selectedNames.join(" / ")} en la ventana actual (y los filtros
              elegidos).
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label={`Promedio (últimos ${summary.count})`}
                  value={`${fmtNum(Math.round(summary.avg * 10) / 10)} ${unit}`}
                  tone="text-sky-300"
                />
                <Stat label="Rango" value={`${fmtNum(summary.min)} – ${fmtNum(summary.max)}`} tone="text-slate-200" />
                <Stat
                  label="Estabilidad"
                  value={stability ? `${stability.text} (±${Math.round(summary.variability * 100)}%)` : "—"}
                  tone={stability?.tone ?? "text-slate-500"}
                />
                {current ? (
                  <Stat
                    label={`Sprint actual: ${current.label}`}
                    value={`${fmtNum(current.scope)} ${unit} · ${pctOf(current.scope, targetOf(current), current.expected != null)}`}
                    tone={loadTone(current.scope, targetOf(current))}
                  />
                ) : (
                  <Stat label="Sprint actual" value="—" tone="text-slate-500" />
                )}
              </div>

              <CapacityBar
                loading={cap.loading}
                error={cap.error}
                rate={summary.rate}
                unit={unit}
                withCapacity={withCapacity}
                total={rows.length}
                onRefresh={cap.refresh}
              />
              {cap.ready && (
                <details className="text-[11px] text-slate-500">
                  <summary className="cursor-pointer hover:text-slate-300">
                    Detalle de lo leído de Capacity (equipo: {cap.team || "el equipo por defecto del proyecto"},{" "}
                    {cap.teamMembers.length} miembros)
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {dated.map((s) => {
                      const k = s.path.toLowerCase();
                      const c = cap.byPath.get(k);
                      const a = availability.get(s.path);
                      const withOff = c?.members.filter((m) => m.daysOff.length > 0) ?? [];
                      const withHours = c?.members.filter((m) => m.capacityPerDay > 0) ?? [];
                      return (
                        <li key={s.path}>
                          <span className="text-slate-300">{s.label}</span> ({fmtDay(s.start)}–{fmtDay(s.finish)}):{" "}
                          {cap.notInTeam.has(k)
                            ? "no está entre los sprints del equipo, no se puede leer su Capacity"
                            : !c
                              ? "sin respuesta"
                              : `${c.teamDaysOff.length} rango(s) de feriados del equipo · ${c.members.length} personas en Capacity · ${withHours.length} con horas · ${withOff.length} con días libres${
                                  withOff.length ? ` (${withOff.map((m) => m.name.split(" ")[0]).join(", ")})` : ""
                                }${a ? ` → ${a.personDays} días-persona` : ""}`}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}

              <Chart rows={visible} avg={summary.avg} unit={unit} availability={availability} />

              <div className="text-xs text-slate-400 bg-slate-800/40 rounded-lg p-3 space-y-1">
                <p>
                  💡 Para la próxima planning: comprometer alrededor de{" "}
                  <span className="text-sky-300 font-semibold">
                    {fmtNum(Math.round(nextUp?.expected ?? summary.avg))} {unit}
                  </span>{" "}
                  de {selectedNames.join(" + ")}
                  {nextUp?.expected != null ? (
                    <>
                      {" "}
                      según el ritmo habitual y la capacidad de {nextUp.label} (
                      {describeAvailability(availability.get(nextUp.path))}).
                    </>
                  ) : (
                    <>
                      {" "}
                      (entre {fmtNum(summary.min)} y {fmtNum(summary.max)} según los últimos {summary.count} sprints).
                    </>
                  )}
                </p>
                {current && <LoadLine row={current} target={targetOf(current)} unit={unit} />}
                {nextUp && nextUp.scope > 0 && <LoadLine row={nextUp} target={targetOf(nextUp)} unit={unit} />}
              </div>

              <p className="text-[11px] text-slate-500">
                Completado = Ready for test en adelante, con el estado actual de cada item (lo que no se terminó suele pasar
                al sprint siguiente). Sólo los sprints cerrados entran al promedio.
                {summary.count < windowSize &&
                  ` Hay ${summary.count} sprint(s) cerrados en la ventana de ${lookbackDays} días; para promediar más, ampliala en la configuración (⚙).`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const pctOf = (v: number, target: number, byCapacity = false) =>
  target > 0 ? `${Math.round((v / target) * 100)}% de lo esperable${byCapacity ? "" : " (prom.)"}` : "";

/** "38 días-persona · 1 feriado · días libres: Ana 5, Juan 2" */
function describeAvailability(a: SprintAvailability | undefined): string {
  if (!a) return "sin datos de capacidad";
  const parts = [`${a.personDays} días-persona (${a.people} personas × ${a.workingDays} días)`];
  if (a.teamDaysOff) parts.push(`${a.teamDaysOff} feriado${a.teamDaysOff > 1 ? "s" : ""}`);
  if (a.peopleOff.length)
    parts.push(`días libres: ${a.peopleOff.map((p) => `${p.name.split(" ")[0]} ${p.days}`).join(", ")}`);
  return parts.join(" · ");
}

function CapacityBar({
  loading,
  error,
  rate,
  unit,
  withCapacity,
  total,
  onRefresh,
}: {
  loading: boolean;
  error: string | null;
  rate: number | null;
  unit: string;
  withCapacity: number;
  total: number;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
      <span className="text-slate-500">Capacidad (Azure DevOps → Capacity):</span>
      {loading ? (
        <span>leyendo…</span>
      ) : error ? (
        <span className="text-red-400" title={error}>
          no se pudo leer ({error.slice(0, 80)})
        </span>
      ) : (
        <>
          <span>
            cargada en {withCapacity} de {total} sprints
          </span>
          {rate != null && (
            <span className="text-sky-300">
              ritmo {rate.toFixed(2)} {unit} por día-persona
            </span>
          )}
          {withCapacity === 0 && (
            <span className="text-slate-500">
              (sin feriados ni vacaciones cargados: se cuenta a todo el equipo todos los días hábiles)
            </span>
          )}
        </>
      )}
      <button onClick={onRefresh} className="text-slate-500 hover:text-slate-200" title="Volver a leer de Azure DevOps">
        ↻ actualizar
      </button>
    </div>
  );
}
const loadTone = (v: number, avg: number) =>
  avg <= 0 ? "text-slate-200" : v > avg * 1.1 ? "text-amber-300" : v < avg * 0.8 ? "text-sky-300" : "text-emerald-300";

function LoadLine({ row, target, unit }: { row: VelocityRow; target: number; unit: string }) {
  const ratio = target > 0 ? row.scope / target : 0;
  const verdict =
    ratio > 1.1
      ? "por encima de lo que el equipo suele completar"
      : ratio < 0.8
        ? "con margen"
        : "en línea con lo esperable";
  return (
    <p>
      {row.phase === "current" ? "Sprint actual" : "Próximo sprint"} ({row.label}): {fmtNum(row.scope)} {unit} cargados
      {row.phase === "current" && `, ${fmtNum(row.delivered)} completos`}
      {row.expected != null && ` (esperable con su capacidad: ${fmtNum(Math.round(row.expected))} ${unit})`} →{" "}
      <span className={loadTone(row.scope, target)}>
        {Math.round(ratio * 100)}%, {verdict}
      </span>
      .
    </p>
  );
}

// --- Gráfico ------------------------------------------------------------------

const W = 720;
const H = 230;
const PAD = { l: 36, r: 12, t: 14, b: 30 };

function Chart({
  rows,
  avg,
  unit,
  availability,
}: {
  rows: VelocityRow[];
  avg: number;
  unit: string;
  availability: Map<string, SprintAvailability>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0) return null;
  const max = Math.max(1, avg, ...rows.map((r) => Math.max(r.scope, r.delivered, r.expected ?? 0)));
  const slot = (W - PAD.l - PAD.r) / rows.length;
  const barW = Math.min(36, slot * 0.6);
  const cx = (i: number) => PAD.l + slot * (i + 0.5);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const base = y(0);
  const ticks = niceTicks(max);
  const closedIdx = rows.map((r, i) => (r.movingAvg != null ? i : -1)).filter((i) => i >= 0);
  const lastClosed = closedIdx[closedIdx.length - 1];
  const avgPts = closedIdx.map((i) => `${cx(i)},${y(rows[i].movingAvg!)}`).join(" ");
  const labelEvery = Math.ceil(rows.length / 12);
  const h = hover != null ? rows[hover] : null;

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-4 text-[11px] text-slate-400 mb-1">
        <Legend swatch={<span className="inline-block w-3 h-3 rounded-sm bg-emerald-500/80" />}>Completado</Legend>
        <Legend swatch={<span className="inline-block w-3 h-3 rounded-sm bg-slate-700" />}>Alcance del sprint</Legend>
        <Legend swatch={<span className="inline-block w-3 h-3 rounded-sm border border-dashed border-slate-400" />}>
          Actual / próximo (cargado)
        </Legend>
        <Legend swatch={<span className="inline-block w-4 h-0.5 bg-sky-400" />}>Promedio móvil</Legend>
        <Legend swatch={<span className="inline-block w-4 border-t-2 border-dashed border-sky-400" />}>Esperable</Legend>
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
        {rows.map((r, i) => {
          const x = cx(i) - barW / 2;
          const open = r.phase !== "closed";
          return (
            <g key={r.path} opacity={hover == null || hover === i ? 1 : 0.55}>
              {r.scope > 0 && (
                <rect
                  x={x}
                  y={y(r.scope)}
                  width={barW}
                  height={Math.max(0, base - y(r.scope))}
                  rx={3}
                  className={open ? "fill-transparent stroke-slate-400" : "fill-slate-700"}
                  strokeDasharray={open ? "4 3" : undefined}
                  strokeWidth={open ? 1.5 : 0}
                />
              )}
              {r.delivered > 0 && (
                <rect
                  x={x + (open ? 3 : 0)}
                  y={y(r.delivered)}
                  width={barW - (open ? 6 : 0)}
                  height={Math.max(0, base - y(r.delivered))}
                  rx={3}
                  className="fill-emerald-500/80"
                />
              )}
              {(i % labelEvery === 0 || i === rows.length - 1) && (
                <text x={cx(i)} y={H - 12} textAnchor="middle" className="fill-slate-500" fontSize={10}>
                  {r.label.length > 14 ? r.label.slice(0, 13) + "…" : r.label}
                </text>
              )}
            </g>
          );
        })}
        {closedIdx.length > 1 && (
          <polyline points={avgPts} fill="none" className="stroke-sky-400" strokeWidth={2} strokeLinejoin="round" />
        )}
        {/* Sprint actual / próximos: lo esperable (por capacidad, o el promedio) */}
        {lastClosed != null &&
          rows.map((r, i) =>
            r.phase === "closed" ? null : (
              <line
                key={`exp-${r.path}`}
                x1={cx(i) - barW / 2 - 6}
                x2={cx(i) + barW / 2 + 6}
                y1={y(r.expected ?? avg)}
                y2={y(r.expected ?? avg)}
                className="stroke-sky-400"
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            ),
          )}
        {closedIdx.map((i) => (
          <circle key={i} cx={cx(i)} cy={y(rows[i].movingAvg!)} r={3} className="fill-sky-400 stroke-slate-900" strokeWidth={2} />
        ))}
        {rows.map((r, i) => (
          <rect
            key={r.path}
            x={cx(i) - slot / 2}
            y={0}
            width={slot}
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
            left: `${(cx(hover) / W) * 100}%`,
            transform: hover > rows.length / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
          }}
        >
          <p className="text-slate-100 font-medium mb-0.5">
            {h.label} <span className="text-slate-500 font-normal">· desde {fmtDay(h.start)}</span>
          </p>
          <p className="text-slate-500 mb-0.5">
            {h.phase === "closed" ? "cerrado" : h.phase === "current" ? "en curso" : "próximo"}
          </p>
          <p>Completado: {fmtNum(h.delivered)} {unit}</p>
          <p>Alcance: {fmtNum(h.scope)} {unit}</p>
          {h.movingAvg != null && <p className="text-sky-300">Promedio móvil: {fmtNum(Math.round(h.movingAvg * 10) / 10)} {unit}</p>}
          {h.expected != null && h.phase !== "closed" && (
            <p className="text-sky-300">Esperable por capacidad: {fmtNum(Math.round(h.expected))} {unit}</p>
          )}
          {availability.get(h.path) && (
            <p className="text-slate-500 mt-0.5">Capacidad: {describeAvailability(availability.get(h.path))}</p>
          )}
          {h.rate != null && <p className="text-slate-500">Ritmo: {h.rate.toFixed(2)} {unit} por día-persona</p>}
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

function Legend({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch}
      {children}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-2.5 min-w-0">
      <p className="text-[11px] text-slate-500 truncate" title={label}>
        {label}
      </p>
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
