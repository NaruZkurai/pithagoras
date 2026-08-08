import { useCallback, useEffect, useState } from "react";
import {
  LuArchive,
  LuDatabase,
  LuExternalLink,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { api, type MemoryHubStatus, type StashMeta } from "../api";

const SERVICES: { key: keyof MemoryHubStatus["services"]; label: string }[] = [
  { key: "core", label: "Core" },
  { key: "panel", label: "Panel" },
  { key: "knowledge", label: "Knowledge" },
  { key: "proxy", label: "Proxy" },
];

/**
 * NK Tools — a settings tab for the portal's background memory hub.
 *
 * Shows a live status light for the TencentDB memory daemon (pushed-to by
 * stashed conversations) and a list of every stash: conversations archived
 * into a thread on a message, and pushed to memory when the hub is up.
 */
export function NKToolsPanel({ onError }: { onError: (msg: string) => void }) {
  const [status, setStatus] = useState<MemoryHubStatus | null>(null);
  const [stashes, setStashes] = useState<StashMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.memoryStatus(), api.stashes()]);
      setStatus(s);
      setStashes(st.stashes);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const remove = async (id: string) => {
    setBusy(`del:${id}`);
    try {
      await api.deleteStash(id);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Background memory hub status light */}
      <div className="rounded-xl border border-line bg-raised/40 p-3">
        <div className="flex items-center gap-2">
          <LuDatabase className="h-4 w-4 shrink-0 text-accent" />
          <span className="text-sm font-medium text-fg">Memory hub</span>
          <span className="ml-auto flex items-center gap-1.5">
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
              {status ? (status.running ? "running" : "down") : "checking…"}
            </span>
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
          Background memory daemon (TencentDB) that stashed conversations get pushed to.
          {status?.error && <span className="text-danger"> {status.error}</span>}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SERVICES.map(({ key, label }) => (
            <span
              key={key}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
                status?.services[key]
                  ? "border-ok/40 text-ok"
                  : "border-line text-fg-faint"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  status ? (status.services[key] ? "bg-ok" : "bg-fg/30") : "bg-fg/20"
                }`}
              />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Stash list */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-fg">Stashed conversations</h3>
          <button
            onClick={load}
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted hover:text-fg"
          >
            <LuRefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        {stashes === null && (
          <p className="py-6 text-center text-sm text-fg-faint">Loading stashes…</p>
        )}
        {stashes !== null && stashes.length === 0 && (
          <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-fg-muted">
            Nothing stashed yet. From a chat, use the stash button on a message to
            archive the conversation into a thread and push it to memory.
          </p>
        )}
        {stashes?.map((s) => (
          <div key={s.id} className="mb-2 rounded-xl border border-line bg-raised/40 p-3">
            <div className="flex items-start gap-3">
              <LuArchive className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
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
                  className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-fg-subtle"
                  title={s.parentText}
                >
                  {s.parentText}
                </p>
                <p className="mt-1 font-mono text-[10px] text-fg-faint">
                  {s.messageCount} message{s.messageCount === 1 ? "" : "s"} ·{" "}
                  {new Date(s.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={`/s/${s.sessionId}`}
                  title="Open the session chat"
                  className="rounded-md p-1 text-fg-faint hover:text-fg"
                >
                  <LuExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  onClick={() => remove(s.id)}
                  disabled={busy === `del:${s.id}`}
                  title="Delete stash (and its thread)"
                  className="rounded-md p-1 text-fg-faint hover:text-danger disabled:opacity-50"
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
