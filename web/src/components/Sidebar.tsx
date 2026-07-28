import { useState, type ReactNode } from "react";
import {
  LuBot,
  LuMessagesSquare,
  LuPin,
  LuPinOff,
  LuPlus,
  LuSettings,
  LuTrash2,
} from "react-icons/lu";
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

/** How many unpinned sessions the sidebar shows before deferring to Sessions. */
const RECENTS_LIMIT = 12;

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
  view,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onPin,
  onCreateWorkspace,
  onOpenSettings,
  onNavigate,
}: {
  sessions: Session[];
  workspaces: Workspace[];
  executor: string;
  activeId: string | null;
  /** Which top-level destination is showing, so the nav can mark it. */
  view: "chat" | "sessions" | "agents";
  onSelect: (id: string) => void;
  onCreate: (workspacePath: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onCreateWorkspace: (name: string) => Promise<Workspace>;
  onOpenSettings: () => void;
  onNavigate: (to: "sessions" | "agents") => void;
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

  const pinned = sessions.filter((s) => s.pinned);
  const recents = sessions.filter((s) => !s.pinned);
  const shownRecents = recents.slice(0, RECENTS_LIMIT);

  const item = (s: Session) => (
    <SessionItem
      key={s.id}
      session={s}
      active={activeId === s.id}
      onSelect={() => onSelect(s.id)}
      onRename={onRename}
      onDelete={onDelete}
      onPin={onPin}
    />
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <h1 className="text-sm font-bold tracking-wide text-cyan-300">Pithagoras</h1>
        <span
          className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
          title="How sessions are executed"
        >
          {executor}
        </span>
      </div>

      {/* Destinations, above the session lists. */}
      <nav className="px-2 pb-2">
        <NavItem icon={<LuPlus />} label="New" onClick={() => setCreating((v) => !v)} active={creating} />
        <NavItem
          icon={<LuMessagesSquare />}
          label="Sessions"
          onClick={() => onNavigate("sessions")}
          active={view === "sessions"}
        />
        <NavItem
          icon={<LuBot />}
          label="Agents"
          onClick={() => onNavigate("agents")}
          active={view === "agents"}
        />

        {creating && (
          <div className="mt-2 space-y-2 px-1">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-300"
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
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm outline-none focus:border-cyan-500/60"
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
              className="w-full rounded-lg bg-cyan-500/15 px-2 py-1.5 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Start session"}
            </button>
          </div>
        )}
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-zinc-500">No sessions yet.</p>
        )}

        {pinned.length > 0 && (
          <>
            <Divider />
            <GroupLabel>Pinned</GroupLabel>
            {pinned.map(item)}
          </>
        )}

        {shownRecents.length > 0 && (
          <>
            <Divider />
            <GroupLabel>Recents</GroupLabel>
            {shownRecents.map(item)}
            {recents.length > shownRecents.length && (
              <button
                onClick={() => onNavigate("sessions")}
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
              >
                {recents.length - shownRecents.length} more…
              </button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-zinc-800 p-2">
        <NavItem icon={<LuSettings />} label="Settings" onClick={onOpenSettings} active={false} />
        <p className="px-2 pt-1 text-[11px] text-zinc-600">
          Sessions keep running if you close this tab.
        </p>
      </div>
    </aside>
  );
}

const Divider = () => <div className="my-2 border-t border-zinc-800/80" />;

const GroupLabel = ({ children }: { children: ReactNode }) => (
  <p className="px-2 pb-1 text-[11px] font-medium text-zinc-500">{children}</p>
);

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition ${
        active ? "bg-white/10 text-zinc-100" : "text-zinc-300 hover:bg-white/5 hover:text-zinc-100"
      }`}
    >
      <span className="shrink-0 text-zinc-500">{icon}</span>
      {label}
    </button>
  );
}

function SessionItem({
  session: s,
  active,
  onSelect,
  onRename,
  onDelete,
  onPin,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group mb-0.5 cursor-pointer rounded-lg px-2 py-1.5 ${
        active ? "bg-white/10" : "hover:bg-white/5"
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

        <div className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPin(s.id, !s.pinned);
            }}
            className="rounded p-1 text-zinc-500 hover:text-cyan-300"
            title={s.pinned ? "Unpin" : "Pin"}
          >
            {s.pinned ? <LuPinOff className="h-3 w-3" /> : <LuPin className="h-3 w-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete "${s.title}"? This stops it if it is running.`)) {
                onDelete(s.id);
              }
            }}
            className="rounded p-1 text-zinc-500 hover:text-red-400"
            title="Delete session"
          >
            <LuTrash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="truncate pl-4 text-[11px] text-zinc-500">{s.workspace.split("/").pop()}</div>
    </div>
  );
}
