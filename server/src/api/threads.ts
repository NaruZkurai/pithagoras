import express, { type Router } from "express";
import { nanoid } from "nanoid";
import {
  appendThreadMessage,
  createSession,
  createThread,
  deleteThreadAndMessages,
  getSession,
  getThread,
  listThreadMessages,
  listThreads,
  type ThreadMessageRow,
  type ThreadRow,
} from "../db.js";
import { EXECUTOR_KIND, sessions } from "../session-manager.js";

/**
 * Message threads — a side-chat attached to one message, like a Discord thread.
 *
 * Each thread is its own isolated session (kind "thread") running the thread
 * agent: it sees only the parent message and the thread's own history, and its
 * only cross-thread memory is the confirmation database it can query.
 */

const MAX_PARENT = 20000;
const MAX_PROMPT = 20000;

const toApi = (thread: ThreadRow, messages: ThreadMessageRow[]) => ({
  id: thread.id,
  sessionId: thread.session_id,
  parentSeq: thread.parent_seq,
  parentRole: thread.parent_role,
  parentText: thread.parent_text,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
  messages: messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.created_at,
  })),
});

export function threadsRouter(): Router {
  const router = express.Router();

  /** Threads attached to a session's messages, with a digest for the list. */
  router.get("/sessions/:id/threads", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const threads = listThreads(session.id).map((t) => {
      const messages = listThreadMessages(t.id);
      const last = messages[messages.length - 1];
      return {
        id: t.id,
        parentSeq: t.parent_seq,
        parentRole: t.parent_role,
        parentText: t.parent_text,
        messageCount: messages.length,
        lastMessage: last?.content ?? null,
        lastRole: last?.role ?? null,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      };
    });
    res.json({ threads });
  });

  /** Open (or reopen) the thread on a message. One thread per message. */
  router.post("/sessions/:id/threads", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });

    const { seq, role, text } = req.body ?? {};
    const parentRole =
      role === "user" || role === "assistant" || role === "tool" ? role : "user";
    const parentText = typeof text === "string" ? text.trim().slice(0, MAX_PARENT) : "";
    if (!parentText) return res.status(400).json({ error: "A message needs text to thread on" });
    const parentSeq = Number.isFinite(Number(seq)) ? Number(seq) : 0;

    // Like Discord: a message has at most one thread.
    const existing = listThreads(session.id).find((t) => t.parent_seq === parentSeq);
    if (existing) return res.json(toApi(existing, listThreadMessages(existing.id)));

    const id = nanoid(12);
    createThread({
      id,
      session_id: session.id,
      parent_seq: parentSeq,
      parent_role: parentRole,
      parent_text: parentText,
    });
    // A thread is its own session, so it gets its own isolated pi agent with
    // the same workspace as the chat it is attached to.
    createSession({
      id,
      title: `Thread on ${parentText.slice(0, 40)}`,
      workspace: session.workspace,
      executor: EXECUTOR_KIND,
      kind: "thread",
    });
    const created = getThread(id) ?? {
      id,
      session_id: session.id,
      parent_seq: parentSeq,
      parent_role: parentRole,
      parent_text: parentText,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    res.json(toApi(created, listThreadMessages(id)));
  });

  router.get("/threads/:id", (req, res) => {
    const thread = getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Not found" });
    res.json(toApi(thread, listThreadMessages(thread.id)));
  });

  /**
   * Say something in the thread. The thread agent answers with only this
   * thread and the parent message as context.
   *
   * Blocks until the agent finishes (the same contract as running a routine).
   */
  router.post("/threads/:id/messages", async (req, res) => {
    const thread = getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Not found" });
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "message required" });
    }

    const before = listThreadMessages(thread.id);
    const userText = text.trim().slice(0, MAX_PROMPT);
    appendThreadMessage({
      id: nanoid(12),
      thread_id: thread.id,
      role: "user",
      content: userText,
    });

    // On the first message the parent is introduced as the thread's only view
    // of the conversation; afterwards the thread session already has both it
    // and the thread's own history. Framed as context, not as a question to
    // answer — the model should act on the instruction, not the parent message.
    const prompt =
      before.length === 0
        ? [
            "You are in a thread attached to one message. The message below is context only — do NOT answer it. Only carry out the final instruction.",
            "",
            `Parent message (${thread.parent_role}):`,
            thread.parent_text,
            "",
            "Instruction:",
            userText,
          ].join("\n")
        : userText;

    try {
      const answer = await sessions.ask(thread.id, prompt, {
        timeoutMs: 15 * 60_000,
        streamText: false,
      });
      appendThreadMessage({
        id: nanoid(12),
        thread_id: thread.id,
        role: "assistant",
        content: answer.trim() || "(no reply)",
      });
    } catch (e) {
      appendThreadMessage({
        id: nanoid(12),
        thread_id: thread.id,
        role: "assistant",
        content: `(error) ${(e as Error).message}`,
      });
    }
    // The thread row can disappear while the ask above blocks (e.g. a delete
    // raced in), so fall back to the thread we resolved up front rather than
    // crashing `toApi` on `getThread(...)!`.
    const fresh = getThread(thread.id);
    res.json(toApi(fresh ?? thread, listThreadMessages(thread.id)));
  });

  router.delete("/threads/:id", async (req, res) => {
    const thread = getThread(req.params.id);
    if (!thread) return res.json({ ok: true });
    await sessions.stop(thread.id).catch(() => {});
    deleteThreadAndMessages(thread.id);
    res.json({ ok: true });
  });

  return router;
}
