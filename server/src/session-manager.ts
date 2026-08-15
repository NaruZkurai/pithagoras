import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { PersonRow, Role } from "./people.js";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { PiClient } from "./pi/types.js";
import { findServerBuiltin, runBuiltin } from "./pi/builtins.js";
import { buildExecutor, type Executor, type ExecutorKind } from "./executors/index.js";
import { destroySandboxContainer } from "./pi/sandbox-fs.js";
import { appendEvent, appendThreadMessage, createSession, createThread, getSession, getSettings, getThread, listThreadMessages, listThreads, markOrphanedSessionsInterrupted, updateSession } from "./db.js";
import { ingestMessageCcvs } from "./ccv.js";
import { captureCheckpoint } from "./checkpoint.js";
import { ensureMainModelServer } from "./model-server.js";
import { fleetJudge } from "./fleet-judge.js";

/**
 * Thinking markers that escape into the answer.
 *
 * A reasoning model sometimes closes a thought inside the text it means to say,
 * and a stray </think> then travels to whoever is reading — a chat window, a
 * Telegram message. Stripped where the text leaves the portal rather than in
 * the stored events, so the record of what the model actually produced stays
 * intact.
 */
export const stripThinkingMarkers = (text: string): string =>
  text.replace(/<\/?think(ing)?>/gi, "").trim();

/** Mirrors what the web transcript shows, so a chat and the UI agree. */
function summarizeToolInput(p: any): string | undefined {
  const input = p.input ?? p.args ?? p.parameters;
  if (!input) return undefined;
  const trim = (v: string) => (v.length > 80 ? `${v.slice(0, 79)}…` : v);
  if (typeof input === "string") return trim(input);
  if (typeof input === "object") {
    const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
    if (typeof first === "string") return trim(first);
    return trim(JSON.stringify(input));
  }
  return undefined;
}

/** The plain text of a pi message, used to wake message-triggered routines. */
function extractMessageText(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .join("")
    .trim();
}

const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || "./data/sessions");
// Each agent is filesystem-sandboxed to its own workspace by default (see the
// guard extension). EXECUTOR=container opts into full OS isolation in a
// throwaway Docker container; EXECUTOR=host disables the in-process confinement
// unless the guard still filters paths.
const EXECUTOR_KIND = (process.env.EXECUTOR || "host") as ExecutorKind;

/**
 * Events that must not be persisted.
 *
 * Beyond noise, extension dialogs are strictly live: a stored
 * extension_ui_request would be replayed to every future reader, so reloading
 * the page reopened a dialog whose extension had long since stopped waiting.
 */
const EPHEMERAL_EVENTS = new Set([
  "queue_update",
  "extension_ui_request",
  "extension_ui_cancel",
]);

interface LiveSession {
  client: PiClient;
  executor: Executor;
}

/**
 * Per-session tracker for the auto-continue nudge.
 *
 * When an agent's turn ends having only run tools and delivered no final
 * answer, it usually stopped mid-chain (the model "decided" it was done after
 * a shell command instead of finishing the task). We nudge it to keep going,
 * but only up to MAX_AUTO_CONTINUES per task so a genuinely stuck agent cannot
 * spin forever.
 */
interface TurnState {
  /** tool_execution_start events seen in the current turn. */
  toolCalls: number;
  /** A substantive assistant message closed in the current turn. */
  answered: boolean;
  /** Auto-continue nudges issued since the last user task began. */
  streak: number;
}

/**
 * Per-session tracker for the "you are wasting time" nudge.
 *
 * After every action (a completed tool call) and on thought milestones we warn
 * the agent how long it has been running without editing a file. Guarantees:
 *   - every nudge text is built from the LIVE state (elapsed, action count,
 *     file-edit count) so it is never a duplicate string, and
 *   - we never resend the original task or earlier content — each warning is a
 *     short, fresh, standalone nudge that references only the current moment.
 */
