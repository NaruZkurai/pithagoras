import express, { type Router } from "express";
import { nanoid } from "nanoid";
import {
  appendThreadMessage,
  createSession,
  createStash,
  createThread,
  deleteStash,
  deleteThreadAndMessages,
  getSession,
  getStash,
  getThread,
  listStashes,
  listThreadMessages,
  listThreads,
  setStashPushed,
} from "../db.js";
import { EXECUTOR_KIND } from "../session-manager.js";
import { readTranscript, readTypedTimeline } from "../pi/transcript.js";
import {
  memoryHubStatus,
  pushStashToMemory,
  listHubMemories,
  typedTimelineToHubMessages,
} from "../memory-hub.js";

/**
 * Conversation stashes — archive a session's history into a thread on one of
 * its messages (the "stash" action) and, when the memory hub is reachable,
 * push it there too. The NK Tools tab lists them.
 *
 * A stash is not a new conversation: it reuses the existing thread machinery,
 * seeding the thread's message log with the archived transcript so opening the
 * thread shows everything that happened and the conversation can continue
 * there.
 */

const MAX_PARENT = 20000;

const threadView = (threadId: string) => {
  const thread = getThread(threadId)!;
  return {
    id: thread.id,
    sessionId: thread.session_id,
    parentSeq: thread.parent_seq,
    parentRole: thread.parent_role,
    parentText: thread.parent_text,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    messages: listThreadMessages(thread.id).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    })),
  };
};

const stashView = (id: string) => {
  const s = getStash(id)!;
  return {
    id: s.id,
    sessionId: s.session_id,
    threadId: s.thread_id,
    parentSeq: s.parent_seq,
    parentRole: s.parent_role,
    parentText: s.parent_text,
    messageCount: s.message_count,
    pushed: !!s.pushed,
    createdAt: s.created_at,
  };
};

export function stashesRouter(): Router {
  const router = express.Router();

  /** Archive a session into a thread on one of its messages, then continue there. */
  router.post("/sessions/:id/stash", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });

    const { seq, role, text } = req.body ?? {};
    const parentRole = role === "user" || role === "assistant" ? role : "user";
    const parentText = typeof text === "string" ? text.trim().slice(0, MAX_PARENT) : "";
    if (!parentText) return res.status(400).json({ error: "A message needs text to stash on" });
    const parentSeq = Number.isFinite(Number(seq)) ? Number(seq) : 0;

    // Like a thread: at most one stash per message. Reuse it if one exists.
    let thread = listThreads(session.id).find((t) => t.parent_seq === parentSeq);
    if (!thread) {
      const id = nanoid(12);
      createThread({
        id,
        session_id: session.id,
        parent_seq: parentSeq,
        parent_role: parentRole,
        parent_text: parentText,
      });
      createSession({
        id,
        title: `Stash on ${parentText.slice(0, 40)}`,
        workspace: session.workspace,
        executor: EXECUTOR_KIND,
        kind: "thread",
      });
      thread = getThread(id)!;
    }

    // Reconstruct the conversation and archive it into the thread's message log.
    const transcript = readTranscript(session.pi_session_file);
    const existing = listThreadMessages(thread.id).length;
    for (const m of transcript) {
      // Don't duplicate a thread that was already seeded on a previous stash.
      if (existing > 0) break;
      appendThreadMessage({
        id: nanoid(12),
        thread_id: thread.id,
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      });
    }

    const stashId = nanoid(12);
    createStash({
      id: stashId,
      session_id: session.id,
      thread_id: thread.id,
      parent_seq: parentSeq,
      parent_role: parentRole,
      parent_text: parentText,
      message_count: transcript.length,
      transcript: JSON.stringify(transcript),
    });

    // Best-effort push to the memory hub; never blocks the response. Each chat
    // atom (thought, message, tool call, memory retrieval) goes in as its own
    // dedicated `{chat#:timeline#}` variable so the hub keeps them separate.
    pushStashToMemory({
      stashId,
      messages: typedTimelineToHubMessages(readTypedTimeline(session.pi_session_file, session.id)),
    })
      .then((r) => {
        if (r.ok) setStashPushed(stashId, 1);
        else console.error(`[nk] stash ${stashId} not pushed: ${r.detail ?? "unknown"}`);
      })
      .catch(() => {});

    res.json({ stash: stashView(stashId), thread: threadView(thread.id), pushed: "pending" });
  });

  /** Recent stashes across sessions, newest first. */
  router.get("/stashes", (_req, res) => {
    res.json({
      stashes: listStashes().map((s) => ({
        id: s.id,
        sessionId: s.session_id,
        sessionTitle: s.session_title ?? "(deleted session)",
        threadId: s.thread_id,
        parentSeq: s.parent_seq,
        parentRole: s.parent_role,
        parentText: s.parent_text,
        messageCount: s.message_count,
        pushed: !!s.pushed,
        createdAt: s.created_at,
      })),
    });
  });

  /** Remove a stash and its thread. */
  router.delete("/stashes/:id", (req, res) => {
    const s = getStash(req.params.id);
    if (!s) return res.status(404).json({ error: "Not found" });
    deleteThreadAndMessages(s.thread_id);
    deleteStash(s.id);
    res.json({ ok: true });
  });

  /** NK Tools status: is the background memory hub running? */
  router.get("/nk/status", async (_req, res) => {
    res.json(await memoryHubStatus());
  });

  /** Everything the hub is holding: memory atoms + locally stashed conversations. */
  router.get("/nk/memories", async (_req, res) => {
    const [hub, stashes] = await Promise.all([listHubMemories(), Promise.resolve(listStashes())]);
    res.json({
      atoms: hub.atoms,
      stashes: stashes.map((s) => ({
        id: s.id,
        sessionId: s.session_id,
        sessionTitle: s.session_title ?? "(deleted session)",
        threadId: s.thread_id,
        parentSeq: s.parent_seq,
        parentRole: s.parent_role,
        parentText: s.parent_text,
        messageCount: s.message_count,
        pushed: !!s.pushed,
        createdAt: s.created_at,
      })),
      error: hub.error,
    });
  });

  return router;
}
