import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PiClient } from "./pi/types.js";
import { findServerBuiltin, runBuiltin } from "./pi/builtins.js";
import { buildExecutor, type Executor, type ExecutorKind } from "./executors/index.js";
import {
  appendEvent,
  getSession,
  getSettings,
  markOrphanedSessionsInterrupted,
  updateSession,
} from "./db.js";

const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || "./data/sessions");
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

  constructor() {
    super();
    this.setMaxListeners(0);
    mkdirSync(SESSION_ROOT, { recursive: true });
    const orphaned = markOrphanedSessionsInterrupted();
    if (orphaned > 0) {
      console.log(`[portal] marked ${orphaned} session(s) interrupted (server restarted mid-run)`);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.client.running ?? false;
  }

  /** Record an event: persist it, then fan out to any attached SSE clients. */
  private record(sessionId: string, type: string, payload: unknown): void {
    if (EPHEMERAL_EVENTS.has(type)) {
      // Still deliver it to anyone attached right now, with a negative seq so
      // it can never be confused with a stored event during replay.
      this.emit(`session:${sessionId}`, {
        seq: -Date.now(),
        session_id: sessionId,
        type,
        payload: JSON.stringify(payload),
      });
      return;
    }
    const row = appendEvent(sessionId, type, payload);
    this.emit(`session:${sessionId}`, row);
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
    const client = await executor.launch({
      sessionId,
      workspacePath: session.workspace,
      provider: session.provider || settings.provider,
      model: session.model || settings.model || undefined,
      thinkingLevel: session.thinking_level || settings.thinkingLevel || undefined,
      sessionFile: session.pi_session_file || undefined,
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

    client.on("event", (msg) => {
      rememberSessionFile();
      this.record(sessionId, msg.type, msg);
      // agent_end marks the end of a run — the task is done whether or not
      // anyone was watching.
      if (msg.type === "agent_end") {
        updateSession(sessionId, { status: "idle" });
        this.record(sessionId, "portal_status", { status: "idle" });
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
   * Submit a prompt. Resolves once pi has accepted it — deliberately not when
   * the work finishes, so the HTTP request returns immediately and the run
   * continues in the background.
   */
  async prompt(sessionId: string, message: string): Promise<void> {
    const client = await this.ensureClient(sessionId);

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
    if (!isCommand) this.record(sessionId, "portal_prompt", { message });
    this.record(sessionId, "portal_status", { status: "running" });
    try {
      await client.prompt(message);
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
       * Called with each assistant message as it completes, so a channel can
       * send what the agent says between tool calls instead of going quiet for
       * minutes. When supplied, ask() resolves with "" — everything has already
       * been handed over, and returning it again would post it twice.
       */
      onReply?: (text: string) => void | Promise<void>;
    } = {}
  ): Promise<string> {
    const previous = this.asking.get(sessionId) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(() => this.askNow(sessionId, message, opts.timeoutMs ?? 15 * 60_000, opts.onReply));
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
    onReply?: (text: string) => void | Promise<void>
  ): Promise<string> {
    await this.ensureClient(sessionId);

    // pi emits one assistant message per stretch of talking, broken up by tool
    // calls. Each is flushed as it closes so a channel can relay progress
    // rather than sitting silent while a long task runs.
    let current = "";
    const all: string[] = [];
    let settle: (() => void) | undefined;
    let fail: ((e: Error) => void) | undefined;

    const flush = () => {
      const done = current.trim();
      current = "";
      if (!done) return;
      all.push(done);
      // Delivery is the channel's problem; a failure there must not take down
      // the run that produced it.
      void Promise.resolve(onReply?.(done)).catch(() => {});
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
        case "agent_end":
          // Anything not closed by a message_end still belongs to the answer.
          flush();
          settle?.();
          break;
        case "portal_status":
          if (payload.status === "error") fail?.(new Error(String(payload.error ?? "run failed")));
          if (payload.status === "idle" && payload.aborted) {
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
      await this.prompt(sessionId, message);
      await finished;
      // Already relayed piece by piece; handing it back would post it twice.
      return onReply ? "" : all.join("\n\n").trim();
    } finally {
      clearTimeout(timer);
      this.off(`session:${sessionId}`, onEvent);
    }
  }

  /**
   * Whether a run is in flight. Checked before queueing an interrupt, which
   * would otherwise wait politely behind the very task it means to stop.
   */
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

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export const sessions = new SessionManager();
export { SESSION_ROOT, EXECUTOR_KIND };
