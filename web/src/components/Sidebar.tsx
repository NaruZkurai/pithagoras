import { useState } from "react";
import type { Project, Session, SessionStatus } from "../api";

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

export function Sidebar({
  sessions,
  projects,
  executor,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onCreateProject,
}: {
  sessions: Session[];
  projects: Project[];
  executor: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (title: string, project: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onCreateProject: (name: string) => Promise<Project>;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [newProject, setNewProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sentinel value in the dropdown that swaps in the "name your folder" field.
  const NEW = "__new__";
  const makingNew = project === NEW;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      let chosen: string | undefined;
      if (makingNew) {
        const created = await onCreateProject(newProject.trim());
        chosen = created.path;
      } else {
        chosen = project || projects[0]?.path;
      }
      if (!chosen) {
        setError("Pick or create a project first");
        return;
      }
      await onCreate(title.trim() || "New task", chosen);
      setTitle("");
      setNewProject("");
      setProject("");
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
            title="How tasks are executed"
          >
            {executor}
          </span>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="mt-2 w-full rounded-lg bg-cyan-900/50 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-900/80"
        >
          + New task
        </button>
        {creating && (
          <div className="mt-2 space-y-2">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Task name"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-none focus:border-cyan-600"
            />
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-300"
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                  {p.isGit ? " (git)" : ""}
                </option>
              ))}
              <option value={NEW}>+ New folder…</option>
            </select>
            {makingNew && (
              <input
                autoFocus
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="folder-name"
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-sm outline-none focus:border-cyan-600"
              />
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={submit}
              disabled={busy || (projects.length === 0 && !makingNew)}
              className="w-full rounded bg-zinc-800 px-2 py-1 text-sm hover:bg-zinc-700 disabled:opacity-40"
            >
              {busy ? "Creating…" : makingNew ? "Create folder + task" : "Create"}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-zinc-500">No tasks yet.</p>
        )}
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
                  const next = prompt("Rename task", s.title);
                  if (next?.trim()) onRename(s.id, next.trim());
                }}
              >
                {s.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${s.title}"? This stops the task if it is running.`)) {
                    onDelete(s.id);
                  }
                }}
                className="ml-auto hidden shrink-0 px-1 text-xs text-zinc-500 hover:text-red-400 group-hover:block"
                title="Delete task"
              >
                ✕
              </button>
            </div>
            <div className="truncate pl-4 text-[11px] text-zinc-500">
              {s.project.split("/").pop()}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-600">
        Tasks keep running if you close this tab.
      </div>
    </aside>
  );
}
