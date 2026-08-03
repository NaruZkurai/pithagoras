import express, { type Router } from "express";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getSession } from "../db.js";

/**
 * Workspace file access from the browser.
 *
 * Two views of the same files:
 *  - /api/sessions/:id/... — the in-chat explorer, scoped to the open
 *    session's workspace, read-only preview.
 *  - /api/workspaces/:name/... — the Files page: full browse, edit,
 *    download (single file or whole-workspace .tar.gz) and delete.
 * Both resolve a relative path against the workspace root and reject
 * anything that escapes it; the agent owns the files either way.
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

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "/workspaces");

/** Excluded from "download whole workspace" — regenerable or huge, not the work itself. */
const ARCHIVE_EXCLUDES = ["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"];

/** Above this, a file is offered as a download only — not decoded into a JSON body. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** The workspace's absolute directory, or throws for a name that isn't one. */
function workspaceDir(name: string): string {
  const dir = path.join(WORKSPACE_ROOT, name);
  if (path.resolve(dir) !== dir || !dir.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error("Invalid workspace name");
  }
  if (!existsSync(dir)) throw new Error(`Workspace "${name}" not found`);
  return dir;
}

/**
 * A path within a workspace, rejecting anything that escapes it via `..` or
 * an absolute override — the query string is client-controlled.
 */
function resolveSafe(base: string, relPath: string): string {
  const rel = String(relPath ?? "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Path escapes the workspace");
  }
  return resolved;
}

/** Null bytes in the first few KB are the cheap, reliable "not text" signal. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
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



  router.get("/workspaces/:name/files", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      const stat = statSync(target);
      if (!stat.isDirectory()) return res.status(400).json({ error: "Not a directory" });

      const entries = readdirSync(target, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => {
          const st = statSync(path.join(target, e.name));
          return {
            name: e.name,
            type: e.isDirectory() ? ("dir" as const) : ("file" as const),
            size: st.size,
            mtime: st.mtimeMs,
          };
        })
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
        );

      res.json({ path: path.relative(dir, target), entries });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/workspaces/:name/file", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      const stat = statSync(target);
      if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });

      if (req.query.download === "1") {
        return res.download(target, path.basename(target));
      }

      const buffer = readFileSync(target);
      if (looksBinary(buffer) || stat.size > MAX_EDIT_BYTES) {
        return res.json({ binary: true, size: stat.size });
      }
      res.json({ binary: false, size: stat.size, content: buffer.toString("utf8") });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.put("/workspaces/:name/file", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      const { content } = req.body ?? {};
      if (typeof content !== "string") return res.status(400).json({ error: "content required" });
      writeFileSync(target, content, "utf8");
      const stat = statSync(target);
      res.json({ ok: true, size: stat.size, mtime: stat.mtimeMs });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * Removes a file or a whole folder (recursively). The workspace root itself
   * is refused — that would be deleting the workspace, not something in it.
   */
  router.delete("/workspaces/:name/file", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      if (target === dir) return res.status(400).json({ error: "Cannot delete the workspace root" });
      if (!existsSync(target)) return res.status(404).json({ error: "Not found" });
      rmSync(target, { recursive: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * The whole workspace as a .tar.gz. Streamed straight from `tar` rather than
   * staged on disk first — a big repo would otherwise need double the space
   * and a cleanup step.
   */
  router.get("/workspaces/:name/archive", (req, res) => {
    let dir: string;
    try {
      dir = workspaceDir(req.params.name);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.tar.gz"`
    );

    const args = [
      "-czf",
      "-",
      ...ARCHIVE_EXCLUDES.map((d) => `--exclude=${d}`),
      "-C",
      dir,
      ".",
    ];
    const tar = spawn("tar", args);
    tar.stdout.pipe(res);
    // tar exits non-zero on excluded-but-vanished files etc.; the stream
    // itself already carries whatever it managed to read, so ignore stderr.
    tar.stderr.resume();
    tar.on("error", () => res.end());
  });

  return router;
}
