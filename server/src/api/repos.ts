import express, { type Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listRepos, upsertRepo, type RepoRow } from "../db.js";

const exec = promisify(execFile);

/** Live git facts pulled from the repo's .git, or empty when not a repo. */
async function gitInfo(p: string): Promise<{ branch: string; commit: string; dirty: boolean }> {
  try {
    const [br, co] = await Promise.all([
      exec("git", ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]).then((r) => r.stdout.trim()),
      exec("git", ["-C", p, "rev-parse", "--short", "HEAD"]).then((r) => r.stdout.trim()),
    ]);
    let dirty = false;
    try {
      const status = await exec("git", ["-C", p, "status", "--porcelain"]);
      dirty = status.stdout.trim().length > 0;
    } catch {
      dirty = false;
    }
    return { branch: br || "", commit: co || "", dirty };
  } catch {
    return { branch: "", commit: "", dirty: false };
  }
}

const view = async (r: RepoRow) => ({
  id: r.id,
  name: r.name,
  path: r.path,
  git: await gitInfo(r.path),
  createdAt: r.created_at,
});

export function reposRouter(): Router {
  const router = express.Router();

  /** All registered repos with live git info. */
  router.get("/repos", async (_req, res) => {
    const rows = listRepos();
    res.json({ repos: await Promise.all(rows.map(view)) });
  });

  /** Register a repo by path (must exist and be inside WORKSPACE_ROOT-ish). */
  router.post("/repos", async (req, res) => {
    const raw = req.body?.path;
    if (typeof raw !== "string" || !raw) {
      return res.status(400).json({ error: "path required" });
    }
    const p = path.resolve(raw);
    if (!existsSync(p)) return res.status(400).json({ error: "path does not exist" });
    const name = (typeof req.body?.name === "string" && req.body.name.trim()) || path.basename(p);
    const existing = listRepos().find((r) => r.path === p);
    if (existing) return res.json({ repo: await view(existing) });
    const id = `r_${p.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || path.basename(p)}`;
    upsertRepo(id, name, p);
    res.json({ repo: await view(listRepos().find((r) => r.path === p)!) });
  });

  return router;
}

/** Seed the portal's own repo so the Repos tab has this app by default. */
export function seedPithagorasRepo(): void {
  try {
    const here = path.resolve(process.cwd());
    if (existsSync(path.join(here, ".git"))) {
      upsertRepo(`r_pithagoras`, "pithagoras", here);
    }
  } catch {
    /* not a repo — skip seeding */
  }
}
