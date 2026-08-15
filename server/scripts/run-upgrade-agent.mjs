#!/usr/bin/env node
/**
 * run-upgrade-agent.mjs — launch an agent to upgrade the pi workspace, with a
 * timed validation protocol.
 *
 * Protocol (matches the request):
 *   1. Create a task session against the workspace.
 *   2. Prompt it with a scoped, non-destructive upgrade task.
 *   3. Wait 30s, then VALIDATE it is producing usable actions (tool calls /
 *      assistant output recorded since the prompt).
 *   4. Wait another 30s.
 *   5. Run the 600s "keep going / finish" command (after validation passed).
 *
 * Drives the portal over its own HTTP API (localhost:4100) and validates via
 * the portal DB (events recorded for the session). No code is pushed; the
 * agent only edits the workspace it was given.
 *
 * Usage:
 *   node server/scripts/run-upgrade-agent.mjs [workspace] [--no-run]
 * Env: PORTAL_URL (default http://localhost:4100), PORTAL_PASS (default
 * deathlover), WS (default the pithagorus-upgrades/pithagoras workspace).
 */
import Database from "better-sqlite3";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORTAL = process.env.PORTAL_URL || "http://localhost:4100";
const PASS = process.env.PORTAL_PASS || "deathlover";
const DB_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "portal.db") : path.join(ROOT, "data", "portal.db");
const WS = process.env.WS || path.join(ROOT, "data/workspaces/pithagorus-upgrades/pithagoras");
const NO_RUN = process.argv.includes("--no-run");
// The /prompt endpoint can block while the model negotiates/starts, so undici's
// default 300s headers timeout throws UND_ERR_HEADERS_TIMEOUT even though the
// prompt was accepted. Give every fetch a 10-min overall budget so the harness
// holds the response and keeps supervising the run.
const REQ_TIMEOUT_MS = 600_000;
// The remote 27B is a REASONING model: it thinks for a while before emitting
// its first message or tool call, so a short validation gate aborts genuinely
// working runs (score 0 at 45s while it reasoned). Be patient: wait up to
// WAIT_FIRST for ANY usable action; only abort if truly nothing appears.
const WAIT_FIRST_MS = 240_000;    // up to 4 min for the first message/tool call
const MIN_FIRST_SCORE = 1;        // any single message_update or tool call proves it's alive
const WAIT_BETWEEN_MS = 45_000;   // then wait 45s more to confirm it's still moving
const MIN_SECOND_SCORE = 3;       // by then it should have done a bit more
const RUN_LONG_MS = 60_000;       // the long follow-up (600s = 600_000; use 60s for a smoke test)

if (!existsSync(WS)) {
  console.error(`workspace not found: ${WS}`);
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`portal db not found: ${DB_PATH}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await fetch(`${PORTAL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "", password: PASS }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0]; // cookie string
}

async function createSession(cookie) {
  const res = await fetch(`${PORTAL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ workspace: WS, title: "autonomous-pi-upgrade" }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const j = await res.json();
  if (!j.id) throw new Error(`createSession failed: ${JSON.stringify(j)}`);
  return j.id;
}

async function prompt(cookie, sessionId, message, behavior = "followUp") {
  // Fire-and-forget on purpose: the /prompt route returns only once pi's own
  // prompt() for the model resolves, which for a big context against a remote
  // model can take >10min. This harness supervises via the DB (events/status),
  // so it should NOT hold the HTTP request open — it accepts the prompt and
  // polls. Resolves as soon as the request is dispatched; errors are logged,
  // not fatal (the session keeps running server-side regardless).
  const promise = fetch(`${PORTAL}/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message, behavior }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  }).catch((e) => {
    console.warn(`[prompt dispatched, response not awaited] ${e?.cause?.code || e?.message}`);
  });
  // Await just long enough to confirm the request reached the server? No — the
  // validation below polls the DB and will notice the session regardless. Keep
  // the promise referenced so any rejection is observed, then move on.
  void promise;
  return { ok: true };
}

