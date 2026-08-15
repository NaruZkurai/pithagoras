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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  while (Date.now() - start < capMs && !stopping && !sentinelExists()) {
    const row = freshDb()
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(sessionId);
    if (row && row.status !== "running") return row.status;
    await sleep(pollMs);
  }
  // Stop signaled mid-wait — abort the running agent so the turn stops.
  if (stopping || sentinelExists()) return "stopped";
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

/** True if `rel` is modified vs the workspace git HEAD (committed state). */
function isDirtyFile(absPath) {
  try {
    const rel = path.relative(WS, absPath);
    const out = execFileSync("git", ["status", "--porcelain", "--", rel], {
      cwd: WS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (out || "").trim().length > 0;
  } catch {
    // If git is unavailable, be conservative: treat as dirty so the gate fails
    // closed rather than trusting an unverifiable lockfile.
    return true;
  }
}

/**
 * The net-negative gate. After the agent finishes, actually verify the changes
 * instead of taking its word: inspect the diff for obvious destructive edits,
 * then run typecheck/build. Only if it passes is the work an improvement.
 */
function verifyChanges() {
  const verdicts = [];
  // 0) Lockfiles must be untouched — a dirty lockfile auto-fails an iteration
  //    (agents repeatedly mangle package-lock.json, breaking the build).
  for (const lf of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
    const lfPath = path.join(WS, lf);
    if (existsSync(lfPath)) {
      const dirty = isDirtyFile(lfPath);
      verdicts.push({ name: `lockfile clean (${lf})`, ok: !dirty, detail: dirty ? "modified" : "untouched" });
    }
  }
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
    // The augmentation path — give the agent the RAW source it must build on
    // so it never has to guess a path (it previously invented
    // `server/src/pi/model-server.ts` and hit ENOENT).
    "server/src/model-server.ts",
    "server/src/pi/project-token-tools.ts",
    "server/src/pi/sdk-client.ts",
    "server/src/pi/payload-inspect.ts",
    "server/scripts/pre-tokenize-project.mjs",
    "server/scripts/run-upgrade-agent.mjs",
    "scripts/train-6gb.sh",
  ];
  const MAX_KEY_BYTES = 300_000; // cap the injected key-file text total

  const lines = ["# PROJECT SNAPSHOT (pre-loaded — do not re-discover it)", ""];

  // Tell the agent exactly where it is so it never hunts for its own files
  // (a past failure: it ran `find / -name package.json` because the inject
  // didn't pin down its working directory). Every path in this snapshot is
  // RELATIVE — resolve it from your CURRENT working directory (your cwd IS the
  // project root). Do NOT prepend a fake mount like `/workspace`: this portal
  // runs the host executor, so `/workspace` does not exist here.
  lines.push(
    "Your working directory (cwd) IS the project root, and every file path in " +
      "this snapshot is RELATIVE to it. To read `server/src/index.ts`, open the " +
      "path `server/src/index.ts` from your cwd — do NOT prefix it with " +
      "`/workspace` or any other mount (that does not exist in this runtime). " +
      "You do not need to locate the project; it is already your cwd. Do not " +
      "run `find`/`ls`/`pwd` to discover files listed here.",
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

const RUNNER_IMAGE = "pithagoras-runner-arch:latest";
const REPO_ROOT = path.resolve(ROOT); // the repo baked into /repo of the image
const RUNNER_DOCKERFILE = path.join(ROOT, "docker", "runner-arch.dockerfile");
const REPO_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".venv", "data", "gitrepos", "vendor"]);

/** Newest mtime under a dir (walking), excluding heavy/vendored dirs. */
function newestMtime(dir) {
  let newest = 0;
  (function walk(d) {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!REPO_EXCLUDE.has(e.name)) walk(p);
      } else if (e.isFile()) {
        try {
          const t = statSync(p).mtimeMs;
          if (t > newest) newest = t;
        } catch {
          /* skip */
        }
      }
    }
  })(dir);
  return newest;
}

/**
 * Ensure the runner image's baked /repo is un-to-date with the current source.
 *
 * `docker build` bakes a SNAPSHOT of the repo (COPY . /repo) at build time, so
 * a stale image makes the agent work on old code. Rebuild the image (via the
 * normal script, which also re-snapshots the non-root node_modules overlay)
 * whenever the Dockerfile or any tracked source file under the repo is NEWER
 * than the cached image. Runs once per process, gated by freshness, so a
 * never-stopping harness doesn't rebuild every iteration.
 */
