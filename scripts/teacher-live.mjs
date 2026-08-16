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
import { loadConfig, routeExperts, trainStep, scoreStep, saveModel, narrowTokenSet, addLayerNoise, maybeResetMoeState, accumulateExpertScores, updateLosingExperts, curveReward, compressionReward } from "./moe-engine.mjs";

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
const TOKENS = path.join(LIVE, "tokens.jsonl"); // full per-step student-guess token ledger
const PORT = Number(process.env.LIVE_PORT || 4199);

const TEACHER_URL = process.env.TEACHER_URL || "http://127.0.0.1:41001"; // 27B
const STUDENT_URL = process.env.STUDENT_URL || "http://127.0.0.1:6465";   // 4B

// CODE-DB BASELINE: load the new-token patterns derived from the entire code DB
// (see scripts/seed-code-baseline.mjs). When present, these baseline chunk-hash
// values are folded into the "new token system" target set, so generated tokens
// that match genuine code constructs are recognized for heavier reward.
let CODE_BASELINE = null;
try {
  const base = JSON.parse(fs.readFileSync(path.join(REPO, "config", "moe", "code-baseline.json"), "utf8"));
  if (base && Array.isArray(base.chunk_hashes)) {
    CODE_BASELINE = {
      chunkHashSet: new Set(base.chunk_hashes.map((c) => String(c.hash))),
      symbols: base.top_code_symbols || [],
      bigrams: base.top_bigrams || [],
      fileCount: base.file_count,
    };
  }
} catch {
  CODE_BASELINE = null; // baseline optional
}
// The baseline "expected" token values, folded into new-token matching.
function codeBaselineSet() {
  return CODE_BASELINE ? CODE_BASELINE.chunkHashSet : new Set();
}

// Sampling knobs are LIVE (read from config/moe-config.json "sampling" each
// step so the UI sliders apply immediately). Helpers return current values.
const SAMPLING = () => loadConfig()?.sampling || {};
const viewTopK = () => Math.min(100, Number(SAMPLING().view_top_k ?? 100));   // how many top tokens model looks at (logprobs)
function emitFor(who) { // {top_k, top_p, temperature} for teacher|student
  const s = SAMPLING().emit?.[who] || {};
  return {
    top_k: Math.min(100, Number(s.top_k ?? 20)),
    top_p: Number(s.top_p ?? 0.9),
    temperature: Number(s.temperature ?? 0.7),
  };
}
const noiseToLayer = () => Number(SAMPLING().noise_to_layer ?? 0.05);
const STUDENT_STEP = Number(process.env.STUDENT_STEP || 5);
// Teacher advances the shared prompt by a small BATCH of coherent tokens in ONE
// request (1-bit models collapse into "the the the" when asked for exactly one
// token per step). The SCORING anchor is still the FIRST token's top-k, so the
// teacher-anchored parity design is preserved. Set TEACHER_BATCH=1 to revert
// to strictly one-token-per-step (not recommended on 1-bit models).
const TEACHER_BATCH = Math.max(1, Number(process.env.TEACHER_BATCH || 8));
const STEPS = Number(process.env.STEPS || 0); // 0 = run forever
let PROMPT =
  process.env.PROMPT ||
  "Consider the Pithagoras portal: the pi model picker sends provider and modelId. The issue is that";
let promptChanged = false; // set true by a /prompt POST to reseed shared next step
let paused = false;        // true = skip training steps (UI keeps serving)

// Token used to denote the 5-token compression footprint (e.g. token 999993
// == the token ids 9,4,3,200,2). We treat "compressed token == sum of its
// constituent token ids" as the signature the 500x detector looks for.
const COMPRESS_AS_TOKEN = Number(process.env.COMPRESS_AS_TOKEN || 999993);

const args = process.argv.slice(2);
function flag(name, d) { const i = args.indexOf("--" + name); return i >= 0 ? Number(args[i + 1]) : d; }
const _steps = flag("steps", STEPS);

