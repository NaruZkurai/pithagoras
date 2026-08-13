import { useCallback, useEffect, useState } from "react";
import { LuGitBranch, LuGitCommitHorizontal, LuRefreshCw } from "react-icons/lu";
import { api, type Repo } from "../api";

export function ReposPage({ onOpenWorkspace }: { onOpenWorkspace: (path: string) => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.repos();
      setRepos(r.repos);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/20">
          <LuGitBranch className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-fg">Repositories</h1>
          <p className="text-xs text-fg-muted">The source repos the portal can work on.</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          <LuRefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {error && <p className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      {repos === null && <p className="py-10 text-center text-sm text-fg-faint">Loading repositories…</p>}

      {repos !== null && repos.length === 0 && (
        <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <LuGitCommitHorizontal className="mx-auto mb-2 h-6 w-6 text-fg-faint" />
          <p className="text-sm text-fg-muted">No repositories registered yet.</p>
        </div>
      )}

      {repos !== null && repos.length > 0 && (
        <div className="space-y-2">
          {repos.map((r) => (
            <div key={r.id} className="rounded-xl border border-line bg-raised/40 p-3">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-fg">{r.name}</span>
                {r.git.dirty && (
                  <span className="shrink-0 rounded-full bg-warn/15 px-1.5 py-0.5 text-[9px] font-medium text-warn">
                    modified
                  </span>
                )}
                <span className="ml-auto font-mono text-[10px] text-fg-faint">
                  {r.git.branch || "no git"}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-fg-faint">{r.path}</p>
              {r.git.commit && (
                <p className="mt-1 font-mono text-[10px] text-fg-faint">@{r.git.commit}</p>
              )}
              <button
                onClick={() => onOpenWorkspace(r.path)}
                className="mt-1.5 rounded-md bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent transition hover:bg-accent/20"
              >
                Open as workspace
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
