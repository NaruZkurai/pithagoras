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
   * channel, "routine" for one a schedule owns, "thread" for a side-chat on a
   * message.
   */
  kind: "task" | "agent" | "routine" | "thread";
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
  /** Routine sessions only: the slug of the routine that owns this session. */
  routine_slug: string | null;
  /** Lowest role this conversation has served — see the migration for why. */
  role: "primary" | "colleague" | "guest" | "unknown";
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
      -- What fires it: 'schedule' (cron / one-off) or 'message' (after an
      -- agent completes a message).
      trigger TEXT NOT NULL DEFAULT 'schedule',
      -- Five-field cron, or one of the @shorthands. Empty for a one-off.
      schedule TEXT NOT NULL DEFAULT '',
      -- Set instead of a schedule: an ISO instant to run at, once.
      run_at TEXT,
      -- What the agent is asked to do, verbatim.
      instructions TEXT NOT NULL DEFAULT '',
      -- Start each run in a clean session instead of the routine's own.
      fresh_session INTEGER NOT NULL DEFAULT 0,
      -- Where a run's report goes. NULL inherits the portal default; '' means
      -- this routine never reports, whatever the default is.
      report_channel TEXT,
      report_target TEXT,
      -- When a run last reached a person. Distinguishes "nothing to say" from
      -- "wrote it out and never sent it", which look identical otherwise.
      last_report_at TEXT,
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
    -- Who the agent talks to. Identified by the platform's own stable id,
    -- scoped by channel, because a display name is chosen by whoever types it.
    CREATE TABLE IF NOT EXISTS people (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      -- primary | colleague | guest | unknown
      role TEXT NOT NULL DEFAULT 'unknown',
      notes TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT,
      announced_at TEXT
    );

    -- Questions a colleague's session could not answer, waiting on the primary
    -- user. The id is short because a human types it back in a chat.
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      person_key TEXT NOT NULL,
      person_name TEXT NOT NULL DEFAULT '',
      channel_slug TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      question TEXT NOT NULL,
      asked_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT,
      answer TEXT
    );

    -- Things the portal said into a conversation while nobody was talking to
    -- it: a routine's report, an answer relayed back. Held until that
    -- conversation next runs, then folded into its context — otherwise the
    -- agent is asked "why did you say that?" about a message it never saw.
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT,
      -- 1 when the person has not seen this yet: the channel could not be
      -- spoken to, so it waits and goes out with the next reply.
      pending_delivery INTEGER NOT NULL DEFAULT 0
    );

    -- Exceptions to what a non-primary role may run. Without these the only
    -- choice is read-only or full trust, and the useful middle — "colleagues may
    -- list my inbox, nothing else" — has nowhere to live.
    CREATE TABLE IF NOT EXISTS tool_rules (
      id TEXT PRIMARY KEY,
      -- colleague | guest | all (both)
      role TEXT NOT NULL,
      tool TEXT NOT NULL,
      -- Glob against the command for bash, the path for file tools.
      pattern TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- The skill library. Skills live on disk but are indexed here so the agent
    -- searches a lightweight manifest (names + descriptions) instead of pi
    -- loading every one into the system prompt.
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      -- Mirrored, pre-tokenized search columns; kept in sync by upsertSkill.
      -- Each row is: name + description (originals), then the lowercased
      -- mirrors and the tokenized mirrors of each.
      name_lc TEXT NOT NULL DEFAULT '',
      desc_lc TEXT NOT NULL DEFAULT '',
      name_tokens TEXT NOT NULL DEFAULT '',
      desc_tokens TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Which skills a session actually used, so a chat can list them for a human.
    CREATE TABLE IF NOT EXISTS skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skill_usage_session ON skill_usage(session_id);

    -- A side-chat attached to one message, like a Discord thread. Isolated
    -- from the rest of the conversation: the thread agent sees only the parent
    -- message and the thread's own history.
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_seq INTEGER NOT NULL,
      parent_role TEXT NOT NULL,
      parent_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);

    -- A thread's own conversation. Nothing outside the thread lives here.
    CREATE TABLE IF NOT EXISTS thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id);

    -- Messages the thread agent has confirmed, across every thread. Queryable
    -- by the agent, and the only thing it remembers between threads.
    CREATE TABLE IF NOT EXISTS confirmations (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_seq INTEGER,
      text TEXT NOT NULL,
      confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_confirmations_time ON confirmations(confirmed_at);

    -- llama.cpp model servers the portal can launch / stop from the UI. The
    -- main one (port 8080) is what pi talks to; others (e.g. the rank model)
    -- can be added and managed the same way.
    CREATE TABLE IF NOT EXISTS model_servers (
      name TEXT PRIMARY KEY,
      bin TEXT NOT NULL,
      model TEXT NOT NULL,
      alias TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 8080,
      ngl INTEGER NOT NULL DEFAULT 0,
      ctx INTEGER NOT NULL DEFAULT 2048,
      threads INTEGER NOT NULL DEFAULT 12,
      parallel INTEGER NOT NULL DEFAULT 2,
      no_kv_offload INTEGER NOT NULL DEFAULT 1,
      extra_args TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  // The lowest role this session has ever served. Ratchets down and never up:
  // once a guest has spoken in a conversation, the private context files stay
  // out of it even if the next message is from the primary user.
  if (!names.includes("role")) {
    d.exec("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'");
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
  const routineCols = (d.prepare("PRAGMA table_info(routines)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (routineCols.length && !routineCols.includes("run_at")) {
    d.exec("ALTER TABLE routines ADD COLUMN run_at TEXT");
  }
  if (routineCols.length && !routineCols.includes("trigger")) {
    d.exec("ALTER TABLE routines ADD COLUMN trigger TEXT NOT NULL DEFAULT 'schedule'");
  }
  // A routine can be bound to one chat ('session' + its id) or left to fire
  // anywhere ('any' — every chat for message triggers, its own session otherwise).
  if (routineCols.length && !routineCols.includes("target")) {
    d.exec("ALTER TABLE routines ADD COLUMN target TEXT NOT NULL DEFAULT 'any'");
  }
  if (routineCols.length && !routineCols.includes("target_session_id")) {
    d.exec("ALTER TABLE routines ADD COLUMN target_session_id TEXT");
  }
  for (const col of ["report_channel", "report_target", "last_report_at"]) {
    if (routineCols.length && !routineCols.includes(col)) {
      d.exec(`ALTER TABLE routines ADD COLUMN ${col} TEXT`);
    }
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_notes_pending ON notes(session_id, consumed_at)");
  const noteCols = (d.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (noteCols.length && !noteCols.includes("pending_delivery")) {
    d.exec("ALTER TABLE notes ADD COLUMN pending_delivery INTEGER NOT NULL DEFAULT 0");
  }

  // Mirrored, pre-tokenized search columns on skills (see tokenizeSkill).
  const skillCols = (d.prepare("PRAGMA table_info(skills)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (skillCols.length) {
    if (!skillCols.includes("name_lc")) d.exec("ALTER TABLE skills ADD COLUMN name_lc TEXT NOT NULL DEFAULT ''");
    if (!skillCols.includes("desc_lc")) d.exec("ALTER TABLE skills ADD COLUMN desc_lc TEXT NOT NULL DEFAULT ''");
    if (!skillCols.includes("name_tokens")) d.exec("ALTER TABLE skills ADD COLUMN name_tokens TEXT NOT NULL DEFAULT ''");
    if (!skillCols.includes("desc_tokens")) d.exec("ALTER TABLE skills ADD COLUMN desc_tokens TEXT NOT NULL DEFAULT ''");
    // The semantic-vector column was an experiment; the library search is pure
    // lexical over the token mirrors, so drop it if a previous run created it.
    if (skillCols.includes("embedding")) d.exec("ALTER TABLE skills DROP COLUMN embedding");
    // An earlier iteration kept one merged `tokens` column; it was replaced by
    // the split name/desc token mirrors.
    if (skillCols.includes("tokens")) d.exec("ALTER TABLE skills DROP COLUMN tokens");
    // Backfill rows created before the mirrored columns existed.
    const stale = d
      .prepare(
        "SELECT name, description FROM skills WHERE name_lc = '' OR desc_lc = '' OR name_tokens = '' OR desc_tokens = ''"
      )
      .all() as { name: string; description: string }[];
    const backfill = d.prepare(
      "UPDATE skills SET name_lc = ?, desc_lc = ?, name_tokens = ?, desc_tokens = ? WHERE name = ?"
    );
    for (const s of stale) {
      const t = tokenizeSkill(s.name, s.description);
      backfill.run(t.name_lc, t.desc_lc, t.name_tokens, t.desc_tokens, s.name);
    }
  }

  // Clean up the (removed) semantic-vector experiment: no embedding server and
  // no model marker. The library search is pure lexical over the token mirrors.
  d.exec("DELETE FROM model_servers WHERE name = 'bonsai-embed'");
  d.exec("DELETE FROM settings WHERE key = 'skill_embed_model'");
}

export function createSession(row: {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  kind?: "task" | "agent" | "routine" | "thread";
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
  // Threads belong to a session; take their messages and confirmations with it.
  const threadIds = (d.prepare("SELECT id FROM threads WHERE session_id = ?").all(id) as { id: string }[]).map(
    (r) => r.id
  );
  for (const t of threadIds) deleteThreadAndMessages(t);
  d.prepare("DELETE FROM events WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

// --- message threads ---

export interface ThreadRow {
  id: string;
  session_id: string;
  parent_seq: number;
  parent_role: string;
  parent_text: string;
  created_at: string;
  updated_at: string;
}

export interface ThreadMessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ConfirmationRow {
  id: string;
  thread_id: string;
  source_session_id: string;
  source_seq: number | null;
  text: string;
  confirmed_at: string;
}

export function listThreads(sessionId: string): ThreadRow[] {
  return getDb()
    .prepare("SELECT * FROM threads WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as ThreadRow[];
}

export function getThread(id: string): ThreadRow | undefined {
  return getDb().prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
}

export function createThread(row: {
  id: string;
  session_id: string;
  parent_seq: number;
  parent_role: string;
  parent_text: string;
}): void {
  getDb()
    .prepare(
      "INSERT INTO threads (id, session_id, parent_seq, parent_role, parent_text) VALUES (@id, @session_id, @parent_seq, @parent_role, @parent_text)"
    )
    .run(row);
}

export function listThreadMessages(threadId: string): ThreadMessageRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC"
    )
    .all(threadId) as ThreadMessageRow[];
}

export function appendThreadMessage(row: {
  id: string;
  thread_id: string;
  role: string;
  content: string;
}): void {
  getDb()
    .prepare(
      "INSERT INTO thread_messages (id, thread_id, role, content) VALUES (@id, @thread_id, @role, @content)"
    )
    .run(row);
  getDb().prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(row.thread_id);
}

export function addConfirmation(row: {
  id: string;
  thread_id: string;
  source_session_id: string;
  source_seq: number | null;
  text: string;
}): void {
  getDb()
    .prepare(
      "INSERT INTO confirmations (id, thread_id, source_session_id, source_seq, text) VALUES (@id, @thread_id, @source_session_id, @source_seq, @text)"
    )
    .run(row);
}

export function searchConfirmations(needle?: string | null, limit = 20): ConfirmationRow[] {
  // The model may send the literal string "null"; treat it like no filter.
  const q = needle ? String(needle).trim() : "";
  const has = Boolean(q && q !== "null" && q !== "undefined");
  if (has) {
    return getDb()
      .prepare("SELECT * FROM confirmations WHERE text LIKE ? ORDER BY confirmed_at DESC LIMIT ?")
      .all(`%${q}%`, limit) as ConfirmationRow[];
  }
  return getDb()
    .prepare("SELECT * FROM confirmations ORDER BY confirmed_at DESC LIMIT ?")
    .all(limit) as ConfirmationRow[];
}

export function deleteThreadAndMessages(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM thread_messages WHERE thread_id = ?").run(id);
  d.prepare("DELETE FROM confirmations WHERE thread_id = ?").run(id);
  d.prepare("DELETE FROM threads WHERE id = ?").run(id);
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

// --- skill library ---

export interface SkillRow {
  name: string;
  description: string;
  path: string;
  content: string;
  /** Lowercased mirror of name, kept in sync by upsertSkill for fast search. */
  name_lc?: string;
  /** Lowercased mirror of description, kept in sync by upsertSkill. */
  desc_lc?: string;
  /** Space-joined, deduped word tokens of the name only. */
  name_tokens?: string;
  /** Space-joined, deduped word tokens of the description only. */
  desc_tokens?: string;
  updated_at: string;
}

/**
 * Pre-tokenize a skill's name + description into searchable mirror columns.
 *
 * The mirrors are: name_lc/desc_lc (lowercased originals, for substring and
 * prefix matching) and name_tokens/desc_tokens (space-joined, deduped word
 * tokens of the name and of the description, kept separate). Written on every
 * upsert so the mirrors always match the originals, and search never has to
 * re-lowercase or re-tokenize the whole library per query.
 */
function tokenizeSkill(
  name: string,
  description: string
): { name_lc: string; desc_lc: string; name_tokens: string; desc_tokens: string } {
  const name_lc = name.toLowerCase();
  const desc_lc = description.toLowerCase();
  const words = (text: string): string => {
    const seen = new Set<string>();
    for (const w of text.split(/[^a-z0-9]+/)) {
      if (w.length >= 2) seen.add(w);
    }
    return [...seen].sort().join(" ");
  };
  return { name_lc, desc_lc, name_tokens: words(name_lc), desc_tokens: words(desc_lc) };
}

/** Index one skill. Content is kept for a later targeted read, not the prompt. */
export function upsertSkill(row: {
  name: string;
  description: string;
  path: string;
  content: string;
}): void {
  const mirror = tokenizeSkill(row.name, row.description);
  getDb()
    .prepare(
      `INSERT INTO skills (name, description, path, content, name_lc, desc_lc, name_tokens, desc_tokens, updated_at)
       VALUES (@name, @description, @path, @content, @name_lc, @desc_lc, @name_tokens, @desc_tokens, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         path = excluded.path,
         content = excluded.content,
         name_lc = excluded.name_lc,
         desc_lc = excluded.desc_lc,
         name_tokens = excluded.name_tokens,
         desc_tokens = excluded.desc_tokens,
         updated_at = datetime('now')`
    )
    .run({ ...row, ...mirror });
}

export function listSkills(): SkillRow[] {
  return getDb().prepare("SELECT * FROM skills ORDER BY name ASC").all() as SkillRow[];
}

/** Tokenise, score and rank skills against a needle. */
function scoreSkills(needle: string): { name: string; score: number }[] {
  // A name hit is worth more than a description hit, and a skill matching
  // several words ranks above one matching a single word. This survives
  // phrasing differences ("write a skill" vs "writing a new skill").
  const tokens = (needle.toLowerCase().match(/[a-z0-9-]{2,}/g) ?? []).slice(0, 8);
  // Score over the pre-tokenized mirrors (kept in sync by upsertSkill) and
  // never touch the content column — bodies can be large, and only the top
  // matches need them (fetched via searchSkillNames/skillsByName).
  const all = getDb()
    .prepare("SELECT name, name_lc, desc_lc FROM skills")
    .all() as { name: string; name_lc: string; desc_lc: string }[];
  if (!tokens.length) return all.map((r) => ({ name: r.name, score: 0 }));
  return all
    .map((r) => {
      let score = 0;
      for (const t of tokens) {
        if (r.name_lc.includes(t)) score += 3;
        else if (r.desc_lc.includes(t)) score += 1;
      }
      return { name: r.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Ranked skill names for a needle (no content fetched). */
export function searchSkillNames(needle: string, limit = 40): string[] {
  return scoreSkills(needle)
    .slice(0, limit)
    .map((x) => x.name);
}

/**
 * The original lexical search, but each match comes back as its raw
 * pre-tokenized slots (name_tokens + desc_tokens) instead of text. The
 * mirrors were computed once at index time, so nothing is re-tokenized here.
 */
export function searchSkillTokens(
  needle: string,
  limit = 40
): { name: string; name_tokens: string; desc_tokens: string }[] {
  const names = searchSkillNames(needle, limit);
  if (!names.length) return [];
  const ph = names.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT name, name_tokens, desc_tokens FROM skills WHERE name IN (${ph})`)
    .all(...names) as { name: string; name_tokens: string; desc_tokens: string }[];
  const byName = new Map(rows.map((r) => [r.name, r]));
  return names
    .map((n) => {
      const r = byName.get(n);
      return r ? { name: r.name, name_tokens: r.name_tokens, desc_tokens: r.desc_tokens } : undefined;
    })
    .filter((x): x is { name: string; name_tokens: string; desc_tokens: string } => Boolean(x));
}

/** Full rows for the given names, in the given order (missing names skipped). */
export function skillsByName(names: string[]): SkillRow[] {
  if (!names.length) return [];
  const ph = names.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM skills WHERE name IN (${ph})`)
    .all(...names) as SkillRow[];
  const byName = new Map(rows.map((r) => [r.name, r]));
  return names.map((n) => byName.get(n)!).filter(Boolean);
}

/** One skill by exact name (full row, incl. content). */
export function getSkill(name: string): SkillRow | undefined {
  return getDb().prepare("SELECT * FROM skills WHERE name = ?").get(name) as SkillRow | undefined;
}

/** Lightweight search — names + descriptions, never the body. */
export function searchSkills(needle: string, limit = 5): SkillRow[] {
  return skillsByName(searchSkillNames(needle, limit));
}

/** How many skills match a needle, so a caller knows whether to refine. */
export function searchSkillsCount(needle: string): number {
  return scoreSkills(needle).length;
}

export function skillCount(): number {
  return (getDb().prepare("SELECT COUNT(*) c FROM skills").get() as { c: number }).c;
}

/** Note that a session used a skill, so its chat can list it. */
export function recordSkillUsage(sessionId: string, skillName: string): void {
  getDb()
    .prepare("INSERT INTO skill_usage (session_id, skill_name) VALUES (?, ?)")
    .run(sessionId, skillName);
}

/** Skills a session used, joined with their library content for a human to read. */
export function usedSkills(sessionId: string): (SkillRow & { used_at: string })[] {
  return getDb()
    .prepare(
      `SELECT s.name, s.description, s.path, s.content, s.updated_at, u.used_at
       FROM skill_usage u JOIN skills s ON s.name = u.skill_name
       WHERE u.session_id = ?
       GROUP BY s.name
       ORDER BY MAX(u.used_at) DESC`
    )
    .all(sessionId) as (SkillRow & { used_at: string })[];
}

// --- model servers (llama.cpp launched/stopped from the UI) ---

export interface ModelServerRow {
  name: string;
  bin: string;
  model: string;
  alias: string;
  port: number;
  ngl: number;
  ctx: number;
  threads: number;
  parallel: number;
  no_kv_offload: number;
  extra_args: string;
  enabled: number;
}

export function listModelServers(): ModelServerRow[] {
  return getDb().prepare("SELECT * FROM model_servers ORDER BY port ASC").all() as ModelServerRow[];
}

export function getModelServer(name: string): ModelServerRow | undefined {
  return getDb().prepare("SELECT * FROM model_servers WHERE name = ?").get(name) as
    | ModelServerRow
    | undefined;
}

/** Insert or replace a model server config. */
export function upsertModelServer(
  s: Omit<ModelServerRow, "created_at"> & { created_at?: string }
): void {
  getDb()
    .prepare(
      `INSERT INTO model_servers
        (name, bin, model, alias, port, ngl, ctx, threads, parallel, no_kv_offload, extra_args, enabled, updated_at)
       VALUES (@name, @bin, @model, @alias, @port, @ngl, @ctx, @threads, @parallel, @no_kv_offload, @extra_args, @enabled, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         bin = excluded.bin,
         model = excluded.model,
         alias = excluded.alias,
         port = excluded.port,
         ngl = excluded.ngl,
         ctx = excluded.ctx,
         threads = excluded.threads,
         parallel = excluded.parallel,
         no_kv_offload = excluded.no_kv_offload,
         extra_args = excluded.extra_args,
         enabled = excluded.enabled,
         updated_at = datetime('now')`
    )
    .run(s);
}

export function deleteModelServer(name: string): void {
  getDb().prepare("DELETE FROM model_servers WHERE name = ?").run(name);
}

/** Where reports go when a routine does not name a destination of its own. */
export interface ReportTo {
  channel: string;
  target: string;
}

export function getDefaultReportTo(): ReportTo | null {
  const stored = getStoredSettings() as Record<string, string>;
  const channel = stored.report_channel;
  const target = stored.report_target;
  return channel && target ? { channel, target } : null;
}

export function setDefaultReportTo(to: ReportTo | null): void {
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const clear = getDb().prepare("DELETE FROM settings WHERE key = ?");
  if (!to) {
    clear.run("report_channel");
    clear.run("report_target");
    return;
  }
  upsert.run("report_channel", to.channel);
  upsert.run("report_target", to.target);
}

/** Something the portal said into a conversation, waiting to join its context. */
export function addNote(sessionId: string, text: string, pendingDelivery = false): void {
  getDb()
    .prepare("INSERT INTO notes (session_id, text, pending_delivery) VALUES (?, ?, ?)")
    .run(sessionId, text, pendingDelivery ? 1 : 0);
}

/**
 * Messages the person has not seen, because their channel cannot be spoken to.
 *
 * Reading them hands over responsibility for delivering them, so they are only
 * taken at the point they are about to go out with a reply.
 */
export function takeDeliveries(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id, text FROM notes WHERE session_id = ? AND pending_delivery = 1 ORDER BY id ASC")
    .all(sessionId) as { id: number; text: string }[];
  const mark = getDb().prepare("UPDATE notes SET pending_delivery = 0 WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  return rows.map((r) => r.text);
}

/** Take the pending notes for a conversation. Reading them consumes them. */
export function takeNotes(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id, text FROM notes WHERE session_id = ? AND consumed_at IS NULL ORDER BY id ASC")
    .all(sessionId) as { id: number; text: string }[];
  if (!rows.length) return [];
  const mark = getDb().prepare("UPDATE notes SET consumed_at = datetime('now') WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  return rows.map((r) => r.text);
}

export interface ToolRule {
  id: string;
  role: string;
  tool: string;
  pattern: string;
  note: string;
  created_at: string;
}

export const listToolRules = (): ToolRule[] =>
  getDb().prepare("SELECT * FROM tool_rules ORDER BY tool, pattern").all() as ToolRule[];

export function addToolRule(rule: Omit<ToolRule, "created_at">): void {
  getDb()
    .prepare("INSERT INTO tool_rules (id, role, tool, pattern, note) VALUES (?, ?, ?, ?, ?)")
    .run(rule.id, rule.role, rule.tool, rule.pattern, rule.note);
}

export const deleteToolRule = (id: string): void => {
  getDb().prepare("DELETE FROM tool_rules WHERE id = ?").run(id);
};
