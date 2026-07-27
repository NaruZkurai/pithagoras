import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";
import {
  createSession,
  deleteSession,
  eventsSince,
  getSession,
  listSessions,
  updateSession,
} from "./db.js";
import { sessions, EXECUTOR_KIND } from "./session-manager.js";
import { authEnabled, checkPassword, isAuthed, issueCookie, requireAuth } from "./auth.js";
import { packagesRouter } from "./api/packages.js";
import { getSettings, setSettings } from "./db.js";

const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT || "/projects");
const PORT = Number(process.env.PORT || 4100);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// --- auth ---

app.get("/api/auth/status", (req, res) => {
  res.json({ authRequired: authEnabled, authed: isAuthed(req) });
});

app.post("/api/auth/login", (req, res) => {
  if (!authEnabled) return res.json({ ok: true });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  issueCookie(res);
  res.json({ ok: true });
});

app.use("/api", requireAuth);

// --- global settings (defaults for every new session) ---

app.get("/api/settings", (_req, res) => {
  res.json({ settings: getSettings(), executor: EXECUTOR_KIND, projectRoot: PROJECT_ROOT });
});

app.put("/api/settings", (req, res) => {
  const { provider, model, thinkingLevel } = req.body ?? {};
  const patch: Record<string, string> = {};
  if (typeof provider === "string") patch.provider = provider.trim();
  if (typeof model === "string") patch.model = model.trim();
  if (typeof thinkingLevel === "string") patch.thinkingLevel = thinkingLevel.trim();
  const settings = setSettings(patch);
  // Existing sessions keep their own settings; this applies to sessions started
  // from here on, which matches how the TUI treats a changed default.
  res.json({ settings, note: "Applies to newly started sessions" });
});

// --- projects ---

/** Directories pi can be pointed at. Anything directly under PROJECT_ROOT. */
app.get("/api/projects", (_req, res) => {
  if (!existsSync(PROJECT_ROOT)) return res.json({ root: PROJECT_ROOT, projects: [] });
  const projects = readdirSync(PROJECT_ROOT)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(path.join(PROJECT_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({
      name,
      path: path.join(PROJECT_ROOT, name),
      isGit: existsSync(path.join(PROJECT_ROOT, name, ".git")),
    }));
  res.json({ root: PROJECT_ROOT, projects });
});

// A project name is a single directory under PROJECT_ROOT: no separators, no
// traversal, nothing that could resolve outside the mounted area.
const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

app.post("/api/projects", (req, res) => {
  const name = req.body?.name;
  if (typeof name !== "string" || !PROJECT_NAME_RE.test(name) || name === "." || name === "..") {
    return res.status(400).json({
      error: "Name must be 1-64 chars: letters, digits, dot, dash, underscore; no slashes",
    });
  }

  const target = path.join(PROJECT_ROOT, name);
  // Belt and braces: even with the regex, confirm the result is really inside.
  if (path.resolve(target) !== target || !target.startsWith(PROJECT_ROOT + path.sep)) {
    return res.status(400).json({ error: "Invalid project name" });
  }
  if (existsSync(target)) return res.status(409).json({ error: "That project already exists" });

  try {
    mkdirSync(target, { recursive: false });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
  res.json({ name, path: target, isGit: false });
});

// --- sessions ---

app.get("/api/sessions", (_req, res) => {
  const rows = listSessions().map((s) => ({ ...s, live: sessions.isRunning(s.id) }));
  res.json({ sessions: rows, executor: EXECUTOR_KIND });
});

app.post("/api/sessions", (req, res) => {
  const { title, project } = req.body ?? {};
  if (typeof project !== "string" || !project) {
    return res.status(400).json({ error: "project required" });
  }
  // Keep pi inside the mounted project area — no escaping to the rest of the FS.
  const resolved = path.resolve(project);
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(PROJECT_ROOT + path.sep)) {
    return res.status(400).json({ error: "project must be inside the project root" });
  }
  if (!existsSync(resolved)) return res.status(400).json({ error: "project does not exist" });

  const id = nanoid(12);
  createSession({
    id,
    title: (typeof title === "string" && title.trim()) || "New task",
    project: resolved,
    executor: EXECUTOR_KIND,
  });
  res.json(getSession(id));
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json({ ...session, live: sessions.isRunning(session.id) });
});

app.patch("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { title } = req.body ?? {};
  if (typeof title === "string" && title.trim()) updateSession(session.id, { title: title.trim() });
  res.json(getSession(session.id));
});

