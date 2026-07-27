import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express, { type Router } from "express";

const run = promisify(execFile);

/**
 * pi packages (extensions, skills, prompts, themes) are managed by the pi CLI
 * rather than the RPC protocol, so these shell out.
 *
 * They install under $HOME/.pi/agent, which the image points at a persistent
 * volume — otherwise every rebuild would silently wipe installed packages.
 */
async function pi(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("pi", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error((err.stderr || err.stdout || err.message).trim());
  }
}

// A package spec is passed to the CLI as a single argument (never a shell
// string), but keep it to shapes pi documents so typos fail fast and nothing
// odd reaches execFile.
const SPEC_RE = /^(npm:|git:|https:\/\/|\.{0,2}\/)[\w@./:+-]+$/;

export function packagesRouter(): Router {
  const router = express.Router();

  router.get("/packages", async (_req, res) => {
    try {
      const { stdout } = await pi(["list"]);
      res.json({ output: stdout.trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/packages", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !SPEC_RE.test(spec)) {
      return res.status(400).json({
        error: "Spec must look like npm:pkg@1.0.0, git:github.com/user/repo, https://…, or a path",
      });
    }
    try {
      const { stdout, stderr } = await pi(["install", spec]);
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/packages", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !SPEC_RE.test(spec)) {
      return res.status(400).json({ error: "Invalid package spec" });
    }
    try {
      const { stdout, stderr } = await pi(["remove", spec]);
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/packages/update", async (_req, res) => {
    try {
      const { stdout, stderr } = await pi(["update", "--all"]);
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
