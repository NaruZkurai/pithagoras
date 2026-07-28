import { useState } from "react";
import { LuArrowRight, LuBot, LuCheck, LuRefreshCw, LuUser } from "react-icons/lu";
import { api, type AgentSetup as Setup } from "../api";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-cyan-500/60";

/**
 * First run for the agent's home directory.
 *
 * Two questions, because the two things the agent cannot work out for itself
 * are who it is and who it is talking to. Everything else has a sensible
 * starting point, and the files are editable afterwards.
 */
export function AgentSetup({ home, onDone }: { home: string; onDone: (s: Setup) => void }) {
  const [step, setStep] = useState<0 | 1>(0);
  const [agentName, setAgentName] = useState("");
  const [vibe, setVibe] = useState("");
  const [userName, setUserName] = useState("");
  const [userAbout, setUserAbout] = useState("");
  const [userPrefers, setUserPrefers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api.runAgentWizard({ agentName, vibe, userName, userAbout, userPrefers })
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-500/15 text-cyan-300">
          <LuBot className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-zinc-100">Set up the agent</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            Every channel talks to one agent, and it keeps what it learns. Two questions and it has
            somewhere to start.
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-zinc-600">{home}</p>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className={`h-0.5 flex-1 rounded-full transition ${
              i <= step ? "bg-cyan-500/60" : "bg-white/10"
            }`}
          />
        ))}
      </div>

      {step === 0 ? (
        <section className="mt-6 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <LuBot className="h-3.5 w-3.5" /> Who it is
          </div>

          <label className="block">
            <span className="text-xs text-zinc-400">Name</span>
            <input
              autoFocus
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && agentName.trim() && setStep(1)}
              placeholder="Aria"
              className={`${inputCls} mt-1`}
            />
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">Character</span>
            <textarea
              value={vibe}
              onChange={(e) => setVibe(e.target.value)}
              rows={5}
              placeholder="How it should come across. Direct and a bit dry? Careful and thorough? Leave it empty for a sensible default you can edit later."
              className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
            />
            <p className="mt-1 text-[11px] text-zinc-600">Becomes SOUL.md.</p>
          </label>

          <button
            disabled={!agentName.trim()}
            onClick={() => setStep(1)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 transition hover:bg-cyan-500/25 disabled:opacity-40"
          >
            Next <LuArrowRight className="h-4 w-4" />
          </button>
        </section>
      ) : (
        <section className="mt-6 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <LuUser className="h-3.5 w-3.5" /> Who it works for
          </div>

          <label className="block">
            <span className="text-xs text-zinc-400">Your name</span>
            <input
              autoFocus
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Anirban"
              className={`${inputCls} mt-1`}
            />
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">About you</span>
            <textarea
              value={userAbout}
              onChange={(e) => setUserAbout(e.target.value)}
              rows={4}
              placeholder="What you work on, what you care about, anything it should assume rather than ask."
              className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
            />
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">How to answer you</span>
            <textarea
              value={userPrefers}
              onChange={(e) => setUserPrefers(e.target.value)}
              rows={3}
              placeholder="Short and blunt? Show the reasoning? Never guess?"
              className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
            />
            <p className="mt-1 text-[11px] text-zinc-600">Becomes PrimaryUser.md.</p>
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              disabled={!userName.trim() || busy}
              onClick={create}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 transition hover:bg-cyan-500/25 disabled:opacity-40"
            >
              {busy ? (
                <LuRefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <LuCheck className="h-4 w-4" />
              )}
              Create
            </button>
            <button
              onClick={() => setStep(0)}
              className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/5"
            >
              Back
            </button>
          </div>
        </section>
      )}

      <p className="mt-8 text-[11px] leading-relaxed text-zinc-600">
        Writes SOUL.md, PrimaryUser.md and MEMORY.md into the agent's home directory. All three are
        handed to pi as context whenever a conversation starts, and stay editable here. An existing
        MEMORY.md is never overwritten.
      </p>
    </div>
  );
}
