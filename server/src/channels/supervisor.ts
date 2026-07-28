import { getDb } from "../db.js";
import { resolveChannelSession } from "../agent.js";
import { sessions, EXECUTOR_KIND } from "../session-manager.js";
import { loadChannels, type LoadedChannel } from "./loader.js";

/**
 * Runs the enabled channels.
 *
 * This is the piece that turns a configured channel into a working one: it
 * calls the package's start(), hands it the context it needs, and turns each
 * ask() into a real session and a real reply.
 */

export type ChannelState = "running" | "stopped" | "starting" | "error";

interface ChannelRow {
  id: string;
  slug: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  instructions: string;
  relay_progress: number;
  relay_tools: number;
  updated_at: string;
}

interface Running {
  /** Restarted when this changes, so an edited token takes effect. */
  signature: string;
  slug: string;
  state: ChannelState;
  error?: string;
  since: string;
  controller: AbortController;
  stop?: () => Promise<void> | void;
  log: { at: string; text: string }[];
}

/** Kept per channel and shown on its page — enough to see what happened. */
const MAX_LOG = 50;

/**
 * Said on its own, these stop whatever the agent is doing.
 *
 * Matched only when the message is the word and nothing else: "stop" halts the
 * run, "stop using the staging bucket" is an instruction and must reach the
 * agent intact.
 */
const INTERRUPTS = new Set([
  "wait",
  "stop",
  "halt",
  "cancel",
  "abort",
  "hold on",
  "nevermind",
  "never mind",
]);

const isInterrupt = (text: string) =>
  INTERRUPTS.has(text.trim().toLowerCase().replace(/[.!?]+$/, ""));

/** An extension dialog waiting on a reply from the chat. */
interface PendingUi {
  id: string;
  method: string;
  options?: string[];
}

class ChannelSupervisor {
  private running = new Map<string, Running>();
  private syncing: Promise<void> | null = null;
  /** Open dialogs, by session. The next message in that chat answers one. */
  private pendingUi = new Map<string, PendingUi>();

  private rows(): ChannelRow[] {
    return getDb().prepare("SELECT * FROM channels").all() as ChannelRow[];
  }

  status(id: string): { state: ChannelState; error?: string; since?: string; log: Running["log"] } {
    const live = this.running.get(id);
    if (!live) return { state: "stopped", log: [] };
    return { state: live.state, error: live.error, since: live.since, log: live.log };
  }

  /** Serialised: two overlapping syncs would start the same channel twice. */
  sync(): Promise<void> {
    const next = (this.syncing ?? Promise.resolve()).catch(() => {}).then(() => this.syncNow());
    this.syncing = next;
    return next;
  }

  private async syncNow(): Promise<void> {
    const { channels: kinds } = await loadChannels();
    const byKind = new Map(kinds.map((k) => [k.id, k]));
    const rows = this.rows();
    const wanted = new Map(rows.filter((r) => r.enabled).map((r) => [r.id, r]));

    // Anything running that should not be, or whose configuration moved.
    for (const [id, live] of [...this.running]) {
      const row = wanted.get(id);
      if (!row || signature(row) !== live.signature) {
        await this.stopChannel(id);
      }
    }

    for (const [id, row] of wanted) {
      if (this.running.has(id)) continue;
      const kind = byKind.get(row.kind);
      if (!kind?.start) {
        // Enabled but unrunnable — say so rather than looking healthy.
        this.running.set(id, {
          signature: signature(row),
          slug: row.slug,
          state: "error",
          error: kind
            ? `${kind.packageName} has no start(), so it cannot run`
            : `No installed package provides "${row.kind}"`,
          since: new Date().toISOString(),
          controller: new AbortController(),
          log: [],
        });
        continue;
      }
      await this.startChannel(row, kind);
    }
  }

