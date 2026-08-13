import express, { type Router } from "express";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { deleteModelServer, getModelServer, listModelServers, upsertModelServer } from "../db.js";
import { start, status, stop } from "../model-server.js";

/** Extensions treated as model files: picked up automatically by the picker. */
const MODEL_EXTS = new Set([".gguf", ".ggml", ".bin", ".safetensors", ".pt", ".pth"]);

function isModelFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  if (MODEL_EXTS.has(ext)) return true;
  // llama.cpp quantized models like Foo-Q4_K_M.gguf are .gguf; this keeps the
  // binary suffix check for anything unusual.
  return /\.(?:gguf|bin)$/i.test(p);
}

/**
 * Launch / stop llama.cpp servers from the UI. Each row in model_servers is
 * one server (bin + model path + port + flags + enabled). The main server on
 * 41001 is what pi talks to; any others (e.g. the rank model) work the same way.
 */
export function modelsRouter(): Router {
  const router = express.Router();

  router.get("/models/servers", async (_req, res) => {
    const mainPort = Number(
      new URL(process.env.LLAMA_BASE_URL || "http://127.0.0.1:41001").port || 41001
    );
    const servers = await Promise.all(
      listModelServers().map(async (s) => ({
        ...s,
        main: s.port === mainPort,
        status: await status(s),
      }))
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
      draft_model: String(b.draft_model ?? "").trim(),
      draft_ngl: Number(b.draft_ngl) || 0,
      enabled: b.enabled ? 1 : 0,
    });
    res.json({ ok: true, server: getModelServer(name) });
  });

  /**
   * Browse a folder on disk to pick a model file or a llama binary. A
   * filesystem picker for the model server form — no manual path typing.
   *   GET /api/models/fs?path=<abs-dir>
   * Returns the directory's subfolders (so you can keep drilling) and any
   * model files / candidate binaries it contains.
   */
  router.get("/models/fs", (req, res) => {
    const raw = String(req.query.path ?? "");
    const start =
      raw && raw.trim()
        ? path.resolve(raw.trim())
        : process.env.MODEL_DIR || "/nzk/models";
    const target = existsSync(start) && statSync(start).isDirectory() ? start : "/nzk/models";
    try {
      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const models = entries
        .filter((e) => e.isFile() && isModelFile(e.name))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const bins = entries
        .filter((e) => {
          if (!e.isFile()) return false;
          const b = e.name;
          return (
            b === "llama-server" ||
            b === "llama-server.exe" ||
            b.includes("llama-server") ||
            b === "llama-rs" ||
            b.includes("llama-turbo")
          );
        })
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({
        path: target,
        parent: path.dirname(target),
        home: homedir(),
        defaultModelDir: process.env.MODEL_DIR || "/nzk/models",
        dirs,
        models,
        bins,
      });
    } catch {
      res.status(400).json({ error: `Cannot read ${target}` });
    }
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
