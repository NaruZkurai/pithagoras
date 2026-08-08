import { useCallback, useEffect, useState } from "react";
import {
  LuArchive,
  LuBrain,
  LuCircleAlert,
  LuDatabase,
  LuRefreshCw,
} from "react-icons/lu";
import { api, type MemoryAtom, type MemoryHubStatus, type StashMeta } from "../api";

const TYPE_META: Record<MemoryAtom["type"], { label: string; cls: string }> = {
  persona: { label: "Persona", cls: "bg-accent/15 text-accent" },
  episodic: { label: "Episodic", cls: "bg-warn/15 text-warn" },
  instruction: { label: "Instruction", cls: "bg-ok/15 text-ok" },
};

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function AtomCard({ atom }: { atom: MemoryAtom }) {
  const meta = TYPE_META[atom.type] ?? TYPE_META.episodic;
  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${meta.cls}`}>
          {meta.label}
        </span>
        <span className="ml-auto font-mono text-[10px] text-fg-faint">
          {fmtTime(atom.updatedAt || atom.createdAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-fg">
        {atom.content}
      </p>
      {atom.background && (
        <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-fg-subtle">
          {atom.background}
        </p>
      )}
    </div>
  );
}

/**
 * Memories — everything the TencentDB memory hub is holding, in one place.
 *
 * A dedicated nav destination (its own icon in the sidebar): lists every
 * stored memory atom grouped by kind (persona / episodic / instruction) plus
 * the conversations stashed from the portal, with a live hub status light.
 */
export function MemoriesPage() {
  const [atoms, setAtoms] = useState<MemoryAtom[] | null>(null);
  const [stashes, setStashes] = useState<StashMeta[]>([]);
  const [status, setStatus] = useState<MemoryHubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api.memories(), api.memoryStatus()]);
      setAtoms(m.atoms);
      setStashes(m.stashes);
      setStatus(s);
      if (m.error) setError(m.error);
      else setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const groups: { type: MemoryAtom["type"]; items: MemoryAtom[] }[] = (
    ["persona", "episodic", "instruction"] as const
  )
    .map((type) => ({ type, items: (atoms ?? []).filter((a) => a.type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/20">
          <LuBrain className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-fg">Memories</h1>
          <p className="text-xs text-fg-muted">
            Everything the memory hub is holding — atoms and stashed conversations.
          </p>
        </div>
        <span className="flex items-center gap-1.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              status ? (status.running ? "bg-ok" : "bg-danger") : "bg-fg/30"
            }`}
          />
          <span
            className={`text-[11px] font-medium ${
              status ? (status.running ? "text-ok" : "text-danger") : "text-fg-faint"
            }`}
          >
            {status ? (status.running ? "hub running" : "hub down") : "checking…"}
          </span>
        </span>
        <button
          onClick={load}
          className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          <LuRefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {atoms === null && (
        <p className="py-10 text-center text-sm text-fg-faint">Loading memories…</p>
      )}

      {atoms !== null && groups.length === 0 && stashes.length === 0 && (
        <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <LuDatabase className="mx-auto mb-2 h-6 w-6 text-fg-faint" />
          <p className="text-sm text-fg-muted">No memories stored yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-fg-faint">
            Memories appear here as the agent records them (persona / episodic /
            instruction) and when you stash a conversation into a thread.
          </p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.type} className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {TYPE_META[g.type].label}
            <span className="rounded-full bg-fg/10 px-1.5 py-0.5 text-[10px] text-fg-faint">
              {g.items.length}
            </span>
          </h2>
          <div className="space-y-2">
            {g.items.map((a) => (
              <AtomCard key={a.id} atom={a} />
            ))}
          </div>
        </section>
      ))}

      {stashes.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            <LuArchive className="h-3.5 w-3.5" />
            Stashed conversations
            <span className="rounded-full bg-fg/10 px-1.5 py-0.5 text-[10px] text-fg-faint">
              {stashes.length}
            </span>
          </h2>
          <div className="space-y-2">
            {stashes.map((s) => (
              <div key={s.id} className="rounded-xl border border-line bg-raised/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium text-fg">
                    {s.sessionTitle || "(deleted session)"}
                  </span>
                  {s.pushed ? (
                    <span className="shrink-0 rounded-full bg-ok/15 px-1.5 py-0.5 text-[9px] font-medium text-ok">
                      pushed to memory
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-fg/10 px-1.5 py-0.5 text-[9px] font-medium text-fg-faint">
                      local only
                    </span>
                  )}
                </div>
                <p
                  className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-subtle"
                  title={s.parentText}
                >
                  {s.parentText}
                </p>
                <p className="mt-1 font-mono text-[10px] text-fg-faint">
                  {s.messageCount} message{s.messageCount === 1 ? "" : "s"} ·{" "}
                  {fmtTime(s.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
