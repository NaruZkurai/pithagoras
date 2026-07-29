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
  /** SQLite has no boolean; 0 or 1. */
  pinned: number;
  /** pi's own session file, so the exact conversation is reopened on restart. */
  pi_session_file: string | null;
  /**
   * "task" for the ones you create here, "agent" for one reached through a
   * channel, "routine" for one a schedule owns.
   */
  kind: "task" | "agent" | "routine";
  /**
   * Agent sessions only: the slug of the channel it arrived through.
   *
   * The slug rather than the channel's id, because ids are regenerated when a
   * channel is deleted and recreated — which orphaned every conversation it
   * had. A slug is stable and yours to choose, so re-adding a channel under the
   * same one picks its conversations back up.
   */
  channel_slug: string | null;
  /**
   * Agent sessions only: the conversation key, as `<channel slug>:<package key>`.
   * The package decides what a conversation is — a Telegram chat id, a Slack
   * channel — and the prefix keeps two channels using the same key apart.
   */
  channel_key: string | null;
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
      thinking_level TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      pi_session_file TEXT,
      kind TEXT NOT NULL DEFAULT 'task',
      channel_slug TEXT,
      channel_key TEXT,
      routine_slug TEXT
    );
    -- The index on (channel_id, channel_key) is created in migrate(), not here.
    -- CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so on an
    -- upgrade these columns do not exist yet at this point and indexing them
    -- fails — which took the server down until the migration had run.

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

    -- Two-way links into the agent session. Each row is one connection
    -- (a Telegram bot, a Slack app, an inbound webhook); messages arriving on
    -- any of them go to the same agent, and its replies go back the same way.
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      -- Stable, yours to choose, and what agent sessions are keyed on. Delete a
      -- channel and recreate it under the same slug and its conversations come
      -- back; the primary key is regenerated and would not.
      slug TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      -- Appended to the agent's system prompt for messages arriving here, so
      -- one door can carry standing guidance the others do not.
      instructions TEXT NOT NULL DEFAULT '',
      -- What the channel relays while the agent works, rather than only at the
      -- end. Both are per channel: a phone wants less noise than a war room.
      relay_progress INTEGER NOT NULL DEFAULT 1,
      relay_tools INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Scheduled work. Each routine owns one session, so a run can see what the
    -- last one did rather than starting blind every time.
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      -- Five-field cron, or one of the @shorthands.
      schedule TEXT NOT NULL,
      -- What the agent is asked to do, verbatim.
      instructions TEXT NOT NULL DEFAULT '',
      -- Start each run in a clean session instead of the routine's own.
      fresh_session INTEGER NOT NULL DEFAULT 0,
      last_run TEXT,
      last_status TEXT,
      last_output TEXT,
      last_ms INTEGER,
      next_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
  if (!names.includes("pinned")) {
    d.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.includes("pi_session_file")) {
    d.exec("ALTER TABLE sessions ADD COLUMN pi_session_file TEXT");
  }

  if (!names.includes("kind")) {
    d.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
  }
  // channel_id was the original link and was a mistake — see channel_slug.
  // There is no data worth migrating, so the old column and its sessions go.
  if (names.includes("channel_id")) {
    d.exec("DROP INDEX IF EXISTS idx_sessions_channel");
    d.exec("DELETE FROM sessions WHERE kind = 'agent'");
    d.exec("ALTER TABLE sessions DROP COLUMN channel_id");
  }
  if (!names.includes("channel_slug")) {
    d.exec("ALTER TABLE sessions ADD COLUMN channel_slug TEXT");
  }
  if (!names.includes("channel_key")) d.exec("ALTER TABLE sessions ADD COLUMN channel_key TEXT");
  if (!names.includes("routine_slug")) d.exec("ALTER TABLE sessions ADD COLUMN routine_slug TEXT");
  // The key already carries its channel's slug, so it is unique on its own.
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_channel_key
            ON sessions(channel_key) WHERE channel_key IS NOT NULL`);

  const channelCols = (d.prepare("PRAGMA table_info(channels)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (channelCols.length && !channelCols.includes("instructions")) {
    d.exec("ALTER TABLE channels ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  }
  if (channelCols.length && !channelCols.includes("slug")) {
    d.exec("ALTER TABLE channels ADD COLUMN slug TEXT NOT NULL DEFAULT ''");
    // Nothing sensible to backfill from, and no data to lose.
    d.exec("DELETE FROM channels WHERE slug = ''");
  }
  if (channelCols.length && !channelCols.includes("relay_progress")) {
    d.exec("ALTER TABLE channels ADD COLUMN relay_progress INTEGER NOT NULL DEFAULT 1");
  }
  if (channelCols.length && !channelCols.includes("relay_tools")) {
    d.exec("ALTER TABLE channels ADD COLUMN relay_tools INTEGER NOT NULL DEFAULT 1");
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug)");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug)");
}

export function createSession(row: {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  kind?: "task" | "agent" | "routine";
  channel_slug?: string | null;
  channel_key?: string | null;
  routine_slug?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key, routine_slug)
       VALUES (@id, @title, @workspace, @executor, @kind, @channel_slug, @channel_key, @routine_slug)`
    )
    .run({
      kind: "task",
      channel_slug: null,
      channel_key: null,
      routine_slug: null,
      ...row,
    });
}

/** The sessions you create yourself. Agent sessions have their own tab. */
export function listSessions(): SessionRow[] {
  // Pinned first, then most recently touched — the order the sidebar shows.
  return getDb()
    .prepare("SELECT * FROM sessions WHERE kind = 'task' ORDER BY pinned DESC, updated_at DESC")
    .all() as SessionRow[];
}

/** Conversations reached through a channel, newest first. */
export function listAgentSessions(): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE kind = 'agent' ORDER BY updated_at DESC")
    .all() as SessionRow[];
}

export function findChannelSession(key: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE channel_key = ?").get(key) as
    | SessionRow
    | undefined;
}

/** The session a routine owns, if it has run before. */
export function findRoutineSession(slug: string): SessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE routine_slug = ? AND kind = 'routine' ORDER BY created_at ASC")
    .get(slug) as SessionRow | undefined;
}

export function listRoutineSessions(slug?: string): SessionRow[] {
  const sql = slug
    ? "SELECT * FROM sessions WHERE kind = 'routine' AND routine_slug = ? ORDER BY updated_at DESC"
    : "SELECT * FROM sessions WHERE kind = 'routine' ORDER BY updated_at DESC";
  return (slug ? getDb().prepare(sql).all(slug) : getDb().prepare(sql).all()) as SessionRow[];
}

/** How many conversations a channel would strand if it were removed. */
export function countChannelSessions(slug: string): number {
  const row = getDb()
    .prepare("SELECT count(*) AS n FROM sessions WHERE channel_slug = ?")
    .get(slug) as { n: number };
  return row.n;
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export function updateSession(
  id: string,
  fields: Partial<
    Pick<
      SessionRow,
      | "title"
      | "status"
      | "last_error"
      | "provider"
      | "model"
      | "thinking_level"
      | "pinned"
      | "pi_session_file"
    >
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