let _imageChecked = false;
async function ensureFreshRunnerImage() {
  if (_imageChecked || process.env.SKIP_IMAGE_REBUILD === "1") return;
  _imageChecked = true;

  const imageTime = (() => {
    try {
      const out = execFileSync("docker", ["image", "inspect", RUNNER_IMAGE, "--format", "{{.Created}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const t = Date.parse(String(out).trim());
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0; // image missing → rebuild
    }
  })();

  const dockerfileMtime = existsSync(RUNNER_DOCKERFILE) ? statSync(RUNNER_DOCKERFILE).mtimeMs : 0;
  const srcMtime = newestMtime(REPO_ROOT);
  const newest = Math.max(dockerfileMtime, srcMtime);
  if (newest <= imageTime) {
    console.log(`runner image ${RUNNER_IMAGE} is current (repo/src not newer than image) — no rebuild.`);
    return;
  }

  console.log(`repo/src changed since image ${RUNNER_IMAGE} (image=${new Date(imageTime).toISOString()}, newest source=${new Date(newest).toISOString()}) — rebuilding so the agent gets up-to-date /repo...`);
  execFileSync(path.join(ROOT, "scripts", "update-runner-node_modules.sh"), [], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 30 * 60_000,
  });
  console.log("runner image rebuilt with fresh /repo.");
}

/** Is the remote model box (any of its ports) reachable right now? */
async function probeRemote() {
  for (const port of [6464, 6465]) {
    try {
      const r = await fetch(`http://192.168.2.64:${port}/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/**
 * Decide which backend to run the upgrade on:
 *   - remote/bonsai-27b   when the box is up;
 *   - local/bonsai-27b    otherwise (ensuring the LOCAL server is launched).
 */
async function chooseModel(cookie) {
  if (await probeRemote()) return { provider: "remote", modelId: "bonsai-27b" };
  console.warn("remote model box unreachable — falling back to LOCAL bonast-27b on :41001");
  // Ensure the local 27B is up (portal launches it for us on first use).
  try {
    await fetch(`${PORTAL}/api/models/servers/bonsai-local/start`, {
      method: "POST",
      headers: { cookie },
      signal: AbortSignal.timeout(120_000),
    }).catch(() => {});
  } catch {
    /* the session's ensureMainModelServer() will also try */
  }
  return { provider: "local", modelId: "bonsai-27b" };
}

/** Point a session at a model via the portal config endpoint. */
async function applyModel(cookie, sessionId, provider, modelId) {
  const res = await fetch(`${PORTAL}/api/sessions/${sessionId}/config`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ provider, modelId }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`set model ${provider}/${modelId}: ${JSON.stringify(j)}`);
  return j;
}

/**
 * Tear down a finished iteration's session — no longer used since the loop
 * now CONTINUES a single session instead of creating one per iteration.
 */

/**
 * Ensure the loop's workspace carries the raw pre-tokenized token patterns the
 * task is built on. `data/project-tokens.json` + a readable PROJECT_TOKENS.md
 * live in the REPO root's data/, but the loop's workspace is a repo copy that
 * usually has no data/ dir at all — so the agent hit ENOENT on
 * /workspace/data/project-tokens.json ("not receiving the raw file as tokens").
 * Copy the manifest in and generate the markdown so the agent can open the
 * token patterns directly. Idempotent; best-effort.
 */
function provisionWorkspaceTokens() {
  const src = path.join(ROOT, "data", "project-tokens.json");
  const dstDir = path.join(WS, "data");
  try {
    const j = existsSync(src) ? JSON.parse(readFileSync(src, "utf8")) : null;
    mkdirSync(dstDir, { recursive: true });
    // Always refresh the manifest + markdown from the source of truth.
    if (j) {
      writeFileSync(path.join(dstDir, "project-tokens.json"), JSON.stringify(j, null, 2) + "\n");
      const lines = [
        "# PROJECT_TOKENS.md — this project's files, pre-tokenized",
        "",
        "```text",
      ];
      for (const f of (j.files || []).slice(0, 2000)) lines.push(`${f.path} [${f.tokens}]`);
      lines.push("```", "");
      writeFileSync(path.join(dstDir, "PROJECT_TOKENS.md"), lines.join("\n"));
    }
  } catch (e) {
    console.warn(`[provisionTokens] could not copy token patterns: ${e?.message ?? e}`);
  }
}

async function runOnce(cookie, sessionId) {
  console.log(`iteration on session ${sessionId} (${WS})`);

  // Make sure the workspace actually carries the token patterns the task
  // builds on. The loop's workspace is a repo copy that often lacks `data/`,
  // so `data/project-tokens.json` / PROJECT_TOKENS.md (the raw token patterns)
  // were absent and the agent ENOENT'd on them. Copy them in every iteration so
  // the agent always has the raw token data it's meant to augment.
  provisionWorkspaceTokens();

  // Failover: prefer the remote box's 27B when reachable, otherwise use the
  // LOCAL 27B on 41001 so the harness runs through a box outage instead of
  // piling up empty responses.
  const { provider, modelId } = await chooseModel(cookie);
  console.log(`routing session to model ${provider}/${modelId}`);
  // Best-effort: an explicit set can fail transiently on a just-booted session
  // (model registry not fully warm). The session already defaults to the right
  // model, so a failure here must NOT abort the run — log and continue.
  try {
    await applyModel(cookie, sessionId, provider, modelId);
  } catch (e) {
    console.warn(`(continuing — could not force model ${provider}/${modelId}: ${e?.message ?? e})`);
  }

  const projectContext = buildProjectContext();
  const upgradeTask =
    projectContext +
    "\n\n" +
    "SELF-AUGMENTATION TASK — the KEY is the 500 MB true-ternary Bonsai-4B " +
    "model. Build one concrete piece of the augmentation pipeline and PROVE it " +
    "by WRITING a real source file. Do NOT stop after reading files — the " +
    "deliverable is a written, working edit. If the model gives you empty " +
    "responses, do not resend; just get on with writing the change.\n\n" +
    "The stack that IS in place (verify, don't rediscover):\n" +
    "- The 500 MB model: /nzk/models/Bonsai-4B-Q1_0.gguf — TRUE TERNARY Q1_0, " +
    "served locally (llama.cpp) at http://127.0.0.1:6465 OpenAI-compatible.\n" +
    "- llama.cpp + the direct-token fork gitrepos/llama-direct-token-input " +
    "(llama-server, llama-tokens, llama-finetune, llama-bench) wrapped by " +
    "scripts/train-6gb.sh.\n" +
    "- The repo's token patterns (pre-tokenized): server/scripts/" +
    "pre-tokenize-project.mjs writes data/project-tokens.json (~161 files, " +
    "~1.72M tokens) and PROJECT_TOKENS.md in this workspace.\n" +
    "- The harness that drives this loop: server/scripts/run-upgrade-agent.mjs.\n\n" +
    "Deliver EXACTLY ONE of these, written as real code, then prove it builds:\n" +
    "A) scripts/augment-500mb.mjs — a self-augmentation runner that reads " +
    "data/project-tokens.json, selects repo token patterns as training " +
    "sequences, and streams them to the 500 MB model at 127.0.0.1:6465 " +
    "(llama.cpp) to produce an augmentation log / co-evolved token patterns. " +
    "Wire it so the augmentation is verifiable (e.g. writes an output file and " +
    "a metric). OR\n" +
    "B) Improve ANY single real bug/simplification in the augmentation path " +
    "(server/src/pi/*, server/src/model-server.ts, scripts/train-6gb.sh, or " +
    "run-upgrade-agent.mjs) that makes the 500 MB self-augmentation more " +
    "correct or faster.\n\n" +
    "STEPS — do them, don't stall:\n" +
    "1. WRITE the chosen file with a write/edit tool (or bash). A real change, " +
    "not a plan.\n" +
    "2. Run the build/typecheck YOURSELF: npm run build -w server (and the web " +
    "if you touched web). If it fails, FIX it until it passes — a red build is " +
    "an automatic FAIL. Green build is part of the deliverable, not optional.\n" +
    "3. If you built A), run it with --dry-run or a bounded MAX_BLOCKS=2 run to " +
    "show it loads the token patterns and targets 127.0.0.1:6465. Confirm the " +
    "generated output is real TypeScript (node --check the .mjs; the emitted " +
    ".ts must typecheck).\n" +
    "When done, report: the exact file you changed, the diff summary, and the " +
    "exact build command that passed.\n\n" +
    "HARD RULES (violating any of these is an automatic FAIL, not a warning):\n" +
    "- NEVER edit, touch, or regenerate package-lock.json / yarn.lock / any " +
    "lockfile. Lockfiles are off-limits; a dirty lockfile means the iteration " +
    "is rejected. Do NOT run npm install / npm ci / npm audit / package " +
    "managers at all.\n" +
    "- Your code MUST be valid, runnable source. In .mjs/.js files there are NO " +
    "TypeScript type annotations (no `: string`, `: number`, `Promise<...>`) and " +
    "no `fileURLToURL` — use `fileURLToPath` from node:url. A file that crashes " +
    "on `node --check` or the typecheck is an automatic FAIL.\n" +
    "- Do NOT modify /nzk/models or re-quantize the GGUF. Do NOT delete files, " +
    "commit, push, or restructure. One verified, written, GREEN-BUILD edit that " +
    "advances the 500 MB self-augmentation beats reads and plans.";


  if (NO_RUN) {
    console.log("(--no-run) would prompt:\n" + upgradeTask);
    return { netPositive: null, reason: "--no-run (dry)" };
  }

  const startSeq = 0;
  await prompt(cookie, sessionId, upgradeTask);
  console.log(`upgrade task sent. waiting up to ${WAIT_FIRST_MS / 1000}s for first usable action (model may reason first)...`);

  // Patient first gate: wait up to WAIT_FIRST_MS for any real action. A
  // reasoning model can sit silent for a while thinking; don't abort it.
  const firstDeadline = Date.now() + WAIT_FIRST_MS;
  let ev1 = eventsSince(sessionId, startSeq);
  let a1 = usableAction(ev1);
  while (a1.score < MIN_FIRST_SCORE && Date.now() < firstDeadline && !stopping && !sentinelExists()) {
    await sleep(2000); // short poll so a stop signal is received within ~2s
    if (stopping || sentinelExists()) break; // receive the stop promptly
    ev1 = eventsSince(sessionId, startSeq);
    a1 = usableAction(ev1);
  }
  if (stopping || sentinelExists()) {
    await abortSessionIfRunning(cookie, sessionId);
    console.log("stop signaled during first gate — aborting this iteration.");
    return { netPositive: false, reason: "stopped" };
  }
  console.log(`first usable action: ${a1.tools} tool calls, ${a1.prose} prose updates (score ${a1.score})`);
  if (a1.score < MIN_FIRST_SCORE) {
    console.error(`still nothing after ${WAIT_FIRST_MS / 1000}s (score ${a1.score} < ${MIN_FIRST_SCORE}) — aborting this iteration.`);
    return { netPositive: false, reason: `no first action (score ${a1.score})` };
  }

  console.log("producing usable actions. waiting 45s to confirm it keeps moving...");
  // Interruptible wait so a stop is honored right away, not after the gap.
  for (let waited = 0; waited < WAIT_BETWEEN_MS && !stopping && !sentinelExists(); waited += 1000) {
    await sleep(1000);
  }
  if (stopping || sentinelExists()) {
    await abortSessionIfRunning(cookie, sessionId);
    console.log("stop signaled during confirmation — aborting this iteration.");
    return { netPositive: false, reason: "stopped" };
  }

  const ev2 = eventsSince(sessionId, startSeq);
  const a2 = usableAction(ev2);
  console.log(`after ${(Date.now() - (Date.now() - WAIT_FIRST_MS - WAIT_BETWEEN_MS)) / 1000}s (approx): ${a2.tools} tool calls, ${a2.prose} prose updates (score ${a2.score})`);
  if (a2.score < MIN_SECOND_SCORE) {
    console.error(`still not enough useful work (score ${a2.score} < ${MIN_SECOND_SCORE}) — aborting long run.`);
    return { netPositive: false, reason: `not enough work (score ${a2.score})` };
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
  return { netPositive, reason: netPositive ? `changed ${changedFiles} file(s)` : "no verified edit" };
}

/**
 * Continuous driver: keep running upgrade iterations until told to stop
 * (Ctrl+C / SIGINT/SIGTERM), or after MAX_ITERS iterations (env, 0 =
 * infinite). Between iterations it waits LOOP_GAP_MS so a finished run's
 * edits settle and the box isn't hammered by back-to-back agents.
 */
const MAX_ITERS = Number(process.env.MAX_ITERS || 0); // 0 = run forever
const LOOP_GAP_MS = Number(process.env.LOOP_GAP_MS || 20_000);

let stopping = false;
function stopLoop() {
  stopping = true;
}

// A stop sentinel file: any process (or the portal UI) can signal the harness
// to stop by creating/`touch`ing this path — no need to find the PID or send a
// signal. The loop checks it each iteration and during the sleep gap.
const STOP_FILE = process.env.STOP_FILE || path.join(ROOT, "data", ".upgrade-stop");
function sentinelExists() {
  return existsSync(STOP_FILE);
}

/** Abort any in-flight agent turn on the reused session so a stop takes effect promptly. */
async function abortSessionIfRunning(cookie, sessionId) {
  try {
    await fetch(`${PORTAL}/api/sessions/${sessionId}/abort`, {
      method: "POST",
      headers: { cookie },
    });
  } catch {
    /* best effort */
  }
}

/** Signal handlers + sentinel mean the harness can RECEIVE a stop from many sources. */
process.on("SIGINT", () => {
  console.log("\nSIGINT — stopping: finishing current work, no new iterations after this.");
  stopLoop();
});
process.on("SIGTERM", () => {
  console.log("\nSIGTERM — stopping: finishing current work, no new iterations after this.");
  stopLoop();
});

async function runForever() {
  let iterations = 0;
  let positives = 0;
  // One login for the whole loop (cookies are long-lived; no need to re-auth
  // every iteration).
  const cookie = await login();
  // ONE session for the whole loop — the loop CONTINUES this session every
  // iteration (each iteration is just the next prompt), so it never leaks a
  // session dir + sandbox container per iteration (that ballooned to 100+).
  const sessionId = await createSession(cookie);
  console.log(`loop session ${sessionId} on ${WS}`);
  // Before launching anything, make sure the runner image's baked /repo is
  // up-to-date with the current source (rebuilds only when the repo/Dockerfile
  // is newer than the cached image). Runs once per process, not per iteration.
  await ensureFreshRunnerImage().catch((e) =>
    console.warn(`could not refresh runner image (continuing with existing): ${e?.message ?? e}`)
  );
  console.log(
    `upgrade loop started. MAX_ITERS=${MAX_ITERS || "infinite"}, LOOP_GAP_MS=${LOOP_GAP_MS}. Press Ctrl+C to stop.`
  );

  while (!stopping && (MAX_ITERS === 0 || iterations < MAX_ITERS)) {
    // Honor the stop sentinel file (touch data/.upgrade-stop to stop from
    // anywhere, no PID needed).
    if (sentinelExists()) {
      if (!stopping) console.log("\nstop sentinel found (data/.upgrade-stop) — stopping.");
      stopLoop();
      break;
    }
    iterations += 1;
    const label = `iteration ${iterations}`;
    console.log(`\n===== ${label} =====`);
    try {
      const { netPositive, reason } = await runOnce(cookie, sessionId);
      if (netPositive) positives += 1;
      console.log(`${label} done → ${netPositive ? "NET-POSITIVE" : "NET-NEGATIVE"} (${reason})`);
    } catch (e) {
      console.error(`${label} errored: ${e?.message ?? e}`);
    }
    // Check the sentinel again after the iteration too.
    if (sentinelExists() && !stopping) {
      console.log("\nstop sentinel found — stopping.");
      stopLoop();
    }
    if (stopping || (MAX_ITERS !== 0 && iterations >= MAX_ITERS)) break;
    console.log(`sleeping ${LOOP_GAP_MS}ms before next iteration (Ctrl+C, kill, or touch data/.upgrade-stop to stop)...`);
    // Wait in small slices so a stop signal / sentinel is noticed promptly.
    const slice = 500;
    for (let waited = 0; waited < LOOP_GAP_MS && !stopping && !sentinelExists(); waited += slice) {
      await sleep(slice);
    }
    if (sentinelExists() && !stopping) {
      console.log("\nstop sentinel found — stopping.");
      stopLoop();
    }
  }

  // If we stopped mid-loop, abort any in-flight agent turn so a stop lands
  // promptly instead of waiting out the full iteration gate.
  if (stopping) await abortSessionIfRunning(cookie, sessionId);

  console.log(
    `\nupgrade loop stopped after ${iterations} iteration(s) on session ${sessionId}; ` +
      `${positives} net-positive (verified edits).`
  );
  process.exit(0);
}

runForever().catch((e) => {
  console.error(e);
  process.exit(1);
});
