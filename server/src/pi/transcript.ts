import { existsSync, readFileSync } from "node:fs";

/**
 * Reconstruct a session's readable transcript from its pi session file.
 *
 * pi writes one `type:"message"` record per message (the final version, not
 * streaming deltas), so the file is an ordered list of user / assistant /
 * tool-result messages. This turns that into `{ role, text }` lines for
 * archiving into a stash thread and for pushing to the memory hub.
 */
export interface TranscriptLine {
  role: "user" | "assistant" | "toolResult";
  text: string;
}

/** Per-message cap so a giant pasted file doesn't bloat the stash. */
const MAX_LINE = 8000;

function partText(part: any): string {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text" && typeof part.text === "string") return part.text;
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
    return `[tool call: ${name}] ${args}`;
  }
  if (part.type === "toolResult") {
    const inner =
      typeof part.content === "string"
        ? part.content
        : Array.isArray(part.content)
          ? part.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n")
          : "";
    return `[tool result] ${inner}`;
  }
  if (part.type === "thinking" && typeof part.thinking === "string") {
    return `[thinking] ${part.thinking}`;
  }
  return "";
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
          const t = partText(part);
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
