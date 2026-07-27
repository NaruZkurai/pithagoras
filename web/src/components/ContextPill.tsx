import { useEffect, useRef, useState } from "react";
import { LuChevronRight, LuRefreshCw } from "react-icons/lu";
import { api, type PiConfig } from "../api";

/**
 * Context fill is the number that decides whether a long session keeps working,
 * so it gets a permanent readout rather than a tooltip: a donut that fills and
 * changes colour, opening onto everything context-related in one place.
 */

const RING = { r: 7, stroke: 3 };
const CIRC = 2 * Math.PI * RING.r;

/** Green while there's room, amber once compaction is near, red when it's close. */
function tone(pct: number) {
  if (pct >= 90) return { stroke: "#f87171", text: "text-red-400", bar: "bg-red-400" };
  if (pct >= 75) return { stroke: "#fb923c", text: "text-orange-400", bar: "bg-orange-400" };
  if (pct >= 50) return { stroke: "#fbbf24", text: "text-amber-400", bar: "bg-amber-400" };
  return { stroke: "#34d399", text: "text-emerald-400", bar: "bg-emerald-400" };
}

function Donut({ pct, color }: { pct: number; color: string }) {
  const filled = Math.max(0, Math.min(100, pct));
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" className="-rotate-90">
      <circle cx={9} cy={9} r={RING.r} fill="none" stroke="#3f3f46" strokeWidth={RING.stroke} />
      <circle
        cx={9}
        cy={9}
        r={RING.r}
        fill="none"
        stroke={color}
        strokeWidth={RING.stroke}
        strokeLinecap="round"
        strokeDasharray={`${(filled / 100) * CIRC} ${CIRC}`}
        className="transition-[stroke-dasharray] duration-500"
      />
    </svg>
  );
}

export function ContextPill({
  sessionId,
  cfg,
  onChanged,
}: {
  sessionId: string;
  cfg: PiConfig;
  /** Stats move after compaction and after toggling auto-compaction. */
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "compact" | "auto">(null);
  /** pi refuses to compact a short session, so its reason has to be visible. */
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const usage = cfg.stats.contextUsage;
  const pct = usage.percent ?? 0;
  const t = tone(pct);
  const auto = cfg.state.autoCompactionEnabled !== false;

  const compactNow = async () => {
    setBusy("compact");
    setNote(null);
    try {
      await api.compact(sessionId);
      await onChanged();
      setNote({ text: "Compacted.", error: false });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async () => {
    setBusy("auto");
    setNote(null);
    try {
      await api.setConfig(sessionId, { autoCompaction: !auto });
      await onChanged();
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  const rows: [string, string][] = [
    ["Input", cfg.stats.tokens.input.toLocaleString()],
    ["Output", cfg.stats.tokens.output.toLocaleString()],
    ["Messages", String(cfg.stats.totalMessages ?? 0)],
    ["Tool calls", String(cfg.stats.toolCalls ?? 0)],
    ["Cost", `$${cfg.stats.cost.toFixed(4)}`],
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={`Context ${pct.toFixed(1)}% full`}
        className={`flex items-center gap-1.5 rounded px-2 py-1 ${
          open ? "bg-zinc-800" : "hover:bg-zinc-800"
        }`}
      >
        <Donut pct={pct} color={t.stroke} />
        <span className={`tabular-nums ${t.text}`}>{pct.toFixed(0)}%</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-zinc-300">Context</p>
            <p className={`text-sm tabular-nums ${t.text}`}>{pct.toFixed(1)}% full</p>
          </div>

          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-all duration-500 ${t.bar}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] tabular-nums text-zinc-500">
            {usage.tokens.toLocaleString()} of {usage.contextWindow.toLocaleString()} tokens ·{" "}
            {Math.max(0, usage.contextWindow - usage.tokens).toLocaleString()} left
          </p>

          <div className="my-3 border-t border-zinc-800" />

          <button
            type="button"
            onClick={toggleAuto}
            disabled={busy !== null}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-200">Auto-compact</p>
              <p className="text-[11px] text-zinc-500">Summarise automatically before it fills</p>
            </div>
            <span
              className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                auto ? "bg-cyan-500/70" : "bg-zinc-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                  auto ? "left-[1.125rem]" : "left-0.5"
                }`}
              />
            </span>
          </button>

          <button
            type="button"
            onClick={compactNow}
            disabled={busy !== null}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-200">Compact now</p>
              <p className="text-[11px] text-zinc-500">Summarise the conversation so far</p>
            </div>
            {busy === "compact" ? (
              <LuRefreshCw className="h-4 w-4 shrink-0 animate-spin text-zinc-400" />
            ) : (
              <LuChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
            )}
          </button>

          {note && (
            <p className={`mt-2 text-[11px] ${note.error ? "text-red-400" : "text-emerald-400"}`}>
              {note.text}
            </p>
          )}

          <div className="my-3 border-t border-zinc-800" />

          <dl className="space-y-1">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between text-[11px]">
                <dt className="text-zinc-500">{label}</dt>
                <dd className="tabular-nums text-zinc-300">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
