import express, { type Router } from "express";
import {
  ccvHash,
  getCcv,
  getCheckpoint,
  listCcvs,
  listMemoryCcvs,
  updateCcv,
  upsertCcv,
} from "../db.js";

/**
 * Callable chat variables (CCVs) — every chat atom (message, thought, tool
 * call, shell output) as a hashed, callable memory. These endpoints let the
 * UI list a session's CCVs, fetch one by its hash, edit its content, and
 * mark one as a remembered memory.
 */

/** Anchor session for memories the user adds by hand (not tied to a chat). */
const MEMORIES_SESSION = "__memories__";

const api = (c: any) => ({
  id: c.id,
  sessionId: c.session_id,
  seq: c.seq,
  idx: c.idx,
  type: c.type,
  owner: c.owner,
  content: c.content,
  memory: !!c.memory,
  edited: !!c.edited,
  createdAt: c.created_at,
});

export function ccvsRouter(): Router {
  const router = express.Router();

  /** All CCVs in a session, in timeline order. */
  router.get("/sessions/:id/ccvs", (req, res) => {
    res.json({ ccvs: listCcvs(req.params.id).map(api) });
  });

  /**
   * The git checkpoint at one timeline point: the workspace git state the
   * message at that seq was anchored to (HEAD, changed files, captured diff).
   */
  router.get("/sessions/:id/checkpoints/:seq", (req, res) => {
    const seq = Number(req.params.seq);
    if (!Number.isFinite(seq)) return res.status(400).json({ error: "bad seq" });
    const c = getCheckpoint(req.params.id, seq);
    if (!c) return res.status(404).json({ error: "No checkpoint" });
    let dirty: string[] = [];
    try {
      dirty = JSON.parse(c.dirty);
    } catch {
      dirty = [];
    }
    res.json({ checkpoint: { seq: c.seq, head: c.head, dirty, diff: c.diff } });
  });

  /** Everything the user chose to remember across all sessions. */
  router.get("/ccvs/memories", (_req, res) => {
    res.json({ ccvs: listMemoryCcvs().map((c) => ({ ...api(c), sessionTitle: c.session_title })) });
  });

  /**
   * Add a remembered memory by hand, not tied to a chat session.
   *
   * Writes a remembered CCV (memory=1) anchored to a reserved "__memories__"
   * session so it surfaces everywhere remembered memories do — the Memories
   * page, listMemoryCcvs, and the agent's memory_search.
   */
  router.post("/ccvs/memories", (req, res) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 12000);
    if (!text) return res.status(400).json({ error: "text is required" });
    const topic = String(req.body?.topic ?? "Context").trim().slice(0, 60) || "Context";
    const seq = Date.now();
    const id = ccvHash(MEMORIES_SESSION, seq, `memory_${topic}`, 0);
    upsertCcv({
      id,
      session_id: MEMORIES_SESSION,
      seq,
      idx: 0,
      type: "message",
      owner: "user",
      content: `[${topic}] ${text}`,
    });
    updateCcv(id, { memory: 1 });
    res.json({ ccv: api(getCcv(id)) });
  });

  /** Fetch a single CCV by its hash (a callable memory / deep link). */
  router.get("/ccvs/:id", (req, res) => {
    const c = getCcv(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json({ ccv: api(c) });
  });

  /** Edit a CCV's content and/or mark it as a remembered memory. */
  router.patch("/ccvs/:id", (req, res) => {
    const c = getCcv(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    const { content, memory } = req.body ?? {};
    updateCcv(c.id, {
      ...(typeof content === "string" ? { content } : {}),
      ...(typeof memory === "boolean" ? { memory: memory ? 1 : 0 } : {}),
    });
    res.json({ ccv: api(getCcv(c.id)) });
  });

  return router;
}
