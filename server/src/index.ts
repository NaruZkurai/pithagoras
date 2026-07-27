import { existsSync, readdirSync, statSync } from "node:fs";
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
  console.log(`pi-portal listening on :${PORT}`);
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
