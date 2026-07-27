import { useEffect, useMemo, useRef, useState } from "react";
import { api, type PiConfig } from "../api";

/**
 * Toolbar under the composer: the session's live model and thinking level as
 * pills you can click to change, plus context usage and a link into the fuller
 * config panel. Mirrors where these controls sit in most agent UIs.
 */
export function ComposerBar({
  sessionId,
  running,
  onOpenPanel,
  panelOpen,
}: {
  sessionId: string;
  running: boolean;
  onOpenPanel: () => void;
  panelOpen: boolean;
}) {
  const [cfg, setCfg] = useState<PiConfig | null>(null);
  const [open, setOpen] = useState<null | "model" | "thinking">(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    api
      .config(sessionId)
      .then(setCfg)
      .catch(() => setCfg(null));

  useEffect(() => {
    setCfg(null);
    setOpen(null);
    load();
  }, [sessionId]);

  // Refresh once a run finishes so token/cost figures stay current.
  useEffect(() => {
    if (!running) load();
  }, [running]);

  // Close a popover when clicking anywhere outside the bar.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const models = cfg?.models.models ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (
      q ? models.filter((m) => (m.id + m.name).toLowerCase().includes(q)) : models
    ).slice(0, 200);
  }, [models, filter]);

  const apply = async (patch: { modelId?: string; thinkingLevel?: string }) => {
    setBusy(true);
    try {
      await api.setConfig(sessionId, patch);
      await load();
      setOpen(null);
      setFilter("");
    } finally {
      setBusy(false);
    }
  };

  // "Anthropic: Claude Sonnet 5" reads better as just the model name.
  const modelLabel = cfg ? cfg.state.model.name.split(":").pop()!.trim() : "…";
  const pct = cfg?.stats.contextUsage.percent ?? 0;

  return (
    <div ref={ref} className="relative mt-1.5 flex items-center gap-1 text-xs">
      <button
        type="button"
        onClick={onOpenPanel}
        title="Global settings, packages, context"
        className={`rounded px-1.5 py-1 ${
          panelOpen ? "text-cyan-300" : "text-zinc-500 hover:text-zinc-200"
        }`}
      >
        ⚙
      </button>

      {cfg && pct > 0 && (
        <span
          className="text-[11px] text-zinc-600"
          title={`${cfg.stats.contextUsage.tokens.toLocaleString()} / ${cfg.stats.contextUsage.contextWindow.toLocaleString()} tokens · $${cfg.stats.cost.toFixed(4)}`}
        >
          {pct.toFixed(0)}% ctx
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          disabled={!cfg || busy}
          onClick={() => setOpen(open === "model" ? null : "model")}
          className="max-w-[220px] truncate rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          title={cfg?.state.model.id}
        >
          {modelLabel}
        </button>
        <button
          type="button"
          disabled={!cfg || busy}
          onClick={() => setOpen(open === "thinking" ? null : "thinking")}
          className="rounded px-2 py-1 capitalize text-amber-300/90 hover:bg-zinc-800 disabled:opacity-50"
          title="Thinking level"
        >
          {cfg?.state.thinkingLevel ?? "—"}
        </button>
        <span
          className={`ml-1 h-2 w-2 rounded-full ${
            running ? "animate-pulse bg-cyan-400" : "bg-zinc-700"
          }`}
          title={running ? "working" : "idle"}
        />
      </div>

      {open === "model" && cfg && (
        <div className="absolute bottom-full right-0 mb-2 w-80 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter models…"
            className="w-full border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
          />
          <div className="max-h-72 overflow-y-auto">
            {filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => apply({ modelId: m.id })}
                className={`block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-zinc-800 ${
                  m.id === cfg.state.model.id ? "text-cyan-300" : "text-zinc-300"
                }`}
                title={m.id}
              >
                {m.name}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-zinc-500">No matches</p>
            )}
          </div>
        </div>
      )}

      {open === "thinking" && cfg && (
        <div className="absolute bottom-full right-0 mb-2 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
          {cfg.thinking.levels.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => apply({ thinkingLevel: lvl })}
              className={`block w-full px-4 py-1.5 text-left text-xs capitalize hover:bg-zinc-800 ${
                lvl === cfg.state.thinkingLevel ? "text-amber-300" : "text-zinc-300"
              }`}
            >
              {lvl}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