/**
 * Fresh readonly connection per query.
 *
 * The single long-lived `db` instance opens a WAL snapshot at connect time and
 * never advances it, so it silently missed every event the portal wrote after
 * startup — scoring 0 even while the agent was actively reading. A new
 * connection per poll sees the current WAL, so validation reflects reality.
 */
function freshDb() {
  const d = new Database(DB_PATH, { readonly: true });
  d.pragma("journal_mode = WAL");
  return d;
}

/** Events recorded for a session since a seq. */
function eventsSince(sessionId, since) {
  const d = freshDb();
  try {
    return d
      .prepare("SELECT seq, type FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC")
      .all(sessionId, since);
  } finally {
    d.close();
  }
}

/** How much "usable action" happened: tool calls + assistant text updates. */
function usableAction(events) {
  const tools = events.filter((e) => e.type === "tool_execution_start").length;
  const prose = events.filter((e) => e.type === "message_update").length;
  return { tools, prose, score: tools * 2 + prose };
}

/** Wait until the session is not running (capped). Returns final status. */
async function waitUntilIdle(sessionId, capMs, pollMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    const row = freshDb()
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(sessionId);
    if (row && row.status !== "running") return row.status;
    await sleep(pollMs);
  }
  return "still-running";
}

/** Try to run a verification command; returns {ok, output} or throws. */
function tryVerify(cmd, opts) {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      cwd: WS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
      ...opts,
    });
    return { ok: true, output: (out || "").slice(-4000) };
  } catch (e) {
    return {
      ok: false,
      output: String(e?.stdout || e?.message || "").slice(-4000),
    };
  }
}

/**
 * The net-negative gate. After the agent finishes, actually verify the changes
 * instead of taking its word: inspect the diff for obvious destructive edits,
 * then run typecheck/build. Only if it passes is the work an improvement.
 */
function verifyChanges() {
  const verdicts = [];
  // 1) Manifest sanity: a project root package.json must stay a real manifest.
  const pkg = path.join(WS, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8"));
      const sane = j && typeof j.name === "string" && (Array.isArray(j.workspaces) || j.scripts);
      verdicts.push({ name: "root manifest intact", ok: !!sane, detail: j?.name || "broken JSON" });
    } catch {
      verdicts.push({ name: "root manifest intact", ok: false, detail: "package.json unparseable" });
    }
  }
  // 2) The repo builds / typechecks (whatever tool the project exposes).
  const checks = [
    ["npm", "run", "build"],
    ["npx", "tsc", "-p", "server/tsconfig.json", "--noEmit"],
  ];
  for (const cmd of checks) {
    const r = tryVerify(cmd);
    verdicts.push({ name: cmd.join(" "), ...r });
    if (r.ok) break; // first passing check is enough
  }
  return verdicts;
}

/**
 * Build a compact, pre-loaded picture of the project so the agent does NOT have
 * to burn turns on `find`/`ls`/`cat` discovery round-trips (the #1 cause of the
 * "keeps gathering information" stalls). Reading the tree + a few key files
 * here on the host is instant and free; injecting it as context means the agent
 * already knows the layout and jumps straight to work.
 *
 * Bundles:
 *  - the file tree (excluding node_modules / .git / dist / build output),
 *  - the full text of the small key files (package.json, tsconfig, README,
 *    SOUL/MEMORY/agent home files) that materially shape what to change.
 */
