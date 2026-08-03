import { nanoid } from "nanoid";
import { createSession, findRoutineSession, getDb, type SessionRow } from "../db.js";
import { agentHome } from "../agent.js";
import { sessions, EXECUTOR_KIND } from "../session-manager.js";
import { isDue, nextRun, parseCron } from "./cron.js";
import { reportFraming, reportToFor } from "../pi/report-tool.js";

/**
 * Runs routines when they are due.
 *
 * A routine is a standing instruction and a schedule: when it fires the agent
 * is given the instruction, does the work, and goes quiet again. Nothing is
 * waiting on the other end the way a chat is, so a run is allowed to take as
 * long as it takes and its outcome is recorded rather than replied to.
 */

export interface RoutineRow {
  id: string;
  slug: string;
  name: string;
  enabled: number;
  /** What fires it: 'schedule' (cron/one-off) or 'message' (agent completed a message). */
  trigger: string;
  /** Where it is assigned: 'any' (every chat) or 'session' (one specific chat). */
  target: string;
  /** The chat a targeted routine is bound to. */
  target_session_id: string | null;
  schedule: string;
  /** An ISO instant, for a routine that runs once instead of repeating. */
  run_at: string | null;
  instructions: string;
  fresh_session: number;
  /**
   * Where this routine's reports go. null inherits the portal default; the
   * empty string means it never reports, whatever the default is.
   */
  report_channel: string | null;
  report_target: string | null;
  last_report_at: string | null;
  last_run: string | null;
  last_status: string | null;
  last_output: string | null;
  last_ms: number | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
}

/** How long a single run may take before it is abandoned. */
const RUN_TIMEOUT_MS = 60 * 60_000;

/** Enough of the outcome to see what happened without storing a transcript. */
const MAX_OUTPUT = 4000;

const TICK_MS = 20_000;

/**
 * A message-triggered routine fires at most this often, so one long agent turn
 * (several messages: tool calls, then the answer) does not fire it repeatedly.
 */
const MESSAGE_COOLDOWN_MS = 30_000;

/** What a message-triggered run is told about the message that woke it. */
const MAX_CONTEXT = 800;

class RoutineSupervisor {
  /** Routines with a run in flight — a slow one must not stack on itself. */
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** Last time each message-triggered routine fired, to enforce the cooldown. */
  private lastFired = new Map<string, number>();

  private rows(): RoutineRow[] {
    return getDb().prepare("SELECT * FROM routines").all() as RoutineRow[];
  }

  start(): void {
    if (this.timer) return;
    this.refreshSchedules();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    // Message-triggered routines react to completed agent messages.
    sessions.on("message_complete", this.handleMessageComplete);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    sessions.off("message_complete", this.handleMessageComplete);
  }

  /**
   * An agent message just completed. Fires every enabled message-triggered
   * routine, once per cooldown window.
   *
   * Routine sessions are skipped: a run's own messages must never re-trigger
   * it, or a message routine would loop forever on its own output.
   */
  onMessageComplete(sessionId: string, kind: string, text: string): void {
    // Routine sessions are skipped: a run's own messages must never re-trigger
    // it, or a message routine would loop forever on its own output. Threads
    // are skipped too: they are side-conversations, not the main chat.
    if (kind === "routine" || kind === "thread") return;
    const now = Date.now();
    for (const row of this.rows()) {
      if (!row.enabled || row.trigger !== "message") continue;
      // A routine assigned to one chat only reacts to that chat's replies.
      if (row.target === "session" && row.target_session_id && row.target_session_id !== sessionId)
        continue;
      if (this.running.has(row.slug)) continue;
      const last = this.lastFired.get(row.slug) ?? 0;
      if (now - last < MESSAGE_COOLDOWN_MS) continue;
      this.lastFired.set(row.slug, now);
      void this.run(row, "message", { sessionId, text });
    }
  }

  private handleMessageComplete = (sessionId: string, kind: string, text: string): void => {
    this.onMessageComplete(sessionId, kind, text);
  };

  /** Recompute when each routine fires next. Cheap, and keeps the UI honest. */
  refreshSchedules(): void {
    for (const row of this.rows()) {
      getDb().prepare("UPDATE routines SET next_run = ? WHERE id = ?").run(whenNext(row), row.id);
    }
  }

