import { useEffect, useState } from "react";
import { api, type GlobalSettings, type PiConfig } from "../api";
import { Modal } from "./Modal";

type Tab = "session" | "global" | "extensions";

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "global", label: "Global" },
  { id: "extensions", label: "Extensions" },
];

export function ConfigModal({
  sessionId,
  onClose,
  initialTab = "global",
}: {
  /** Absent when settings are opened without a session — the Session tab needs one. */
  sessionId?: string;
  onClose: () => void;
  initialTab?: Tab;
}) {
  const tabs = sessionId ? ALL_TABS : ALL_TABS.filter((t) => t.id !== "session");
  const [tab, setTab] = useState<Tab>(
    initialTab === "session" && !sessionId ? "global" : initialTab
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      onClose={onClose}
      title={
        <div className="flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                tab === t.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400/70 hover:text-red-300">
            ✕
          </button>
        </div>
      )}
      {tab === "session" && sessionId && <SessionTab sessionId={sessionId} onError={setError} />}
      {tab === "global" && <GlobalTab onError={setError} />}
      {tab === "extensions" && <ExtensionsTab onError={setError} />}
    </Modal>
  );
}

// --- shared bits ---

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-600";
const btnCls =
  "rounded-lg bg-zinc-800 px-3 py-2 text-sm transition hover:bg-zinc-700 disabled:opacity-40";
const primaryCls =
  "rounded-lg bg-cyan-900/60 px-3 py-2 text-sm text-cyan-100 transition hover:bg-cyan-900 disabled:opacity-40";

// --- session ---

