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
import { extensionsRouter } from "./api/extensions.js";
import { piSettingsPath } from "./pi-settings.js";
import { getBuiltinCommands } from "./pi/builtins.js";
import { isValidSlug, slugify } from "./slug.js";
import { getSettingDefaults, getSettings, getStoredSettings, setSettings } from "./db.js";

// WORKSPACE_ROOT is the new name; WORKSPACE_ROOT still works for existing deploys.
const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || process.env.WORKSPACE_ROOT || "/workspaces"
);
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
  // `stored` and `defaults` are separated so the UI can show an empty field
  // with the inherited value as a placeholder, instead of pre-filling it and
  // turning the next Save into a permanent pin.
  res.json({
    settings: getSettings(),
    stored: getStoredSettings(),
    defaults: getSettingDefaults(),
    piSettingsPath: piSettingsPath(),
    executor: EXECUTOR_KIND,
    workspaceRoot: WORKSPACE_ROOT,
  });
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

// --- workspaces ---

/** Directories pi can be pointed at. Anything directly under WORKSPACE_ROOT. */
app.get("/api/workspaces", (_req, res) => {
  if (!existsSync(WORKSPACE_ROOT)) return res.json({ root: WORKSPACE_ROOT, workspaces: [] });
  const workspaces = readdirSync(WORKSPACE_ROOT)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(path.join(WORKSPACE_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({
      name,
      path: path.join(WORKSPACE_ROOT, name),
      isGit: existsSync(path.join(WORKSPACE_ROOT, name, ".git")),
    }));
  res.json({ root: WORKSPACE_ROOT, workspaces });
});

app.post("/api/workspaces", (req, res) => {
  const raw = req.body?.name;
  if (typeof raw !== "string" || !raw.trim()) {
    return res.status(400).json({ error: "name required" });
  }
  // "Cool Project" becomes the directory "cool-project", and that same slug
  // becomes the session title — one name drives both.
  const name = slugify(raw);
  if (!isValidSlug(name)) {
    return res.status(400).json({ error: `"${raw}" does not produce a usable folder name` });
  }

  const target = path.join(WORKSPACE_ROOT, name);
  if (path.resolve(target) !== target || !target.startsWith(WORKSPACE_ROOT + path.sep)) {
    return res.status(400).json({ error: "Invalid workspace name" });
  }
  if (existsSync(target)) return res.status(409).json({ error: `Workspace "${name}" already exists` });

  try {
    mkdirSync(target, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
  res.json({ name, path: target, isGit: false });
});

// --- sessions ---

/** SQLite stores pinned as 0/1; the API speaks booleans. */
const toApi = (s: ReturnType<typeof getSession> & {}) => ({
  ...s,
  pinned: Boolean(s.pinned),
  live: sessions.isRunning(s.id),
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listSessions().map(toApi), executor: EXECUTOR_KIND });
});

app.post("/api/sessions", (req, res) => {
  const { title, workspace } = req.body ?? {};
  if (typeof workspace !== "string" || !workspace) {
    return res.status(400).json({ error: "workspace required" });
  }
  // Keep pi inside the mounted workspace area — no escaping to the rest of the FS.
  const resolved = path.resolve(workspace);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    return res.status(400).json({ error: "workspace must be inside the workspace root" });
  }
  if (!existsSync(resolved)) return res.status(400).json({ error: "workspace does not exist" });

  const id = nanoid(12);
  createSession({
    id,
    // Default the session name to the workspace folder name.
    title: (typeof title === "string" && title.trim()) || path.basename(resolved),
    workspace: resolved,
    executor: EXECUTOR_KIND,
  });
  res.json(toApi(getSession(id)!));
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json(toApi(session));
});

app.patch("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { title, pinned } = req.body ?? {};
  if (typeof title === "string" && title.trim()) updateSession(session.id, { title: title.trim() });
  if (typeof pinned === "boolean") updateSession(session.id, { pinned: pinned ? 1 : 0 });
  res.json(toApi(getSession(session.id)!));
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

/** The browser answering a dialog an extension is waiting on. */
app.post("/api/sessions/:id/ui-response", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { id, value, cancelled } = req.body ?? {};
  if (typeof id !== "string") return res.status(400).json({ error: "id required" });
  const delivered = sessions.respondUi(session.id, id, { value, cancelled: Boolean(cancelled) });
  res.json({ ok: delivered, note: delivered ? undefined : "Request already resolved or expired" });
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
    // Reading config starts pi if it isn't already up, so these are the live
    // values rather than a guess from env defaults.
    const client = await sessions.client(session.id);
    const [state, levels, models, stats] = await Promise.all([
      client.getState(),
      client.getThinkingLevels(),
      client.getModels(),
      client.getStats(),
    ]);
    res.json({ state, thinking: { levels }, models: { models }, stats });
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
    const client = await sessions.client(session.id);
    if (typeof modelId === "string" && modelId) {
      await client.setModel(provider || getSettings().provider, modelId);
      applied.push("model");
    }
    if (typeof thinkingLevel === "string" && thinkingLevel) {
      await client.setThinkingLevel(thinkingLevel);
      applied.push("thinkingLevel");
    }
    if (typeof autoCompaction === "boolean") {
      await client.setAutoCompaction(autoCompaction);
      applied.push("autoCompaction");
    }
    if (typeof autoRetry === "boolean") {
      await client.setAutoRetry(autoRetry);
      applied.push("autoRetry");
    }
    const state = await client.getState();
    // Recorded so the choice survives a restart, not just this pi process.
    // Taken from the resolved state rather than the request: pi coerces the
    // thinking level on a non-reasoning model, and storing what was asked for
    // would reapply the rejected value on every relaunch.
    //
    // Only the fields actually changed are written. Persisting all of them on
    // any change meant that adjusting the effort while pi was sitting on a
    // fallback model wrote that fallback in as the session's chosen model.
    const patch: Parameters<typeof updateSession>[1] = {};
    if (applied.includes("model")) {
      patch.provider = state.model.provider;
      patch.model = state.model.id;
    }
    if (applied.includes("thinkingLevel")) patch.thinking_level = state.thinkingLevel;
    if (Object.keys(patch).length) updateSession(session.id, patch);

    res.json({ ok: true, applied, state });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, applied });
  }
});

app.post("/api/sessions/:id/compact", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    const client = await sessions.client(session.id);
    await client.compact();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Commands available in this session: built-ins plus anything contributed by
 * installed packages. Discovered at runtime, so installing a package makes its
 * commands available immediately.
 */
app.get("/api/sessions/:id/commands", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    const client = await sessions.client(session.id);
    // Builtins first: they are the ones people reach for most.
    const [builtins, discovered] = await Promise.all([
      getBuiltinCommands(),
      client.getCommands(),
    ]);
    res.json({ commands: [...builtins, ...discovered] });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- pi packages (extensions, skills, prompts, themes) ---
app.use("/api", packagesRouter());
app.use("/api", extensionsRouter());

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
    // Live-only events carry a negative seq: deliver them, but never let one
    // move the replay cursor, or a reconnect would skip stored history.
    if (row.seq < 0) {
      write(row);
      return;
    }
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
  console.log(`  workspaces: ${WORKSPACE_ROOT}`);
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
