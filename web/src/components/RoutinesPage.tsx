import { useEffect, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuClock,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { api, type Routine } from "../api";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-cyan-500/60";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 transition hover:bg-cyan-500/25 disabled:opacity-40";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/10 disabled:opacity-40";

const STATUS_STYLE: Record<string, string> = {
  ok: "text-emerald-400",
  error: "text-red-400",
  running: "text-cyan-400",
};

const PRESETS = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "@hourly" },
  { label: "Daily 9am", cron: "0 9 * * *" },
  { label: "Weekdays 8am", cron: "0 8 * * 1-5" },
  { label: "Weekly", cron: "@weekly" },
];

const when = (iso: string | null) => {
  if (!iso) return "never";
  const then = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z").getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (!Number.isFinite(mins)) return iso;
  if (mins < 0) return "soon";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const until = (iso: string | null) => {
  if (!iso) return "not scheduled";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "due";
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${mins}m`;
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`;
  return `in ${Math.round(mins / 1440)}d`;
};

/**
 * Work that happens on a schedule rather than because somebody asked.
 *
 * A routine is a standing instruction and a cron expression: it fires, the
 * agent does the job, and it goes quiet again. What it did last time is kept,
 * because that is the only way to know a routine is working.
 */
export function RoutinesPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .routines()
      .then((r) => setRoutines(r.routines))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const open = routines.find((r) => r.id === openId);

  if (open) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <RoutineDetail
            routine={open}
            onBack={() => setOpenId(null)}
            onChanged={load}
            onError={setError}
            onOpenSession={onOpenSession}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-500/10 via-transparent to-transparent px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-500/15 text-cyan-300">
              <LuClock className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-zinc-100">Routines</h2>
              <p className="mt-0.5 max-w-xl text-sm text-zinc-400">
                Work the agent does on a schedule instead of because you asked. It wakes up, follows
                its instructions, and goes quiet again.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Stat value={routines.length} label="routines" />
            <Stat value={routines.filter((r) => r.enabled).length} label="enabled" tone="text-cyan-300" />
            <Stat
              value={routines.filter((r) => r.lastStatus === "error").length}
              label="failing"
              tone="text-red-400"
            />
          </div>
        </header>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Scheduled
          </h3>
          <button onClick={() => setAdding(!adding)} className={adding ? btnCls : primaryCls}>
            <LuPlus className="h-4 w-4" /> {adding ? "Cancel" : "New routine"}
          </button>
        </div>

        {adding && (
          <NewRoutine
            onCancel={() => setAdding(false)}
            onError={setError}
            onCreated={async (created) => {
              setAdding(false);
              await load();
              setOpenId(created.id);
            }}
          />
        )}

        {loading ? (
          <p className="py-10 text-center text-sm text-zinc-500">Loading…</p>
        ) : routines.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-zinc-800 px-4 py-10 text-center">
            <p className="text-sm text-zinc-400">No routines yet.</p>
            <p className="mx-auto mt-2 max-w-md text-xs text-zinc-600">
              A morning summary of what changed overnight, a nightly check that backups ran, a
              weekly tidy of a directory — anything you would otherwise remember to ask for.
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {routines.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setOpenId(r.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-left transition hover:bg-white/5"
                >
                  <LuClock
                    className={`h-4 w-4 shrink-0 ${r.enabled ? "text-cyan-400" : "text-zinc-600"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-200">{r.name}</p>
                    <p className="truncate text-[11px] text-zinc-600">
                      <span className="font-mono">{r.schedule}</span>
                      {r.enabled ? ` · ${until(r.nextRun)}` : " · disabled"}
                      {r.lastStatus && (
                        <>
                          {" · "}
                          <span className={STATUS_STYLE[r.lastStatus] ?? ""}>{r.lastStatus}</span>
                          {" "}
                          {when(r.lastRun)}
                        </>
                      )}
                    </p>
                  </div>
                  <LuChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-zinc-600">
          Schedules use the server's clock and five-field cron, or a shorthand like{" "}
          <code>@daily</code>. A routine that is still running when its next slot comes round is
          skipped rather than stacked.
        </p>
      </div>
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-lg bg-black/30 px-2.5 py-1">
      <span className={`text-sm tabular-nums ${tone ?? "text-zinc-200"}`}>{value}</span>
      <span className="text-[11px] text-zinc-500">{label}</span>
    </div>
  );
}

function SchedulePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [preview, setPreview] = useState<{ runs?: string[]; error?: string }>({});

  useEffect(() => {
    if (!value.trim()) return setPreview({});
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .previewSchedule(value)
        .then((r) => !cancelled && setPreview({ runs: r.runs }))
        .catch((e) => !cancelled && setPreview({ error: (e as Error).message }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value]);

  return (
    <div>
      <span className="text-xs text-zinc-400">Schedule</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * *"
        className={`${inputCls} mt-1 font-mono text-xs`}
      />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => onChange(p.cron)}
            className="rounded-lg bg-white/5 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-white/10 hover:text-zinc-200"
          >
            {p.label}
          </button>
        ))}
      </div>
      {preview.error && <p className="mt-1.5 text-[11px] text-red-400">{preview.error}</p>}
      {preview.runs && preview.runs.length > 0 && (
        <p className="mt-1.5 text-[11px] text-zinc-500">
          Next: {preview.runs.slice(0, 3).map((r) => new Date(r).toLocaleString()).join(" · ")}
        </p>
      )}
    </div>
  );
}

function NewRoutine({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (r: Routine) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await onCreated(await api.createRoutine({ name, schedule, instructions }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <label className="block">
        <span className="text-xs text-zinc-400">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning summary"
          className={`${inputCls} mt-1`}
        />
      </label>

      <SchedulePicker value={schedule} onChange={setSchedule} />

      <label className="block">
        <span className="text-xs text-zinc-400">Instructions</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={5}
          placeholder="What to do when it fires. Written as an instruction, not a question — nobody is there to answer one."
          className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
        />
      </label>

      <div className="flex items-center gap-2">
        <button disabled={!name.trim() || busy} onClick={create} className={primaryCls}>
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : <LuCheck className="h-4 w-4" />}
          Create
        </button>
        <button onClick={onCancel} className={btnCls}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RoutineDetail({
  routine: r,
  onBack,
  onChanged,
  onError,
  onOpenSession,
}: {
  routine: Routine;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [name, setName] = useState(r.name);
  const [schedule, setSchedule] = useState(r.schedule);
  const [instructions, setInstructions] = useState(r.instructions);
  const [fresh, setFresh] = useState(r.freshSession);
  const [busy, setBusy] = useState<null | "save" | "run">(null);
  const [saved, setSaved] = useState(false);
  const [runs, setRuns] = useState<{ id: string; title: string }[]>([]);

  useEffect(() => {
    setName(r.name);
    setSchedule(r.schedule);
    setInstructions(r.instructions);
    setFresh(r.freshSession);
  }, [r.id, r.updatedAt]);

  useEffect(() => {
    api
      .routineSessions(r.id)
      .then((x) => setRuns(x.sessions.map((s) => ({ id: s.id, title: s.title }))))
      .catch(() => {});
  }, [r.id, r.lastRun]);

  const dirty =
    name !== r.name ||
    schedule !== r.schedule ||
    instructions !== r.instructions ||
    fresh !== r.freshSession;

  const act = async (which: "save" | "run", fn: () => Promise<unknown>) => {
    setBusy(which);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
      >
        <LuChevronLeft className="h-3.5 w-3.5" /> Routines
      </button>

      <div className="mb-5 flex items-start gap-3">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            r.enabled ? "bg-cyan-500/10 text-cyan-300" : "bg-white/5 text-zinc-500"
          }`}
        >
          <LuClock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-transparent text-sm font-medium text-zinc-100 outline-none"
          />
          <p className="truncate text-xs text-zinc-500">
            {r.enabled ? until(r.nextRun) : "disabled"} · <span className="font-mono">{r.slug}</span>
          </p>
        </div>
        <button
          onClick={() => act("save", () => api.updateRoutine(r.id, { enabled: !r.enabled }))}
          disabled={busy !== null}
          title={r.enabled ? "Disable" : "Enable"}
          className={`relative mt-1 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ${
            r.enabled ? "bg-cyan-500/70" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
              r.enabled ? "left-[1.125rem]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <section className="mb-6 space-y-3">
        <SchedulePicker value={schedule} onChange={setSchedule} />

        <label className="block">
          <span className="text-xs text-zinc-400">Instructions</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
          />
          <p className="mt-1 text-[11px] text-zinc-600">
            Given to the agent verbatim, with a note that it was woken by a schedule and that
            nobody is waiting on a reply.
          </p>
        </label>

        <button
          type="button"
          onClick={() => setFresh(!fresh)}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left transition hover:bg-white/5"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-200">Fresh session each run</p>
            <p className="text-[11px] text-zinc-500">
              Off: one session it keeps, so a run can see what the last one did. On: a clean start
              every time.
            </p>
          </div>
          <span
            className={`relative h-5 w-9 shrink-0 rounded-full transition ${
              fresh ? "bg-cyan-500/70" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                fresh ? "left-[1.125rem]" : "left-0.5"
              }`}
            />
          </span>
        </button>
      </section>

      {r.lastStatus && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Last run</h3>
          <div className="mt-2 rounded-xl border border-white/10 bg-black/20 p-3">
            <p className="text-xs">
              <span className={STATUS_STYLE[r.lastStatus] ?? "text-zinc-400"}>{r.lastStatus}</span>
              <span className="text-zinc-600">
                {" "}
                · {when(r.lastRun)}
                {r.lastMs ? ` · took ${Math.round(r.lastMs / 1000)}s` : ""}
              </span>
            </p>
            {r.lastOutput && (
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-400">
                {r.lastOutput}
              </pre>
            )}
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Sessions ({runs.length})
          </h3>
          <ul className="mt-2 space-y-1">
            {runs.slice(0, 8).map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => onOpenSession(s.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-left text-xs text-zinc-300 transition hover:bg-white/5"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            act("save", async () => {
              await api.updateRoutine(r.id, {
                name,
                schedule,
                instructions,
                freshSession: fresh,
              });
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            })
          }
          disabled={busy !== null || !dirty}
          className={primaryCls}
        >
          {busy === "save" ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <LuCheck className="h-4 w-4" />
          ) : null}
          {saved ? "Saved" : "Save"}
        </button>

        <button
          onClick={() => act("run", () => api.runRoutine(r.id))}
          disabled={busy !== null}
          className={btnCls}
          title="Run it now, without waiting for the schedule"
        >
          {busy === "run" ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <LuPlay className="h-4 w-4" />
          )}
          {busy === "run" ? "Running…" : "Run now"}
        </button>

        <button
          onClick={() => {
            if (confirm(`Delete "${r.name}"? Its sessions are kept.`)) {
              act("save", async () => {
                await api.deleteRoutine(r.id);
                onBack();
              });
            }
          }}
          disabled={busy !== null}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
        >
          <LuTrash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </>
  );
}
