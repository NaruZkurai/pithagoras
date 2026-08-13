import { existsSync, readFileSync } from "node:fs";

/**
 * Reconstruct a session's readable transcript from its pi session file.
 *
 * pi writes one `type:"message"` record per message (the final version, not
 * streaming deltas), so the file is an ordered list of user / assistant /
 * tool-result messages. This turns that into `{ role, text }` lines for
 * archiving into a stash thread, and into a typed timeline of per-part atoms
 * (`readTypedTimeline`) for the memory hub, where each thought / message /
 * tool call / memory retrieval is its own addressable entry.
 */

export interface TranscriptLine {
  role: "user" | "assistant" | "toolResult";
  text: string;
}

/**
 * What a chat atom actually is. Thinking is the assistant's private chain of
 * thought; `message` is surfaced text; `tool_call`/`tool_result` are a tool
 * round-trip; `memory_retrieval` is a call or result that reached into stored
 * memory (or a search over it) rather than doing some other work.
 */
export type MessageType =
  | "message"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "memory_retrieval";

/**
 * One addressable chat atom for the memory hub. Every chat message becomes a
 * dedicated variable keyed `{chat#:timeline#}` whose value is
 * `{owner,messagetype,chatmessage}` — so thoughts, plain messages, tool calls
 * and memory retrieval are all distinguishable, not flattened into one blob.
 */
export interface TypedTimelineEntry {
  /** Which conversation this atom belongs to (the portal session id). */
  chatId: string;
  /** Position of this atom within that conversation (1-based). */
  timeline: number;
  /** The hub-facing speaker: the hub only accepts `user` / `assistant`. */
  role: "user" | "assistant";
  /** Who emitted the atom: the human, the agent, or a tool. */
  owner: "user" | "assistant" | "tool";
  messagetype: MessageType;
  chatmessage: string;
}

/** Per-message cap so a giant pasted file doesn't bloat the stash. */
const MAX_LINE = 8000;

/** Tools whose whole job is fetching something remembered/searched. */
const MEMORY_TOOL = /memory|recall|remember|search|skill|retriev/i;

/** Tool names that count as "memory retrieval" for the messagetype. */
function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL.test(name);
}

/** Plain text of a part, or empty when the part carries nothing readable. */
function partText(part: any): { type: MessageType; owner: "assistant" | "tool"; text: string } {
  if (!part || typeof part !== "object") return { type: "message", owner: "assistant", text: "" };

  if (part.type === "text" && typeof part.text === "string")
    return { type: "message", owner: "assistant", text: part.text };

  if (part.type === "thinking" && typeof part.thinking === "string")
    return { type: "thinking", owner: "assistant", text: part.thinking };

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
      type: isMemoryTool(name) ? "memory_retrieval" : "tool_call",
      owner: "tool",
      text: `[tool call: ${name}] ${args}`,
    };
  }

  if (part.type === "toolResult") {
    const inner =
      typeof part.content === "string"
        ? part.content
        : Array.isArray(part.content)
          ? part.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n")
          : "";
    return {
      type: isMemoryTool(String((part as any)?.name ?? "")) ? "memory_retrieval" : "tool_result",
      owner: "tool",
      text: `[tool result] ${inner}`,
    };
  }

  return { type: "message", owner: "assistant", text: "" };
}

export function readTranscript(piSessionFile?: string | null): TranscriptLine[] {
  if (!piSessionFile) return [];
  try {
    if (!existsSync(piSessionFile)) return [];
    const lines = readFileSync(piSessionFile, "utf8").split("\n");
    const out: TranscriptLine[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type !== "message" || !o?.message) continue;
      const m = o.message;
      const role = m.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

      let text = "";
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          const t = partText(part).text;
          if (t) text += (text ? "\n" : "") + t;
        }
      } else if (typeof m.content === "string") {
        text = m.content;
      }
      if (!text.trim()) continue;
      out.push({ role, text: text.slice(0, MAX_LINE) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The memory-hub view of a conversation: one typed atom per addressed slot,
 * in order. Unlike `readTranscript` this does not merge parts together — a
 * thought, the message after it, and the tool call it triggered each get their
 * own `chat# : timeline#` slot so the hub can tell them apart.
 */
export function readTypedTimeline(
  piSessionFile?: string | null,
  chatId?: string
): TypedTimelineEntry[] {
  if (!piSessionFile) return [];
  const out: TypedTimelineEntry[] = [];
  try {
    if (!existsSync(piSessionFile)) return [];
    const lines = readFileSync(piSessionFile, "utf8").split("\n");
    let timeline = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type !== "message" || !o?.message) continue;
      const m = o.message;
      const role = m.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

      const atoms = Array.isArray(m.content)
        ? m.content
            .map((part: any) => partText(part))
            .filter((a: any) => a.text.trim())
        : typeof m.content === "string" && m.content.trim()
          ? [{ type: "message" as MessageType, owner: "assistant" as const, text: m.content }]
          : [];

      for (const atom of atoms) {
        const owner: "user" | "assistant" | "tool" =
          role === "user" ? "user" : atom.owner;
        timeline += 1;
        out.push({
          chatId: chatId ?? "",
          timeline,
          role: role === "user" ? ("user" as const) : ("assistant" as const),
          owner,
          messagetype: atom.type,
          chatmessage: atom.text.slice(0, MAX_LINE),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
