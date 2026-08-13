import express, { type Router } from "express";
import { getCcv, listCcvs, listMemoryCcvs, updateCcv } from "../db.js";

/**
 * Callable chat variables (CCVs) — every chat atom (message, thought, tool
 * call, shell output) as a hashed, callable memory. These endpoints let the
 * UI list a session's CCVs, fetch one by its hash, edit its content, and
 * mark one as a remembered memory.
 */

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

  /** Everything the user chose to remember across all sessions. */
  router.get("/ccvs/memories", (_req, res) => {
    res.json({ ccvs: listMemoryCcvs().map((c) => ({ ...api(c), sessionTitle: c.session_title })) });
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
