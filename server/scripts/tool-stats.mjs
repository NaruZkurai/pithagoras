#!/usr/bin/env node
/**
 * tool-stats.mjs — mine the portal session DB for per-tool effectiveness.
 *
 * The self-training loop (see docs/self-training.md, Phase 1) starts here:
 * measure how each tool actually performs so we can (a) feed the numbers back
 * into harness refinement to pick better tools/heuristics, and (b) later label
 * trajectories for LoRA/DPO. This is the same idea as prime-agent's
 * edit-tool-stats.mjs / read-tool-stats.mjs, running against the portal's own
 * `events` table instead of pi session JSONL.
 *
 * Usage:
 *   node server/scripts/tool-stats.mjs                 # whole DB
 *   node server/scripts/tool-stats.mjs <sessionId>     # one session
 *   node server/scripts/tool-stats.mjs all --json      # machine-readable
 *
 * Reads data/portal.db (or $DATA_DIR/portal.db) READ-ONLY and never writes.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "portal.db");

if (!existsSync(DB_PATH)) {
  console.error(`no portal.db at ${DB_PATH}`);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

/** Error keywords to bucket bash tool failures (mirrors prime-agent classify). */
const ERROR_KINDS = [
  ["file_not_found", /no such file|not found|cannot access|enoent/i],
  ["permission", /permission denied|operation not permitted|eperm|eacces/i],
  ["command_not_found", /command not found|: not found/i],
  ["timeout", /timeout|timed out|killed/i],
  ["network", /could not resolve|connection refused|failed to connect|curl: \(\d+\)/i],
  ["syntax", /syntax error|parse error|unexpected token/i],
] ;

function classifyError(text) {
  for (const [kind, re] of ERROR_KINDS) {
    if (re.test(text)) return kind;
  }
  return "other";
}

/** Pull tool_execution_start / tool_execution_end pairs for one session. */
function sessionToolCalls(sessionId) {
  const rows = db
    .prepare(
      `SELECT seq, type, payload FROM events
       WHERE session_id = ? AND type IN ('tool_execution_start','tool_execution_end')
       ORDER BY seq ASC`
    )
    .all(sessionId);

  const start = new Map(); // toolName -> most recent call token
  const calls = []; // { toolName, args, ok, errorKind }
  let token = 0;
  for (const row of rows) {
    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (row.type === "tool_execution_start") {
      token++;
      start.set(token, {
        name: String(payload.toolName ?? payload.name ?? "tool"),
        command: String(payload.args?.command ?? payload.input?.command ?? ""),
        path: String(payload.args?.path ?? payload.input?.path ?? payload.input?.file_path ?? ""),
        seq: row.seq,
      });
    } else if (row.type === "tool_execution_end") {
      const name = String(payload.toolName ?? payload.name ?? "tool");
      // Match the most recent unmatched start of the same tool name.
      let matched = null;
      for (const [k, v] of start) {
        if (v.name === name) {
          matched = [k, v];
        }
      }
      if (!matched) continue;
      const [k, s] = matched;
      start.delete(k);
      const isErr = !!payload.isError || !!payload.error;
      const outText = extractText(payload.result);
      calls.push({
        toolName: s.name,
        command: s.command,
        path: s.path,
        ok: !isErr,
        errorKind: isErr || outText ? classifyError(outText || String(payload.error ?? "")) : "ok",
        outputLen: outText.length,
      });
    }
  }
  return calls;
}

function extractText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("\n");
}

function summarize(calls) {
  const perTool = new Map(); // name -> { calls, ok, byKind:{} , repeated }
  const byCommand = new Map(); // command -> lastOk
  for (const c of calls) {
    let t = perTool.get(c.toolName);
    if (!t) {
      t = { calls: 0, ok: 0, byKind: {}, repeated: 0 };
      perTool.set(c.toolName, t);
    }
    t.calls++;
    if (c.ok) t.ok++;
    t.byKind[c.errorKind] = (t.byKind[c.errorKind] || 0) + 1;
    // Repeated identical failing command (same command failed before).
    const key = `${c.toolName}\u0000${c.command}`;
    if (byCommand.get(key) === false && !c.ok) t.repeated++;
    byCommand.set(key, c.ok);
  }
  return perTool;
}

function print(table) {
  const rows = [...table.entries()].sort((a, b) => b[1].calls - a[1].calls);
  console.log(`\n${"tool".padEnd(14)} ${"calls".padStart(6)} ${"ok".padStart(5)} ${"err%".padStart(6)} ${"repeated".padStart(9)}  failure kinds`);
  for (const [name, t] of rows) {
    const errPct = t.calls ? Math.round(((t.calls - t.ok) / t.calls) * 100) : 0;
    const kinds = Object.entries(t.byKind)
      .filter(([k]) => k !== "ok")
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`)
      .join(", ");
    console.log(`${name.slice(0, 14).padEnd(14)} ${String(t.calls).padStart(6)} ${String(t.ok).padStart(5)} ${String(errPct).padStart(6)} ${String(t.repeated).padStart(9)}  ${kinds}`);
  }
}

// ---- main ----
const sessions = process.argv[2] && process.argv[2] !== "all"
  ? [process.argv[2]]
  : db.prepare("SELECT id FROM sessions ORDER BY updated_at DESC").all().map((r) => r.id);

const all = new Map();
const union = (a, b) => {
  for (const [k, v] of b) {
    const t = a.get(k);
    if (t) {
      t.calls += v.calls;
      t.ok += v.ok;
      t.repeated += v.repeated;
      for (const [kk, nn] of Object.entries(v.byKind)) t.byKind[kk] = (t.byKind[kk] || 0) + nn;
    } else {
      a.set(k, { ...v, byKind: { ...v.byKind } });
    }
  }
  return a;
};

for (const sid of sessions) {
  const calls = sessionToolCalls(sid);
  union(all, summarize(calls));
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      [...all.entries()].map(([name, t]) => ({ tool: name, ...t, errorRate: t.calls ? (t.calls - t.ok) / t.calls : 0 })),
      null,
      2
    )
  );
} else {
  const scope = process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : `${sessions.length} session(s)`;
  console.log(`Tool stats for ${scope}`);
  print(all);
}
