import { Type } from "typebox";

/**
 * Payload inspection — "see the entire thing we send to the model", from inside pi.
 *
 * pi hands a full provider request (model + provider, system prompt, every
 * message — the whole conversation, the tools advertised, and generation
 * parameters) to the model API. It exposes the same pieces to extensions:
 *
 *   - `ctx.getSystemPrompt()`  — the resolved system prompt
 *   - `ctx.model`              — the active model (id, provider, contextWindow)
 *   - `ctx.getContextUsage()`  — token usage of the current context
 *   - `ctx.getAllTools()`      — the tools advertised to the model
 *   - `ctx.sessionManager`     — the session, whose resolved messages are what
 *                                actually went into the request
 *
 * This factory registers ONE tool (`inspect_request`) that reads all of that
 * LIVE at call time and returns the entire assembled request. It deliberately
 * registers NO event handlers — earlier attempts that parked `context` /
 * `before_provider_request` handlers produced empty tool results, so the tool
 * avoids touching pi's request pipeline entirely and reads state on demand.
 */

const ok = (text: string) => ({ output: text, isError: false });

/** Cap the serialized payload so a huge context doesn't blow the tool reply. */
const MAX_OUT = 32000;

function render(value: unknown): string {
  let text: string;
  try {
    // replacer collapses bigint and lets cycles/undefined render rather than
    // throwing; nothing else is dropped.
    text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_OUT) {
    text =
      text.slice(0, MAX_OUT) +
      `\n… (truncated, ${text.length - MAX_OUT} chars omitted — narrow the task or read the returned JSONL) …`;
  }
  return text;
}

/** Trim a multi-line string to the first N lines, noting truncation. */
function head(value: string | undefined | null, lines: number): string {
  if (!value) return "";
  const parts = String(value).split("\n");
  if (parts.length <= lines) return parts.join("\n");
  return parts.slice(0, lines).join("\n") + `\n… (${parts.length - lines} more lines)`;
}

/** A human-scale tool summary (name + truncated description), not full schemas. */
function summarizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t: any) => ({
    name: t?.name ?? t?.id ?? "?",
    description: head(t?.description, 3),
    parameters:
      typeof t?.parameters === "object" && t.parameters
        ? Object.keys(t.parameters).length
        : undefined,
  }));
}

/**
 * Safely read the resolved conversation messages pi is sending.
 * Confirmed: `sessionManager.buildSessionContext()` returns
 * `{ messages, thinkingLevel, model }` with the real resolved messages; fall
 * back to a plain `.messages` getter if present.
 */
function readMessages(api: any): unknown {
  try {
    const sm = api.sessionManager;
    if (!sm) return undefined;
    if (typeof sm.buildSessionContext === "function") {
      const sc = sm.buildSessionContext();
      if (sc && sc.messages) return sc.messages;
    }
    if (typeof sm.messages !== "undefined") return sm.messages;
    if (typeof sm.getMessages === "function") return sm.getMessages();
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register the `inspect_request` tool for a session.
 * One factory instance per session.
 */
export function payloadInspect(pi: any, opts: { sessionId: string }) {
  const sessionId = opts.sessionId;

  pi.registerTool({
    name: "inspect_request",
    label: "See the entire request being sent to the model",
    description:
      "Return the complete request pi sends to the model: the model id + provider, the full system prompt, every message (the entire conversation so far, including your own tool calls and their results), the set of tools advertised to the model, and context usage / generation parameters. This is exactly what the model sees — the whole context, not a summary or a guess. Use it to audit what you are about to send (or just sent) to the model.",
    promptSnippet: "inspect_request — see the entire request being sent to the model",
    parameters: Type.Object({}),
    // ctx is the freshest extension API handle pi passes to executed tools.
    async execute(_id: string, _params: any, _signal: unknown, _onUpdate: unknown, ctx?: any) {
      const api = ctx ?? pi;
      let systemPrompt = "";
      try {
        systemPrompt = api.getSystemPrompt?.() ?? "";
      } catch (e) {
        console.warn(`[payload-inspect ${sessionId}] getSystemPrompt: ${(e as Error)?.message ?? e}`);
      }
      const model: any = api.model;
      let contextUsage: unknown;
      try {
        contextUsage = api.getContextUsage?.() ?? null;
      } catch (e) {
        console.warn(`[payload-inspect ${sessionId}] getContextUsage: ${(e as Error)?.message ?? e}`);
      }
      let tools: unknown = [];
      try {
        tools = summarizeTools(api.getAllTools?.() ?? []);
      } catch (e) {
        console.warn(`[payload-inspect ${sessionId}] getAllTools: ${(e as Error)?.message ?? e}`);
      }
      const messages = readMessages(api);

      const full = {
        model: model?.id ?? null,
        provider: model?.provider ?? null,
        contextWindow: model?.contextWindow ?? null,
        systemPrompt: head(systemPrompt, 500),
        messages,
        tools,
        contextUsage,
        sessionId,
      };

      try {
        const msgCount =
          Array.isArray(messages)
            ? messages.length
            : messages && typeof messages === "object"
              ? (messages as any).length ?? "object"
              : "unavailable";
        const toolCount = Array.isArray(tools) ? tools.length : "unavailable";
        return ok(
          `inspect_request OK in session ${sessionId}. ` +
            `model=${full.provider ?? "?"}/${full.model ?? "?"}; ` +
            `messages=${msgCount}; tools=${toolCount}; ` +
            `systemPromptChars=${systemPrompt?.length ?? 0}.\n\n` +
            `FULL REQUEST:\n` +
            render(full)
        );
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        console.error(`[payload-inspect ${sessionId}] inspect_request failed: ${msg}`);
        return ok(
          `inspect_request could not fully render in session ${sessionId}: ${msg}.\n` +
            `model=${full.provider ?? "?"}/${full.model ?? "?"}; systemPromptChars=${systemPrompt?.length ?? 0}.`
        );
      }
    },
  });
}
