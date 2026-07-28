import { useEffect, useState } from "react";
import {
  LuCheck,
  LuFolder,
  LuPlus,
  LuRadio,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type Channel, type ChannelKind } from "../api";

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
  const [home, setHome] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.channels();
      setChannels(r.channels);
      setKinds(r.kinds);
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
              <ChannelCard
                key={ch.id}
                channel={ch}
                kind={kindOf(ch.kind)}
                busy={busy === ch.id}
                onError={onError}
                onChanged={load}
                setBusy={setBusy}
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
            onCreated={async () => {
              setAdding(null);
              await load();
            }}
          />
        )}
      </section>

      <div className="flex items-start gap-2 rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/80">
        <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Credentials are stored and validated here, but no transport is running yet — channels
          will show as “not connected” until the agent side is built. Nothing will arrive or be
          sent in the meantime.
        </p>
      </div>
    </>
  );
}

function ChannelCard({
  channel: ch,
  kind,
  busy,
  onError,
  onChanged,
  setBusy,
}: {
  channel: Channel;
  kind?: ChannelKind;
  busy: boolean;
  onError: (e: string) => void;
  onChanged: () => Promise<void>;
  setBusy: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValues({ ...ch.config });
  }, [ch.id, ch.updated_at]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(ch.id);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act(async () => {
      await api.updateChannel(ch.id, { config: values });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });

  return (
    <li className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <LuRadio className={`h-4 w-4 shrink-0 ${ch.enabled ? "text-cyan-400" : "text-zinc-600"}`} />
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm text-zinc-200">{ch.name}</p>
          <p className="truncate text-[11px] text-zinc-600">
            {kind?.label ?? ch.kind} · {ch.status}
          </p>
        </button>

        <button
          onClick={() => act(() => api.updateChannel(ch.id, { enabled: !ch.enabled }))}
          disabled={busy}
          title={ch.enabled ? "Disable" : "Enable"}
          className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ${
            ch.enabled ? "bg-cyan-500/70" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
              ch.enabled ? "left-[1.125rem]" : "left-0.5"
            }`}
          />
        </button>
        <button
          onClick={() => {
            if (confirm(`Remove "${ch.name}"?`)) act(() => api.deleteChannel(ch.id));
          }}
          disabled={busy}
          className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
          title="Remove"
        >
          {busy ? (
            <LuRefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LuTrash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {open && kind && (
        <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
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
          <button onClick={save} disabled={busy} className={saved ? primaryCls : btnCls}>
            {saved ? (
              <>
                <LuCheck className="h-4 w-4" /> Saved
              </>
            ) : (
              "Save"
            )}
          </button>
        </div>
      )}
    </li>
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
  onCreated: () => Promise<void>;
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
      await api.createChannel(kind.id, name, values);
      await onCreated();
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
