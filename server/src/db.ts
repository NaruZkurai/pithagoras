import Database from "better-sqlite3";
import { piSetting } from "./pi-settings.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  /** Per-session overrides of the portal defaults; null means "use the default". */
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
}

export interface EventRow {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

const DATA_DIR = process.env.DATA_DIR || "./data";
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, "portal.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'host',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      provider TEXT,
      model TEXT,
      thinking_level TEXT
    );

    -- Every event pi emits is appended here. This is what makes the portal
    -- fire-and-forget: a browser that reconnects days later replays from its
    -- last seen seq instead of having missed the run entirely.
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

    -- Portal-wide defaults applied to every new session. Env vars are the
    -- fallback, so an untouched install still works out of the box.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migrate(db);
  return db;
}

/**
 * Migrations run in place rather than recreating the table, so existing
 * sessions and their event history survive an upgrade.
 */
function migrate(d: Database.Database): void {
  const names = (d.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (names.includes("project") && !names.includes("workspace")) {
    d.exec("ALTER TABLE sessions RENAME COLUMN project TO workspace");
  }
  // Model and effort used to live only in the running pi process, so a restart
  // silently reverted every session to the portal defaults.
  for (const col of ["provider", "model", "thinking_level"]) {
    if (!names.includes(col)) d.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
  }
}

export function createSession(row: {
  id: string;
  title: string;
  workspace: string;
  executor: string;
}): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, title, workspace, executor) VALUES (@id, @title, @workspace, @executor)"
    )
    .run(row);
}

export function listSessions(): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
    .all() as SessionRow[];
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export function updateSession(
  id: string,
  fields: Partial<
    Pick<SessionRow, "title" | "status" | "last_error" | "provider" | "model" | "thinking_level">
  >
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values, id);
}

export function deleteSession(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM events WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function appendEvent(sessionId: string, type: string, payload: unknown): EventRow {
  const info = getDb()
    .prepare("INSERT INTO events (session_id, type, payload) VALUES (?, ?, ?)")
    .run(sessionId, type, JSON.stringify(payload));
  return {
    seq: Number(info.lastInsertRowid),
    session_id: sessionId,
    type,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
  };
}

/** Events after `since`, for replaying what a disconnected browser missed. */
export function eventsSince(sessionId: string, since = 0, limit = 5000): EventRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
    )
    .all(sessionId, since, limit) as EventRow[];
}

/**
 * A session marked `running` at boot cannot actually be running — the process
 * that owned it died with the previous server. Mark them interrupted so the UI
 * can offer a resume instead of showing a spinner forever.
 */
export function markOrphanedSessionsInterrupted(): number {
  const info = getDb()
    .prepare(
      "UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE status = 'running'"
    )
    .run();
  return info.changes;
}

// --- global settings ---

export interface GlobalSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
}

/**
 * Read fresh each time rather than cached: pi's settings.json is editable from
 * the Advanced tab, and a stale copy would keep launching the old model.
 *
 * `defaultProvider` / `defaultModel` come from pi itself, so an install
 * configured through the CLI behaves the same here without being set twice.
 * "openrouter" is only the last resort, once pi has no opinion either.
 */
const SETTING_DEFAULTS = (): GlobalSettings => ({
  provider: process.env.PI_PROVIDER || piSetting("defaultProvider") || "openrouter",
  model: process.env.PI_MODEL || piSetting("defaultModel") || "",
  thinkingLevel:
    process.env.PI_THINKING_LEVEL || piSetting("defaultThinkingLevel") || "medium",
});

/** Only what the portal was explicitly told; absent keys fall through. */
export function getStoredSettings(): Partial<GlobalSettings> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(
    rows.filter((r) => r.value).map((r) => [r.key, r.value])
  ) as Partial<GlobalSettings>;
}

/** What pi is actually launched with: stored, else env, else pi's file. */
export function getSettings(): GlobalSettings {
  const stored = getStoredSettings();
  const defaults = SETTING_DEFAULTS();
  return {
    provider: stored.provider || defaults.provider,
    model: stored.model || defaults.model,
    thinkingLevel: stored.thinkingLevel || defaults.thinkingLevel,
  };
}

export { SETTING_DEFAULTS as getSettingDefaults };

/**
 * An empty value clears the override rather than storing "", so a field can be
 * handed back to pi's own defaults instead of being pinned forever.
 */
export function setSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const clear = getDb().prepare("DELETE FROM settings WHERE key = ?");
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "string") continue;
    if (v.trim()) upsert.run(k, v.trim());
    else clear.run(k);
  }
  return getSettings();
}
