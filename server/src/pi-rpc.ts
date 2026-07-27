import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/** A message pi emits on stdout. `type: 'response'` replies to a command; everything else is an event. */
export interface PiMessage {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * Client for `pi --mode rpc`: newline-delimited JSON over the child's stdio.
 *
 * Framing note from pi's docs: records are separated by LF only. Node's
 * `readline` also splits on U+2028/U+2029, which would corrupt any payload
 * containing those characters, so the buffer is split manually.
 */
export class PiRpcClient extends EventEmitter {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (m: PiMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    this.setMaxListeners(0);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    child.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`pi exited (code=${code} signal=${signal}) before replying`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    child.on("error", (err) => this.emit("error", err));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    // Split on LF only — see framing note above.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: PiMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // A non-JSON line is pi logging to stdout; surface it rather than crash.
        this.emit("stderr", trimmed + "\n");
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: PiMessage): void {
    if (msg.type === "response" && msg.id) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
    }
    this.emit("event", msg);
  }

  /** Send a command and wait for its matching `response`. */
  send(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<PiMessage> {
    if (this.closed) return Promise.reject(new Error("pi process is not running"));
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, type, ...params }) + "\n";

    return new Promise<PiMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command '${type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Submit a prompt. Resolves as soon as pi accepts it — the actual work streams
   * back as events, which is what lets a task keep running after the browser
   * that started it has gone away.
   */
  async prompt(message: string): Promise<void> {
    const res = await this.send("prompt", { message });
    if (res.success === false) throw new Error(res.error || "pi rejected the prompt");
  }

  abort(): Promise<PiMessage> {
    return this.send("abort");
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.closed) this.child.kill(signal);
  }

  get running(): boolean {
    return !this.closed;
  }
}
