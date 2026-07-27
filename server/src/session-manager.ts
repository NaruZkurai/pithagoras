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
    });

    client.on("event", (msg) => {
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
   * Send a raw RPC command to a session's pi process, starting it if needed.
   * Backs the config panel — the equivalent of the TUI's slash commands.
   */
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