interface TimeWarnState {
  /** When the current task/run began. */
  startedAt: number;
  /** Completed tool-call events since start. */
  actions: number;
  /** Distinct nudge texts already sent (dedupe guard). */
  sent: Set<string>;
  /** Last seq a nudge was attached to, so one action gets at most one nudge. */
  lastSeq: number;
}

/** How long a task may run before we start warning. */
const TIME_WARN_AFTER_MS = 20_000;
/** Never send more than one warning per distinct action. */
const TIME_WARN_MAX = 8;

/** How many times a stalled turn is nudged before we stop asking. */
const MAX_AUTO_CONTINUES = 3;
/** The nudge sent to an agent that stopped mid-chain without an answer. */
const CONTINUE_NUDGE =
  "You stopped in the middle of the task without producing a final answer — " +
  "several of your last steps ran tools but no reply followed. Continue from " +
  "where you left off and finish the task completely. If you hit a genuine " +
  "blocker, say so plainly and stop.";

/**
 * Owns every running pi process.
 *
 * The important property: a run is tied to this manager, not to any HTTP
 * request. Once a prompt is accepted the browser can disappear — output keeps
 * streaming into the event log, and a later reconnect replays it.
 */
class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>();
  /** In-flight ask() per session, so messages in one chat are answered in turn. */
  private asking = new Map<string, Promise<string>>();
  /**
   * Who sent the message being handled, per session.
   *
   * Per message rather than per session because a group conversation has many
   * senders: the guard asks this at tool-call time so capability follows whoever
   * is actually speaking, not whoever spoke first.
   */
  private speaker = new Map<string, PersonRow>();
  /** Auto-continue state per session. */
  private turn = new Map<string, TurnState>();

  /** Time-waste warning state per session. */
  private timeWarn = new Map<string, TimeWarnState>();

  private turnState(sessionId: string): TurnState {
    let t = this.turn.get(sessionId);
    if (!t) {
      t = { toolCalls: 0, answered: false, streak: 0 };
      this.turn.set(sessionId, t);
    }
    return t;
  }

  private timeWarnState(sessionId: string): TimeWarnState {
    let s = this.timeWarn.get(sessionId);
    if (!s) {
      s = { startedAt: Date.now(), actions: 0, sent: new Set(), lastSeq: 0 };
      this.timeWarn.set(sessionId, s);
    }
    return s;
  }

  /** Reset the time-warning clock when a fresh task begins. */
  private resetTimeWarn(sessionId: string): void {
    this.timeWarn.set(sessionId, { startedAt: Date.now(), actions: 0, sent: new Set(), lastSeq: 0 });
  }

  /**
   * Warn the agent it is spending too long, after an action or a thought.
   *
   * Called on a completed tool call and on thought milestones. Builds a SHORT,
   * FRESH nudge from the live moment (elapsed seconds, action count, file-edit
   * count) so the text is unique — never a resend of the task or of an earlier
   * warning. Also consults the 4B FLEET (independent judges) on whether the
   * agent is actually making progress; if they say "no", the nudge escalates.
   * One nudge per distinct action; capped so we never spam.
   */
  private async maybeWarnTimeWasted(
    sessionId: string,
    seq: number,
    editedFiles: () => number
  ): Promise<void> {
    const s = this.timeWarnState(sessionId);
    if (s.sent.size >= TIME_WARN_MAX) return; // never spam past the cap
    if (s.lastSeq === seq) return; // one nudge per action/milestone
    const elapsedSec = Math.round((Date.now() - s.startedAt) / 1000);
    if (elapsedSec < TIME_WARN_AFTER_MS / 1000) return; // not yet wasting time

    const edits = editedFiles();
    let fleetLine = "";
    let escalate = false;
    try {
      // Independent progress judgment from the four 4B models.
      const verdict = await fleetJudge(
        `Session ${sessionId}: ${s.actions} tool actions so far, ~${elapsedSec}s elapsed, ${edits} file(s) edited.`
      );
      if (verdict.inconclusive) {
        fleetLine = "";
      } else {
        fleetLine = verdict.progress
          ? ` (fleet says: making progress)`
          : ` (fleet says: NOT making progress — ${verdict.reason || "stuck"})`;
        escalate = !verdict.progress;
      }
    } catch {
      fleetLine = "";
    }

    // Build a UNIQUE warning from live state only (no duplicate content, no
    // re-sent task). Escalate when the fleet independently votes "no progress".
    const text =
      `[time-warning] You have been working for ~${elapsedSec}s (${s.actions} tool ` +
      `actions, ${edits} file(s) edited)${fleetLine}. ` +
      (escalate
        ? `The independent judges say you are NOT making progress — STOP reading and ` +
          `thinking and make a concrete file edit with a write/edit tool NOW. The ` +
          `deliverable is one changed source file that passes the build.`
        : `You are spending too long reading/thinking without producing a file edit. ` +
          `Make the concrete edit NOW with a write/edit tool and verify it builds.`);
    s.lastSeq = seq;
    s.actions += 1;
    if (s.sent.has(text)) return; // belt-and-braces: never repeat identical text
    s.sent.add(text);

    const live = this.live.get(sessionId);
    if (!live) return;
    await live.client
      .prompt(text, "followUp")
      .catch((e) => console.warn(`[time-warn ${sessionId}] failed: ${(e as Error).message}`));
  }

  constructor() {
    super();
    this.setMaxListeners(0);
    mkdirSync(SESSION_ROOT, { recursive: true });
    const orphaned = markOrphanedSessionsInterrupted();
    if (orphaned > 0) {
      console.log(`[portal] marked ${orphaned} session(s) interrupted (server restarted mid-run)`);
    }
  }

  /** How many sessions have a live pi client right now. */
  runningCount(): number {
    let n = 0;
    for (const s of this.live.values()) if (s.client.running) n++;
    return n;
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.client.running ?? false;
  }

  /** Record an event: persist it, then fan out to any attached SSE clients. */
  private record(sessionId: string, type: string, payload: unknown): number {
    if (EPHEMERAL_EVENTS.has(type)) {
      // Still deliver it to anyone attached right now, with a negative seq so
      // it can never be confused with a stored event during replay.
      this.emit(`session:${sessionId}`, {
        seq: -Date.now(),
        session_id: sessionId,
        type,
        payload: JSON.stringify(payload),
      });
      return -Date.now();
    }
    const row = appendEvent(sessionId, type, payload);
    this.emit(`session:${sessionId}`, row);
    return row.seq;
  }

  /**
   * Nudge an agent whose turn ended mid-chain.
   *
   * Called on `agent_end` when the finished turn ran tools but never delivered
   * a final answer — the classic "stops responding / stops its chain" failure.
   * Sends a `followUp` continue message through the client directly (not via
   * prompt(), so it does not swallow the caller's task bookkeeping or reset the
   * streak) and caps the number of nudges per user task.
   */
  private async maybeAutoContinue(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    const t = this.turnState(sessionId);
    // Only nudge a turn that did real tool work and never answered.
    if (t.toolCalls === 0 || t.answered || t.streak >= MAX_AUTO_CONTINUES) return;
    t.streak += 1;
    t.toolCalls = 0;
    t.answered = false;
    console.log(
      `[auto-continue ${sessionId}] nudging stalled agent (${t.streak}/${MAX_AUTO_CONTINUES})`
    );
    try {
      await live.client.prompt(CONTINUE_NUDGE, "followUp");
    } catch (e) {
      console.warn(`[auto-continue ${sessionId}] nudge failed: ${(e as Error).message}`);
    }
  }

  private async ensureClient(sessionId: string): Promise<PiClient> {
    const existing = this.live.get(sessionId);
    if (existing?.client.running) return existing.client;

    const session = getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);

    const executor = buildExecutor(EXECUTOR_KIND, SESSION_ROOT);
    mkdirSync(path.join(SESSION_ROOT, sessionId), { recursive: true });

    // The session's own choices win over the portal defaults. Without this a
    // restart relaunched pi on the default model, quietly undoing the pick.
    const settings = getSettings();
    // Lazy model startup: with LAZY_MODELS on, nothing is pinned at boot. Bring
    // up the local llama server pi will talk to before launching the session.
    const provider = session.provider || settings.provider || "local";
    if (provider === "local") await ensureMainModelServer();
    const client = await executor.launch({
      sessionId,
      workspacePath: session.workspace,
      provider: session.provider || settings.provider,
      model: session.model || settings.model || undefined,
      thinkingLevel: session.thinking_level || settings.thinkingLevel || undefined,
      sessionFile: session.pi_session_file || undefined,
      // Channels only. A task session works inside somebody's repository and
      // has no business rescheduling anything; a routine run is excluded too,
      // since a routine that can create routines can build a chain unwatched.
      routineTools: session.kind === "agent",
      // A thread is its own session; give it the thread agent + confirmation
      // tools so it stays a focused sub-agent with a database but no other
      // cross-thread memory.
      threadId: session.kind === "thread" ? sessionId : undefined,
      // A routine run gets the report tool instead: it is the one kind of
      // session with nobody on the other end to read what it found.
      routineSlug: session.kind === "routine" ? session.routine_slug : undefined,
      // The session's settled role picks the context files; the live one gates
      // each tool call, so a group conversation follows whoever is speaking.
      role: session.role,
      whoNow: () => ({ role: this.speakerRole(sessionId), key: this.speakerKey(sessionId) }),
    });

    // pi writes the file lazily, so it usually does not exist yet at launch.
    // Recorded the first time it appears; from then on this exact conversation
    // is what gets reopened.
    let recordedFile = session.pi_session_file;
    const rememberSessionFile = () => {
      if (recordedFile) return;
      const file = client.sessionFile;
      if (!file) return;
      recordedFile = file;
      updateSession(sessionId, { pi_session_file: file });
    };
    rememberSessionFile();

    let currentAssistantSeq: number | null = null;
    client.on("event", (msg) => {
      rememberSessionFile();
      const seq = this.record(sessionId, msg.type, msg);

      // Track the current turn for the auto-continue stall detector.
      const turn = this.turnState(sessionId);
      if (msg.type === "tool_execution_start") turn.toolCalls += 1;
      // A user message (or portal status change) starts a fresh logical task:
      // reset the streak and turn counters so the cap applies per task.
      if (msg.type === "portal_status" && msg.status === "running") {
        turn.toolCalls = 0;
        turn.answered = false;
        // A fresh task restarts the time-warning clock too.
        this.resetTimeWarn(sessionId);
      }

      // Time-waste warnings: after every completed action (tool call) and on
      // thought milestones, nudge the agent with a fresh warning and never
      // resend duplicate content.
      const editedFiles = () => {
        try {
          const ws = getSession(sessionId)?.workspace;
          if (!ws) return 0;
          const out = execFileSync("git", ["diff", "--name-only"], {
            cwd: ws,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return out.split("\n").filter(Boolean).length;
        } catch {
          return 0;
        }
      };
      if (msg.type === "tool_execution_end") void this.maybeWarnTimeWasted(sessionId, seq, editedFiles);
      else if (msg.type === "message_update") void this.maybeWarnTimeWasted(sessionId, seq, editedFiles);

      // Remember which event each assistant message starts at — its thread is
      // keyed on that seq so it lines up with the transcript's message id.
      if (msg.type === "message_update") {
        const inner = msg.assistantMessageEvent ?? {};
        if (typeof inner.delta === "string" && inner.delta && currentAssistantSeq === null) {
          currentAssistantSeq = seq;
        }
      }
      // A completed agent message wakes message-triggered routines. Routine
      // sessions are skipped inside the supervisor, so a run can never loop on
      // its own output.
      if (msg.type === "message_end" && msg.message) {
        // Ingest this message's atoms as callable chat variables (CCVs) so
        // every thought, message, tool call and shell output is hashed and
        // callable/rememberable. Assistant messages use currentAssistantSeq so
        // a CCV's seq matches the timeline key the UI shows for that message.
        const ccvSeq =
          msg.message.role === "assistant" && currentAssistantSeq !== null
            ? currentAssistantSeq
            : seq;
        ingestMessageCcvs({ sessionId, seq: ccvSeq, role: msg.message.role, message: msg.message });
        // Anchor this completed agent message to the workspace git state.
        const ws = getSession(sessionId)?.workspace;
        if (ws) void captureCheckpoint(sessionId, ccvSeq, ws);
        if (msg.message.role === "assistant") {
          const text = extractMessageText(msg.message);
          if (text) {
            // A substantive assistant reply closes the turn: it is not stalled.
            turn.answered = true;
            this.emit("message_complete", sessionId, session.kind, text);
            // Log every agent message into the thread attached to it, not just
            // the last one when a run finishes.
            if (currentAssistantSeq !== null) {
              this.logAgentMessageToThread(sessionId, currentAssistantSeq, text);
            }
          }
          currentAssistantSeq = null;
        }
      }
      // agent_end marks the end of a run — the task is done whether or not
      // anyone was watching.
      if (msg.type === "agent_end") {
        updateSession(sessionId, { status: "idle" });
        this.record(sessionId, "portal_status", { status: "idle" });
        // If it stopped mid-chain without answering, nudge it to keep going.
        void this.maybeAutoContinue(sessionId);
      }
    });

    client.on("stderr", (chunk: string) => {
      const text = chunk.trim();
      if (text) this.record(sessionId, "stderr", { text });
    });

    client.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      this.live.delete(sessionId);
      const current = getSession(sessionId);
      // A clean exit after a finished run is normal; anything else is a failure
      // worth surfacing in the UI rather than leaving as a silent stall.
      if (current?.status === "running") {
        const message = `pi exited unexpectedly (code=${code} signal=${signal})`;
        updateSession(sessionId, { status: "error", last_error: message });
        this.record(sessionId, "portal_status", { status: "error", error: message });
      }
      executor.cleanup?.(sessionId).catch(() => {});
    });

    this.live.set(sessionId, { client, executor });

    return client;
  }

  /**
   * Log a completed agent message into the thread attached to it. One thread
   * per message (like Discord). The message becomes the thread's parent — so
   * every agent message is recorded in a thread of its own, not just the last
   * one when a run finishes. If the message already had a thread, the new text
   * is appended to that thread's log as well.
   */
  private logAgentMessageToThread(sessionId: string, parentSeq: number, text: string): void {
    const session = getSession(sessionId);
    // Plain task sessions only — never a thread-of-a-thread, and no routine or
    // channel chatter auto-threading itself into the list.
    if (!session || session.kind !== "task") return;
    const parentText = text.slice(0, 20000);
    let thread = listThreads(sessionId).find((t) => t.parent_seq === parentSeq);
    const existing = !!thread;
    if (!thread) {
      const id = nanoid(12);
      createThread({
        id,
        session_id: sessionId,
        parent_seq: parentSeq,
        parent_role: "assistant",
        parent_text: parentText,
      });
      createSession({
        id,
        title: `Thread on ${parentText.slice(0, 40)}`,
        workspace: session.workspace,
        executor: EXECUTOR_KIND,
        kind: "thread",
      });
      thread = getThread(id)!;
    }
    // Fresh threads already carry the message as their parent; only append when
    // the thread existed before this message (e.g. the user already threaded
    // it), and never duplicate the exact same text.
    if (!existing || !thread) return;
    const msgs = listThreadMessages(thread.id);
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && last.content === parentText) return;
    appendThreadMessage({
      id: nanoid(12),
      thread_id: thread.id,
      role: "assistant",
      content: parentText,
    });
  }

  /**
   * Submit a prompt. Resolves once pi has accepted it — deliberately not when
   * the work finishes, so the HTTP request returns immediately and the run
   * continues in the background.
   */
  async prompt(sessionId: string, message: string, behavior: "followUp" | "steer" = "followUp"): Promise<void> {
    const client = await this.ensureClient(sessionId);

    // Every task keeps the main model server alive: reset its idle timer, and
    // if the idle sweep stopped it, relaunch it with the configured model so a
    // reused client never talks to a dead port.
    const promptSession = getSession(sessionId);
    const promptProvider = promptSession?.provider || getSettings().provider || "local";
    // Whether the agent was already mid-turn before this message arrived. Only
    // a genuinely queued/steered message gets the context framing below — a
    // plain send to an idle agent is just a normal message.
    const wasRunning = promptSession?.status === "running";
    if (promptProvider === "local") await ensureMainModelServer();

    // A slash command is an instruction to the agent, not something said in the
    // conversation, so it should not appear as a chat message — its dialog or
    // output is the feedback. Matched against the real command list rather than
    // a bare leading slash, so a message that merely starts with a path like
    // "/etc/hosts is wrong" is still shown.
    const isCommand = await this.looksLikeCommand(client, message);

    // Portal builtins never reach the model — they act on the session itself.
    const builtin = /^\/([\w-]+)\s*(.*)$/.exec(message.trim());
    const serverBuiltin = builtin ? await findServerBuiltin(builtin[1]) : undefined;
    if (serverBuiltin) {
      // Not awaited: /compact is a model call and would hold the request open.
      // Same contract as a prompt — accept it, report through the event stream.
      updateSession(sessionId, { status: "running", last_error: null });
      this.record(sessionId, "portal_status", { status: "running" });
      void (async () => {
        try {
          const text = await runBuiltin(serverBuiltin.name, builtin![2], client);
          this.record(sessionId, "portal_notice", { text });
        } catch (e) {
          this.record(sessionId, "portal_notice", { text: (e as Error).message, error: true });
        } finally {
          updateSession(sessionId, { status: "idle" });
          this.record(sessionId, "portal_status", { status: "idle" });
        }
      })();
      return;
    }

    updateSession(sessionId, { status: "running", last_error: null });
    if (!isCommand) {
      const seq = this.record(sessionId, "portal_prompt", { message });
      // The user's own message is a CCV too.
      ingestMessageCcvs({
        sessionId,
        seq,
        role: "user",
        message: { role: "user", content: [{ type: "text", text: message }] },
      });
      // Anchor this user message to the workspace git state at this point.
      const ws = getSession(sessionId)?.workspace;
      if (ws) void captureCheckpoint(sessionId, seq, ws);
    }
    this.record(sessionId, "portal_status", { status: "running" });
    try {
      // Frame queued / steered messages so the model understands the context —
      // only when the agent was actually mid-turn. The user's own transcript
      // copy is kept untouched (recorded above).
      const framed =
        wasRunning && behavior === "steer"
          ? `[The user interrupted you with this message — treat it as a priority instruction and redirect your attention to it now]\n\n${message}`
          : wasRunning && behavior === "followUp"
            ? `[This message was queued by the user while you were working; your previous reply is done and this is the follow-up to it]\n\n${message}`
            : message;
      await client.prompt(framed, behavior);
      // A slash command completes inside prompt() without starting an agent
      // turn, so no agent_end arrives to clear the status. Settle it here
      // rather than leaving "working" on screen forever.
      const idle = (client as { isIdle?: () => boolean }).isIdle?.();
      if (idle) {
        updateSession(sessionId, { status: "idle" });
        this.record(sessionId, "portal_status", { status: "idle" });
      }
    } catch (e) {
      const message = (e as Error).message;
      updateSession(sessionId, { status: "error", last_error: message });
      this.record(sessionId, "portal_status", { status: "error", error: message });
      throw e;
    }
  }

  /**
   * Prompt and wait for the answer.
   *
   * The inverse of prompt(), which returns the moment pi accepts a message —
   * the property the whole portal is built on. A channel needs the opposite:
   * somebody is sitting in a chat waiting for a reply, so this blocks until the
   * turn finishes and hands back what the agent said.
   *
   * Serialised per session. Two messages arriving in the same chat while the
   * agent is still working would otherwise interleave, and both callers would
   * see whichever agent_end came first.
   */
  ask(
    sessionId: string,
    message: string,
    opts: {
      timeoutMs?: number;
      /**
       * Relays what happens during the run — assistant prose as each stretch
       * completes, and the name of every tool as it starts.
       */
      onReply?: (text: string) => void | Promise<void>;
      /**
       * Whether prose goes through onReply as well as tool lines.
       *
       * When it does, ask() resolves with "" — it has all been handed over, and
       * returning it too would post everything twice. When it does not, only
       * tool lines are relayed and the prose comes back at the end, which is
       * what a channel showing activity but not partial answers wants.
       */
      streamText?: boolean;
      /**
       * An extension asking the user something mid-run. The browser draws a
       * modal for these; a channel has to ask in the chat and wait for the
       * next message, so it needs to know one is open.
       */
      onUi?: (request: any) => void;
    } = {}
  ): Promise<string> {
    const previous = this.asking.get(sessionId) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(() =>
        this.askNow(
          sessionId,
          message,
          opts.timeoutMs ?? 15 * 60_000,
          opts.onReply,
          opts.streamText,
          opts.onUi
        )
      );
    // Kept only while it is the newest, so a finished chain is not held forever.
    this.asking.set(sessionId, next);
    void next.catch(() => {}).finally(() => {
      if (this.asking.get(sessionId) === next) this.asking.delete(sessionId);
    });
    return next;
  }

  private async askNow(
    sessionId: string,
    message: string,
    timeoutMs: number,
    onReply?: (text: string) => void | Promise<void>,
    streamText = true,
    onUi?: (request: any) => void
  ): Promise<string> {
    await this.ensureClient(sessionId);

    // pi emits one assistant message per stretch of talking, broken up by tool
    // calls. Each is flushed as it closes so a channel can relay progress
    // rather than sitting silent while a long task runs.
    let current = "";
    const all: string[] = [];
    let settle: (() => void) | undefined;
    let fail: ((e: Error) => void) | undefined;

    // Delivery is the channel's problem; a failure there must not take down the
    // run that produced it.
    const relay = (line: string) => void Promise.resolve(onReply?.(line)).catch(() => {});

    const flush = () => {
      const done = current.trim();
      current = "";
      if (!done) return;
      all.push(done);
      if (streamText) relay(done);
    };

    const onEvent = (row: { type: string; payload: string }) => {
      let payload: any = {};
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return;
      }
      switch (row.type) {
        case "message_update": {
          const inner = payload.assistantMessageEvent ?? {};
          // Thinking deltas are not the answer, and nobody in a chat wants them.
          if (inner.type === "text_delta" && typeof inner.delta === "string") {
            current += inner.delta;
          }
          break;
        }
        case "message_end":
          flush();
          break;

        case "tool_execution_start": {
          if (!onReply) break;
          // Prose first: a tool line landing mid-sentence reads badly.
          flush();
          const name = String(payload.toolName ?? payload.name ?? "tool");
          const detail = summarizeToolInput(payload);
          relay(detail ? `⚙ ${name} · ${detail}` : `⚙ ${name}`);
          break;
        }
        // Output from a builtin like /session or /compact. It is the answer as
        // far as whoever asked is concerned, so it goes back like any other.
        case "portal_notice":
          flush();
          if (typeof payload.text === "string" && payload.text.trim()) {
            all.push(payload.text.trim());
            if (streamText) relay(payload.text.trim());
          }
          break;

        // An extension is blocking on an answer. Handed straight over: whoever
        // is asking has to put the question somewhere a human will see it.
        case "extension_ui_request":
          flush();
          onUi?.(payload);
          break;

        // The dialog gave up waiting.
        case "extension_ui_cancel":
          onUi?.({ ...payload, cancelled: true });
          break;

        case "agent_end":
          // Anything not closed by a message_end still belongs to the answer.
          flush();
          settle?.();
          break;

        case "portal_status":
          if (payload.status === "error") fail?.(new Error(String(payload.error ?? "run failed")));
          // Settled on idle, not only on agent_end. A slash command completes
          // without ever starting an agent turn, so waiting for agent_end hung
          // until the timeout — and because asks are serialised per session,
          // every later message in that chat queued behind it.
          if (payload.status === "idle") {
            flush();
            settle?.();
          }
          break;
      }
    };

    // Attached before prompting: a fast reply would otherwise finish before
    // anyone was listening.
    this.on(`session:${sessionId}`, onEvent);
    const timer = setTimeout(
      () => fail?.(new Error(`The agent did not finish within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );

    try {
      const finished = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      // A failure is delivered twice: as a portal_status event (rejecting
      // `finished` here) and as a throw from prompt(). If prompt() throws
      // first, `finished` is never awaited — so attach a handler now, or that
      // orphaned rejection takes down the whole process.
      finished.catch(() => {});
      await this.prompt(sessionId, message);
      await finished;
      // Already relayed piece by piece; handing it back would post it twice.
      // Streamed already, so handing it back would post it twice.
      return onReply && streamText ? "" : all.join("\n\n").trim();
    } finally {
      clearTimeout(timer);
      this.off(`session:${sessionId}`, onEvent);
    }
  }

  /**
   * Whether a run is in flight. Checked before queueing an interrupt, which
   * would otherwise wait politely behind the very task it means to stop.
   */
  setSpeaker(sessionId: string, person: PersonRow): void {
    this.speaker.set(sessionId, person);
  }

  /**
   * The role in force right now.
   *
   * Falls back to the conversation's own role, never to "primary". Only channel
   * messages identify a speaker; a message sent through the portal's prompt
   * endpoint identifies nobody, and defaulting to primary there handed a
   * colleague's conversation full privileges — the conversation is still theirs,
   * and they still read whatever comes back.
   */
  speakerRole(sessionId: string): Role {
    const live = this.speaker.get(sessionId);
    if (live) return live.role;
    const row = getSession(sessionId);
    return (row?.role as Role) ?? "guest";
  }

  /** Who is speaking, surviving a restart via the session's own record. */
  speakerKey(sessionId: string): string | undefined {
    return this.speaker.get(sessionId)?.key ?? getSession(sessionId)?.last_person_key ?? undefined;
  }

  currentSpeaker(sessionId: string): PersonRow | undefined {
    return this.speaker.get(sessionId);
  }

  isBusy(sessionId: string): boolean {
    if (this.asking.has(sessionId)) return true;
    return getSession(sessionId)?.status === "running";
  }

  /** Access the live client for config reads and writes, starting pi if needed. */
  client(sessionId: string): Promise<PiClient> {
    return this.ensureClient(sessionId);
  }

  /** True when the message invokes a command pi actually knows about. */
  private async looksLikeCommand(client: PiClient, message: string): Promise<boolean> {
    const match = /^\/([\w:-]+)/.exec(message.trim());
    if (!match) return false;
    try {
      const commands = await client.getCommands();
      return commands.some((c) => c.name === match[1]);
    } catch {
      return false;
    }
  }

  /** Answer an extension dialog for a live session. */
  respondUi(sessionId: string, id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    return this.live.get(sessionId)?.client.respondUi(id, response) ?? false;
  }

  async abort(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.client.running) return;
    await live.client.abort().catch(() => {});
    updateSession(sessionId, { status: "idle" });
    this.record(sessionId, "portal_status", { status: "idle", aborted: true });
  }

  async stop(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.client.dispose();
    this.live.delete(sessionId);
    await live.executor.cleanup?.(sessionId).catch(() => {});
  }

  /**
   * Permanently tear down a session: stop its agent process and delete its
   * persistent sandbox container. Called only when the session itself is
   * deleted. Mere inactivity never destroys the container — an idle session
   * keeps its container warm so its caches and background state still exist
   * when it's asked something again.
   */
  async destroy(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    await destroySandboxContainer(sessionId).catch(() => {});
  }

  /** Drop the running process so the next turn rebuilds it — used when a
   * session's role changes and its context files must be reloaded. */
  async shutdownSession(sessionId: string): Promise<void> {
    await this.stop(sessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export const sessions = new SessionManager();
export { SESSION_ROOT, EXECUTOR_KIND };
