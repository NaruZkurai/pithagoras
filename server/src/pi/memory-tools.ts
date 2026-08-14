import { Type } from "typebox";
import { appendFileSync, existsSync } from "node:fs";
import {
  ccvHash,
  getCcv,
  searchChatCcvs,
  searchMemoryCcvs,
  updateCcv,
  upsertCcv,
} from "../db.js";

/**
 * Memory tools: the agent's durable, recalled memory.
 *
 * Everything the portal ingests (each message, thought, tool call, shell
 * output) is already stored as a callable chat variable (CCV) in the memory
 * DB, and some are flagged "remembered". But until now the agent had NO way to
 * look back at any of it — the DB grew silently and the agent only ever saw the
 * static MEMORY.md handed to it at session start.
 *
 * These tools close that gap:
 *   - memory_search   looks back at remembered memories and/or past chat
 *                     history, so the agent can recall what was actually said
 *                     without re-reading whole sessions.
 *   - memory_remember writes a durable memory to BOTH the memory DB (flagged
 *                      as remembered) and the agent's MEMORY.md, so the file
 *                      and the database never drift apart.
 *   - memory_forget   unpins a memory from the DB.
 *
 * MEMORY.md writes only happen when this session runs out of an agent home that
 * actually has a MEMORY.md (i.e. an agent session) — a plain task workspace
 * keeps its memories purely in the DB.
 */

const ok = (text: string) => ({ output: text, isError: false });
const bad = (text: string) => ({ output: text, isError: true });

/** pi may hand args over as an object or a JSON string; normalise. */
function toolArgs(p: any): any {
  let a = p;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = {};
    }
  }
  return a ?? {};
}

function queryArg(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return !s || s === "null" || s === "undefined" ? undefined : s;
}

const MAX_CONTENT = 12000;
function clip(s: string): string {
  return s.length > 220 ? `${s.slice(0, 219)}…` : s;
}

export interface MemoryToolCtx {
  sessionId: string;
  sessionSeq?: number;
  /** Path to the agent's MEMORY.md, when this session owns an agent home. */
  memoryMdPath?: string;
}

/**
 * Append one bullet to MEMORY.md under the last ## section, or a new Context
 * section at the end. Best-effort: the DB record happens regardless. Uses the
 * per-call ctx set in memoryTools() so the file path is always the agent home.
 */
let mdPathForCtx = "";
function appendToMemoryMd(text: string): string {
  if (!mdPathForCtx || !existsSync(mdPathForCtx)) return "";
  const bullet = `- ${text} _(remembered ${new Date().toISOString().slice(0, 10)})_`;
  try {
    appendFileSync(mdPathForCtx, "\n" + bullet + "\n");
    return "Appended to MEMORY.md.";
  } catch {
    return ""; // DB record still happened; the file write is best-effort.
  }
}

export function memoryTools(pi: any, ctx: MemoryToolCtx): void {
  mdPathForCtx = ctx.memoryMdPath ?? "";

  pi.registerTool({
    name: "memory_search",
    label: "Search memories & chat history",
    description:
      "Search what you (or the conversation) have remembered or said before. Scope 'memories' searches the durable remembered-memory DB, 'history' searches the plain text of past chat messages, 'all' (default) does both. Returns light snippets so you can recall a fact without re-reading whole sessions.",
    promptSnippet: "memory_search — recall a remembered memory or past message",
    parameters: Type.Object({
      query: Type.String({
        description: "Text to look for in what was remembered or said.",
      }),
      scope: Type.Optional(
        Type.String({
          description: "memories | history | all (default all)",
        })
      ),
      limit: Type.Optional(
        Type.Number({ description: "How many to return (default 8, max 25)" })
      ),
    }),
    async execute(_id: string, p: any) {
      const args = toolArgs(p);
      const query = queryArg(args?.query);
      const scope = String(args?.scope ?? "all") as "memories" | "history" | "all";
      const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 25);
      if (!query) return bad("memory_search needs a query.");

      const out: string[] = [];
      if (scope === "memories" || scope === "all") {
        const mems = searchMemoryCcvs(query, limit);
        if (!mems.length) {
          out.push("Memories: none match.");
        } else {
          out.push(
            "Memories (remembered, newest first):\n" +
              mems
                .map((m) => `• [${m.id}] (${m.session_title}) ${clip(m.content)}`)
                .join("\n")
          );
        }
      }
      if (scope === "history" || scope === "all") {
        const hist = searchChatCcvs(query, limit, ctx.sessionId);
        if (!hist.length) {
          out.push("Chat history: none match.");
        } else {
          out.push(
            `Chat history (session "${ctx.sessionId}", newest first):\n` +
              hist
                .map((h) => `• seq ${h.seq} ${h.owner}: ${clip(h.content)}`)
                .join("\n")
          );
        }
      }
      return ok(out.join("\n\n"));
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Remember something durable",
    description:
      "Record something you want to keep permanently. It is written to both the memory database and your MEMORY.md so it survives restarts and is searchable later with memory_search. Use this for stable facts: preferences, decisions, how something is set up. Do not use it for one-off details you could look up.",
    promptSnippet: "memory_remember — save a durable memory (DB + MEMORY.md)",
    parameters: Type.Object({
      text: Type.String({
        description: "The fact or note to remember, as a concise statement.",
      }),
      topic: Type.Optional(
        Type.String({
          description: "Optional section/group name, e.g. 'Context' or 'Preferences'.",
        })
      ),
    }),
    async execute(_id: string, p: any) {
      const text = String(p?.text ?? "").trim();
      if (!text) return bad("memory_remember needs text.");
      const topic = queryArg(p?.topic) ?? "Context";
      const clipped = text.slice(0, MAX_CONTENT);

      // 1) DB record, flagged as a remembered memory (linked to this session).
      const seq = ctx.sessionSeq ?? Date.now();
      const ccv = {
        id: ccvHash(ctx.sessionId, seq, `memory_${topic}`, 0),
        session_id: ctx.sessionId,
        seq,
        idx: 0,
        type: "message" as const,
        owner: "assistant" as const,
        content: `[${topic}] ${clipped}`,
      };
      upsertCcv(ccv);
      updateCcv(ccv.id, { memory: 1 });

      // 2) MEMORY.md, when this is an agent session with a durable file.
      appendToMemoryMd(clipped);

      return ok(`Remembered (${ccv.id}). Searchable later with memory_search.`);
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Forget a memory",
    description:
      "Unpin a remembered memory from the database so memory_search no longer returns it. Give the id shown by memory_search. (Your MEMORY.md is left as-is; delete the line there yourself if you also want it gone.)",
    promptSnippet: "memory_forget — unpin a remembered memory",
    parameters: Type.Object({
      id: Type.String({ description: "The memory id from memory_search (ccv_…) or its text." }),
    }),
    async execute(_id: string, p: any) {
      let id = String(p?.id ?? "").trim();
      if (!id) return bad("memory_forget needs an id.");
      const ccv = id.startsWith("ccv_") ? getCcv(id) : undefined;
      if (!ccv) return bad("No remembered memory with that id.");
      updateCcv(ccv.id, { memory: 0 });
      return ok(`Forgot ${ccv.id}.`);
    },
  });
}
