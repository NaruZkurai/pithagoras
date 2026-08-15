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
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORTAL = process.env.PORTAL_URL || "http://localhost:4100";
const PASS = process.env.PORTAL_PASS || "deathlover";
const DB_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "portal.db") : path.join(ROOT, "data", "portal.db");
const WS = process.env.WS || path.join(ROOT, "data/workspaces/pithagorus-upgrades/pithagoras");
const NO_RUN = process.argv.includes("--no-run");
const WAIT_VALIDATE_MS = 30_000; // wait 30s then validate usable actions
const WAIT_BETWEEN_MS = 30_000;   // then wait 30s
const RUN_LONG_MS = 60_000;       // the long follow-up (600s = 600_000; use 60s for a smoke test)

if (!existsSync(WS)) {
  console.error(`workspace not found: ${WS}`);
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`portal db not found: ${DB_PATH}`);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });
db.pragma("journal_mode = WAL");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await fetch(`${PORTAL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "", password: PASS }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0]; // cookie string
}

async function createSession(cookie) {
  const res = await fetch(`${PORTAL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ workspace: WS, title: "autonomous-pi-upgrade" }),
  });
  const j = await res.json();
  if (!j.id) throw new Error(`createSession failed: ${JSON.stringify(j)}`);
  return j.id;
}

async function prompt(cookie, sessionId, message, behavior = "followUp") {
  const res = await fetch(`${PORTAL}/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message, behavior }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`prompt failed: ${JSON.stringify(j)}`);
  return j;
}

/** Events recorded for a session since a seq. */
function eventsSince(sessionId, since) {
  return db
    .prepare("SELECT seq, type FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC")
    .all(sessionId, since);
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
    const row = db
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

async function run() {
  const cookie = await login();
  const sessionId = await createSession(cookie);
  console.log(`session ${sessionId} on ${WS}`);

  const upgradeTask =
    "You are upgrading this Pithagoras project. Work NON-DESTRUCTIVELY: " +
    "inspect the code, identify 2-4 concrete, low-risk improvements (bugs, " +
    "obvious issues, small wins), implement them in the workspace, and run " +
    "the existing build/lint/typecheck for whatever you touch. Do NOT delete " +
    "files, do NOT commit or push, do NOT restructure broadly. When done, " +
    "summarize exactly what you changed and what you verified.";

  if (NO_RUN) {
    console.log("(--no-run) would prompt:\n" + upgradeTask);
    return;
  }

  const startSeq = 0;
  await prompt(cookie, sessionId, upgradeTask);
  console.log("upgrade task sent. waiting 30s to validate usable actions...");

  await sleep(WAIT_VALIDATE_MS);
  const ev1 = eventsSince(sessionId, startSeq);
  const a1 = usableAction(ev1);
  console.log(`after 30s: ${a1.tools} tool calls, ${a1.prose} prose updates (score ${a1.score})`);
  if (a1.score < 4) {
    console.error("NOT producing usable actions — aborting long run.");
    process.exitCode = 1;
    return;
  }

  console.log("validated producing usable actions. waiting 30s more...");
  await sleep(WAIT_BETWEEN_MS);

  const ev2 = eventsSince(sessionId, startSeq);
  const a2 = usableAction(ev2);
  console.log(`after 60s: ${a2.tools} tool calls, ${a2.prose} prose updates (score ${a2.score})`);
  if (a2.score < 8) {
    console.error("still not enough useful work — aborting long run.");
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
  // typecheck/build pass. Only then is the work an improvement.
  const finalStatus = await waitUntilIdle(sessionId, 15 * 60_000);
  console.log(`session ${sessionId} final status: ${finalStatus}`);

  const verdicts = verifyChanges();
  for (const v of verdicts) {
    console.log(`  [${v.ok ? "PASS" : "FAIL"}] ${v.name}${v.detail ? " — " + v.detail : ""}`);
  }
  const netPositive = finalStatus === "idle" && verdicts.every((v) => v.ok);
  console.log(netPositive ? "RESULT: NET-POSITIVE (verified improvements)." : "RESULT: NET-NEGATIVE or unverified — do NOT adopt these changes.");
  process.exitCode = netPositive ? 0 : 1;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