app.delete("/api/sessions/:id", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.stop(session.id);
  deleteSession(session.id);
  res.json({ ok: true });
});

// --- prompting ---

app.post("/api/sessions/:id/prompt", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const message = req.body?.message;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message required" });
  }
  try {
    // Returns as soon as pi accepts the prompt. The run continues server-side
    // regardless of what this browser does next.
    await sessions.prompt(session.id, message);
    res.json({ ok: true, status: "running" });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions/:id/abort", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.abort(session.id);
  res.json({ ok: true });
});

// --- per-session config (the web equivalent of the TUI's slash commands) ---

app.get("/api/sessions/:id/config", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    // Reading config starts pi if it isn't already up, so the values shown are
    // the live ones rather than a guess from env defaults.
    const [state, thinking, models, stats] = await Promise.all([
      sessions.command(session.id, "get_state"),
      sessions.command(session.id, "get_available_thinking_levels"),
      sessions.command(session.id, "get_available_models"),
      sessions.command(session.id, "get_session_stats"),
    ]);
    res.json({ state, thinking, models, stats });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions/:id/config", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { provider, modelId, thinkingLevel, autoCompaction, autoRetry } = req.body ?? {};
  const applied: string[] = [];
  try {
    if (typeof modelId === "string" && modelId) {
      // pi resolves a model as `${provider}/${modelId}` — both are required.
      await sessions.command(session.id, "set_model", {
        provider: provider || process.env.PI_PROVIDER || "openrouter",
        modelId,
      });
      applied.push("model");
    }
    if (typeof thinkingLevel === "string" && thinkingLevel) {
      await sessions.command(session.id, "set_thinking_level", { level: thinkingLevel });
      applied.push("thinkingLevel");
    }
    if (typeof autoCompaction === "boolean") {
      await sessions.command(session.id, "set_auto_compaction", { enabled: autoCompaction });
      applied.push("autoCompaction");
    }
    if (typeof autoRetry === "boolean") {
      await sessions.command(session.id, "set_auto_retry", { enabled: autoRetry });
      applied.push("autoRetry");
    }
    res.json({ ok: true, applied, state: await sessions.command(session.id, "get_state") });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, applied });
  }
});

app.post("/api/sessions/:id/compact", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    await sessions.command(session.id, "compact");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Commands available in this session: built-ins plus anything contributed by
 * installed packages (extensions, prompt templates, skills). Discovered at
 * runtime, so installing a package immediately makes its commands available in
 * the UI without any portal change.
 *
 * pi has no "run command" RPC — commands are invoked by sending them as user
 * input, exactly as the TUI does, so the client just puts `/name` in a prompt.
 */
app.get("/api/sessions/:id/commands", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    const data = (await sessions.command(session.id, "get_commands")) as {
      commands?: unknown[];
    };
    res.json({ commands: data?.commands ?? data ?? [] });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- pi packages (extensions, skills, prompts, themes) ---
app.use("/api", packagesRouter());

// --- event stream ---

/**
 * Replay-then-tail. The client passes the last seq it saw, so reconnecting
 * after minutes or days delivers exactly what was missed and then continues
 * live — no gap, no duplicates.
 */
app.get("/api/sessions/:id/events", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });

  const since = Number(req.query.since ?? 0) || 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (row: { seq: number; type: string; payload: string }) => {
    res.write(`id: ${row.seq}\ndata: ${JSON.stringify({
      seq: row.seq,
      type: row.type,
      payload: JSON.parse(row.payload),
    })}\n\n`);
  };

  let lastSent = since;
  for (const row of eventsSince(session.id, since)) {
    write(row);
    lastSent = row.seq;
  }
  res.write(`event: caught-up\ndata: ${JSON.stringify({ seq: lastSent })}\n\n`);

  const onEvent = (row: { seq: number; type: string; payload: string }) => {
    // Guard against double-sending anything the replay already covered.
    if (row.seq <= lastSent) return;
    lastSent = row.seq;
    write(row);
  };
  sessions.on(`session:${session.id}`, onEvent);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sessions.off(`session:${session.id}`, onEvent);
  });
});

// --- static web UI ---

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`pithagoras listening on :${PORT}`);
  console.log(`  executor: ${EXECUTOR_KIND}`);
  console.log(`  projects: ${PROJECT_ROOT}`);
  console.log(`  auth:     ${authEnabled ? "password" : "DISABLED"}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received — stopping running sessions`);
  await sessions.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