function buildProjectContext() {
  const EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".venv", "data", "gitrepos", "vendor"]);
  const KEY_FILES = [
    "package.json",
    "server/package.json",
    "web/package.json",
    "docs/package.json",
    "tsconfig.json",
    "server/tsconfig.json",
    "web/tsconfig.json",
    "README.md",
    "SOUL.md",
    "MEMORY.md",
  ];
  const MAX_KEY_BYTES = 200_000; // cap the injected key-file text total

  const lines = ["# PROJECT SNAPSHOT (pre-loaded — do not re-discover it)", ""];

  // Tell the agent exactly where it is so it never hunts for its own files
  // (a past failure: it ran `find / -name package.json` because the inject
  // didn't pin down its working directory). Inside its bash sandbox the
  // workspace is mounted at /workspace; every path below is relative to that.
  lines.push(
    "Your working directory is `WORKSPACE_ROOT` and every file path in this " +
      "snapshot is RELATIVE to it. In your bash shell, that root is mounted at " +
      "`/workspace` — so `server/src/index.ts` below means `/workspace/server/src/index.ts`. " +
      "You do not need to locate the project; it is already your cwd. Do not run " +
      "`find`/`ls`/`pwd` to discover files listed here.",
    ""
  );

  // 1) COMPLETE file-location inventory.
  //
  // Every file in the project, as its relative path -- so the agent knows the
  // full layout before doing anything and never needs to `find`/`ls` to locate
  // a file. Excluded only the heavy/build/private dirs that aren't project
  // source (node_modules, .git, dist, data, vendored trees). No truncation:
  // a long inventory is cheap tokens and is exactly what kills the discovery
  // loop.
  const files = [];
  (function walk(dir) {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      if (EXCLUDE.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        files.push(path.relative(WS, full));
      }
    }
  })(WS);
  lines.push("## All files", "");
  lines.push(`_${files.length} files total._`);

  // Pre-tokenized sizes, if pre-tokenize-project.mjs has run for this project.
  // Reuses the direct-token API output already on disk (data/project-tokens.json)
  // so the agent knows each file's real token cost without re-tokenizing.
  const tokenMap = new Map();
  try {
    const tokPath = path.join(ROOT, "data", "project-tokens.json");
    if (existsSync(tokPath)) {
      const j = JSON.parse(readFileSync(tokPath, "utf8"));
      for (const f of j.files || []) tokenMap.set(f.path, f.tokens);
    }
  } catch {
    /* optimistic — annotation is optional */
  }
  if (tokenMap.size) {
    lines.push(
      "_Pre-tokenized (via the model's direct-token API; each line: `path [tokens]`)._"
    );
    lines.push(
      "```text",
      files.map((f) => `${f} [${tokenMap.get(f) ?? "?"}]`).join("\n") || "(empty project)",
      "```",
      ""
    );
  } else {
    lines.push("```text", files.length ? files.join("\n") : "(empty project)", "```", "");
  }

  // 2) Key file contents (only what exists, capped in total size).
  lines.push("## Key files (contents pre-loaded)", "");
  let budget = MAX_KEY_BYTES;
  for (const rel of KEY_FILES) {
    const full = path.join(WS, rel);
    if (!existsSync(full)) continue;
    let txt;
    try {
      txt = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (txt.length > 60_000) txt = txt.slice(0, 60_000) + "\n[… truncated …]\n";
    budget -= txt.length;
    if (budget < 0) {
      lines.push(`- (skipped further key files to stay compact)`);
      break;
    }
    lines.push(`### ${rel}\n\n\`\`\`\n${txt}\n\`\`\``, "");
  }
  return lines.join("\n");
}

