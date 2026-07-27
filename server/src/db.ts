import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface SessionRow {
  id: string;
  title: string;
  project: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
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
      project TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'host',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT
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
  `);
  return db;
}

export function createSession(row: {
  id: string;
  title: string;
  project: string;
  executor: string;
}): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, title, project, executor) VALUES (@id, @title, @project, @executor)"
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
  fields: Partial<Pick<SessionRow, "title" | "status" | "last_error">>
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
