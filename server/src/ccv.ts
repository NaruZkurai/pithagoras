import { ccvHash, upsertCcv } from "./db.js";

/**
 * CCV ingestion: turn a completed pi message into callable chat variables.
 *
 * One pi `message` can carry several atoms — a private thought, the surfaced
 * text, one or more tool calls. Each becomes its own hashed CCV slot
 * (message / thinking / tool_call / tool_result / shell), so a thought, a
 * command, or a console output is individually callable and rememberable.
 */

export interface CcvAtom {
  type: "message" | "thinking" | "tool_call" | "tool_result" | "shell";
  owner: "user" | "assistant" | "tool";
  content: string;
}

/** Tool names whose whole job is executing shell commands. */
const SHELL_TOOL = /bash|shell|sh|terminal|exec/i;

/** Plain text of one message content part, typed, or null if unrenderable. */
function atomOf(part: any): CcvAtom | null {
  if (!part || typeof part !== "object") return null;

  if (part.type === "text" && typeof part.text === "string") {
    return part.text.trim()
      ? { type: "message", owner: "assistant", content: part.text }
      : null;
  }

  if (part.type === "thinking" && typeof part.thinking === "string") {
    return part.thinking.trim()
      ? { type: "thinking", owner: "assistant", content: part.thinking }
      : null;
  }

  if (part.type === "toolCall") {
    const name = typeof part.name === "string" ? part.name : "tool";
    let args = "";
    try {
      args =
        typeof part.arguments === "string"
          ? part.arguments
          : JSON.stringify(part.arguments ?? {});
    } catch {
      args = "";
    }
    return {
      type: SHELL_TOOL.test(name) ? "shell" : "tool_call",
      owner: "tool",
      content: `[tool call: ${name}] ${args}`.trim(),
    };
  }

  if (part.type === "toolResult") {
    const inner =
      typeof part.content === "string"
        ? part.content
        : Array.isArray(part.content)
          ? part.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n")
          : "";
    const text = `[tool result] ${inner}`.trim();
    if (!text) return null;
    const name = String((part as any)?.name ?? "");
    return {
      type: SHELL_TOOL.test(name) ? "shell" : "tool_result",
      owner: "tool",
      content: text,
    };
  }

  return null;
}

/**
 * Ingest one completed pi message into CCV storage. `role` is the message
 * speaker (user / assistant / toolResult); user messages become a single
 * message CCV, assistant/tool messages become their typed atoms.
 *
 * Idempotent per (session, seq, type, idx): re-ingesting an already-seen
 * message is a no-op.
 */
export function ingestMessageCcvs(opts: {
  sessionId: string;
  seq: number;
  role: "user" | "assistant" | "toolResult" | string;
  message: any;
}): void {
  const { sessionId, seq, message } = opts;
  if (!message) return;

  if (opts.role === "user") {
    const text = Array.isArray(message.content)
      ? message.content
          .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
          .join("")
          .trim()
      : typeof message.content === "string"
        ? message.content.trim()
        : "";
    if (!text) return;
    upsertCcv({
      id: ccvHash(sessionId, seq, "message", 0),
      session_id: sessionId,
      seq,
      idx: 0,
      type: "message",
      owner: "user",
      content: text,
    });
    return;
  }

  // assistant / toolResult: split content into typed atoms.
  const parts = Array.isArray(message.content) ? message.content : [];
  let idx = 0;
  for (const part of parts) {
    const atom = atomOf(part);
    if (!atom) continue;
    upsertCcv({
      id: ccvHash(sessionId, seq, atom.type, idx),
      session_id: sessionId,
      seq,
      idx,
      type: atom.type,
      owner: atom.owner,
      content: atom.content,
    });
    idx += 1;
  }
}
