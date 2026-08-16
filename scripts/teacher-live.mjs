#!/usr/bin/env node
/**
 * teacher-live.mjs — continuous TEACHER-ANCHORED generation + scoring, streamed
 * live for the UI.
 *
 * Mechanism (from the owner):
 *   - 27B (teacher) and 4B (student) get the SAME task.
 *   - At each step the teacher (27B) adds ONE token; that token is appended and
 *     becomes the student's (4B) NEW prompt. The student emits 5 tokens.
 *   - We hold per-position TOP-K (up to 100) for the student and the teacher's
 *     top-k at that position.
 *
 * Scoring:
 *   - BASE: +1 per token position where the student's chosen token is in the
 *     teacher's top-k (1 teacher token == 1 student token), so +N max per step.
 *   - BONUS: +100 * n_step points each step (broad top-k now; will narrow later).
 *   - 500x VALUE GENERATION: compute the compressed token of the student's 5
 *     tokens (value = the sum of its 5 token ids, the n1+n2+n3 footprint, e.g.
 *     token 999993 == 9,4,3,200,2). If that compressed token appears in the
 *     top-k of the next-5 window AND a match exists in the top-100 of the next
 *     5 generated tokens, this step is a 500x value generation.
 *
 * Stream: writes output/live/current.json (latest state) + appends each step to
 * output/live/history.jsonl, and wraps both in HTML-SSE under output/live/events
 * for the real-time UI. Run:  node scripts/teacher-live.mjs [--steps N] [--topk 100]
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig, routeExperts, trainStep, scoreStep, saveModel } from "./moe-engine.mjs";

/** Deep-merge `patch` over `base` (objects merged recursively; scalars replaced). */
function deepMerge(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const LIVE = path.join(REPO, "output", "live");
const CURRENT = path.join(LIVE, "current.json");
const HISTORY = path.join(LIVE, "history.jsonl");
const PORT = Number(process.env.LIVE_PORT || 4199);

const TEACHER_URL = process.env.TEACHER_URL || "http://127.0.0.1:41001"; // 27B
const STUDENT_URL = process.env.STUDENT_URL || "http://127.0.0.1:6465";   // 4B
const TOP_K = Number(process.env.TOPK || 100);
const STUDENT_STEP = Number(process.env.STUDENT_STEP || 5);
const STEPS = Number(process.env.STEPS || 0); // 0 = run forever
const PROMPT =
  process.env.PROMPT ||
  "Consider the Pithagoras portal: the pi model picker sends provider and modelId. The issue is that";

// Token used to denote the 5-token compression footprint (e.g. token 999993
// == the token ids 9,4,3,200,2). We treat "compressed token == sum of its
// constituent token ids" as the signature the 500x detector looks for.
const COMPRESS_AS_TOKEN = Number(process.env.COMPRESS_AS_TOKEN || 999993);

const args = process.argv.slice(2);
function flag(name, d) { const i = args.indexOf("--" + name); return i >= 0 ? Number(args[i + 1]) : d; }
const _steps = flag("steps", STEPS);

/** Get per-position top-k (up to 100) + chosen token from a model via
 *  /v1/completions?logprobs. logprobs=N can be >5; clamp to TOP_K. */
async function profile(url, prompt, n) {
  const body = JSON.stringify({
    model: "x", prompt, max_tokens: n, temperature: 0.2,
    top_p: 1, top_k: TOP_K, logprobs: Math.min(100, TOP_K), echo: false, stream: false,
  });
  const res = await fetch(`${url}/v1/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  const d = await res.json();
  const content = d?.choices?.[0]?.logprobs?.content || [];
  return content.map((row) => ({
    chosen: { token: row.token, logprob: Number.isFinite(row.logprob) ? row.logprob : 0 },
    top: (row.top_logprobs || []).map((t) => ({
      token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0,
    })),
  }));
}

/**
 * Resilient profile: retry transient errors (esp. HTTP 500 from a busy teacher
 * box) so a single flaky call never corrupts a whole step into {error}. Gives
 * up after ~3 tries over ~6s; the caller then skips the step cleanly.
 */
async function profileRetry(url, prompt, n, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await profile(url, prompt, n);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last;
}

/** The 5-token compression footprint: a single token id whose VALUE equals the
 *  sum of the 5 constituent token ids (the n1+n2+n3 convention). */
function compressFootprint(tokens) {
  return tokens.reduce((a, t) => a + t, 0);
}

let latest = null; // latest current.json content to serve to the UI

function sendCurrent(extra = {}) {
  const payload = { ...latest, ...extra, ts: Date.now() };
  fs.writeFileSync(CURRENT, JSON.stringify(payload, null, 2));
  fs.appendFileSync(HISTORY, JSON.stringify({ ...latest, ts: Date.now() }) + "\n");
  latest = payload;
  return payload;
}

/** Serve an SSE stream of current.json to the UI. */
function startServer() {
  fs.mkdirSync(LIVE, { recursive: true });
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    const url = req.url || "";
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // /config GET: return the live MoE config (point values, formulas, experts).
    if (url === "/config" && req.method === "GET") {
      const cfg = loadConfig() || {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cfg));
      return;
    }
    // /config POST: MERGE edited MoE config onto the existing one (points,
    // penalties, formulas, experts). Shallow+deep merge so a partial update
    // never clobbers the rest of the config.
    if (url === "/config" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          const cfgPath = path.join(REPO, "config", "moe-config.json");
          const existing = fs.existsSync(cfgPath)
            ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
            : {};
          const merged = deepMerge(existing, patch);
          fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, saved: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    if (url.startsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const push = () => {
        if (latest) { res.write("data: " + JSON.stringify(latest) + "\n\n"); }
      };
      push();
      const iv = setInterval(push, 400);
      req.on("close", () => clearInterval(iv));
      return;
    }
    // Serve the plain current.json
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.existsSync(CURRENT) ? fs.readFileSync(CURRENT, "utf8") : "{}");
  });
  server.listen(PORT, () => console.log(`[live-ui] SSE + JSON at http://127.0.0.1:${PORT}`));
  return server;
}

async function run() {
  fs.mkdirSync(LIVE, { recursive: true });
  console.log("=== TEACHER-LIVE: 27B teacher -> 4B student, continuous scoring ===");
  console.log(`  teacher ${TEACHER_URL} | student ${STUDENT_URL} | top-${TOP_K} | student step ${STUDENT_STEP}`);
  startServer();

  let shared = PROMPT;
  let baseScoreTotal = 0;
  let bonusTotal = 0;
  let fives = 0;
  let step = 0;
  let ended = false;

  // rolling window of the last few steps for the "compression ~ generation" plot
  const recent = [];
  const alwaysRun = _steps === 0;

  while (!ended && (alwaysRun || step < _steps)) {
    step++;
    let stepRec = { step, ts: Date.now() };
    try {
      // Teacher (27B) adds ONE token (retry transient 500s).
      const teacher = await profileRetry(TEACHER_URL, shared, 1);
      const tPos = teacher[0];
      if (!tPos || tPos.chosen.token === undefined) { stepRec.note = "teacher empty"; ended = true; break; }
      const teacherToken = tPos.chosen.token;
      shared += " " + teacherToken;

      // Student (4B) emits 5 tokens from the SAME (teacher-appended) prompt.
      const student = await profileRetry(STUDENT_URL, shared, STUDENT_STEP);
      if (!student.length) { stepRec.note = "student empty"; ended = true; break; }

      // Base score: +1 per position where student chosen token is in teacher top-k.
      const teacherTopK = new Set((tPos.top || []).map((x) => x.token));
      let base = 0;
      for (const s of student) if (teacherTopK.has(s.chosen.token)) base++;
      baseScoreTotal += base;

      // 500x detector: the 5-token compression footprint of the student's step
      // (value = sum of constituent token ids). If that "compressed token" is
      // in the top-k of this window and a match is in the top-100 of the 5
      // generated tokens, it's a 500x value generation.
      const studentIds = student.map((s) => s.chosen.token);
      const footprint = compressFootprint(studentIds);
      const top100All = new Set(student.flatMap((s) => (s.top || []).map((x) => x.token)));
      const inTopK = student.some((s) => (s.top || []).some((x) => x.token === COMPRESS_AS_TOKEN));
      const inTop100 = top100All.has(COMPRESS_AS_TOKEN) || top100All.has(footprint);
      const is500x = inTopK && inTop100;
      if (is500x) fives++;

      // ---- MoE: route through the expert layers (top-2), train, score ----
      let moe = null, sc = null;
      try {
        const route = routeExperts((tPos.top || []).map((x) => x.token));
        const training = trainStep(route, Math.exp(Math.min(0, tPos.chosen.logprob)), 0.5);
        sc = scoreStep({ baseMatches: base, step, is500x }); // config points/penalties
        bonusTotal = sc.bonus;
        // Surface full detail: each expert's top-k value, active flag, size,
        // layers used, num experts, per-layer training deltas, and the new
        // tokens (compressed + student new tokens this step).
        const cfg = loadConfig();
        moe = {
          num_experts: cfg?.moe?.num_experts ?? route.count,
          expert_topk: route.rows.map((r) => ({ expert: r.name, value: Number(r.value).toFixed(4), active: r.active, role: r.role, mutation: r.mutation, topk_weight: r.topk_weight })),
          active: route.rows.filter((r) => r.active).map((r) => r.name),
          layers_used: training.layers,
          layers_total: route.layer_count,
          per_layer: training.perLayer || [],
          training_delta: training.delta,
          new_tokens: {
            teacher: studentIds.map((_, i) => student[i].chosen.token), // student new tokens
            teacher_anchor: teacherToken,
            compressed: footprint,       // 5-token compression footprint
            compressed_token: COMPRESS_AS_TOKEN,
          },
        };
        // Save the model while generating every SAVE_EVERY steps.
        if (step % (Number(process.env.SAVE_EVERY) || 25) === 0) {
          const f = saveModel(step, route, training);
          moe.last_snapshot = f;
        }
      } catch (e) {
        moe = { error: String(e.message || e) };
        bonusTotal = 100 * step;
        sc = { base, bonus: bonusTotal, gain: 0, penalty: 0, totalGain: base + bonusTotal };
      }

      stepRec = {
        ...stepRec,
        teacher_token: teacherToken,
        student_tokens: studentIds,
        teacher_topk: (tPos.top || []).slice(0, 10).map((x) => x.token),
        student_top100_count: top100All.size,
        compressed_footprint: footprint,
        compressed_token: COMPRESS_AS_TOKEN,
        in_topk: inTopK,
        in_top100: inTop100,
        is_500x_value_generation: is500x,
        moe,
        base_step_score: base,
        penalty: sc ? sc.penalty : 0,
        step_gain: sc ? sc.totalGain : 0,
        base_score_total: baseScoreTotal,
        bonus_total: bonusTotal,
        total_score: baseScoreTotal + bonusTotal,
      };
    } catch (e) {
      stepRec.error = String(e.message || e);
      stepRec.total_score = baseScoreTotal + bonusTotal;
    }

    recent.push(stepRec);
    if (recent.length > 60) recent.shift();

    // Publish for the UI.
    latest = {
      mode: "teacher-anchored live",
      teacher: TEACHER_URL, student: STUDENT_URL,
      top_k: TOP_K, student_step_tokens: STUDENT_STEP,
      step, base_score: baseScoreTotal, bonus_score: bonusTotal,
      total_score: baseScoreTotal + bonusTotal,
      "500x_generations": fives,
      num_experts: stepRec.moe?.num_experts ?? loadConfig()?.moe?.num_experts ?? 5,
      layers_total: stepRec.moe?.layers_total ?? loadConfig()?.layers?.count ?? 5,
      recent,
      prompt: shared,
      ts: Date.now(),
    };
    sendCurrent();
    console.log(`  step ${step}: base=${baseScoreTotal} bonus=${bonusTotal} 500x=${fives} ${stepRec.is_500x_value_generation ? "  <<500x" : ""}`);

    // Small gap so the UI can render; not a sleep hack, just pacing.
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("teacher-live finished.");
  process.exit(0);
}

run().catch((e) => { console.error("teacher-live failed:", e); process.exit(1); });