function SessionTab({ sessionId, onError }: { sessionId: string; onError: (e: string) => void }) {
  const [cfg, setCfg] = useState<PiConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.config(sessionId).then(setCfg).catch((e) => onError((e as Error).message));
  useEffect(() => {
    load();
  }, [sessionId]);

  if (!cfg) return <p className="text-sm text-zinc-500">Starting pi to read this session's config…</p>;

  const usage = cfg.stats.contextUsage;

  return (
    <>
      <Section title="Model">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
          <p className="text-sm text-zinc-200">{cfg.state.model.name}</p>
          <p className="mt-0.5 font-mono text-xs text-zinc-500">{cfg.state.model.id}</p>
          <p className="mt-2 text-xs text-zinc-500">
            Change it from the pill under the chat box — this list is long and lives better there.
          </p>
        </div>
      </Section>

      <Section title="Context">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="flex justify-between text-xs text-zinc-400">
            <span>{usage.percent.toFixed(1)}% used</span>
            <span>
              {usage.tokens.toLocaleString()} / {usage.contextWindow.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all"
              style={{ width: `${Math.min(100, usage.percent)}%` }}
            />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              ["tokens in", cfg.stats.tokens.input.toLocaleString()],
              ["tokens out", cfg.stats.tokens.output.toLocaleString()],
              ["cost", `$${cfg.stats.cost.toFixed(4)}`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-zinc-900 py-2">
                <dt className="text-[11px] text-zinc-500">{k}</dt>
                <dd className="text-sm text-zinc-200">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={cfg.state.autoCompactionEnabled ?? true}
                disabled={busy}
                onChange={async (e) => {
                  setBusy(true);
                  try {
                    await api.setConfig(sessionId, { autoCompaction: e.target.checked });
                    await load();
                  } catch (err) {
                    onError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="accent-cyan-500"
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
                } catch (err) {
                  onError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              className={`${btnCls} ml-auto`}
            >
              Compact now
            </button>
          </div>
        </div>
      </Section>
    </>
  );
}

// --- global ---

function GlobalTab({ onError }: { onError: (e: string) => void }) {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [meta, setMeta] = useState<{ executor: string; workspaceRoot: string } | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [piJson, setPiJson] = useState<{ path: string; content: string } | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setSettings(r.settings);
        setMeta({ executor: r.executor, workspaceRoot: r.workspaceRoot });
      })
      .catch((e) => onError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!showJson || piJson) return;
    api.piSettings().then(setPiJson).catch((e) => onError((e as Error).message));
  }, [showJson]);

  if (!settings) return <p className="text-sm text-zinc-500">Loading…</p>;

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveSettings(settings);
      setSettings(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Defaults for new sessions"
        hint="Sessions already running keep their own settings."
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-zinc-400">Provider</span>
            <input
              value={settings.provider}
              onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
              className={`${inputCls} mt-1 font-mono`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Model</span>
            <input
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder="anthropic/claude-sonnet-5"
              className={`${inputCls} mt-1 font-mono`}
            />
          </label>
          <div>
            <span className="text-xs text-zinc-400">Effort</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {(levels.length ? levels : ["off", "minimal", "low", "medium", "high", "xhigh", "max"]).map(
                (lvl) => (
                  <button
                    key={lvl}
                    onClick={() => setSettings({ ...settings, thinkingLevel: lvl })}
                    className={`rounded-lg px-2.5 py-1 text-xs capitalize transition ${
                      settings.thinkingLevel === lvl
                        ? "bg-amber-900/50 text-amber-200"
                        : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                    }`}
                  >
                    {lvl}
                  </button>
                )
              )}
            </div>
          </div>
          <button onClick={save} disabled={busy} className={`${primaryCls} w-full`}>
            {busy ? "Saving…" : saved ? "Saved ✓" : "Save defaults"}
          </button>
        </div>
      </Section>

      <Section title="Deployment">
        <dl className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-sm">
          <div className="flex justify-between py-0.5">
            <dt className="text-zinc-500">executor</dt>
            <dd className="font-mono text-zinc-300">{meta?.executor}</dd>
          </div>
          <div className="flex justify-between py-0.5">
            <dt className="text-zinc-500">workspace root</dt>
            <dd className="truncate pl-4 font-mono text-zinc-300">{meta?.workspaceRoot}</dd>
          </div>
          <p className="mt-1 text-xs text-zinc-600">Both are set at deploy time via environment.</p>
        </dl>
      </Section>

      <Section title="Advanced" hint="pi's settings file, where installed extensions keep their own config.">
        <button onClick={() => setShowJson((v) => !v)} className={btnCls}>
          {showJson ? "Hide settings.json" : "Edit settings.json"}
        </button>
        {showJson && piJson && (
          <div className="mt-2 space-y-2">
            <textarea
              value={piJson.content}
              onChange={(e) => setPiJson({ ...piJson, content: e.target.value })}
              rows={10}
              spellCheck={false}
              className={`${inputCls} resize-y font-mono text-xs`}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  try {
                    await api.savePiSettings(piJson.content);
                    setSaved(true);
                    setTimeout(() => setSaved(false), 2000);
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
                className={btnCls}
              >
                Save file
              </button>
              <span className="truncate font-mono text-[11px] text-zinc-600">{piJson.path}</span>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

// --- extensions ---

const SOURCES = [
  { label: "npm", placeholder: "npm:@scope/package", hint: "published on npm" },
  { label: "git", placeholder: "git:github.com/user/repo@v1", hint: "a git repository" },
  { label: "url", placeholder: "https://github.com/user/repo", hint: "a URL" },
  { label: "path", placeholder: "/absolute/path/to/package", hint: "a local directory" },
];

interface InstalledPackage {
  spec: string;
  path?: string;
  scope?: string;
}

/**
 * Parse `pi list`, which nests by indentation:
 *
 *   User packages:
 *     npm:pi-llama-cpp
 *       /data/home/.pi/agent/npm/node_modules/pi-llama-cpp
 *
 * The deeper line is where that package is installed, not another package —
 * treating every path-looking line as an entry listed each one twice.
 */
function parsePackages(output: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  let scope: string | undefined;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (indent === 0) {
      scope = text.replace(/packages:?$/i, "").trim() || undefined;
      continue;
    }
    if (indent <= 2) {
      packages.push({ spec: text, scope });
      continue;
    }
    // Deeper than the spec: the install location for the entry above it.
    const last = packages[packages.length - 1];
    if (last && !last.path) last.path = text;
  }
  return packages;
}

function ExtensionsTab({ onError }: { onError: (e: string) => void }) {
  const [output, setOutput] = useState("");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    api
      .packages()
      .then((r) => setOutput(r.output))
      .catch((e) => onError((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const act = async (label: string, fn: () => Promise<{ output: string }>) => {
    setBusy(label);
    try {
      await fn();
      await refresh();
      setSpec("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const installed = parsePackages(output);

  return (
    <>
      <Section
        title="Install"
        hint="Extensions, skills, prompt templates and themes. They persist across restarts."
      >
        <div className="flex gap-2">
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && spec.trim() && act("install", () => api.installPackage(spec.trim()))}
            placeholder="npm:@scope/package"
            className={`${inputCls} font-mono text-xs`}
          />
          <button
            disabled={!spec.trim() || busy !== null}
            onClick={() => act("install", () => api.installPackage(spec.trim()))}
            className={primaryCls}
          >
            {busy === "install" ? "Installing…" : "Install"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {SOURCES.map((s) => (
            <button
              key={s.label}
              onClick={() => setSpec(s.placeholder)}
              title={`Install from ${s.hint}`}
              className="rounded-lg bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-200"
            >
              {s.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`Installed${installed.length ? ` (${installed.length})` : ""}`}>
        {installed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500">
            Nothing installed yet.
            <p className="mt-1 text-xs text-zinc-600">
              Installed commands show up in the chat box when you type “/”.
            </p>
          </div>
        ) : (
          <ul className="space-y-1">
            {installed.map((pkg) => (
              <li
                key={pkg.spec}
                className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-zinc-200">{pkg.spec}</p>
                  {pkg.path && (
                    <p className="truncate font-mono text-[10px] text-zinc-600" title={pkg.path}>
                      {pkg.path}
                    </p>
                  )}
                </div>
                {pkg.scope && (
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                    {pkg.scope}
                  </span>
                )}
                <button
                  disabled={busy !== null}
                  onClick={() => act(pkg.spec, () => api.removePackage(pkg.spec))}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
                >
                  {busy === pkg.spec ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={busy !== null}
            onClick={() => act("update", () => api.updatePackages())}
            className={btnCls}
          >
            {busy === "update" ? "Updating…" : "Update all"}
          </button>
          <button onClick={refresh} className={btnCls}>
            Refresh
          </button>
        </div>
      </Section>

      {output && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
            Raw output
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-[11px] text-zinc-400">
            {output}
          </pre>
        </details>
      )}
    </>
  );
}
