import { useEffect, useState } from "react";
import { LuBookOpen, LuRefreshCw, LuX } from "react-icons/lu";
import { api, type UsedSkill } from "../api";

/** Keep the list fresh so a skill the agent just used appears by itself. */
const POLL_MS = 5000;

/**
 * The skills this chat's agent actually used, read from the skill library so a
 * human can see what it leaned on. Content is read-only — the agent owns it.
 */
export function ChatSkillsPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<UsedSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const r = await api.usedSkills(sessionId);
      setSkills(r.skills);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <LuBookOpen className="h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg">Skills used</div>
          <div className="truncate text-[10px] text-fg-faint">
            {skills === null
              ? "loading…"
              : `${skills.length} skill${skills.length === 1 ? "" : "s"} in this chat`}
          </div>
        </div>
        <button
          onClick={() => load()}
          title="Refresh"
          className="rounded-md p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg-muted"
        >
          <LuRefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          title="Close skills"
          className="rounded-md p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg-muted"
        >
          <LuX className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {error && (
          <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</div>
        )}
        {skills !== null && skills.length === 0 && !error && (
          <div className="pt-8 text-center">
            <p className="text-sm text-fg-muted">No skills used yet.</p>
            <p className="mx-auto mt-1 max-w-[220px] text-[11px] leading-relaxed text-fg-faint">
              When the agent loads a skill for this chat, it shows up here with its instructions.
            </p>
          </div>
        )}
        {skills?.map((s) => (
          <details key={s.name} className="rounded-xl border border-line bg-raised/40">
            <summary className="cursor-pointer px-3 py-2 transition hover:bg-fg/5">
              <p className="text-xs font-medium text-fg">{s.name}</p>
              <p className="mt-0.5 line-clamp-2 text-[11px] text-fg-subtle">{s.description}</p>
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
              {s.content}
            </pre>
          </details>
        ))}
      </div>
    </aside>
  );
}
