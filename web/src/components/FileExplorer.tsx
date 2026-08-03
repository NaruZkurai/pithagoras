import { useEffect, useRef, useState } from "react";
import {
  LuChevronLeft,
  LuChevronRight,
  LuFile,
  LuFolder,
  LuFolderOpen,
  LuRefreshCw,
  LuX,
} from "react-icons/lu";
import { api, type WorkspaceEntry } from "../api";

/** Keep the listing fresh so files the agent is creating show up by themselves. */
const POLL_MS = 5000;

/** A short label for a file's size, or a dash for directories. */
function humanSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Built-in workspace file explorer: browse the session's workspace, preview
 * text files, and watch the agent work. Read-only — the agent owns the files.
 */
export function FileExplorer({
  sessionId,
  workspace,
  onClose,
}: {
  sessionId: string;
  workspace: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [preview, setPreview] = useState<{ name: string; path: string; content?: string; binary?: boolean; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reflected refs so the poller always targets the latest location without
  // re-arming the interval on every navigation.
  const pathRef = useRef(path);
  pathRef.current = path;
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const load = async (p: string) => {
    try {
      setError(null);
      const r = await api.listFiles(sessionId, p);
      setEntries(r.entries);
      setPath(p);
      setPreview(null);
    } catch (e) {
      setError((e as Error).message);
      setEntries(null);
    }
  };

  const openFile = async (entry: WorkspaceEntry) => {
    try {
      setError(null);
      const f = await api.readFile(sessionId, entry.path);
      setPreview({ name: entry.name, path: entry.path, content: f.content, binary: f.binary, size: f.size });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    load("");
    const t = setInterval(() => {
      if (!previewRef.current) load(pathRef.current);
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const crumbs = path ? path.split("/") : [];
  const workspaceName = workspace.split("/").filter(Boolean).pop() || workspace;

  const goCrumb = (idx: number) => {
    const target = crumbs.slice(0, idx).join("/");
    load(target);
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <LuFolderOpen className="h-4 w-4 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg">Files</div>
          <div className="truncate font-mono text-[10px] text-fg-faint" title={workspace}>
            {workspaceName}
          </div>
        </div>
        <button
          onClick={() => load(preview ? preview.path.split("/").slice(0, -1).join("/") : path)}
          title="Refresh"
          className="rounded-md p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg-muted"
        >
          <LuRefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          title="Close file explorer"
          className="rounded-md p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg-muted"
        >
          <LuX className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5 text-[11px]">
        <button
          onClick={() => load("")}
          className={`shrink-0 rounded px-1 py-0.5 transition hover:bg-fg/5 ${
            path ? "text-fg-subtle hover:text-fg" : "text-fg"
          }`}
        >
          {workspaceName}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex shrink-0 items-center gap-1">
            <LuChevronRight className="h-3 w-3 text-fg-faint" />
            <button
              onClick={() => goCrumb(i + 1)}
              className={`rounded px-1 py-0.5 transition hover:bg-fg/5 ${
                i === crumbs.length - 1 ? "text-fg" : "text-fg-subtle hover:text-fg"
              }`}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2">
        {error && <p className="px-2 py-2 text-xs text-danger">{error}</p>}

        {preview ? (
          <div>
            <div className="flex items-center gap-2 px-1 py-1">
              <button
                onClick={() => load(preview.path.split("/").slice(0, -1).join("/"))}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
              >
                <LuChevronLeft className="h-3.5 w-3.5" />
                folder
              </button>
              <span className="truncate font-mono text-[11px] text-fg">{preview.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-fg-faint">
                {humanSize(preview.size)}
              </span>
            </div>
            {preview.binary ? (
              <p className="px-2 py-3 text-xs text-fg-subtle">
                Binary file — can't preview ({humanSize(preview.size)}).
              </p>
            ) : (
              <pre className="overflow-x-auto whitespace-pre rounded-lg border border-line bg-raised/50 p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
                {preview.content}
              </pre>
            )}
          </div>
        ) : entries === null && !error ? (
          <p className="px-2 py-2 text-xs text-fg-subtle">Loading…</p>
        ) : entries && entries.length === 0 ? (
          <p className="px-2 py-3 text-xs text-fg-subtle">
            Empty folder{path ? "" : " — the agent hasn't written anything here yet"}.
          </p>
        ) : (
          <ul className="space-y-px">
            {entries!.map((e) => (
              <li key={e.path}>
                <button
                  onClick={() => (e.isDir ? load(e.path) : openFile(e))}
                  title={e.path}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition hover:bg-fg/5"
                >
                  {e.isDir ? (
                    <LuFolder className="h-4 w-4 shrink-0 text-accent/70" />
                  ) : (
                    <LuFile className="h-4 w-4 shrink-0 text-fg-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-muted hover:text-fg">
                    {e.name}
                  </span>
                  {!e.isDir && (
                    <span className="shrink-0 text-[10px] text-fg-faint">{humanSize(e.size)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