async function run() {
  const cookie = await login();
  const sessionId = await createSession(cookie);
  console.log(`session ${sessionId} on ${WS}`);

  const projectContext = buildProjectContext();
  const upgradeTask =
    projectContext +
    "\n\n" +
    "You are upgrading this Pithagoras project. 'Upgrading' means IMPROVING " +
    "THE CODE, not upgrading the system. Do exactly ONE concrete, small, " +
    "low-risk code improvement and PROVE it with a real file edit:\n\n" +
    "STEP 1 — Pick ONE specific, obvious improvement in this codebase. Good " +
    "candidates: a real bug, an obvious typo, a small correctness or " +
    "simplicity win in server/src or web/src. Be specific about the file and " +
    "the change.\n" +
    "STEP 2 — MAKE the edit with a write/edit tool (or bash). The deliverable " +
    "is a changed source file. Do not stop after reading — WRITE the file.\n" +
    "STEP 3 — Run the build/typecheck (npm run build -w server) and confirm it " +
    "still passes. If it fails, fix your edit.\n" +
    "When done, report exactly which file you changed, the diff, and that the " +
    "build passes.\n\n" +
    "Do NOT run package-manager or OS updaters (pacman/apt/npm install/npm ci). " +
    "Do NOT delete files, commit, push, or restructure. One verified edit " +
    "beats an unverified sweep.";

  if (NO_RUN) {
    console.log("(--no-run) would prompt:\n" + upgradeTask);
    return;
  }

  const startSeq = 0;
  await prompt(cookie, sessionId, upgradeTask);
  console.log(`upgrade task sent. waiting up to ${WAIT_FIRST_MS / 1000}s for first usable action (model may reason first)...`);

  // Patient first gate: wait up to WAIT_FIRST_MS for any real action. A
  // reasoning model can sit silent for a while thinking; don't abort it.
  const firstDeadline = Date.now() + WAIT_FIRST_MS;
  let ev1 = eventsSince(sessionId, startSeq);
  let a1 = usableAction(ev1);
  while (a1.score < MIN_FIRST_SCORE && Date.now() < firstDeadline) {
    await sleep(10_000);
    ev1 = eventsSince(sessionId, startSeq);
    a1 = usableAction(ev1);
  }
  console.log(`first usable action: ${a1.tools} tool calls, ${a1.prose} prose updates (score ${a1.score})`);
  if (a1.score < MIN_FIRST_SCORE) {
    console.error(`still nothing after ${WAIT_FIRST_MS / 1000}s (score ${a1.score} < ${MIN_FIRST_SCORE}) — aborting.`);
    process.exitCode = 1;
    return;
  }

  console.log("producing usable actions. waiting 45s to confirm it keeps moving...");
  await sleep(WAIT_BETWEEN_MS);

  const ev2 = eventsSince(sessionId, startSeq);
  const a2 = usableAction(ev2);
  console.log(`after ${(Date.now() - (Date.now() - WAIT_FIRST_MS - WAIT_BETWEEN_MS)) / 1000}s (approx): ${a2.tools} tool calls, ${a2.prose} prose updates (score ${a2.score})`);
  if (a2.score < MIN_SECOND_SCORE) {
    console.error(`still not enough useful work (score ${a2.score} < ${MIN_SECOND_SCORE}) — aborting long run.`);
    process.exitCode = 1;
    return;
  }

  console.log(`doing something useful. running 600s follow-up command...`);
  await prompt(
    cookie,
    sessionId,
    "Continue working on the upgrade. Finish the improvements you started, run " +
      "the relevant checks, and give a final concise summary of what changed and " +
      "the verification evidence. Do not push; work only in this workspace.",
    "followUp"
  );
  console.log("600s command dispatched. waiting for the run to finish...");

  // Net-negative gate: the small agent's own judgment is not enough (limited
  // context). Once idle, actually verify its changes — manifest intact +
  // typecheck/build pass AND a real diff exists. Talking without editing is
  // not an improvement.
  const finalStatus = await waitUntilIdle(sessionId, 15 * 60_000);
  console.log(`session ${sessionId} final status: ${finalStatus}`);

  // Number of source files actually changed (must be > 0 to count).
  let changedFiles = 0;
  try {
    const out = execFileSync("git", ["diff", "--name-only"], {
      cwd: WS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    changedFiles = (out || "").split("\n").filter(Boolean).length;
  } catch {
    changedFiles = 0;
  }

  const verdicts = verifyChanges();
  for (const v of verdicts) {
    console.log(`  [${v.ok ? "PASS" : "FAIL"}] ${v.name}${v.detail ? " — " + v.detail : ""}`);
  }
  console.log(`  [${changedFiles > 0 ? "PASS" : "FAIL"}] changed source files (${changedFiles})`);
  const netPositive = finalStatus === "idle" && changedFiles > 0 && verdicts.every((v) => v.ok);
  console.log(netPositive ? "RESULT: NET-POSITIVE (verified code edit)." : "RESULT: NET-NEGATIVE or unverified — no verified code edit made.");
  process.exitCode = netPositive ? 0 : 1;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
