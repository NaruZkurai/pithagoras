import { useEffect, useMemo, useRef, useState } from "react";
import { api, type PiConfig, type PiModel } from "../api";

const RECENTS_KEY = "pithagoras.recentModels";
const MAX_RECENTS = 4;

function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): string[] {
  const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or full storage — recents are a convenience, not a feature.
  }
  return next;
}

/** "Anthropic: Claude Sonnet 5" reads better as "Claude Sonnet 5". */
const shortName = (m: { name: string }) => m.name.split(":").pop()!.trim();

/**
 * Toolbar under the composer: the session's live model and effort level as
 * pills you can click to change, plus context usage.
 */
export function ComposerBar({
  sessionId,
  running,
}: {
  sessionId: string;
  running: boolean;
}) {
  const [cfg, setCfg] = useState<PiConfig | null>(null);
  const [open, setOpen] = useState<null | "model" | "effort">(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
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

  // Refresh once a run ends so token and cost figures stay current.
  useEffect(() => {
    if (!running) load();
  }, [running]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(null);
        setShowAll(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const models = cfg?.models.models ?? [];
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);

  // Short list: models picked here before, plus the current one.
  const quick = useMemo(() => {
    const ids = [...recents];
    if (cfg && !ids.includes(cfg.state.model.id)) ids.push(cfg.state.model.id);
    return ids.map((id) => byId.get(id) ?? (cfg && id === cfg.state.model.id ? cfg.state.model : null)).filter(Boolean) as PiModel[];
  }, [recents, cfg, byId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (q ? models.filter((m) => (m.id + m.name).toLowerCase().includes(q)) : models).slice(0, 200);
  }, [models, filter]);

  const applyModel = async (id: string) => {
    setBusy(true);
    try {
      await api.setConfig(sessionId, { modelId: id });
      setRecents(pushRecent(id));
      await load();
      setOpen(null);
      setShowAll(false);
      setFilter("");
    } finally {
      setBusy(false);
    }
  };

  const applyEffort = async (level: string) => {
    setBusy(true);
    try {
      await api.setConfig(sessionId, { thinkingLevel: level });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const levels = cfg?.thinking.levels ?? [];
  const effortIndex = Math.max(0, levels.indexOf(cfg?.state.thinkingLevel ?? ""));
  const pct = cfg?.stats.contextUsage.percent ?? 0;

  return (
    <div ref={ref} className="relative mt-1.5 flex items-center gap-1 text-xs">
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
          className={`max-w-[220px] truncate rounded px-2 py-1 disabled:opacity-50 ${
            open === "model" ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800"
          }`}
          title={cfg?.state.model.id}
        >
          {cfg ? shortName(cfg.state.model) : "…"}
        </button>
        <button
          type="button"
          disabled={!cfg || busy}
          onClick={() => setOpen(open === "effort" ? null : "effort")}
          className={`rounded px-2 py-1 capitalize disabled:opacity-50 ${
            open === "effort" ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800"
          }`}
          title="Effort / thinking level"
        >
          {cfg?.state.thinkingLevel ?? "—"}
        </button>
        <span
          className={`ml-1 h-2 w-2 rounded-full ${running ? "animate-pulse bg-amber-400" : "bg-zinc-700"}`}
          title={running ? "working" : "idle"}
        />
      </div>

      {/* Models */}
      {open === "model" && cfg && (
        <div className="absolute bottom-full right-0 mb-2 w-72 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-2xl">
          <p className="px-3 py-1 text-[11px] text-zinc-500">Models</p>
          {!showAll ? (
            <>
              {quick.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => applyModel(m.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                  title={m.id}
                >
                  <span className="truncate">{shortName(m)}</span>
                  {m.id === cfg.state.model.id && (
                    <span className="ml-auto text-zinc-400">✓</span>
                  )}
                </button>
              ))}
              <div className="my-1 border-t border-zinc-800" />
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800"
              >
                More models
                <span className="ml-auto text-zinc-500">›</span>
              </button>
            </>
          ) : (
            <>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter models…"
                className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs outline-none focus:border-cyan-600"
              />
              <div className="max-h-72 overflow-y-auto">
                {filtered.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => applyModel(m.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800"
                    title={m.id}
                  >
                    <span className="truncate">{shortName(m)}</span>
                    {m.id === cfg.state.model.id && (
                      <span className="ml-auto text-zinc-400">✓</span>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-2 text-xs text-zinc-500">No matches</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Effort */}
      {open === "effort" && cfg && levels.length > 0 && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl">
          <p className="text-sm text-zinc-400">
            Effort <span className="capitalize text-zinc-100">{cfg.state.thinkingLevel}</span>
          </p>
          <div className="mt-3 flex justify-between text-[11px] text-zinc-500">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <input
            type="range"
            min={0}
            max={levels.length - 1}
            step={1}
            value={effortIndex}
            disabled={busy}
            onChange={(e) => applyEffort(levels[Number(e.target.value)])}
            className="mt-1 w-full accent-amber-400"
          />
          <div className="mt-1 flex justify-between">
            {levels.map((lvl) => (
              <span
                key={lvl}
                title={lvl}
                className={`h-1 w-1 rounded-full ${
                  lvl === cfg.state.thinkingLevel ? "bg-amber-400" : "bg-zinc-700"
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
