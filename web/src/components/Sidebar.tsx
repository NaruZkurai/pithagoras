import { useState } from "react";
import type { Session, SessionStatus, Workspace } from "../api";

const STATUS_STYLE: Record<SessionStatus, string> = {
  running: "bg-cyan-400 animate-pulse",
  idle: "bg-zinc-600",
  error: "bg-red-500",
  interrupted: "bg-amber-500",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "running",
  idle: "idle",
  error: "error",
  interrupted: "interrupted — server restarted mid-run",
};

/** Mirrors the server's slugify so the preview matches what actually gets created. */
function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
}

// Sentinel for the dropdown — a new workspace is the default choice.
const NEW = "__new__";

export function Sidebar({
  sessions,
  workspaces,
  executor,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onCreateWorkspace,
  onOpenSettings,
}: {
  sessions: Session[];
  workspaces: Workspace[];
  executor: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (workspacePath: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onCreateWorkspace: (name: string) => Promise<Workspace>;
  onOpenSettings: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [choice, setChoice] = useState<string>(NEW);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const makingNew = choice === NEW;
  const slug = slugify(name);
  const canSubmit = makingNew ? slug.length > 0 : Boolean(choice);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      // Either branch produces a workspace path; the session takes its name
      // from that folder.
      const workspacePath = makingNew ? (await onCreateWorkspace(name.trim())).path : choice;
      await onCreate(workspacePath);
      setName("");
      setChoice(NEW);
      setCreating(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
      <div className="border-b border-zinc-800 p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold tracking-wide text-cyan-300">Pithagoras</h1>
          <span
            className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
            title="How sessions are executed"
          >
            {executor}
          </span>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="mt-2 w-full rounded-lg bg-cyan-900/50 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-900/80"
        >
          + New session
        </button>

        {creating && (
          <div className="mt-2 space-y-2">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-300"
            >
              <option value={NEW}>New workspace</option>
              {workspaces.length > 0 && (
                <optgroup label="Existing workspaces">
                  {workspaces.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.name}
                      {w.isGit ? " (git)" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            {makingNew && (
              <div>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="Cool Project"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-none focus:border-cyan-600"
                />
                {name.trim() && (
                  <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                    {slug ? `→ ${slug}` : "needs at least one letter or digit"}
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={submit}
              disabled={busy || !canSubmit}
              className="w-full rounded bg-zinc-800 px-2 py-1 text-sm hover:bg-zinc-700 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Start session"}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && <p className="px-2 py-4 text-xs text-zinc-500">No sessions yet.</p>}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group mb-1 cursor-pointer rounded px-2 py-1.5 ${
              activeId === s.id ? "bg-zinc-800" : "hover:bg-zinc-900"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[s.status]}`}
                title={STATUS_LABEL[s.status]}
              />
              <span
                className="truncate text-sm text-zinc-200"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const next = prompt("Rename session", s.title);
                  if (next?.trim()) onRename(s.id, next.trim());
                }}
              >
                {s.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${s.title}"? This stops it if it is running.`)) {
                    onDelete(s.id);
                  }
                }}
                className="ml-auto hidden shrink-0 px-1 text-xs text-zinc-500 hover:text-red-400 group-hover:block"
                title="Delete session"
              >
                ✕
              </button>
            </div>
            <div className="truncate pl-4 text-[11px] text-zinc-500">
              {s.workspace.split("/").pop()}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-800 p-2">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
        >
          <span className="text-base leading-none">⚙</span>
          Settings
        </button>
        <p className="px-2 pt-1 text-[11px] text-zinc-600">
          Sessions keep running if you close this tab.
        </p>
      </div>
    </aside>
  );
}
