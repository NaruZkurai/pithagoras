import type { PortalEvent } from "./api";

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      detail?: string;
      /** Raw tool output (e.g. command stdout), captured on completion. */
      output?: string;
    }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

/**
 * Fold pi's event stream into renderable turns.
 *
 * Deliberately tolerant: pi emits more event types than we render, and shapes
 * vary by version. Anything unrecognised is skipped rather than breaking the
 * transcript — a task that ran fine shouldn't look broken because of one
 * unexpected field.
 */
export function buildTranscript(events: PortalEvent[]): Item[] {
  const items: Item[] = [];
  let current: Extract<Item, { kind: "assistant" }> | null = null;

  const closeCurrent = () => {
    if (current) {
      current.done = true;
      current = null;
    }
  };

  for (const ev of events) {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case "portal_prompt":
        closeCurrent();
        items.push({ kind: "user", id: `u${ev.seq}`, text: String(p.message ?? "") });
        break;

      case "message_update": {
        const inner = p.assistantMessageEvent ?? {};
        const delta = typeof inner.delta === "string" ? inner.delta : "";
        if (!delta) break;
        if (!current) {
          current = { kind: "assistant", id: `a${ev.seq}`, text: "", thinking: "", done: false };
          items.push(current);
        }
        if (inner.type === "thinking_delta") current.thinking += delta;
        else if (inner.type === "text_delta") current.text += delta;
        break;
      }

      case "message_end":
        closeCurrent();
        break;

      case "tool_execution_start":
        closeCurrent();
        items.push({
          kind: "tool",
          id: `t${ev.seq}`,
          name: String(p.toolName ?? p.name ?? "tool"),
          status: "running",
          detail: summarizeToolInput(p),
        });
        break;

      case "tool_execution_end": {
        // Close the most recent still-running tool of the same name and attach
        // the raw output it produced (stdout+stderr) so it can be shown.
        const name = String(p.toolName ?? p.name ?? "tool");
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.status === "running" && it.name === name) {
            it.status = p.isError || p.error ? "error" : "done";
            const output = resultText(p.result);
            if (output) it.output = output;
            break;
          }
        }
        break;
      }

      case "tool_execution_update": {
        // Stream partial output into the open tool row while it runs.
        const name = String(p.toolName ?? p.name ?? "tool");
        const partial = resultText(p.partialResult);
        if (!partial) break;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.status === "running" && it.name === name) {
            it.output = it.output ? it.output + partial : partial;
            break;
          }
        }
        break;
      }

      // Output from a builtin like /session or /compact — pi never saw it.
      case "portal_notice":
        items.push({
          kind: "notice",
          id: `n${ev.seq}`,
          text: String(p.text ?? ""),
          tone: p.error ? "error" : "info",
        });
        break;

      case "portal_status":
        if (p.status === "error" && p.error) {
          items.push({ kind: "notice", id: `n${ev.seq}`, text: String(p.error), tone: "error" });
        }
        if (p.status === "idle" && p.aborted) {
          items.push({ kind: "notice", id: `n${ev.seq}`, text: "Aborted", tone: "info" });
        }
        break;

      case "agent_end":
        closeCurrent();
        break;

      default:
        break;
    }
  }

  // Anything still open belongs to a run in flight.
  return items;
}

function summarizeToolInput(p: any): string | undefined {
  const input = p.input ?? p.args ?? p.parameters;
  if (!input) return undefined;
  if (typeof input === "string") return truncate(input);
  if (typeof input === "object") {
    const first =
      input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
    if (typeof first === "string") return truncate(first);
    return truncate(JSON.stringify(input));
  }
  return undefined;
}

/** The plain text pi returned from a tool — its stdout+stderr for bash. */
function resultText(result: any): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
}

function truncate(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Highest seq seen, so a reconnect resumes exactly where the stream left off. */
export function lastSeq(events: PortalEvent[]): number {
  return events.length ? events[events.length - 1].seq : 0;
}
