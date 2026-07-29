import { useEffect, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuLock,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuWrench,
} from "react-icons/lu";
import { api, type Skill, type SkillDiagnostic } from "../api";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-cyan-500/60";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/10 disabled:opacity-40";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 transition hover:bg-cyan-500/25 disabled:opacity-40";

/**
 * Skills the agent can reach for.
 *
 * The list is pi's own, so it matches what the model is actually offered —
 * including anything a package brought with it. Those are read-only here: a
 * package's skill belongs to the package, and editing it in place would be
 * silently undone by the next update.
 */
export function SkillsPanel({ onError }: { onError: (e: string) => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [root, setRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [openName, setOpenName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const r = await api.skills();
      setSkills(r.skills);
      setDiagnostics(r.diagnostics ?? []);
      setRoot(r.root);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const open = skills.find((s) => s.name === openName);
  if (open) {
    return <SkillDetail skill={open} onBack={() => setOpenName(null)} onError={onError} onChanged={load} />;
  }

  const mine = skills.filter((s) => s.editable);
  const theirs = skills.filter((s) => !s.editable);

  return (
    <>
      <section className="mb-6 rounded-xl border border-white/10 bg-black/20 p-3">
        <p className="text-xs text-zinc-500">
          A skill is a set of instructions the agent pulls in when its description matches what is
          being asked. Every session sees them, so they are a good place for a procedure you would
          otherwise repeat.
        </p>
        <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-600">{root}</p>
      </section>

      {diagnostics.length > 0 && (
        <ul className="mb-5 space-y-1">
          {diagnostics.map((d, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/25 px-3 py-2 text-xs text-amber-200/80"
            >
              <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <p>{d.message}</p>
                {d.path && <p className="truncate font-mono text-[10px] opacity-70">{d.path}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="mb-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Yours{mine.length ? ` (${mine.length})` : ""}
          </h3>
          <button onClick={() => setAdding(!adding)} className="text-[11px] text-cyan-400 hover:text-cyan-300">
            {adding ? "Cancel" : "+ New skill"}
          </button>
        </div>

        {adding && (
          <NewSkill
            onCancel={() => setAdding(false)}
            onError={onError}
            onCreated={async (name) => {
              setAdding(false);
              await load();
              setOpenName(name);
            }}
          />
        )}

        {loading ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : mine.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500">
            None yet.
            <p className="mt-1 text-xs text-zinc-600">
              How you like releases cut, the shape of a good commit message, the steps for a
              deploy — anything you have explained more than twice.
            </p>
          </div>
        ) : (
          <ul className="mt-2 space-y-1">
            {mine.map((s) => (
              <SkillRow key={s.name} skill={s} onOpen={() => setOpenName(s.name)} />
            ))}
          </ul>
        )}
      </section>

      {theirs.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            From packages ({theirs.length})
          </h3>
          <ul className="mt-2 space-y-1">
            {theirs.map((s) => (
              <SkillRow key={s.name} skill={s} onOpen={() => setOpenName(s.name)} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function SkillRow({ skill: s, onOpen }: { skill: Skill; onOpen: () => void }) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-left transition hover:bg-white/5"
      >
        {s.editable ? (
          <LuWrench className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        ) : (
          <LuLock className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-200">
            {s.name}
            {s.manualOnly && (
              <span className="ml-1.5 rounded bg-white/5 px-1 py-0.5 text-[10px] text-zinc-500">
                /skill only
              </span>
            )}
          </p>
          <p className="line-clamp-2 text-[11px] text-zinc-500">{s.description}</p>
        </div>
        <LuChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
      </button>
    </li>
  );
}

function NewSkill({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (name: string) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createSkill(name, description);
      await onCreated(r.name);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <label className="block">
        <span className="text-xs text-zinc-400">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="cut-a-release"
          className={`${inputCls} mt-1 font-mono text-xs`}
        />
      </label>
      <label className="block">
        <span className="text-xs text-zinc-400">When to use it</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Use when cutting a release: version bump, changelog, tag and push."
          className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
        />
        <p className="mt-1 text-[11px] text-zinc-600">
          This is the only part the model reads when deciding whether the skill applies. Say when,
          not what.
        </p>
      </label>
      <div className="flex items-center gap-2">
        <button disabled={!name.trim() || !description.trim() || busy} onClick={create} className={primaryCls}>
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : <LuPlus className="h-4 w-4" />}
          Create
        </button>
        <button onClick={onCancel} className={btnCls}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SkillDetail({
  skill: s,
  onBack,
  onError,
  onChanged,
}: {
  skill: Skill;
  onBack: () => void;
  onError: (e: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(s.content);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(s.content), [s.name, s.content]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
      >
        <LuChevronLeft className="h-3.5 w-3.5" /> Skills
      </button>

      <div className="mb-5 flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-cyan-500/10 text-cyan-300">
          {s.editable ? <LuWrench className="h-4 w-4" /> : <LuLock className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-zinc-100">{s.name}</h3>
          <p className="text-xs text-zinc-500">{s.description}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{s.path}</p>
        </div>
      </div>

      {s.editable ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={18}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-cyan-500/60"
          />
          <p className="mt-1 text-[11px] text-zinc-600">
            The frontmatter at the top is what pi reads — changing <code>name</code> renames the
            skill, and <code>description</code> is what the model matches against.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() =>
                act(async () => {
                  await api.saveSkill(s.name, draft);
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                })
              }
              disabled={busy || draft === s.content}
              className={primaryCls}
            >
              {busy ? (
                <LuRefreshCw className="h-4 w-4 animate-spin" />
              ) : saved ? (
                <LuCheck className="h-4 w-4" />
              ) : null}
              {saved ? "Saved" : "Save"}
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete the skill "${s.name}"?`)) {
                  act(async () => {
                    await api.deleteSkill(s.name);
                    onBack();
                  });
                }
              }}
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
            >
              <LuTrash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-zinc-500">
          <LuLock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" />
          <p>
            This skill came with a package. Editing it here would be undone by the next update, so
            it is read-only — change it by removing or replacing the package in Extensions.
          </p>
        </div>
      )}
    </>
  );
}
