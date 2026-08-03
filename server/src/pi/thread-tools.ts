import { Type } from "typebox";
import { nanoid } from "nanoid";
import { addConfirmation, getThread, searchConfirmations } from "../db.js";

/**
 * Confirmation-database tools, registered only for thread sessions.
 *
 * A thread agent's one persistent ability: it can write the messages it has
 * confirmed to a shared database and search that database from any thread. It
 * has no other memory between threads — this is the only thing it carries over.
 */

const ok = (text: string) => ({ output: text, isError: false });
const bad = (text: string) => ({ output: text, isError: true });

/**
 * pi hands tool arguments over as an object, but be tolerant of a JSON string
 * and of the model sending the literal string "null" instead of a real empty.
 */
function toolArgs(p: any): any {
  let args = p;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return args ?? {};
}

/** A search query, or undefined for "everything". */
function queryArg(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return !s || s === "null" || s === "undefined" ? undefined : s;
}

/**
 * The persona handed to a thread agent.
 *
 * Appended to the ordinary agent framing at system level, so the thread agent
 * knows it is a focused sub-agent whose whole context is the parent message and
 * its own thread, and that the confirmation database is its only memory.
 */
export function threadFraming(): string {
  return [
    "You are the thread agent.",
    "You work inside a thread attached to one message. Your whole context is that one message and this thread — you do not see the rest of the conversation, and you do not remember anything from other threads.",
    "Messages you confirm are written to a shared database you can also search. It is the only thing you carry between threads.",
    "Do the work in the current workspace. Be concise, and finish with a short account of what you did.",
  ].join("\n");
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function threadTools(pi: any, ctx: { threadId: string }): void {
  pi.registerTool({
    name: "confirmations_search",
    label: "Search confirmed messages",
    description:
      "Search the shared database of every message confirmed across all threads. Use it to check what has already been confirmed, or to find a fact you confirmed before.",
    promptSnippet: "confirmations_search — look up previously confirmed messages",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Text to search for in confirmed messages. Omit to list the most recent." })
      ),
      limit: Type.Optional(
        Type.Number({ description: "How many to return (default 20, max 100)" })
      ),
    }),
    async execute(_id: string, p: any) {
      const args = toolArgs(p);
      const query = queryArg(args?.query);
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
      const rows = searchConfirmations(query, limit);
      if (!rows.length) return ok("No confirmed messages match.");
      return ok(
        JSON.stringify(
          rows.map((r) => ({ text: r.text, confirmedAt: r.confirmed_at })),
          null,
          2
        )
      );
    },
  });

  pi.registerTool({
    name: "confirmation_add",
    label: "Confirm a message",
    description:
      "Record the given message text as confirmed in the shared database. It is stored permanently and searchable from any future thread, but nothing else about this conversation is remembered.",
    promptSnippet: "confirmation_add — record a message as confirmed",
    parameters: Type.Object({
      text: Type.String({ description: "The message text to confirm, verbatim" }),
    }),
    async execute(_id: string, p: any) {
      const text = String(p?.text ?? "").trim();
      if (!text) return bad("Nothing to confirm — text is empty.");
      const thread = getThread(ctx.threadId);
      addConfirmation({
        id: nanoid(12),
        thread_id: ctx.threadId,
        source_session_id: thread?.session_id ?? ctx.threadId,
        source_seq: thread?.parent_seq ?? null,
        text: text.slice(0, 20000),
      });
      return ok("Confirmed. It is now searchable from any thread.");
    },
  });
}
