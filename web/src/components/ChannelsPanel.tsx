import { useEffect, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuDownload,
  LuFolder,
  LuPackage,
  LuPlus,
  LuRadio,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type BrokenChannelPackage, type Channel, type ChannelKind } from "../api";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-cyan-500/60";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/10 disabled:opacity-40";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 transition hover:bg-cyan-500/25 disabled:opacity-40";

/**
 * Channels are two-way links into the agent — one long-lived session rooted at
 * agentHome. Every channel talks to that same conversation, so this reads as
 * "ways to reach the agent" rather than a list of separate bots.
 */
export function ChannelsPanel({ onError }: { onError: (e: string) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [kinds, setKinds] = useState<ChannelKind[]>([]);
  const [broken, setBroken] = useState<BrokenChannelPackage[]>([]);
  const [home, setHome] = useState("");
  const [spec, setSpec] = useState("");
  const [installing, setInstalling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.channels();
      setChannels(r.channels);
      setKinds(r.kinds);
      setBroken(r.broken ?? []);
      setHome(r.agentHome);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const kindOf = (id: string) => kinds.find((k) => k.id === id);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      await api.installChannelPackage(spec.trim());
      setSpec("");
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const open = channels.find((c) => c.id === openId);
  if (openId && open) {
    return (
      <ChannelDetail
        channel={open}
        kind={kindOf(open.kind)}
        onBack={() => setOpenId(null)}
        onError={onError}
        onChanged={load}
      />
    );
  }

  return (
    <>
      <section className="mb-6 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="flex items-center gap-2">
          <LuFolder className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          <p className="text-xs text-zinc-500">Agent home</p>
          <p className="ml-auto truncate pl-3 font-mono text-xs text-zinc-300">{home || "…"}</p>
        </div>
        <p className="mt-1.5 text-xs text-zinc-600">
          Every channel below is a door into one long-lived session running here. They share the
          agent's memory rather than each starting a conversation of their own.
        </p>
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Channels{channels.length ? ` (${channels.length})` : ""}
          </h3>
          <button onClick={load} className="text-[11px] text-zinc-500 hover:text-zinc-300">
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : channels.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500">
            No channels yet.
            <p className="mt-1 text-xs text-zinc-600">
              Add one below to reach the agent from outside the portal.
            </p>
          </div>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {channels.map((ch) => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                kind={kindOf(ch.kind)}
                onOpen={() => setOpenId(ch.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Add channel</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k.id}
              onClick={() => setAdding(adding === k.id ? null : k.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
                adding === k.id
                  ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-inset ring-cyan-400/30"
                  : "bg-white/5 text-zinc-300 hover:bg-white/10"
              }`}
            >
              <LuPlus className="h-3.5 w-3.5" />
              {k.label}
            </button>
          ))}
        </div>

        {adding && kindOf(adding) && (
          <NewChannelForm
            kind={kindOf(adding)!}
            onCancel={() => setAdding(null)}
            onError={onError}
            onCreated={async (created) => {
              setAdding(null);
              await load();
              setOpenId(created.id);
            }}
          />
        )}
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Packages</h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          Channel types come from packages. Point at a GitHub repo following the convention and it
          becomes available above.
        </p>

        <div className="mt-2 flex gap-2">
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && spec.trim() && install()}
            placeholder="user/repo"
            className={`${inputCls} font-mono text-xs`}
          />
          <button
            disabled={!spec.trim() || installing}
            onClick={install}
            className={primaryCls}
          >
            {installing ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <LuDownload className="h-4 w-4" />
            )}
            {installing ? "Installing…" : "Install"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-600">
          Anything npm understands: <code>user/repo</code>, <code>github:user/repo#v2</code>, a git
          URL, or an npm package name.
        </p>

        <ul className="mt-3 space-y-1">
          {kinds.map((k) => (
            <li
              key={k.packageName}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
            >
              <LuPackage className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-zinc-300">
                  {k.label}{" "}
                  <span className="font-mono text-[10px] text-zinc-600">{k.packageName}</span>
                </p>
                {!k.runnable && (
                  <p className="text-[10px] text-amber-400/80">no start() — cannot run</p>
                )}
              </div>
              {k.version && (
                <span className="shrink-0 font-mono text-[10px] text-zinc-600">v{k.version}</span>
              )}
              {k.builtin ? (
                <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">
                  builtin
                </span>
              ) : (
                <button
                  onClick={() => {
                    if (confirm(`Uninstall ${k.packageName}? Configured channels are kept.`)) {
                      act(() => api.removeChannelPackage(k.packageName));
                    }
                  }}
                  className="shrink-0 rounded p-1 text-zinc-500 hover:text-red-400"
                  title="Uninstall"
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {broken.length > 0 && (
          <ul className="mt-2 space-y-1">
            {broken.map((b) => (
              <li
                key={b.packageName}
                className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300"
              >
                <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px]">{b.packageName}</p>
                  <p className="text-[11px] text-red-300/80">{b.error}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-start gap-2 rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/80">
        <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Credentials are stored and validated here, but no transport is running yet — channels
          will show as “not connected” until the agent session exists. Packages define start(), and
          nothing calls it in the meantime.
        </p>
      </div>
    </>
  );
}

/** A row in the list. Clicking it opens the channel's own page. */
function ChannelRow({
  channel: ch,
  kind,
  onOpen,
}: {
  channel: Channel;
  kind?: ChannelKind;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-left transition hover:bg-white/5"
      >
        <LuRadio className={`h-4 w-4 shrink-0 ${ch.enabled ? "text-cyan-400" : "text-zinc-600"}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-200">{ch.name}</p>
          <p className="truncate text-[11px] text-zinc-600">
            {kind?.label ?? ch.kind} · {ch.status}
            {ch.instructions ? " · has instructions" : ""}
          </p>
        </div>
        {!ch.enabled && (
          <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">
            disabled
          </span>
        )}
        <LuChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
      </button>
    </li>
  );
}

/**
 * One channel's own page inside the modal. The list only has room for a name
 * and a toggle; everything that needs explaining — credentials, and the
 * instructions appended for messages arriving here — lives here instead.
 */
function ChannelDetail({
  channel: ch,
  kind,
  onBack,
  onError,
  onChanged,
}: {
  channel: Channel;
  kind?: ChannelKind;
  onBack: () => void;
  onError: (e: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(ch.name);
  const [values, setValues] = useState<Record<string, string>>({ ...ch.config });
  const [instructions, setInstructions] = useState(ch.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(ch.name);
    setValues({ ...ch.config });
    setInstructions(ch.instructions ?? "");
  }, [ch.id, ch.updated_at]);

  const dirty =
    name !== ch.name ||
    instructions !== (ch.instructions ?? "") ||
    kind?.fields.some((f) => (values[f.key] ?? "") !== (ch.config[f.key] ?? ""));

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      await api.updateChannel(ch.id, { name, config: values, instructions });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });

  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
      >
        <LuChevronLeft className="h-3.5 w-3.5" /> Channels
      </button>

      <div className="mb-5 flex items-start gap-3">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            ch.enabled ? "bg-cyan-500/10 text-cyan-300" : "bg-white/5 text-zinc-500"
          }`}
        >
          <LuRadio className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-transparent text-sm font-medium text-zinc-100 outline-none"
          />
          <p className="truncate text-xs text-zinc-500">
            {kind?.label ?? ch.kind} · {ch.status}
          </p>
        </div>
        <button
          onClick={() => act(() => api.updateChannel(ch.id, { enabled: !ch.enabled }))}
          disabled={busy}
          title={ch.enabled ? "Disable" : "Enable"}
          className={`relative mt-1 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ${
            ch.enabled ? "bg-cyan-500/70" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
              ch.enabled ? "left-[1.125rem]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Instructions
        </h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          Appended to the agent's system prompt for every message that arrives through this
          channel. Use it for standing guidance that only applies here — the shape of the reply,
          who is on the other end, what to leave out.
        </p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={6}
          placeholder={"You are answering over " + (kind?.label ?? "this channel") + ". Keep replies short — they are read on a phone. Never paste secrets or full file contents."}
          className={`${inputCls} mt-2 resize-y text-xs leading-relaxed`}
        />
        <p className="mt-1 text-[11px] text-zinc-600">
          Leave empty for none. The agent's own memory is shared across channels; this is not.
        </p>
      </section>

      {kind && kind.fields.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Connection
          </h3>
          <div className="mt-2 space-y-3">
            {kind.fields.map((f) => (
              <div key={f.key}>
                <div className="flex items-baseline gap-2">
                  <label className="font-mono text-xs text-zinc-300">{f.label}</label>
                  {f.secret &&
                    (ch.secretsSet.includes(f.key) ? (
                      <span className="text-[10px] text-emerald-500/80">stored</span>
                    ) : (
                      <span className="text-[10px] text-zinc-600">not set</span>
                    ))}
                </div>
                <input
                  type={f.secret ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  placeholder={
                    f.secret && ch.secretsSet.includes(f.key)
                      ? "leave blank to keep the stored value"
                      : f.placeholder
                  }
                  className={`${inputCls} mt-1 font-mono text-xs`}
                />
                {f.hint && <p className="mt-1 text-[11px] text-zinc-600">{f.hint}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {!kind && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            No installed package provides “{ch.kind}”. Reinstall it to edit this channel, or delete
            the channel below.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={busy || !dirty} className={primaryCls}>
          {busy ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <>
              <LuCheck className="h-4 w-4" /> Saved
            </>
          ) : (
            "Save"
          )}
        </button>
        <button
          onClick={() => {
            if (confirm(`Remove "${ch.name}"?`)) {
              act(async () => {
                await api.deleteChannel(ch.id);
                onBack();
              });
            }
          }}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
        >
          <LuTrash2 className="h-3.5 w-3.5" /> Remove channel
        </button>
      </div>
    </>
  );
}

function NewChannelForm({
  kind,
  onCancel,
  onCreated,
  onError,
}: {
  kind: ChannelKind;
  onCancel: () => void;
  onCreated: (created: Channel) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState(kind.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(kind.label);
    setValues({});
  }, [kind.id]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createChannel(kind.id, name, values);
      await onCreated(created);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <p className="text-xs text-zinc-500">{kind.blurb}</p>

      <div>
        <label className="text-xs text-zinc-400">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${inputCls} mt-1`}
        />
      </div>

      {kind.fields.map((f) => (
        <div key={f.key}>
          <div className="flex items-baseline gap-2">
            <label className="font-mono text-xs text-zinc-300">{f.label}</label>
            {f.required && <span className="text-[10px] text-zinc-600">required</span>}
          </div>
          <input
            type={f.secret ? "password" : "text"}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            placeholder={f.placeholder}
            className={`${inputCls} mt-1 font-mono text-xs`}
          />
          {f.hint && <p className="mt-1 text-[11px] text-zinc-600">{f.hint}</p>}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button onClick={create} disabled={busy} className={primaryCls}>
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : "Add channel"}
        </button>
        <button onClick={onCancel} className={btnCls}>
          Cancel
        </button>
      </div>
    </div>
  );
}