  private async startChannel(row: ChannelRow, kind: LoadedChannel): Promise<void> {
    const controller = new AbortController();
    const live: Running = {
      signature: signature(row),
      slug: row.slug,
      state: "starting",
      since: new Date().toISOString(),
      controller,
      log: [],
    };
    this.running.set(row.id, live);

    const log = (text: string) => {
      live.log.push({ at: new Date().toISOString(), text: String(text) });
      if (live.log.length > MAX_LOG) live.log.shift();
      console.log(`[channel ${row.slug}] ${text}`);
    };

    try {
      const handle = await kind.start!({
        config: parseConfig(row.config),
        log,
        signal: controller.signal,
        ask: (text: string, meta: Record<string, unknown> = {}) =>
          this.ask(row.id, text, meta),
      });
      live.stop = handle?.stop;
      live.state = "running";
      log("started");
    } catch (e) {
      live.state = "error";
      live.error = (e as Error).message;
      log(`failed to start: ${live.error}`);
    }
  }

  private async stopChannel(id: string): Promise<void> {
    const live = this.running.get(id);
    if (!live) return;
    this.running.delete(id);
    try {
      live.controller.abort();
      await live.stop?.();
    } catch (e) {
      console.error(`[channel ${live.slug}] stop failed: ${(e as Error).message}`);
    }
  }

  /**
   * A message arriving on a channel.
   *
   * The package decided what conversation it belongs to; this turns that key
   * into a session and waits for the agent's reply, because somebody is sitting
   * in a chat expecting one.
   */
  private async ask(
    channelId: string,
    text: string,
    meta: Record<string, unknown>
  ): Promise<string> {
    const row = getDb().prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as
      | ChannelRow
      | undefined;
    if (!row) throw new Error("This channel has been removed");

    const key = typeof meta.session === "string" ? meta.session : "";
    if (!key) {
      // Loud on purpose: silently lumping every chat into one session is the
      // failure this whole design exists to prevent.
      throw new Error(
        "ask() needs meta.session — the key identifying which conversation this message belongs to"
      );
    }

    const { session } = resolveChannelSession({
      channelSlug: row.slug,
      key,
      title: typeof meta.title === "string" ? meta.title : undefined,
      executor: EXECUTOR_KIND,
    });

    // Everything below jumps the queue on purpose. ask() serialises per
    // session, so anything meant to affect the run in progress has to be
    // handled before it, or it waits behind the thing it is answering.

    const open = this.pendingUi.get(session.id);

    if (isInterrupt(text)) {
      if (open) {
        this.pendingUi.delete(session.id);
        sessions.respondUi(session.id, open.id, { cancelled: true });
        return "Cancelled.";
      }
      if (!sessions.isBusy(session.id)) return "Nothing running.";
      await sessions.abort(session.id);
      return "Stopped.";
    }

    // Answering an extension's question, not starting a new turn. The reply
    // travels back through the ask that is still running.
    if (open) {
      const answer = interpretAnswer(open, text);
      if (answer.error) return answer.error;
      this.pendingUi.delete(session.id);
      if (!sessions.respondUi(session.id, open.id, answer.response!)) {
        return "That question has already expired.";
      }
      return "";
    }

    const packageReply =
      typeof meta.onReply === "function"
        ? (meta.onReply as (text: string) => void | Promise<void>)
        : undefined;

    // Both off and nothing is relayed: the package gets one reply at the end,
    // which is also what a package that never passed onReply gets.
    const wantsProgress = Boolean(row.relay_progress);
    const wantsTools = Boolean(row.relay_tools);
    const relaying = packageReply && (wantsProgress || wantsTools);

    return sessions.ask(session.id, withInstructions(text, row.instructions), {
      onReply: relaying ? packageReply : undefined,
      streamText: wantsProgress,
      // Dialogs are relayed whatever the toggles say. They are not progress
      // chatter — the run is stopped until somebody answers, and silence here
      // means the command hangs until it times out.
      onUi: (request) => {
        if (request?.cancelled) {
          this.pendingUi.delete(session.id);
          void packageReply?.("That question timed out.");
          return;
        }
        const question = describeUi(request);
        if (!question) return; // notify/setStatus/setWidget are one-way

        // A channel with no way to send an unprompted message — a webhook has
        // one response to fill — cannot ask. Answering it is impossible, so
        // decline immediately instead of holding the run until it times out.
        if (!packageReply) {
          sessions.respondUi(session.id, request.id, { cancelled: true });
          return;
        }

        this.pendingUi.set(session.id, {
          id: request.id,
          method: request.method,
          options: request.options,
        });
        void packageReply?.(question);
      },
    });
  }