/** Get per-position top-k + chosen token from a model via
 *  /v1/completions?logprobs. The model VIEWS the top-viewTopK tokens
 *  (logprobs=N) but only EMITS from the top-k / top-p of the given role
 *  (teacher/student) — which also keeps the teacher coherent.
 *  `who` selects the live sampling.emit.<who> values from config. */
async function profile(url, prompt, n, who = "teacher") {
  const { top_k, top_p, temperature } = emitFor(who);
  const body = JSON.stringify({
    model: "x", prompt, max_tokens: n, temperature,
    top_p, top_k, logprobs: viewTopK(), echo: false, stream: false,
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
async function profileRetry(url, prompt, n, who = "teacher", tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await profile(url, prompt, n, who);
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

    if (url === "/tokens") {
      // Full per-step student-guess token ledger (tokens only) for review at
      // any step. If only the current step's rows are needed, ?step=N filters.
      try {
        const all = fs.existsSync(TOKENS)
          ? fs.readFileSync(TOKENS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
          : [];
        const q = new URL(url, "http://x").searchParams;
        const step = q.get("step");
        const out = step !== null ? all.filter((r) => r.step === Number(step)) : all;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }

    // /prompt POST: set the teacher/student prompt LIVE. The next step re-seeds
    // `shared` with this new prompt (a fresh generation run).
    if (url === "/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          const p = String(patch.prompt ?? patch.p ?? "").trim();
          if (!p) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "missing prompt" }));
            return;
          }
          PROMPT = p;
          promptChanged = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, prompt: PROMPT }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    // /pause POST: pause/resume training (body {paused:true|false} or GET).
    if (url === "/pause") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const patch = JSON.parse(body || "{}");
            paused = patch.paused !== undefined ? !!patch.paused : !paused;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, paused }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
          }
        });
        return;
      }
      // GET current paused state
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, paused }));
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
  console.log(`  teacher ${TEACHER_URL} | student ${STUDENT_URL} | view-top-${viewTopK()} emit teacher tK${emitFor("teacher").top_k}/tP${emitFor("teacher").top_p} student tK${emitFor("student").top_k}/tP${emitFor("student").top_p} | student step ${STUDENT_STEP}`);
  startServer();

  let shared = PROMPT;
  const teacherOutput = []; // teacher's accumulated output tokens (1 per step)
  const newTokens = [];     // current list of NEW tokens created (compressed chunks + sentinel)
  let baseScoreTotal = 0;
  let bonusTotal = 0;
  let layerNoiseState = null; // per-token noise accumulator for layer states
  let fives = 0;
  let step = 0;
  let ended = false;

  // rolling window of the last few steps for the "compression ~ generation" plot
  const recent = [];
  const alwaysRun = _steps === 0;

  while (!ended && (alwaysRun || step < _steps)) {
    // Live prompt change (from /prompt POST): reseed the shared prompt, clear
    // the teacher's accumulated output, and reset the step counter so the new
    // prompt starts a fresh generation run.
    if (promptChanged) {
      promptChanged = false;
      shared = PROMPT;
      teacherOutput.length = 0;
      newTokens.length = 0;      // clear the created new-token list on a new prompt
      layerNoiseState = null;
      recent.length = 0;
      step = 0;
      console.log(`  >> prompt changed to: ${JSON.stringify(PROMPT.slice(0, 80))}... (restarting generation)`);
    }
    // Pause: skip training steps but keep the UI (SSE/JSON) alive and reflect
    // the paused state so the browser stays connected.
    if (paused) {
      latest = { ...(latest || {}), paused: true, step };
      sendCurrent();
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    step++;
    let stepRec = { step, ts: Date.now() };
    try {
      // Teacher (27B) advances the shared prompt by TEACHER_BATCH coherent tokens
      // in ONE request (1-bit models collapse into "the the the" when asked for
      // exactly one token per step). The SCORING anchor remains the FIRST token
      // (tPos) so the teacher-anchored top-k parity design is preserved.
      const teacher = await profileRetry(TEACHER_URL, shared, TEACHER_BATCH, "teacher");
      const tPos = teacher[0];
      if (!tPos || tPos.chosen.token === undefined) { stepRec.note = "teacher empty"; ended = true; break; }
      const teacherToken = tPos.chosen.token;
      const teacherAdvance = teacher.map((x) => x.chosen.token).filter((t) => t !== undefined);
      shared += " " + teacherAdvance.join(" ");
      teacherOutput.push(...teacherAdvance); // accumulate teacher's output tokens

      // Student (4B) emits STUDENT_STEP tokens from the SAME (teacher-appended)
      // prompt, limited by the student's live top-k/top-p (emit.student).
      const student = await profileRetry(STUDENT_URL, shared, STUDENT_STEP, "student");
      if (!student.length) { stepRec.note = "student empty"; ended = true; break; }

      // Scoring per-token: the student's narrowed top-n/k ∩ top-n/p set at each
      // output position vs the teacher's narrowed top-n/k ∩ top-n/p set.
      // Points = how many of the student's kept tokens are also in the
      // teacher's kept set (per scoring.base.per_topk_token_match / _topp).
      // PLUS extra points for each student CHOSEN token that falls in the
      // teacher's ACTUAL emitted top-k (per_teacher_emit_match).
      const cfgScore = loadConfig()?.scoring?.base || {};
      const ptsK = Number(cfgScore.per_topk_token_match ?? 1);
      const ptsP = Number(cfgScore.per_topp_token_match ?? 1);
      const ptsEmit = Number(cfgScore.per_teacher_emit_match ?? 2);
      const tSetK = narrowTokenSet(tPos.top, emitFor("teacher").top_k, 1);
      const tSetP = narrowTokenSet(tPos.top, viewTopK(), emitFor("teacher").top_p);
      let base = 0, baseP = 0, baseEm = 0, overInK = 0, overInP = 0, overInEm = 0;
      for (const s of student) {
        const sSetK = narrowTokenSet(s.top, emitFor("student").top_k, 1);
        const sSetP = narrowTokenSet(s.top, viewTopK(), emitFor("student").top_p);
        for (const tok of sSetK) if (tSetK.has(tok)) { base += ptsK; overInK++; }
        for (const tok of sSetP) if (tSetP.has(tok)) { baseP += ptsP; overInP++; }
        // Teacher actually emitted from tPos.top (its narrow cut); extra points
        // when the student's CHOSEN token is in that emitted set.
        if (tSetK.has(s.chosen.token)) { baseEm += ptsEmit; overInEm++; }
      }
      baseScoreTotal += base + baseP + baseEm;

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
      // THE NEW-TOKEN SYSTEM (visible): each step, the student's 5 output
      // tokens are COMPRESSED into ONE new token whose value = their sum
      // (footprint). We record it as a created new token + a table describing
      // how the compression works, so the UI can show the system + current list.
      newTokens.push({
        step,
        input: studentIds,           // the 5 tokens being compressed
        new_token: footprint,        // the created new token (sum of input ids)
        sentinel: COMPRESS_AS_TOKEN, // the fixed sentinel this scheme matches
        created: is500x,             // true when this new token appears in top-k AND top-100
        ts: Date.now(),
      });
      if (newTokens.length > 200) newTokens.shift(); // keep the list bounded

      // ---- NEW REWARDS: exponential teacher-curve + compression-ratio ----
      // (1) EXPONENTIAL teacher-curve: teacher is perfect top-k; the closer the
      //     student's top-k curve is to the teacher's, the exponentially bigger
      //     the reward (reward = per_topk_token_match * exp_base^(overlap*scaler)).
      // (2) COMPRESSION: a compressed token that packs a lot of text/effective
      //     tokens is rewarded by compressionRatio * baseEffectiveTokens
      //     * (1 + textLen / tokensSaved), with a multiplier if the emitted
      //     tokens match the new-token-system's created tokens.
      const cfgRew = loadConfig()?.scoring || {};
      // Fold the code-DB baseline "genuine" token values into the new-token
      // target set, so generated tokens matching real code patterns earn the
      // compression/curve reward (recognized as genuine, not random).
      const newTokenSet = new Set(newTokens.flatMap((t) => [String(t.new_token), ...(t.input || []).map(String)]));
      for (const b of codeBaselineSet()) newTokenSet.add(b);
      let curveRw = { reward: 0, overlapFraction: 0, matched: 0, numSlots: 0, compressedMatched: false, compressedSlotRank: -1 };
      let compressRw = { reward: 0, compressionRatio: 0, tokensSaved: 0, newTokenMatchPct: 0, appliedMultiplier: 1 };
      if (cfgRew.curve?.enabled !== false) {
        curveRw = curveReward({
          student,
          teacherTopK: (tPos.top || []).map((x) => x.token),
          perTokenMatch: ptsK,
          compressedToken: footprint,
          newTokenSet,
        });
      }
      if (cfgRew.compression?.enabled !== false) {
        const textLen = student.reduce((a, s) => a + String(s.chosen.token ?? "").length, 0);
        compressRw = compressionReward({
          emittedTokens: STUDENT_STEP,
          perTokenEmitted: studentIds.map(String),
          textLengthGenerated: textLen,
          newTokenSet,
        });
      }
      const curvePoints = (cfgRew.curve?.enabled === false) ? 0 : (curveRw.reward || 0);
      const compressionPoints = (cfgRew.compression?.enabled === false) ? 0 : (compressRw.reward || 0);

      // ---- MoE: route through the expert layers (top-2), train, score ----
      let moe = null, sc = null;
      try {
        // Per-token layer noise: for each student token emitted, add noise to
        // the layers so the NEXT output token routes through a nudged layer.
        const nLayers = loadConfig()?.layers?.count || 5;
        for (let ti = 0; ti < (studentIds.length || 1); ti++) {
          layerNoiseState = addLayerNoise(layerNoiseState, noiseToLayer(), nLayers, ti);
        }
        const route = routeExperts((tPos.top || []).map((x) => x.token), layerNoiseState);
        const training = trainStep(route, Math.exp(Math.min(0, tPos.chosen.logprob)), 0.5);
        sc = scoreStep({ baseMatches: base, step, is500x }); // config points/penalties
        bonusTotal = sc.bonus;
        // Round reset: if the expert state has reached steps_per_round *
        // rounds_before_reset, reset the accumulators (keeping lastRound for
        // display) BEFORE scoring the new round.
        maybeResetMoeState();
        // Attribute the step's points across ALL experts by their VALUE
        // (affinity), so every expert shows its own points (not just the top-2
        // routed ones). Active experts get their value-weighted share of the
        // step's points; inactive experts keep a value-based standing share.
        // Include the new reward terms (exponential teacher-curve + compression)
        // so they are tallied into the round cumulative score (before reset).
        const pts = base + baseP + baseEm + curvePoints + compressionPoints;
        const vAll = route.rows.reduce((a, r) => a + (Number(r.value) || 0), 0) || 1;
        const perExpertPoints = route.rows.map((r) => ({
          expert: r.name,
          score: Number((pts * ((Number(r.value) || 0) / vAll)).toFixed(4)),
        }));
        const expertScores = route.rows.map((r) => ({
          expert: r.name,
          active: r.active,
          role: r.role,
          mutation: r.mutation,
          weight: Number(r.topk_weight) || 0,
          score: Number((pts * ((Number(r.value) || 0) / vAll)).toFixed(4)),
        }));
        // Accumulate each expert's score into the persistent round state so all
        // experts build cumulative points (visible across resets via lastRound).
        const cumScores = accumulateExpertScores(perExpertPoints);
        // UPDATE LOSING EXPERTS: every losing_experts_update_every steps, re-seed
        // the weakest experts from the previous window's data.
        updateLosingExperts();
        const st = route.state || {};
        // Per-expert "guess": ONE token per expert. Each expert Ei owns the
        // student's output position i % STUDENT_STEP, so we tag that chosen
        // token with the expert (with its affinity/active state) for display.
        const perExpertGuesses = route.rows.map((r, i) => ({
          expert: r.name,
          active: r.active,
          value: Number(r.value).toFixed(4),
          token: studentIds[(i % Math.max(1, studentIds.length))],
        }));
        // Surface full detail: each expert's top-k value, active flag, size,
        // layers used, num experts, per-layer training deltas, and the new
        // tokens (compressed + student new tokens this step).
        const cfg = loadConfig();
        moe = {
          round: st.round ?? 1,
          cumulative_scores: cumScores,
          last_round: st.lastRound ?? null,
          num_experts: cfg?.moe?.num_experts ?? route.count,
          expert_topk: route.rows.map((r) => ({ expert: r.name, value: Number(r.value).toFixed(4), active: r.active, role: r.role, mutation: r.mutation, topk_weight: r.topk_weight })),
          expert_scores: expertScores,
          expert_guesses: perExpertGuesses,
          active: route.rows.filter((r) => r.active).map((r) => r.name),
          layers_used: training.layers,
          layers_total: route.layer_count,
          per_layer: training.perLayer || [],
          training_delta: training.delta,
          layer_noise: layerNoiseState ? layerNoiseState.layers.map((v) => Number(v.toFixed(4))) : [],
          state: route.state ? {
            noise: Number(route.state.noise?.toFixed?.(4) ?? route.state.noise ?? 0),
            step: route.state.step ?? 0,
            topP: route.state.topP || {},
            kl: route.state.kl || {},
            output: route.state.output || {},
            expertValues: Object.fromEntries(route.rows.map((r) => [r.name, Number((route.state.expertValues?.[r.name] ?? 0).toFixed?.(4) ?? route.state.expertValues?.[r.name]) || 0])),
          } : undefined,
          new_tokens: {
            teacher: studentIds.map((_, i) => student[i].chosen.token), // student new tokens
            teacher_anchor: teacherToken,
            compressed: footprint,       // 5-token compression footprint
            compressed_token: COMPRESS_AS_TOKEN,
          },
        };
        // Save the model while generating every SAVE_EVERY steps (emits a REAL
        // sparse-MoE checkpoint, not a dense snapshot).
        if (step % (Number(process.env.SAVE_EVERY) || 25) === 0) {
          const f = saveModel(step, route, training, route.state);
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
        per_expert_guesses: (moe?.expert_guesses || []).map((g) => ({ expert: g.expert, token: g.token })),
        teacher_topk: (tPos.top || []).slice(0, 10).map((x) => x.token),
        student_top100_count: top100All.size,
        compressed_footprint: footprint,
        compressed_token: COMPRESS_AS_TOKEN,
        in_topk: inTopK,
        in_top100: inTop100,
        is_500x_value_generation: is500x,
        moe,
        base_step_score: base,
        score_breakdown: {
          topk: base, tpp: baseP, teacher_emit: baseEm,
          curve: curvePoints ?? 0, compression: compressionPoints ?? 0,
          inK: overInK, inP: overInP, inEm: overInEm,
          curve_overlap: curveRw?.overlapFraction ?? 0,
          curve_matched: curveRw?.numSlots ?? 0,
          curve_compressed_match: curveRw?.compressedMatched ?? false,
          comp_ratio: compressRw?.compressionRatio ?? 0,
          comp_tokens_saved: compressRw?.tokensSaved ?? 0,
          comp_newtok_pct: compressRw?.newTokenMatchPct ?? 0,
          comp_mult: compressRw?.appliedMultiplier ?? 1,
        },
        penalty: sc ? sc.penalty : 0,
        step_gain: sc ? sc.totalGain : 0,
        // Per-step points BEFORE the expert/layer gets updated this token.
        // This RESETS every single token (step) — it does NOT accumulate.
        step_points: base + baseP + baseEm + curvePoints + compressionPoints,
        base_score_total: baseScoreTotal,
        bonus_total: bonusTotal,
        total_score: base + baseP + baseEm + curvePoints + compressionPoints,
      };
    } catch (e) {
      stepRec.error = String((e && e.message) || e) || "unknown step error";
      console.error("  !! step error:", (e && e.message) || e, e);
      const sp = (Number(base) || 0) + (Number(baseP) || 0) + (Number(baseEm) || 0)
        + (Number(curvePoints) || 0) + (Number(compressionPoints) || 0);
      stepRec.total_score = sp;
      stepRec.step_points = sp;
    }

    recent.push(stepRec);
    if (recent.length > 60) recent.shift();

    // Publish for the UI.
    latest = {
      mode: "teacher-anchored live",
      teacher: TEACHER_URL, student: STUDENT_URL,
      view_top_k: viewTopK(),
      emit: { teacher: emitFor("teacher"), student: emitFor("student") },
      noise_to_layer: noiseToLayer(),
      base_model: loadConfig()?.model?.base_gguf ?? STUDENT_URL,
      expert_policy: loadConfig()?.expert_policy || {},
      per_teacher_emit_match: Number(loadConfig()?.scoring?.base?.per_teacher_emit_match ?? 2),
      student_step_tokens: STUDENT_STEP,
      step, base_score: stepRec.step_points ?? 0, bonus_score: bonusTotal,
      // total = this token's points BEFORE the expert was updated; resets each token.
      total_score: stepRec.step_points ?? 0,
      "500x_generations": fives,
      num_experts: stepRec.moe?.num_experts ?? loadConfig()?.moe?.num_experts ?? 5,
      layers_total: stepRec.moe?.layers_total ?? loadConfig()?.layers?.count ?? 5,
      // NEW-TOKEN SYSTEM: how new tokens are created + the current created list.
      new_token_system: {
        how: "Each step, the student's STUDENT_STEP output tokens are COMPRESSED into ONE new token whose VALUE = the sum of their token ids (footprint). A fixed sentinel (COMPRESS_AS_TOKEN) marks the compression; when that new token appears in the model's top-k of the space AND a match is in the top-100 of the emitted tokens, it counts as a 500x value generation.",
        sentinel: COMPRESS_AS_TOKEN,
        per_step: STUDENT_STEP,
        create_rule: "new_token = sum(input tokens)",
        code_baseline: CODE_BASELINE ? {
          loaded: true,
          file_count: CODE_BASELINE.fileCount,
          symbols: CODE_BASELINE.symbols.length,
          bigrams: CODE_BASELINE.bigrams.length,
          chunk_hashes: CODE_BASELINE.chunkHashSet.size,
          note: "code-DB baseline new-token patterns folded into the reward target set",
        } : { loaded: false, note: "run scripts/seed-code-baseline.mjs to feed the code DB as baseline" },
      },
      new_tokens_list: newTokens,
      // Teacher: the total prompt + accumulated output tokens.
      teacher_prompt: PROMPT,
      teacher_output: teacherOutput,
      teacher_prompt_output_tokens: (PROMPT + " " + teacherOutput.join(" ")).trim().split(/\s+/).length,
      recent,
      prompt: shared,
      paused: false,
      ts: Date.now(),
    };
    sendCurrent();
    // Token ledger: full per-step student guesses (tokens only) so any step can
    // be reviewed later, not just the last 60.
    try {
      fs.appendFileSync(TOKENS, JSON.stringify({
        step,
        teacher_token: stepRec.teacher_token,
        teacher_prefix: teacherOutput,
        student_tokens: stepRec.student_tokens || [],
        per_expert_guesses: stepRec.per_expert_guesses || [],
      }) + "\n");
    } catch { /* ledger best-effort */ }
    console.log(`  step ${step}: base=${baseScoreTotal} bonus=${bonusTotal} 500x=${fives} ${stepRec.is_500x_value_generation ? "  <<500x" : ""}`);

    // Small gap so the UI can render; not a sleep hack, just pacing.
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("teacher-live finished.");
  process.exit(0);
}

run().catch((e) => { console.error("teacher-live failed:", e); process.exit(1); });
