import { useCallback, useEffect, useState } from "react";
import {
  LuArrowLeft,
  LuChevronRight,
  LuCircleAlert,
  LuFileCode2,
  LuFolderOpen,
  LuPencil,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuServer,
  LuSquare,
  LuTrash2,
} from "react-icons/lu";
import { api, type ModelFs, type ModelFsEntry, type ModelServer } from "../api";

const DEFAULT_BIN = "/nzk/bin/llama-turbo-latest/llama-server";

/** Context-size presets offered under the slider (server total tokens). */
const CTX_PRESETS = [2048, 8192, 16384, 32768, 65536, 131072];
const CTX_MIN = 2048;
const CTX_MAX = 131072;
const CTX_STEP = 1024;

/**
 * A filesystem picker for the model server form — browse folders to pick a
 * model file or a llama binary instead of typing a path by hand.
 */
function FolderPicker({
  label,
  value,
  mode,
  onPick,
}: {
  label: string;
  value: string;
  /** "model" lists .gguf files; "bin" lists llama-server binaries. */
  mode: "model" | "bin";
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fs, setFs] = useState<ModelFs | null>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = async (path?: string) => {
    setError(null);
    try {
      setFs(await api.modelFs(path));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openPicker = () => {
    setOpen((v) => !v);
    if (!open) void browse(value ? undefined : undefined);
  };

  const pick = (entry: ModelFsEntry) => {
    onPick(entry.path);
    setOpen(false);
  };

  const nav = (dir: ModelFsEntry) => void browse(dir.path);

  if (!open) {
    return (
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium text-fg-subtle">{label}</span>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={value}
            onChange={(e) => onPick(e.target.value)}
            placeholder={mode === "bin" ? "path to llama-server" : "path to model .gguf"}
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={openPicker}
            title={`Browse folders for a ${mode === "bin" ? "llama binary" : "model file"}`}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-fg-muted hover:text-fg"
          >
            <LuFolderOpen className="h-3.5 w-3.5" /> Browse
          </button>
        </div>
      </label>
    );
  }

  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-fg-subtle">{label}</span>
      <div className="rounded-lg border border-line bg-surface p-2">
        <div className="mb-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={openPicker}
            title="Close picker"
            className="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-fg/5 hover:text-fg"
          >
            ✕
          </button>
          {fs?.parent && (
            <button
              type="button"
              onClick={() => void browse(fs.parent)}
              title="Up one folder"
              className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-fg/5 hover:text-fg"
            >
              <LuArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-subtle" title={fs?.path}>
            {fs?.path}
          </span>
        </div>
        {error && <p className="mb-1 text-[11px] text-danger">{error}</p>}
        {fs && fs.dirs.length === 0 && fs.models.length === 0 && fs.bins.length === 0 && (
          <p className="py-2 text-center text-[11px] text-fg-faint">(empty folder)</p>
        )}
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          {fs?.dirs.map((d) => (
            <div
              key={d.path}
              className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-fg hover:bg-fg/5"
              onClick={() => nav(d)}
            >
              <LuFolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate">{d.name}</span>
              <LuChevronRight className="ml-auto h-3 w-3 shrink-0 text-fg-faint" />
            </div>
          ))}
          {(mode === "bin" ? fs?.bins ?? [] : fs?.models ?? []).map((f) => (
            <div
              key={f.path}
              className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-fg hover:bg-fg/5"
              onClick={() => pick(f)}
            >
              <LuFileCode2 className="h-3.5 w-3.5 shrink-0 text-ok" />
              <span className="truncate">{f.name}</span>
            </div>
          ))}
        </div>
      </div>
    </label>
  );
}

const empty = {
  name: "",
  host: "",
  bin: DEFAULT_BIN,
  model: "",
  alias: "",
  port: "41001",
  ngl: "0",
  ctx: "65536",
  threads: "12",
  parallel: "1",
  draft_model: "",
  draft_ngl: "0",
  no_kv_offload: true,
  extra_args: "",
  enabled: true,
};

/**
 * Launch / stop llama.cpp servers from the UI. Each row is one server — pick
 * the model file, the binary, the port, offload/context, and whether it should
 * come back up with the portal. Start/Stop are live.
 */
export function ModelServersPanel({ onError }: { onError: (msg: string) => void }) {
  const [servers, setServers] = useState<ModelServer[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setServers((await api.modelServers()).servers);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const set =
    (k: keyof typeof empty) =>
    (e: { target: { type?: string; value: string; checked?: boolean } }) =>
      setForm((f) => ({
        ...f,
        // Text/number inputs report checked=false (not undefined), so only read
        // `checked` for actual checkboxes — otherwise every field becomes "false".
        [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
      }));

  const save = async () => {
    if (!form.name.trim()) return onError("Give the server a name");
    if (!form.model.trim()) return onError("Pick a model file");
    setBusy("save");
    try {
      await api.saveModelServer({
        name: form.name.trim(),
        host: form.host.trim(),
        bin: form.bin.trim() || DEFAULT_BIN,
        model: form.model.trim(),
        alias: form.alias.trim(),
        port: Number(form.port) || 41001,
        ngl: Number(form.ngl) || 0,
        ctx: Number(form.ctx) || 2048,
        threads: Number(form.threads) || 12,
        parallel: Number(form.parallel) || 1,
        draft_model: form.draft_model.trim(),
        draft_ngl: Number(form.draft_ngl) || 0,
        no_kv_offload: form.no_kv_offload,
        extra_args: form.extra_args,
        enabled: form.enabled,
      });
      setForm(empty);
      setShowForm(false);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const run = async (name: string, action: "start" | "stop" | "restart") => {
    setBusy(`${name}:${action}`);
    try {
      if (action === "start") await api.startModelServer(name);
      else if (action === "stop") await api.stopModelServer(name);
      else {
        await api.stopModelServer(name);
        // Give the OS a moment to release the listen socket before relaunching.
        await new Promise((r) => setTimeout(r, 400));
        await api.startModelServer(name);
      }
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    setBusy(`del:${name}`);
    try {
      await api.deleteModelServer(name);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Load a server's settings into the form so Save updates it (upsert by name). */
  const edit = (s: ModelServer) => {
    setForm({
      name: s.name,
      host: s.host ?? "",
      bin: s.bin,
      model: s.model,
      alias: s.alias ?? "",
      port: String(s.port),
      ngl: String(s.ngl),
      ctx: String(s.ctx),
      threads: String(s.threads),
      parallel: String(s.parallel),
      draft_model: s.draft_model ?? "",
      draft_ngl: String(s.draft_ngl ?? 0),
      no_kv_offload: !!s.no_kv_offload,
      extra_args: s.extra_args ?? "",
      enabled: !!s.enabled,
    });
    setShowForm(true);
  };

  const toggleEnabled = async (s: ModelServer) => {
    try {
      await api.saveModelServer({ name: s.name, enabled: !s.enabled });
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-fg-muted">
            Launch and stop llama.cpp servers. The one on <code className="font-mono text-[11px]">:41001</code> is
            what pi talks to.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          <LuRefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs text-white"
        >
          <LuPlus className="h-3.5 w-3.5" /> Add server
        </button>
      </div>

      {showForm && (
        <div className="space-y-2 rounded-xl border border-line bg-raised/40 p-3">
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-fg-subtle">Host</span>
            <input
              type="text"
              value={form.host}
              onChange={set("host")}
              placeholder="leave blank for this machine, or e.g. 192.168.2.64 for a remote server"
              className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
            />
            {form.host.trim() && (
              <span className="mt-0.5 block text-[10px] text-accent">
                Remote — probed from the portal, never launched/stopped here.
              </span>
            )}
          </label>
          {(
            [
              ["name", "Name", "text"],
              ["alias", "Alias / model id", "text"],
              ["port", "Port", "number"],
              ["ngl", "GPU layers (-ngl)", "number"],
              ["threads", "Threads (-t)", "number"],
              ["parallel", "Parallel slots", "number"],
            ] as const
          ).map(([key, label, type]) => (
            <label key={key} className="block">
              <span className="mb-0.5 block text-[11px] font-medium text-fg-subtle">{label}</span>
              <input
                type={type}
                value={String(form[key])}
                onChange={set(key)}
                placeholder={label}
                className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
              />
            </label>
          ))}

          {/* Pick a model file by browsing a folder — no manual path typing. */}
          <FolderPicker
            label="Model file (.gguf)"
            mode="model"
            value={form.model}
            onPick={(p) => setForm((f) => ({ ...f, model: p }))}
          />
          {/* Pick the llama binary by browsing a folder. */}
          <FolderPicker
            label="Binary path (llama-server)"
            mode="bin"
            value={form.bin}
            onPick={(p) => setForm((f) => ({ ...f, bin: p }))}
          />

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-fg-subtle">Context (-c)</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={CTX_MIN}
                  step={CTX_STEP}
                  value={form.ctx}
                  onChange={(e) => setForm((f) => ({ ...f, ctx: e.target.value }))}
                  title="Type an exact context size in tokens — allocated on the next start"
                  className="w-28 rounded-lg border border-line bg-surface px-2 py-1 text-right font-mono text-[11px] text-fg outline-none focus:border-accent"
                />
                <span className="font-mono text-[10px] text-fg-faint">tokens</span>
              </div>
            </div>
            <input
              type="range"
              min={CTX_MIN}
              max={CTX_MAX}
              step={CTX_STEP}
              value={Number(form.ctx) || CTX_MIN}
              onChange={(e) => setForm((f) => ({ ...f, ctx: e.target.value }))}
              className="w-full accent-accent"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {CTX_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, ctx: String(p) }))}
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                    Number(form.ctx) === p
                      ? "border-accent text-accent"
                      : "border-line text-fg-faint hover:text-fg"
                  }`}
                >
                  {p / 1024}k
                </button>
              ))}
              {Number(form.parallel) > 1 && (
                <span className="ml-auto font-mono text-[10px] text-fg-faint">
                  ≈{Math.max(1, Math.round(Number(form.ctx) / Number(form.parallel) / 1024))}k/request
                </span>
              )}
            </div>
          </div>

          {/* Speculative decoding — a small "drafter" that guesses tokens. */}
          <div className="rounded-lg border border-line bg-surface/50 p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-fg-subtle">Drafter model (speculative)</span>
              <span className="text-[10px] text-fg-faint">optional — boosts speed</span>
            </div>
            <FolderPicker
              label="Drafter model file (.gguf)"
              mode="model"
              value={form.draft_model}
              onPick={(p) => setForm((f) => ({ ...f, draft_model: p }))}
            />
            <label className="mt-2 block">
              <span className="mb-0.5 block text-[11px] font-medium text-fg-subtle">
                Drafter GPU layers (--draft-ngl)
              </span>
              <input
                type="number"
                value={String(form.draft_ngl)}
                onChange={set("draft_ngl")}
                placeholder="0"
                className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
              />
            </label>
          </div>

          {/* Advanced / scuff-but-works flags. */}
          <label className="flex items-center gap-2 py-1 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={form.no_kv_offload}
              onChange={(e) => setForm((f) => ({ ...f, no_kv_offload: e.target.checked }))}
            />
            Keep KV cache on CPU (--no-kv-offload)
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-fg-subtle">
              Extra args (advanced)
            </span>
            <input
              type="text"
              value={form.extra_args}
              onChange={(e) => setForm((f) => ({ ...f, extra_args: e.target.value }))}
              placeholder="--reasoning off --mlock etc."
              className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="flex items-center gap-2 py-1 text-xs text-fg-muted">
            <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
            Start with the portal
          </label>
          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={busy === "save"}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => {
                setForm(empty);
                setShowForm(false);
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {servers === null && (
        <div className="flex items-center gap-2 py-8 text-sm text-fg-faint">
          <LuCircleAlert className="h-4 w-4" /> Loading model servers…
        </div>
      )}

      {servers !== null && servers.length === 0 && (
        <div className="py-8 text-center text-sm text-fg-muted">
          <LuServer className="mx-auto mb-2 h-6 w-6 text-fg-faint" />
          No model servers configured yet. Add one to launch llama.cpp from here.
        </div>
      )}

      {servers?.map((s) => {
        const up = s.status.running;
        const healthy = s.status.healthy;
        const managed = s.status.managed;
        const remote = s.status.remote || !!s.host;
        const where = remote ? s.status.host || s.host : "127.0.0.1";
        return (
          <div key={s.name} className="rounded-xl border border-line bg-raised/40 p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{s.name}</span>
                  {remote && (
                    <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent">
                      remote
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        up ? (healthy ? "bg-ok" : "bg-warn") : "bg-fg/30"
                      }`}
                      title={up ? (healthy ? "Server is up" : "Server is still starting") : "Server is down"}
                    />
                    <span
                      className={`text-[11px] font-medium ${
                        up ? (healthy ? "text-ok" : "text-warn") : "text-fg-faint"
                      }`}
                    >
                      {up ? (healthy ? (remote || !managed ? (remote ? "up · remote" : "up · external") : "up") : "starting…") : "down"}
                    </span>
                  </span>
                  {managed && s.status.pid && (
                    <span className="font-mono text-[10px] text-fg-faint">pid {s.status.pid}</span>
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle" title={s.model}>
                  {s.model}
                </p>
                <p className="mt-0.5 text-[11px] text-fg-faint">
                  {where}:{s.port}
                  {s.alias ? ` · ${s.alias}` : ""} · ngl {s.ngl} · ctx {s.ctx}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {up ? (
                  <>
                    <button
                      onClick={() => run(s.name, "stop")}
                      disabled={busy === `${s.name}:stop` || busy === `${s.name}:restart` || !managed}
                      title={managed ? "Stop server" : "Started outside the portal — stop it in its own terminal"}
                      className="flex items-center gap-1 rounded-lg border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                    >
                      <LuSquare className="h-3 w-3" /> Stop
                    </button>
                    <button
                      onClick={() => run(s.name, "restart")}
                      disabled={busy === `${s.name}:restart` || busy === `${s.name}:stop` || !managed}
                      title={managed ? "Restart server (stop, then start)" : "Started outside the portal — restart it in its own terminal"}
                      className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                    >
                      <LuRefreshCw className="h-3 w-3" /> Restart
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => run(s.name, "start")}
                    disabled={busy === `${s.name}:start` || busy === `${s.name}:restart`}
                    title="Start server"
                    className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs text-white disabled:opacity-50"
                  >
                    <LuPlay className="h-3 w-3" /> Start
                  </button>
                )}
                <label className="flex items-center gap-1.5 text-[11px] text-fg-muted" title="Start with the portal">
                  <input
                    type="checkbox"
                    checked={!!s.enabled}
                    onChange={() => toggleEnabled(s)}
                  />
                  auto
                </label>
                <button
                  onClick={() => edit(s)}
                  title="Edit server config (binary, model, port…)"
                  className="rounded-md p-1 text-fg-faint hover:text-fg"
                >
                  <LuPencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => remove(s.name)}
                  title="Delete server config"
                  className="rounded-md p-1 text-fg-faint hover:text-danger"
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
