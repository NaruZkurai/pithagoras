import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PiRpcClient } from "./pi-rpc.js";
import { buildExecutor, type Executor, type ExecutorKind } from "./executors/index.js";
import {
  appendEvent,
  getSession,
  markOrphanedSessionsInterrupted,
  updateSession,
} from "./db.js";

const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || "./data/sessions");
const EXECUTOR_KIND = (process.env.EXECUTOR || "host") as ExecutorKind;

/** Events that carry no useful history and would bloat the log if persisted. */
const EPHEMERAL_EVENTS = new Set(["queue_update"]);

interface LiveSession {
  client: PiRpcClient;
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
    if (EPHEMERAL_EVENTS.has(type)) return;
    const row = appendEvent(sessionId, type, payload);
    this.emit(`session:${sessionId}`, row);
  }

  private async ensureClient(sessionId: string): Promise<PiRpcClient> {
    const existing = this.live.get(sessionId);
    if (existing?.client.running) return existing.client;

    const session = getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);

    const executor = buildExecutor(EXECUTOR_KIND, SESSION_ROOT);
    mkdirSync(path.join(SESSION_ROOT, sessionId), { recursive: true });

    const client = executor.launch({
      sessionId,
      projectPath: session.project,
      provider: process.env.PI_PROVIDER,
      model: process.env.PI_MODEL,
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
    updateSession(sessionId, { status: "running", last_error: null });
    this.record(sessionId, "portal_prompt", { message });
    this.record(sessionId, "portal_status", { status: "running" });
    try {
      await client.prompt(message);
    } catch (e) {
      const message = (e as Error).message;
      updateSession(sessionId, { status: "error", last_error: message });
      this.record(sessionId, "portal_status", { status: "error", error: message });
      throw e;
    }
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
    live.client.kill();
    this.live.delete(sessionId);
    await live.executor.cleanup?.(sessionId).catch(() => {});
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export const sessions = new SessionManager();
export { SESSION_ROOT, EXECUTOR_KIND };
