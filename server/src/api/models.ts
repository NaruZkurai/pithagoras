import express, { type Router } from "express";
import { deleteModelServer, getModelServer, listModelServers, upsertModelServer } from "../db.js";
import { start, status, stop } from "../model-server.js";

/**
 * Launch / stop llama.cpp servers from the UI. Each row in model_servers is
 * one server (bin + model path + port + flags + enabled). The main server on
 * 41001 is what pi talks to; any others (e.g. the rank model) work the same way.
 */
export function modelsRouter(): Router {
  const router = express.Router();

  router.get("/models/servers", async (_req, res) => {
    const servers = await Promise.all(
      listModelServers().map(async (s) => ({ ...s, status: await status(s) }))
    );
    res.json({ servers });
  });

  router.post("/models/servers", (req, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    upsertModelServer({
      name,
      bin: String(b.bin ?? "").trim() || "/nzk/bin/llama-turbo-latest/llama-server",
      model: String(b.model ?? "").trim(),
      alias: String(b.alias ?? "").trim(),
      port: Math.max(1, Math.min(65535, Number(b.port) || 41001)),
      ngl: Number(b.ngl) || 0,
      ctx: Number(b.ctx) || 2048,
      threads: Number(b.threads) || 12,
      parallel: Number(b.parallel) || 2,
      no_kv_offload: b.no_kv_offload === false ? 0 : 1,
      extra_args: String(b.extra_args ?? ""),
      enabled: b.enabled ? 1 : 0,
    });
    res.json({ ok: true, server: getModelServer(name) });
  });

  router.post("/models/servers/:id/start", async (req, res) => {
    try {
      await start(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/models/servers/:id/stop", async (req, res) => {
    try {
      await stop(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/models/servers/:id", async (req, res) => {
    try {
      await stop(req.params.id);
    } catch {
      // ignore
    }
    deleteModelServer(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