  isRunning(slug: string): boolean {
    return this.running.has(slug);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const row of this.rows()) {
      if (!row.enabled || this.running.has(row.slug)) continue;
      // Message-triggered routines fire on agent messages, not the clock.
      if (row.trigger === "message") continue;

      if (isOneOff(row)) {
        // Deliberately catches up: a one-off whose moment passed while the
        // server was down should still happen, unlike a recurring one which
        // simply waits for its next slot.
        if (row.last_run || new Date(row.run_at!) > now) continue;
        void this.run(row, "schedule");
        continue;
      }

      let cron;
      try {
        cron = parseCron(row.schedule);
      } catch {
        continue;
      }
      if (!isDue(cron, now, row.last_run ? new Date(row.last_run) : null)) continue;
      void this.run(row, "schedule");
    }
  }

  /**
   * Run one routine.
   *
   * Not awaited by the tick: a routine that takes twenty minutes must not hold
   * up every other one, and the next tick skips it because it is still marked
   * as running.
   */
  async run(
    row: RoutineRow,
    trigger: "schedule" | "manual" | "message",
    context?: { sessionId: string; text: string }
  ): Promise<RoutineRow> {
    if (this.running.has(row.slug)) throw new Error(`"${row.name}" is already running`);
    this.running.add(row.slug);

    const started = Date.now();
    // Written before the work, so a crash mid-run cannot make it fire again
    // the moment the server comes back.
    getDb()
      .prepare("UPDATE routines SET last_run = ?, last_status = 'running' WHERE id = ?")
      .run(new Date().toISOString(), row.id);

    try {
      const session = this.sessionFor(row);
      const output = await sessions.ask(session.id, prompt(row, trigger, context), {
        timeoutMs: RUN_TIMEOUT_MS,
      });
      this.finish(row.id, "ok", output, Date.now() - started);
    } catch (e) {
      this.finish(row.id, "error", (e as Error).message, Date.now() - started);
    } finally {
      this.running.delete(row.slug);
      // A one-off has nothing left to do. Disabled rather than deleted, so the
      // result stays readable and it can be re-armed by giving it a new time.
      if (isOneOff(row)) {
        getDb().prepare("UPDATE routines SET enabled = 0 WHERE id = ?").run(row.id);
      }
      this.refreshSchedules();
    }

    return getDb().prepare("SELECT * FROM routines WHERE id = ?").get(row.id) as RoutineRow;
  }

  private finish(id: string, status: string, output: string, ms: number): void {
    getDb()
      .prepare("UPDATE routines SET last_status = ?, last_output = ?, last_ms = ? WHERE id = ?")
      .run(status, (output ?? "").slice(0, MAX_OUTPUT), ms, id);
  }

  /**
   * The session a run happens in.
   *
   * By default a routine keeps one, so a run can see what the last one did —
   * "nothing new since yesterday" needs yesterday. `fresh_session` gives each
   * run a clean one instead, for work where history is only noise.
   */
  private sessionFor(row: RoutineRow): SessionRow {
    // A routine assigned to a chat does its work in that chat, so the files it
    // touches land in that chat's workspace. Except a message-triggered one: it
    // is woken BY a message in that chat, which is still in flight — asking the
    // same chat mid-turn collides with it, so it reacts to the chat but runs in
    // its own session instead.
    if (row.trigger !== "message" && row.target === "session" && row.target_session_id) {
      const target = getDb()
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(row.target_session_id) as SessionRow | undefined;
      if (target) return target;
    }

    if (!row.fresh_session) {
      const existing = findRoutineSession(row.slug);
      if (existing) return existing;
    }

    const id = nanoid(12);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    createSession({
      id,
      title: row.fresh_session ? `${row.name} — ${stamp}` : row.name,
      workspace: agentHome(),
      executor: EXECUTOR_KIND,
      kind: "routine",
      routine_slug: row.slug,
    });
    const created = getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
    return created;
  }
}

/**
 * What the agent is actually asked.
 *
 * The instruction is given verbatim, with a line of context around it: an agent
 * that does not know it was woken by a schedule tends to answer as if somebody
 * is waiting, and asks a follow-up question nobody will ever read.
 */
function prompt(
  row: RoutineRow,
  trigger: "schedule" | "manual" | "message",
  context?: { sessionId: string; text: string }
): string {
  const how =
    trigger === "manual"
      ? "run by hand"
      : trigger === "message"
        ? "because an agent just finished a message"
        : isOneOff(row)
          ? "at the time it was scheduled for"
          : `on its schedule (${row.schedule})`;
  const reporting = reportFraming(reportToFor(row.slug));
  const lines = [
    `<routine name="${row.name}" trigger="${how}">`,
    "This is a scheduled task. Nobody is waiting on a reply — do the work, then",
    "finish with a short account of what you did and anything that needs a human.",
    "Do not ask questions; there is nobody to answer them.",
    ...(reporting ? ["", reporting] : []),
    "</routine>",
  ];
  if (context?.text) {
    lines.push(
      "",
      "The routine fired because this agent reply just completed:",
      context.text.slice(0, MAX_CONTEXT),
    );
  }
  lines.push("", row.instructions.trim());
  return lines.join("\n");
}

/** A routine with a moment rather than a pattern. */
export const isOneOff = (row: { run_at: string | null; schedule: string }) =>
  Boolean(row.run_at) && !row.schedule.trim();

/** When it fires next, or null if it never will again. */
export function whenNext(row: RoutineRow): string | null {
  if (!row.enabled) return null;
  // Message-triggered routines have no clock slot — they fire on the next
  // completed agent message instead.
  if (row.trigger === "message") return null;
  if (isOneOff(row)) return row.last_run ? null : row.run_at;
  try {
    return nextRun(parseCron(row.schedule))?.toISOString() ?? null;
  } catch {
    // An unparseable schedule is reported by the API on save; here it simply
    // never fires.
    return null;
  }
}

export const routineSupervisor = new RoutineSupervisor();
