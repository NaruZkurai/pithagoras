import { useEffect, useMemo, useState } from "react";
import { LuBot, LuFolder, LuMessageSquare, LuRadio } from "react-icons/lu";
import { api, type AgentSession, type SessionStatus } from "../api";

const STATUS_STYLE: Record<SessionStatus, string> = {
  running: "bg-cyan-400 animate-pulse",
  idle: "bg-zinc-600",
  error: "bg-red-500",
  interrupted: "bg-amber-500",
};

const when = (iso: string) => {
  const then = new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (!Number.isFinite(mins)) return iso;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

/**
 * The agent's conversations, one per chat rather than one overall.
 *
 * A channel package supplies a key for each conversation it sees — a Telegram
 * chat id, a Slack channel — and the portal turns each into its own session.
 * That is what stops a group chat and a DM sharing a memory. They are ordinary
 * sessions, so they open in the ordinary chat view.
 */
export function AgentPage({ onSelect }: { onSelect: (id: string) => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [home, setHome] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () =>
    api
      .agentSessions()
      .then((r) => {
        setSessions(r.sessions);
        setHome(r.agentHome);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Grouped by the door each conversation came through.
  const groups = useMemo(() => {
    const out = new Map<string, { name: string; kind: string | null; items: AgentSession[] }>();
    for (const s of sessions) {
      const id = s.channel?.id ?? "none";
      if (!out.has(id)) {
        out.set(id, {
          name: s.channel?.name ?? "No channel",
          kind: s.channel?.kind ?? null,
          items: [],
        });
      }
      out.get(id)!.items.push(s);
    }
    return [...out.entries()];
  }, [sessions]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-500/10 via-transparent to-transparent px-5 py-5">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-500/15 text-cyan-300">
                <LuBot className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-zinc-100">Agent</h2>
                <p className="mt-0.5 max-w-xl text-sm text-zinc-400">
                  Conversations that reached the agent through a channel. Each chat gets its own
                  session, so a group and a DM never share a memory.
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <div className="flex items-baseline gap-1.5 rounded-lg bg-black/30 px-2.5 py-1">
                <span className="text-sm tabular-nums text-zinc-200">{sessions.length}</span>
                <span className="text-[11px] text-zinc-500">conversations</span>
              </div>
              <div className="flex items-baseline gap-1.5 rounded-lg bg-black/30 px-2.5 py-1">
                <span className="text-sm tabular-nums text-cyan-300">
                  {sessions.filter((s) => s.status === "running").length}
                </span>
                <span className="text-[11px] text-zinc-500">running</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-black/30 px-2.5 py-1">
                <LuFolder className="h-3 w-3 shrink-0 text-zinc-600" />
                <span className="truncate font-mono text-[11px] text-zinc-500">{home}</span>
              </div>
            </div>
          </header>

          {loading ? (
            <p className="py-12 text-center text-sm text-zinc-500">Loading…</p>
          ) : sessions.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-zinc-800 px-4 py-10 text-center">
              <p className="text-sm text-zinc-400">Nothing has reached the agent yet.</p>
              <p className="mx-auto mt-2 max-w-md text-xs text-zinc-600">
                Conversations appear here once a channel is running and someone messages it. No
                transport is started yet, so nothing can arrive — configure a channel in Settings
                and it will be waiting when the runtime lands.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              {groups.map(([id, group]) => (
                <section key={id}>
                  <div className="flex items-center gap-2 px-1">
                    <LuRadio className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                    <h3 className="truncate text-xs font-medium text-zinc-400">{group.name}</h3>
                    {group.kind && (
                      <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">
                        {group.kind}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-zinc-600">
                      {group.items.length}
                    </span>
                  </div>

                  <ul className="mt-1.5 space-y-1">
                    {group.items.map((s) => (
                      <li key={s.id}>
                        <button
                          onClick={() => onSelect(s.id)}
                          className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-left transition hover:bg-white/5"
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[s.status]}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-zinc-200">{s.title}</p>
                            <p className="truncate font-mono text-[10px] text-zinc-600">
                              {s.channel_key}
                            </p>
                          </div>
                          <LuMessageSquare className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
                          <span className="shrink-0 text-[11px] text-zinc-600">
                            {when(s.updated_at)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
