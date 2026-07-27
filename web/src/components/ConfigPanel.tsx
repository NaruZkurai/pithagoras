import { useEffect, useMemo, useState } from "react";
import { api, type GlobalSettings, type PiConfig } from "../api";

/**
 * The web equivalent of pi's TUI slash commands: model, thinking level,
 * auto-compaction, context stats, and package management.
 *
 * Config is per-session and read live from the running pi process, so what you
 * see is what that session is actually using — not the env defaults.
 */
export function ConfigPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [cfg, setCfg] = useState<PiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"session" | "global" | "packages">("session");

  const load = () =>
    api
      .config(sessionId)
      .then(setCfg)
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    setCfg(null);
    setError(null);
    load();
  }, [sessionId]);

  const models = cfg?.models.models ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : models;
    return list.slice(0, 300); // the OpenRouter catalogue is enormous
  }, [models, filter]);

  const apply = async (patch: Parameters<typeof api.setConfig>[1]) => {
    setBusy(true);
    setError(null);
    try {
      await api.setConfig(sessionId, patch);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <div className="flex gap-1 text-xs">
          {(["session", "global", "packages"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-2 py-1 ${
                tab === t ? "bg-zinc-800 text-cyan-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t === "session" ? "Session" : t === "global" ? "Global" : "Packages"}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="ml-auto px-1 text-zinc-500 hover:text-zinc-200">
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        {error && <p className="rounded bg-red-950/50 px-2 py-1 text-xs text-red-300">{error}</p>}

        {tab === "session" && (
          <>
            {!cfg && !error && <p className="text-xs text-zinc-500">Starting pi to read config…</p>}
            {cfg && (
              <>
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Model
                  </h3>
                  <p className="mb-1 truncate text-xs text-zinc-400" title={cfg.state.model.id}>
                    {cfg.state.model.name}
                  </p>
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter models…"
                    className="mb-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-cyan-600"
                  />
                  <select
                    value={cfg.state.model.id}
                    disabled={busy}
                    onChange={(e) => apply({ modelId: e.target.value })}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
                  >
                    {!filtered.some((m) => m.id === cfg.state.model.id) && (
                      <option value={cfg.state.model.id}>{cfg.state.model.name} (current)</option>
                    )}
                    {filtered.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </section>

                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Thinking
                  </h3>
                  <div className="flex flex-wrap gap-1">
                    {cfg.thinking.levels.map((lvl) => (
                      <button
                        key={lvl}
                        disabled={busy}
                        onClick={() => apply({ thinkingLevel: lvl })}
                        className={`rounded px-2 py-0.5 text-xs ${
                          cfg.state.thinkingLevel === lvl
                            ? "bg-cyan-900/60 text-cyan-200"
                            : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Context
                  </h3>
                  <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-xs text-zinc-400">
                    <div className="mb-1 flex justify-between">
                      <span>used</span>
                      <span>
                        {cfg.stats.contextUsage.tokens.toLocaleString()} /{" "}
                        {cfg.stats.contextUsage.contextWindow.toLocaleString()} (
                        {cfg.stats.contextUsage.percent.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                      <div
                        className="h-full bg-cyan-500"
                        style={{ width: `${Math.min(100, cfg.stats.contextUsage.percent)}%` }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between">
                      <span>tokens in/out</span>
                      <span>
                        {cfg.stats.tokens.input.toLocaleString()} /{" "}
                        {cfg.stats.tokens.output.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>cost</span>
                      <span>${cfg.stats.cost.toFixed(4)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>tool calls</span>
                      <span>{cfg.stats.toolCalls}</span>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <input
                      type="checkbox"
                      checked={cfg.state.autoCompactionEnabled ?? true}
                      disabled={busy}
                      onChange={(e) => apply({ autoCompaction: e.target.checked })}
                    />
                    auto-compaction
                  </label>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api.compact(sessionId);
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    className="w-full rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40"
                  >
                    Compact now
                  </button>
                </section>
              </>
            )}
          </>
        )}

        {tab === "global" && <Global onError={setError} levels={cfg?.thinking.levels ?? []} />}

        {tab === "packages" && <Packages onError={setError} />}
      </div>
    </aside>
  );
}

function Packages({ onError }: { onError: (e: string) => void }) {
  const [output, setOutput] = useState("");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api
      .packages()
      .then((r) => setOutput(r.output || "(none installed)"))
      .catch((e) => onError((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const act = async (fn: () => Promise<{ output: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      setOutput(r.output);
      await refresh();
      setSpec("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Extensions, skills, prompts and themes. Installed into the portal's persistent home, so
        they survive restarts.
      </p>
      <input
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
        placeholder="npm:@foo/bar  ·  git:github.com/user/repo"
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs outline-none focus:border-cyan-600"
      />
      <div className="flex gap-1">
        <button
          disabled={busy || !spec.trim()}
          onClick={() => act(() => api.installPackage(spec.trim()))}
          className="flex-1 rounded bg-cyan-900/50 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-900 disabled:opacity-40"
        >
          Install
        </button>
        <button
          disabled={busy || !spec.trim()}
          onClick={() => act(() => api.removePackage(spec.trim()))}
          className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40"
        >
          Remove
        </button>
        <button
          disabled={busy}
          onClick={() => act(() => api.updatePackages())}
          className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40"
        >
          Update all
        </button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[11px] text-zinc-400">
        {busy ? "working…" : output}
      </pre>
    </div>
  );
}

function Global({
  onError,
  levels,
}: {
  onError: (e: string) => void;
  levels: string[];
}) {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [meta, setMeta] = useState<{ executor: string; workspaceRoot: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setSettings(r.settings);
        setMeta({ executor: r.executor, workspaceRoot: r.workspaceRoot });
      })
      .catch((e) => onError((e as Error).message));
  }, []);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      const r = await api.saveSettings(settings);
      setSettings(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <p className="text-xs text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Defaults for every <em>newly started</em> session. Sessions already running keep their own
        settings — change those on the Session tab.
      </p>

      <label className="block">
        <span className="text-xs text-zinc-400">Provider</span>
        <input
          value={settings.provider}
          onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs outline-none focus:border-cyan-600"
        />
      </label>

      <label className="block">
        <span className="text-xs text-zinc-400">Default model</span>
        <input
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          placeholder="anthropic/claude-sonnet-5"
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs outline-none focus:border-cyan-600"
        />
      </label>

      <div>
        <span className="text-xs text-zinc-400">Default thinking level</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {(levels.length ? levels : ["off", "low", "medium", "high", "max"]).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setSettings({ ...settings, thinkingLevel: lvl })}
              className={`rounded px-2 py-0.5 text-xs ${
                settings.thinkingLevel === lvl
                  ? "bg-cyan-900/60 text-cyan-200"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {lvl}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded bg-cyan-900/50 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-900 disabled:opacity-40"
      >
        {busy ? "Saving…" : saved ? "Saved ✓" : "Save global defaults"}
      </button>

      <PiSettingsEditor onError={onError} />

      {meta && (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-[11px] text-zinc-500">
          <div className="flex justify-between">
            <span>executor</span>
            <span className="font-mono text-zinc-400">{meta.executor}</span>
          </div>
          <div className="flex justify-between">
            <span>workspace root</span>
            <span className="truncate font-mono text-zinc-400">{meta.workspaceRoot}</span>
          </div>
          <p className="mt-1 text-zinc-600">Both are set at deploy time via environment.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Extensions configure themselves through pi's settings.json, and pi exposes no
 * schema for that over RPC — so rather than fake a generated form, edit the file.
 */
function PiSettingsEditor({ onError }: { onError: (e: string) => void }) {
  const [content, setContent] = useState("");
  const [file, setFile] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .piSettings()
      .then((r) => {
        setContent(r.content);
        setFile(r.path);
      })
      .catch((e) => onError((e as Error).message));
  }, [open]);

  const save = async () => {
    setBusy(true);
    try {
      await api.savePiSettings(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
      >
        pi settings.json
        <span className="ml-auto text-zinc-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-2">
          <p className="text-[11px] text-zinc-500">
            Where installed extensions keep their own configuration. Applies to newly started
            sessions.
          </p>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            spellCheck={false}
            className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-[11px] outline-none focus:border-cyan-600"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40"
            >
              {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </button>
            <span className="truncate font-mono text-[10px] text-zinc-600">{file}</span>
          </div>
        </div>
      )}
    </div>
  );
}