  /** One line for the boot log. */
  summary(): string {
    const all = [...this.running.values()];
    if (!all.length) return "none enabled";
    const running = all.filter((c) => c.state === "running").length;
    const failed = all.filter((c) => c.state === "error");
    const parts = [`${running} running`];
    if (failed.length) parts.push(`${failed.length} failed (${failed.map((f) => f.slug).join(", ")})`);
    return parts.join(", ");
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopChannel(id)));
  }
}

/**
 * An extension's question, as something you can answer in a chat.
 *
 * The browser draws a modal with buttons; here the options are numbered and the
 * next message picks one. Returns undefined for the one-way calls — notify,
 * setStatus, setWidget — which are not questions and must not block anything.
 */
function describeUi(request: any): string | undefined {
  const title = String(request?.title ?? "").trim();
  const message = String(request?.message ?? "").trim();
  const head = [title, message].filter(Boolean).join("\n");

  switch (request?.method) {
    case "select": {
      const options: string[] = Array.isArray(request.options) ? request.options : [];
      if (!options.length) return `${head || "Choose"}\n(no options offered)`;
      const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
      return `${head || "Choose one"}\n${list}\n\nReply with a number, or "cancel".`;
    }
    case "confirm":
      return `${head || "Confirm"}\n\nReply "yes" or "no".`;
    case "input":
    case "editor": {
      const hint = String(request.placeholder ?? request.defaultValue ?? "").trim();
      return `${head || "Enter a value"}${hint ? `\n(${hint})` : ""}\n\nReply with the value, or "cancel".`;
    }
    default:
      return undefined;
  }
}

/** Turn a chat reply into the answer the extension is waiting for. */
function interpretAnswer(
  open: PendingUi,
  text: string
): { response?: { value?: unknown; cancelled?: boolean }; error?: string } {
  const answer = text.trim();

  if (open.method === "select") {
    const options = open.options ?? [];
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return { response: { value: options[n - 1] } };
    }
    // Typing the option itself is the obvious thing to try, so accept it.
    const exact = options.find((o) => o.toLowerCase() === answer.toLowerCase());
    if (exact) return { response: { value: exact } };
    return { error: `Reply with a number from 1 to ${options.length}, or "cancel".` };
  }

  if (open.method === "confirm") {
    if (/^(y|yes|ok|okay|sure|do it)$/i.test(answer)) return { response: { value: true } };
    if (/^(n|no|nope|don't|dont)$/i.test(answer)) return { response: { value: false } };
    return { error: 'Reply "yes" or "no".' };
  }

  return { response: { value: answer } };
}

/**
 * The channel's standing instructions, attached to each incoming message.
 *
 * Appended per message rather than set once as a system prompt: pi exposes
 * systemPrompt as a getter with no setter, and editing the instructions should
 * take effect on the next message rather than the next restart.
 */
function withInstructions(text: string, instructions: string): string {
  const extra = (instructions ?? "").trim();
  if (!extra) return text;
  return `${text}\n\n<channel-instructions>\n${extra}\n</channel-instructions>`;
}

const parseConfig = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/** Config or identity changing means the running channel is stale. */
const signature = (row: ChannelRow) =>
  `${row.slug}|${row.kind}|${row.config}|${row.updated_at}`;

export const channelSupervisor = new ChannelSupervisor();
