import express, { type Router } from "express";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getSession } from "../db.js";

/**
 * Workspace file access for the built-in file explorer.
 *
 * Scoped to a session's workspace: every request resolves a relative path
 * against the workspace and rejects anything that escapes it. Reads are for
 * preview only — no writes, no delete, no rename. The agent owns the files;
 * this is just a window into what it is doing.
 */

/** Directories the explorer hides by default (huge build/tool dirs). */
const IGNORED = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".idea",
  ".vscode",
  "Pods",
]);

/** Largest file the explorer will open in the preview. */
const MAX_PREVIEW = 512 * 1024;

/** Resolve a relative path inside the workspace, or null if it escapes. */
function resolveInWorkspace(workspace: string, rel: string): string | null {
  const base = path.resolve(workspace);
  const target = path.resolve(base, rel || ".");
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export function filesRouter(): Router {
  const router = express.Router();

  /** GET /api/sessions/:id/files?path=<rel>&all=1 — list a workspace directory. */
  router.get("/sessions/:id/files", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const workspace = path.resolve(session.workspace);
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const dir = resolveInWorkspace(workspace, rel);
    if (!dir) return res.status(400).json({ error: "Path escapes the workspace" });
    if (!existsSync(dir)) return res.status(404).json({ error: "Not found" });
    const st = statSync(dir);
    if (!st.isDirectory()) return res.status(400).json({ error: "Not a directory" });

    const showAll = req.query.all === "1";
    const names = readdirSync(dir)
      .filter((n) => n !== "." && n !== "..")
      .filter((n) => showAll || !IGNORED.has(n));

    const entries = names
      .map((name) => {
        let s: ReturnType<typeof statSync>;
        try {
          s = statSync(path.join(dir, name));
        } catch {
          return null; // vanished between readdir and stat — skip it
        }
        const relPath = path.relative(workspace, path.join(dir, name)).split(path.sep).join("/");
        return {
          name,
          path: relPath,
          isDir: s.isDirectory(),
          size: s.isDirectory() ? null : s.size,
          mtime: s.mtime.toISOString(),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // Folders first, then files; alphabetical within each.
    entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    );

    res.json({ workspace, path: rel, entries });
  });

  /** GET /api/sessions/:id/file?path=<rel> — read a file for preview. */
  router.get("/sessions/:id/file", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const workspace = path.resolve(session.workspace);
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const file = resolveInWorkspace(workspace, rel);
    if (!file) return res.status(400).json({ error: "Path escapes the workspace" });
    if (!existsSync(file)) return res.status(404).json({ error: "Not found" });
    const st = statSync(file);
    if (st.isDirectory()) return res.status(400).json({ error: "Is a directory" });
    if (st.size > MAX_PREVIEW) {
      return res.status(413).json({ error: `Too large to preview (${st.size} bytes)` });
    }

    const buf = readFileSync(file);
    // Binary heuristic: a NUL byte in the first chunk means it is not text.
    if (buf.includes(0)) {
      return res.json({ path: rel, binary: true, size: buf.length });
    }
    return res.json({ path: rel, content: buf.toString("utf8"), size: buf.length });
  });

  return router;
}
