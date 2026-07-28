import { useMemo, useState } from "react";
import { LuMessagesSquare, LuPin, LuPinOff, LuSearch, LuTrash2 } from "react-icons/lu";
import type { Session, SessionStatus } from "../api";

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

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-lg bg-black/30 px-2.5 py-1">
      <dd className={`text-sm tabular-nums ${tone ?? "text-zinc-200"}`}>{value}</dd>
      <dt className="text-[11px] text-zinc-500">{label}</dt>
    </div>
  );
}

/**
 * Every session, not just the dozen the sidebar has room for — with search,
 * since the sidebar list is capped and old sessions otherwise become
 * unreachable once they fall off the end.
 */
export function SessionsPage({
  sessions,
  onSelect,
  onDelete,
  onPin,
}: {
  sessions: Session[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
}) {
  const [query, setQuery] = useState("");

  const running = sessions.filter((s) => s.status === "running").length;
  const pinnedCount = sessions.filter((s) => s.pinned).length;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title + s.workspace).toLowerCase().includes(q));
  }, [sessions, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-500/10 via-transparent to-transparent px-5 py-5">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-500/15 text-cyan-300">
                <LuMessagesSquare className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-zinc-100">Sessions</h2>
                <p className="mt-0.5 max-w-xl text-sm text-zinc-400">
                  Every task you have handed to pi. Each one runs on the server, so you can close
                  the tab and pick it back up here once it is done.
                </p>
              </div>
            </div>

            <dl className="mt-4 flex flex-wrap gap-2">
              <Stat label="total" value={sessions.length} />
              <Stat label="running" value={running} tone="text-cyan-300" />
              <Stat label="pinned" value={pinnedCount} />
            </dl>
          </header>

          <div className="relative mt-4">
            <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or workspace…"
              className="w-full rounded-lg border border-white/10 bg-black/30 py-2 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-600 focus:border-cyan-500/60"
            />
            {query && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-zinc-600">
                {matches.length} of {sessions.length}
              </span>
            )}
          </div>

          {matches.length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-500">
              {sessions.length === 0 ? "No sessions yet." : "Nothing matches that."}
            </p>
          ) : (
            <ul className="mt-3 space-y-1">
              {matches.map((s) => (
                <li
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className="group flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 transition hover:bg-white/5"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[s.status]}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="truncate text-sm text-zinc-200">{s.title}</p>
                      {s.pinned && (
                        <LuPin className="h-3 w-3 shrink-0 text-cyan-400/70" title="Pinned" />
                      )}
                    </div>
                    <p className="truncate font-mono text-[11px] text-zinc-600">{s.workspace}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-600">{when(s.updated_at)}</span>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPin(s.id, !s.pinned);
                      }}
                      className="rounded p-1.5 text-zinc-500 hover:text-cyan-300"
                      title={s.pinned ? "Unpin" : "Pin"}
                    >
                      {s.pinned ? <LuPinOff className="h-3.5 w-3.5" /> : <LuPin className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${s.title}"? This stops it if it is running.`)) {
                          onDelete(s.id);
                        }
                      }}
                      className="rounded p-1.5 text-zinc-500 hover:text-red-400"
                      title="Delete session"
                    >
                      <LuTrash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
