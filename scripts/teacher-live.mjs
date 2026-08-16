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
import { loadConfig, routeExperts, trainStep, scoreStep, saveModel, narrowTokenSet, addLayerNoise, maybeResetMoeState, accumulateExpertScores, updateLosingExperts, curveReward, compressionReward, bumpMoeStep, listSnapshots, loadSnapshot, diffRecentCheckpoint, clearCheckpointCache, chunkTokenIds, tokenToChunk } from "./moe-engine.mjs";

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
// TOP-K CURVE DATASET: one JSONL line per emitted teacher token, recording its
// FULL top-n (k) distribution (id + token + logprob). This is the reference
// "top-k curve" the student is trained to reproduce — the model should learn to
// output a top-k distribution matching the teacher's at each step.
const TOP_K_CURVE = path.join(LIVE, "topk-curve.jsonl");
const TOP_K_TO_SAVE = Number(process.env.TOP_K_TO_SAVE || 40); // how many top tokens per line

// Append one step's teacher top-k curve to the dataset file (best-effort; never
// crashes the step if the disk write fails).
function saveTopKCurve({ step, promptCtx, teacherToken, teacherId, top }) {
  try {
    const row = {
      step,
      ctx: String(promptCtx ?? "").slice(0, 400),           // short prompt context
      teacher_token: teacherToken,
      teacher_id: teacherId,
      top_k: (top || []).slice(0, TOP_K_TO_SAVE).map((t) => ({
        id: t.id, token: t.token, logprob: t.logprob,
      })),
      top_k_size: (top || []).length,
      ts: Date.now(),
    };
    fs.appendFileSync(TOP_K_CURVE, JSON.stringify(row) + "\n");
  } catch (e) { /* best-effort */ }
}
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
// The STUDENT model runs with a small context (-c 16384). It also has a SMALLER
// vocab than the teacher: the teacher = 27B MoE variant (n_vocab 248320),
// the running 4B dense student has its native vocab (default 151669). Teacher
// token ids > student-n_vocab make the student return HTTP 400 "invalid
// tokens" (the "setting a prompt deletes the input" bug). We keep the TEACHER
// in the full MoE token space but, for what we send to the STUDENT, clamp both
// the context length AND drop ids outside the student's valid vocab so it
// never 400s. (Proper fix later: run the 4B with the teacher's embedded vocab.)
const STUDENT_CTX = Number(process.env.STUDENT_CTX || 16384);
const STUDENT_CTX_MARGIN = Number(process.env.STUDENT_CTX_MARGIN || 512);
const studentCtxCap = () => Math.max(64, STUDENT_CTX - STUDENT_CTX_MARGIN - (STUDENT_STEP || 5));
// The STUDENT's own vocab size — a property of the RUNNING 4B dense student, NOT
// model.n_vocab. model.n_vocab reflects the teacher/30B target vocab (248320);
// the 4B student actually serves 151669 tokens, so teacher-only ids >151668
// would make it return HTTP 400 "invalid tokens". We cap the student-bound
// prompt at the student's real vocab (env STUDENT_N_VOCAB; default 151669).
const studentVocab = () => Number(process.env.STUDENT_N_VOCAB || 151669);
// Keep the last `cap` valid token ids (most recent context window) so the model
// still sees the tail of the prompt + accumulated output, dropping only ids the
// student's vocab can't represent.
function studentSafePrompt(ids) {
  const cap = studentCtxCap();
  const vMax = studentVocab() - 1;
  const safe = ids.filter((id) => Number.isFinite(id) && id >= 0 && id <= vMax);
  return safe.length > cap ? safe.slice(safe.length - cap) : safe;
}

// COMPRESSED TOKEN INPUT: when enabled (config model.compressed_token_input or
// env COMPRESSED_INPUT=1), the tokens fed to the model are the CHUNKED /
// compressed form (chunk_id = vocab_offset + floor(rawId/chunkSize)) instead of
// the raw ids. This is the "compressed token input" the harness can ingest —
// the model sees compact chunk tokens (fewer ids, each packing several raw
// tokens). `sharedIds` stays raw for scoring; only the model feed is chunked.
const compressedInputEnabled = () => {
  const c = process.env.COMPRESSED_INPUT || loadConfig()?.model?.compressed_token_input;
  return c === true || c === 1 || c === "1" || c === "true" || c === "on";
};
const chunkSize = () => Number(loadConfig()?.model?.chunk_size ?? (process.env.CHUNK_SIZE || 4));
const vocabOffset = () => Number(loadConfig()?.model?.chunk_token_offset ?? (process.env.CHUNK_OFFSET || 0));
function sharedToModelInput(ids) {
  if (!compressedInputEnabled()) return studentSafePrompt(ids);
  const chunked = chunkTokenIds(ids, chunkSize(), vocabOffset());
  // clamp context + drop ids outside the student vocab (in chunk space)
  const cap = studentCtxCap();
  return chunked.length > cap ? chunked.slice(chunked.length - cap) : chunked;
}
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

// ---- LOOP-AND-INCREMENT windowing (user spec) ----
// "each of the experts and mtp's must have identical top k's while training,
//  sooo loop on the same first n tokens not just continuous tokens, gradually
//  increment the tokens emitted until the text output and source layers are
//  identical ± offset and additional layers fight to become the new token
//  compressor layers. ensure the increase includes effectively identical top k
//  (bc compressed chunks == formulaic tokens). do 5 rounds of 8n then 5 of 9n
//  until 2000 out."
// We build the tier schedule once from config: 5 rounds at 8 tokens, 5 at 9, ...
// until max_tokens (2000). Within a tier we loop on the SAME first-N-window of
// teacher reference tokens (all experts + MTP share that window's teacher top-k).
function windowSchedule() {
  const w = loadConfig()?.windowing || {};
  if (!w.enabled) return null;
  const start = Math.max(1, Number(w.start_tokens ?? 8));
  const step = Math.max(1, Number(w.tokens_per_round_growth ?? 1));
  const roundsPerTier = Math.max(1, Number(w.rounds_per_tier ?? 5));
  const maxT = Math.max(start, Number(w.max_tokens ?? 2000));
  const tiers = [];
  let n = start;
  while (n <= maxT) {
    tiers.push({ tokens: n, rounds: roundsPerTier });
    n += step;
  }
  return {
    enabled: true,
    tiers,
    identityTolerance: Number(w.identity_tolerance ?? 0.95),
    loopSameWindow: w.loop_same_window !== false,
  };
}

// ---- COMPRESSOR-TOKEN CONSTRAINT (user spec: "EACH COMPRESSOR MUST USE ONLY
//      COMPRESSOR TOKENS") ----
// A "compressor" is an expert whose ROLE starts with "compr" OR is listed in
// moe.compressor_experts (config). Compressors may ONLY route/emit/score tokens
// from the compressor-token set (the compressed-chunk / formulaic tokens), never
// the general vocabulary. This is what makes the extra layers fight to become
// token-COMPRESSOR layers — they can only express compressed tokens.
function compressorExpertSet() {
  const m = loadConfig()?.moe || {};
  const set = new Set();
  for (const nm of m.compressor_experts || []) set.add(nm);
  const ex = m.experts || {};
  for (const nm of Object.keys(ex)) {
    const role = String(ex[nm]?.role || "").toLowerCase();
    if (role.startsWith("compr")) set.add(nm);
  }
  return set;
}
function isCompressorExpert(name) {
  return compressorExpertSet().has(name);
}
// Constrain a raw token top-k list to ONLY compressor tokens (for a compressor
// expert). Returns a Set of token strings that are BOTH in `top` AND compressor.
function compressorConstrained(top, compressor) {
  const out = new Set();
  for (const t of (top || [])) {
    if (compressor.has(String(t))) out.add(t);
  }
  return out;
}

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
  // `prompt` may be a STRING (plain text) or a NUMBER ARRAY (raw token ids —
  // direct token input). The direct-token fork's /v1/completions accepts both.
  const body = JSON.stringify({
    model: "x", prompt, max_tokens: n, temperature,
    top_p, top_k, logprobs: viewTopK(), echo: false, stream: false,
  });
  const res = await fetch(`${url}/v1/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    // Include the server's error body so the real cause (e.g. which token /
    // how long the context was) is visible instead of a bare "HTTP 400".
    let detail = "";
    try { detail = (await res.text()).slice(0, 400); } catch (e) { /* ignore */ }
    throw new Error(`${url} HTTP ${res.status} :: ${detail}`);
  }
  const d = await res.json();
  const content = d?.choices?.[0]?.logprobs?.content || [];
  return content.map((row) => ({
    chosen: { id: row.id, token: row.token, logprob: Number.isFinite(row.logprob) ? row.logprob : 0 },
    top: (row.top_logprobs || []).map((t) => ({
      id: t.id, token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0,
    })),
  }));
}

/** Tokenize a text string into raw token ids via the fork's /tokenize endpoint. */
async function tokenizeText(url, text) {
  const res = await fetch(`${url}/tokenize`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: String(text ?? "") }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`/tokenize HTTP ${res.status}`);
  const d = await res.json();
  return Array.isArray(d.tokens) ? d.tokens : [];
}

// Tokenize the shared prompt with the TEACHER's (MoE variant) tokenizer. The
// whole harness runs in the TEACHER's token space — the teacher is the MoE
// model that defines the vocab (tokenizer_n_vocab 248320 from the 27B GGUF),
// and the student is meant to operate in that same space. The 4B student
// rejects teacher-vocab ids (>151668) ONLY when it is launched with its own
// small vocab; the correct setup is to run the student with the teacher's
// tokenizer/vocab so the shared ids are valid for both (see launch notes).
function tokenizeShared(text) {
  return tokenizeText(TEACHER_URL, text);
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

/**
 * The compression footprint: a single token ID whose VALUE represents the sum
 * of the constituent token ids (the n1+n2+n3 convention). To be a MEANINGFUL
 * token the model can actually emit/match, we fold the (potentially huge) raw
 * sum into the model's valid vocab range via modulo n_vocab — otherwise a sum
 * like 500942 (> n_vocab 248320) is out-of-vocab, can never appear in top-k,
 * and the 500x detector can never fire. Returns {id, rawSum}.
 */
function compressFootprint(tokens) {
  const nv = Number(loadConfig()?.model?.n_vocab
    ?? loadConfig()?.model?.tokenizer_n_vocab ?? 248320);
  const rawSum = (tokens || []).reduce((a, t) => a + (Number(t) || 0), 0);
  const id = rawSum % Math.max(1, nv); // valid in-vocab token id
  return { id, rawSum };
}


/**
 * Detect a degenerate teacher run — 1-bit (Q1_0) models fall into character
 * repetition ("the the the", or huge runs of "*"/"-"/spaces). Returns a
 * degeneracy fraction 0..1 (how dominated the recent output is by a single
 * repeated token/character). >~0.6 means the teacher is stuck in a loop.
 */
function teacherDegeneracy(tokens, windowSize = 20) {
  const recent = (tokens || []).slice(-windowSize);
  if (!recent.length) return 0;
  const counts = {};
  let total = 0;
  for (const t of recent) {
    const s = String(t);
    // Normalize: strip whitespace so a run of "*"-boxes counts as a symbol.
    const key = s.replace(/\s+/g, "");
    if (!key) continue; // pure whitespace tokens are common, don't count them
    counts[key] = (counts[key] || 0) + 1;
    total++;
  }
  if (!total) return 0;
  let maxRun = 0;
  for (const k of Object.keys(counts)) maxRun = Math.max(maxRun, counts[k]);
  return Math.min(1, maxRun / total);
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

    // /checkpoint GET: list saved per-expert checkpoints (newest first) + the
    // in-RAM delta cache stats.
    if (url === "/checkpoint" && req.method === "GET") {
      try {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ checkpoints: listSnapshots(), ram_cache: diffRecentCheckpoint() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    // /checkpoint/load POST: { id } -> load a saved per-expert checkpoint to
    // resume training from it.
    if (url.startsWith("/checkpoint/load") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          const idOrFile = patch.id || patch.file;
          if (!idOrFile) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "missing id" })); return; }
          const r = loadSnapshot(idOrFile);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, loaded: r }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // /checkpoint/cache POST: { action: "clear" } clears the in-RAM cache.
    if (url === "/checkpoint/cache" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          if (patch.action === "clear") clearCheckpointCache();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ram_cache: diffRecentCheckpoint() }));
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
  let sharedIds = []; // RAW TOKEN IDS of the shared prompt (direct token input)
  // Initialize the token-id prompt once from the base text (via /tokenize).
  try { sharedIds = await tokenizeShared(PROMPT); } catch (e) { sharedIds = []; }
  const teacherOutput = []; // teacher's accumulated output tokens (1 per step)
  const newTokens = [];     // current list of NEW tokens created (compressed chunks + sentinel)
  let baseScoreTotal = 0;
  let bonusTotal = 0;
  let layerNoiseState = null; // per-token noise accumulator for layer states
  let fives = 0;
  let step = 0;
  let ended = false;
  let teacherDegenerateStreak = 0; // consecutive degenerate teacher batches

  // rolling window of the last few steps for the "compression ~ generation" plot
  const recent = [];
  const alwaysRun = _steps === 0;

  // ---- LOOP-AND-INCREMENT windowing state ----
  // When enabled, training loops on a FIXED reference window of the first N
  // teacher tokens (not continuous forward streaming). All experts + MTP share
  // that window's teacher top-k. After `rounds_per_tier` steps at tier N, N is
  // incremented (5 rounds at 8, 5 at 9, ...) until max_tokens (2000).
  const win = windowSchedule();
  let winTierIdx = 0;        // index into win.tiers
  let winStepInTier = 0;     // steps completed within the current tier
  let winRefIds = [];        // fixed reference window (teacher token ids)
  let winRefTopK = null;     // teacher top-k over the reference window (shared by all)
  let winSeq = 0;            // sequence number (for the payload)
  let bestWinOverlap = 0;    // best student↔window overlap seen within the current tier
  let lastConvergedStep = -1;// step at which the student last hit identity_tolerance
  const curWindowTier = () => win && win.tiers ? win.tiers[Math.min(winTierIdx, win.tiers.length - 1)] : null;

  while (!ended && (alwaysRun || step < _steps)) {
    // Live prompt change (from /prompt POST): reseed the shared prompt, clear
    // the teacher's accumulated output, and reset the step counter so the new
    // prompt starts a fresh generation run.
    if (promptChanged) {
      promptChanged = false;
      shared = PROMPT;
      try { sharedIds = await tokenizeShared(PROMPT); } catch (e) { sharedIds = []; }
      teacherOutput.length = 0;
      newTokens.length = 0;      // clear the created new-token list on a new prompt
      layerNoiseState = null;
      // NOTE: the MoE expert/layer state is INTENTIONALLY NOT reset here — we
      // are TRAINING the model and want expert values / layer sizes to persist
      // and keep accumulating across prompts and rounds.
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
    bumpMoeStep(); // advance the MoE round/step counter ONCE per harness step
    // AUTO-PAUSE at intervals: if training.pause_every_n_steps > 0, pause the
    // harness every N steps so the user can inspect between bursts. On each
    // pause we ALSO re-seed the prompt to the base PROMPT (default input) so a
    // resume starts a fresh run from the prompt, not the accumulated output.
    const pauseEvery = Number(loadConfig()?.training?.pause_every_n_steps ?? 0);
    if (pauseEvery > 0 && step >= pauseEvery && step % pauseEvery === 0) {
      shared = PROMPT;
      try { sharedIds = await tokenizeShared(PROMPT); } catch (e) { sharedIds = []; }
      teacherOutput.length = 0;
      paused = true;
      latest = { ...(latest || {}), paused: true, step, auto_paused: true };
      sendCurrent({ auto_paused: true });
      console.log(`  >> auto-pause at step ${step} (every ${pauseEvery}); prompt re-seeded to base`);
      await new Promise((r) => setTimeout(r, 200));
    }
    // ---- LOOP-AND-INCREMENT: advance the window tier when the current tier's
    //      rounds are done, then (re)build the fixed teacher reference window. ---
    let stepRec = { step, ts: Date.now() };
    if (win && win.enabled) {
      const tier = curWindowTier();
      if (tier && winStepInTier >= tier.rounds) {
        winTierIdx = Math.min(winTierIdx + 1, win.tiers.length - 1);
        winStepInTier = 0;
        winRefIds = [];
        winRefTopK = null;
        console.log(`  >> window tier -> ${curWindowTier().tokens} tokens (tier ${winTierIdx}+1/${win.tiers.length})`);
      }
      // Establish the fixed reference window this tier: ensure the base prompt
      // is seeded (loop on the same first N source tokens), and (only once per
      // tier) capture the teacher's first `tier.tokens` reference tokens + their
      // top-k as the shared target for ALL experts and the MTP head.
      if (sharedIds.length === 0) {
        try { sharedIds = await tokenizeShared(PROMPT); } catch (e) { sharedIds = []; }
        teacherOutput.length = 0;
      }
      if (!winRefTopK || winRefIds.length < (tier.tokens || 1)) {
        // Not built or stale -> (re)generate the reference window from the base.
        const baseLen = Math.max(1, (tier.tokens || 8));
        const need = baseLen - winRefIds.length;
        if (need > 0) {
          try {
            // Advance teacher from the CURRENT base prompt to fill `need` tokens.
            const tch = await profileRetry(TEACHER_URL, sharedIds, Math.min(need, TEACHER_BATCH), "teacher");
            const tpos0 = tch[0];
            if (tpos0 && tpos0.chosen.token !== undefined) {
              winRefTopK = tpos0.top || [];                    // shared across all experts + MTP
              const tids = tch.map((x) => x.chosen.id).filter((v) => Number.isFinite(v));
              // LOOP: extend the reference by feeding the teacher its own output
              // only within the window budget (fixed first-N, no unbounded growth).
              winRefIds.push(...tids.slice(0, need));
              saveTopKCurve({ step, promptCtx: PROMPT.slice(-400), teacherToken: tpos0.chosen.token, teacherId: tpos0.chosen.id, top: tpos0.top });
            }
          } catch (e) { /* keep partial window */ }
        }
        if (winRefIds.length === 0) winRefIds = [2413]; // guard
      }
      winSeq++;
      stepRec.window = { tier: curWindowTier().tokens, idx: winTierIdx + 1, of: win.tiers.length, step_in_tier: winStepInTier + 1, loops: winSeq, topk_size: (winRefTopK || []).length };
    }
    let _b = 0, _bP = 0, _bE = 0, _cP = 0, _cmp = 0;
    try {
      // Teacher (27B) advances the shared prompt. In windowing mode we LOOP on
      // the same fixed window (sharedIds already holds it); otherwise continuous.
      let teacher, tPos;
      let teacherAdvance = [], teacherAdvanceIds = [];
      if (win && win.enabled) {
        // Loop on the fixed reference window: use the window's stored top-k as
        // the teacher anchor (identical for every expert + the MTP head).
        teacher = [];
        const firstRef = winRefTopK && winRefTopK[0];
        tPos = { chosen: { token: firstRef?.token, id: firstRef?.id, logprob: 0 }, top: winRefTopK || [] };
      } else {
        teacher = await profileRetry(TEACHER_URL, sharedIds, TEACHER_BATCH, "teacher");
        tPos = teacher[0];
      }
      const teacherToken = tPos.chosen.token;
      if (tPos.chosen.token === undefined) { stepRec.note = "teacher empty"; ended = true; break; }
      // In windowing mode, do NOT keep appending the teacher's advancing output
      // to the shared prompt — that would break the "loop on the same first N".
      if (!(win && win.enabled)) {
        saveTopKCurve({ step, promptCtx: shared.slice(-400), teacherToken, teacherId: tPos.chosen.id, top: tPos.top });
        teacherAdvance = teacher.map((x) => x.chosen.token).filter((t) => t !== undefined);
        teacherAdvanceIds = teacher.map((x) => x.chosen.id).filter((v) => Number.isFinite(v));
        if (teacherAdvanceIds.length) sharedIds.push(...teacherAdvanceIds);
        shared += " " + teacherAdvance.join(" ");
        teacherOutput.push(...teacherAdvance);
      } else {
        // Keep scoring the SAME window top-k (already captured above).
        stepRec.window = { ...(stepRec.window || {}), teacher_token: teacherToken };
      }

      // ---- TEACHER DEGENERACY GUARD ----
      // 1-bit (Q1_0) teachers fall into repetitive symbol runs ("***", "---").
      // If the accumulated output becomes dominated by ONE repeated token, the
      // model is stuck in a feedback loop. Detect it and FLUSH the garbage tail
      // back to the clean base prompt, then raise sampling temperature to help
      // the model escape. We still keep training (the points are real), but we
      // stop feeding garbage back into the prompt.
      let teacherDegenerate = false;
      const accDeg = teacherDegeneracy(teacherOutput, 24);
      const batchDeg = teacherDegeneracy(teacherAdvance, TEACHER_BATCH);
      if (batchDeg > 0.75 || (accDeg > 0.8 && teacherOutput.length > 40)) {
        teacherDegenerate = true;
        teacherDegenerateStreak++;
        console.log(`  !! teacher degenerate (batch ${batchDeg.toFixed(2)}, acc ${accDeg.toFixed(2)}) streak ${teacherDegenerateStreak}`);
      } else {
        teacherDegenerateStreak = 0;
      }
      // If the teacher has been stuck in a loop for a few steps, drop the
      // accumulated garbage and restart from the clean base prompt so the model
      // isn't fed its own asterisk river.
      if (teacherDegenerateStreak >= 2 || accDeg > 0.9) {
        console.log(`  >> flushing degenerate teacher output back to base prompt (len ${shared.length})`);
        shared = PROMPT;
        try { sharedIds = await tokenizeShared(PROMPT); } catch (e) { sharedIds = []; }
        teacherOutput.length = 0;
        teacherDegenerateStreak = 0;
      }

      // Student (4B) emits STUDENT_STEP tokens from the SAME (teacher-appended)
      // prompt, limited by the student's live top-k/top-p (emit.student). The
      // prompt is CLAMPED to the student's context window so a long prompt /
      // grown teacher output doesn't overflow n_ctx and HTTP-400 (which looked
      // like "the input got deleted"). The teacher still sees the full prompt.
      const _stuPrompt = sharedToModelInput(sharedIds);
      if (step % 10 === 0) console.log(`    [dbg] student model input tokens: ${_stuPrompt.length} (raw ${sharedIds.length}, chunked ${compressedInputEnabled()}, cap ${studentCtxCap()})`);
      const student = await profileRetry(STUDENT_URL, _stuPrompt, STUDENT_STEP, "student");
      if (!student.length) { stepRec.note = "student empty"; ended = true; break; }

      // STUDENT DEGENERACY GUARD: a 1-bit/ternary model can collapse to ONE
      // repeated token (e.g. all "/") — its output distribution is a single
      // attractor. Detect it (all chosen + top tokens are the same) and flag it
      // so the collapse is visible instead of silently training on the same
      // token forever. (The teacher has an equivalent guard + flush; this logs
      // the student collapse without disrupting the loop.)
      {
        const stuChosen = student.map((s)=>({id:s.chosen?.id, t:s.chosen?.token}));
        const stuTopVals = student.map((s)=>((s.top||[]).length>0? s.top[0].token : null));
        const chosenSet = new Set(stuChosen.map((x)=>x.id));
        const topSet = new Set(stuTopVals);
        const collaped = chosenSet.size === 1 && topSet.size === 1;
        if (collaped) {
          stepRec.student_collapsed = true;
          stepRec.student_collapse_token = stuChosen[0]?.t;
          if (step % 5 === 0) console.log(`  !! student collapse: all ${stuChosen.length} outputs = «${stuChosen[0]?.t}» (1-bit ternary attractor) — training on a single repeated token`);
        }
      }

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
      const studentIds = student.map((s) => s.chosen.token);          // TEXT (display)
      const studentIdNums = student.map((s) => Number(s?.chosen?.id)).filter((v) => Number.isFinite(v)); // NUMERIC ids (compression math)
      const footprint = compressFootprint(studentIdNums.length ? studentIdNums : student.map((_, i) => i + 1));
      const fpId = footprint.id;                    // valid in-vocab compressed token id
      const fpRaw = footprint.rawSum;               // raw (huge) sum for display/debug
      const top100All = new Set(student.flatMap((s) => (s.top || []).map((x) => x.token)));
      const inTopK = student.some((s) => (s.top || []).some((x) => x.token === COMPRESS_AS_TOKEN || String(x.token) === String(fpId)));
      const inTop100 = top100All.has(COMPRESS_AS_TOKEN) || top100All.has(String(fpId)) || top100All.has(String(fpRaw));
      const is500x = inTopK && inTop100;
      if (is500x) fives++;
      // THE NEW-TOKEN SYSTEM (visible): each step, the student's 5 output
      // tokens are COMPRESSED into ONE new token whose value = their SUM OF
      // TOKEN IDS (footprint — a real number, not a text concatenation). We
      // record it as a created new token + a table describing how the
      // compression works, so the UI can show the system + current list.
      newTokens.push({
        step,
        input_ids: studentIdNums.length ? studentIdNums : student.map((s) => Number(s?.chosen?.id) || 0), // the 5 token ids being compressed
        input: studentIds,           // the 5 token TEXT being compressed (display)
        new_token: fpId,             // MEANINGFUL compressed token id (sum % n_vocab — valid in-vocab)
        new_token_text: `${fpId} (sum ${fpRaw} % n_vocab = in-vocab token)`,
        raw_sum: fpRaw,              // the raw (unfolded) sum, for debug
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
          compressedToken: fpId,
          newTokenSet,
          degenerate: stepRec.student_collapsed === true,
        });
      }
      if (cfgRew.compression?.enabled !== false) {
        const textLen = student.reduce((a, s) => a + String(s.chosen.token ?? "").length, 0);
        compressRw = compressionReward({
          emittedTokens: STUDENT_STEP,
          perTokenEmitted: (studentIdNums.length ? studentIdNums : studentIds).map(String),
          textLengthGenerated: textLen,
          newTokenSet,
          degenerate: stepRec.student_collapsed === true,
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
        // PER-EXPERT TEACHER-MATCH differential: each expert Ei owns student
        // output position i % STUDENT_STEP. Its own "match" = how many tokens
        // in that position's NARROWED top-k also appear in the teacher's top-k
        // set (same narrow logic the base score uses), PLUS a big boost if the
        // student's CHOSEN token at that position is in the teacher's ACTUAL
        // emitted set. This is what makes experts evolve apart: an expert whose
        // routed token matched the teacher climbs; one that missed drifts back.
        const expertMatch = route.rows.map((r, i) => {
          const pos = i % Math.max(1, student.length);
          const st = student[pos];
          // EACH COMPRESSOR MUST USE ONLY COMPRESSOR TOKENS: a compressor expert
          // may only score tokens that are compressor tokens (newTokenSet), never
          // the general vocabulary.
          const isCompr = isCompressorExpert(r.name) && (loadConfig()?.moe?.compressor_tokens_only ?? true);
          const comprSet = isCompr ? newTokenSet : null;
          const sSetK = narrowTokenSet(st?.top || [], emitFor("student").top_k, 1);
          let m = 0;
          // MTP HEAD (+1 forward): the MTP expert predicts the NEXT token, so it
          // is scored on how well the student's output tracks the teacher's top-k
          // one position ahead (its own forward-looking signal).
          if (r.name === "EMTP") {
            const ahead = student[(pos + 1) % Math.max(1, student.length)];
            const aheadSet = narrowTokenSet(ahead?.top || [], emitFor("student").top_k, 1);
            // MTP is a compressor: constrain to compressor tokens only.
            const aheadSetUse = isCompr ? compressorConstrained(aheadSet, comprSet) : aheadSet;
            for (const tok of aheadSetUse) if (tSetK.has(tok)) m++;
            if (isCompr ? comprSet.has(String(ahead?.chosen?.token)) && tSetK.has(ahead?.chosen?.token)
                        : ahead && tSetK.has(ahead.chosen.token)) m += 10; // next-token emit-match boost
            return m;
          }
          // Constrain to compressor tokens ONLY for compressor experts.
          const sSetUse = isCompr ? compressorConstrained(sSetK, comprSet) : sSetK;
          for (const tok of sSetUse) if (tSetK.has(tok)) m++;
          const chosenOk = isCompr ? (st && comprSet.has(String(st.chosen.token)) && tSetK.has(st.chosen.token))
                                   : (st && tSetK.has(st.chosen.token));
          if (chosenOk) m += 10; // strong emit-match boost (compressor: only when it's a compressor token)
          return m;
        });
        const training = trainStep(route, Math.exp(Math.min(0, tPos.chosen.logprob)), 0.5, expertMatch);
        sc = scoreStep({ baseMatches: base, step, is500x }); // config points/penalties
        bonusTotal = sc.bonus;
        // Round reset: if the expert state has reached steps_per_round *
        // rounds_before_reset, reset the accumulators (keeping lastRound for
        // display) BEFORE scoring the new round.
        maybeResetMoeState();
        // Attribute the step's points to EACH EXPERT INDEPENDENTLY, driven by
        // that expert's OWN teacher top-k match count (expertMatch[i]) — NOT a
        // re-share of one shared total. This is "each expert its own score":
        // an expert whose routed tokens matched more of the teacher's top-k
        // wins real points; an expert that matched nothing earns ~0, regardless
        // of what the other experts did. The base/emit/hit points are split by
        // each expert's individual match fraction; the curve/compression rewards
        // (whole-step events) are also weighted by that expert's own share so
        // they stay below the per-token base but still reflect its contribution.
        const vAll = route.rows.reduce((a, r) => a + (Number(r.value) || 0), 0) || 1;
        // EACH EXPERT'S OWN SCORE. Driven by the expert's PERSISTENT cumulative
        // teacher-match count (route.state.matchScore, per-expert and distinct)
        // combined with its current top-k match this step. This is genuinely
        // per-expert ("the more topk tokens that match the teacher the more you
        // should win") and does NOT collapse to one shared total.
        const msTot = route.rows.reduce((a, r) => a + (Number(route.state?.matchScore?.[r.name]) || 0), 0)
          || route.rows.length;
        const perExpertPoints = route.rows.map((r) => {
          const ms = Number(route.state?.matchScore?.[r.name]) || 0;
          const ownPts = (base + baseP + baseEm) * 0.6 * (ms / msTot) +
                         (curvePoints + compressionPoints) * (0.4 * (ms / msTot) + 0.6 * ((Number(r.value) || 0) / vAll));
          return { expert: r.name, score: Number(ownPts.toFixed(4)) };
        });
        // TEACHER is the BASELINE/ceiling: it earns the FULL step points every
        // step (it always matches its own top-k), so its cumulative line rises
        // and can act as the reference in the accumulated-points chart too.
        const teacherStepPts = Number((base + baseP + baseEm + curvePoints + compressionPoints).toFixed(4));
        perExpertPoints.push({ expert: "TEACHER", score: teacherStepPts });
        const expertScores = route.rows.map((r) => {
          const ms = Number(route.state?.matchScore?.[r.name]) || 0;
          const ownPts = (base + baseP + baseEm) * 0.6 * (ms / msTot) +
                         (curvePoints + compressionPoints) * (0.4 * (ms / msTot) + 0.6 * ((Number(r.value) || 0) / vAll));
          return {
            expert: r.name,
            active: r.active,
            role: r.role,
            mutation: r.mutation,
            weight: Number(r.topk_weight) || 0,
            match: ms,                 // this expert's own cumulative match count
            score: Number(ownPts.toFixed(4)),
          };
        });
        expertScores.push({
          expert: "TEACHER", active: true, role: "teacher", mutation: "reference (baseline)",
          weight: 1, match: 0, score: teacherStepPts,
        });
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
        const perExpertGuesses = route.rows.map((r, i) => {
          const rawTok = studentIds[(i % Math.max(1, studentIds.length))];
          // EACH COMPRESSOR MUST USE ONLY COMPRESSOR TOKENS: a compressor expert's
          // emitted/display token must come from the compressor-token set.
          let token = rawTok;
          if (isCompressorExpert(r.name) && (loadConfig()?.moe?.compressor_tokens_only ?? true)) {
            const firstCompr = [...newTokenSet].find((t) => String(t) === String(rawTok)) ?? [...newTokenSet][0];
            token = firstCompr ?? rawTok;
          }
          return { expert: r.name, active: r.active, value: Number(r.value).toFixed(4), token };
        });
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
          training_per_expert: (training.perExpert || []).map((e) => ({
            expert: e.expert, delta: Number(e.delta).toFixed ? Number(e.delta).toFixed(6) : e.delta,
            value: Number(e.value).toFixed ? Number(e.value).toFixed(4) : e.value,
            active: e.active,
          })),
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
            compressed: fpId,            // MEANINGFUL compressed token id (sum % n_vocab)
            compressed_raw_sum: fpRaw,   // raw (unfolded) sum for debug
            compressed_token: COMPRESS_AS_TOKEN,
          },
        };
        // Save the trained MoE state PER EXPERT (checkpoint diff from base)
        // every SAVE_EVERY steps (default 25) — tiny files, one per expert.
        if (step % (Number(process.env.SAVE_EVERY) || 25) === 0) {
          const saved = saveModel(step, route, training, route.state);
          moe.last_snapshot = typeof saved === "string" ? saved : (saved?.manifest || `saved ${saved?.count ?? 0} expert diffs`);
          moe.checkpoint_count = typeof saved === "object" ? saved.count : undefined;
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
        compressed_footprint: fpId,      // MEANINGFUL compressed token id (sum % n_vocab)
        compressed_footprint_raw: fpRaw, // raw (unfolded) sum for debug
        compressed_token: COMPRESS_AS_TOKEN,
        in_topk: inTopK,
        in_top100: inTop100,
        is_500x_value_generation: is500x,
        student_collapsed: stepRec.student_collapsed || false,
        student_collapse_token: stepRec.student_collapse_token,
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
          curve_degenerate: curveRw?.degenerate === true,
          comp_degenerate: compressRw?.degenerate === true,
          degenerate_penalty: compressRw?.degeneratePenalty ?? 0,
        },
        penalty: sc ? sc.penalty : 0,
        step_gain: sc ? sc.totalGain : 0,
        // Per-step points BEFORE the expert/layer gets updated this token.
        // This RESETS every single token (step) — it does NOT accumulate.
        step_points: base + baseP + baseEm + curvePoints + compressionPoints,
        base_score_total: baseScoreTotal,
        bonus_total: bonusTotal,
        total_score: base + baseP + baseEm + curvePoints + compressionPoints,
        teacher_degenerate: !!teacherDegenerate,
        teacher_degen_streak: teacherDegenerateStreak,
      };
    } catch (e) {
      stepRec.error = String((e && e.message) || e) || "unknown step error";
      console.error("  !! step error:", (e && e.message) || e, e);
      // The try-scoped accumulators may not be initialized — use safe fallbacks.
      const b = Number(typeof base !== "undefined" ? base : _b) || 0;
      const bP = Number(typeof baseP !== "undefined" ? baseP : _bP) || 0;
      const bE = Number(typeof baseEm !== "undefined" ? baseEm : _bE) || 0;
      const cPs = Number(typeof curvePoints !== "undefined" ? curvePoints : _cP) || 0;
      const cmp = Number(typeof compressionPoints !== "undefined" ? compressionPoints : _cmp) || 0;
      const sp = b + bP + bE + cPs + cmp;
      stepRec.total_score = sp;
      stepRec.step_points = sp;
    }

    recent.push(stepRec);
    if (recent.length > 60) recent.shift();

    // LOOP-AND-INCREMENT: mark this step done within the current window tier.
    // Advance the tier after `rounds_per_tier` steps OR when the student output
    // already matches the teacher window within identity_tolerance (so tiers can
    // graduate early once the student "compresses" the window to identical top-k).
    if (win && win.enabled) {
      winStepInTier++;
      const tier = curWindowTier();
      const tol = win.identityTolerance;
      const overlap = stepRec.score_breakdown?.curve_overlap ?? 0;
      // Track the best overlap seen THIS tier so the UI can show whether the
      // student is converging on the window (0.0 = still collapsed / no match).
      bestWinOverlap = Math.max(bestWinOverlap, overlap);
      const graduated = overlap >= tol;
      stepRec.window = {
        ...(stepRec.window || {}),
        overlap, graduated, best_overlap: bestWinOverlap, tol,
      };
      if (graduated) lastConvergedStep = step;
      if (tier && (winStepInTier >= tier.rounds || graduated)) {
        if (graduated) console.log(`  >> window tier ${tier.tokens}: student matched teacher top-k (${overlap.toFixed(3)} >= ${tol}) — graduating early`);
        winStepInTier = tier.rounds; // force the advance next step
        bestWinOverlap = 0;          // reset best-overlap for the next tier
      }
    }

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
      pause_every_n_steps: Number(loadConfig()?.training?.pause_every_n_steps ?? 0),
      windowing: win && win.enabled ? { enabled: true, tier: winTierIdx + 1, tokens: curWindowTier()?.tokens ?? 0, of: win.tiers.length, step_in_tier: winStepInTier + 1, loops: winSeq, max_tokens: loadConfig()?.windowing?.max_tokens ?? 2000, overlap: stepRec.window?.overlap ?? 0, best_overlap: bestWinOverlap, tol: win.identityTolerance, graduated: !!(stepRec.window?.graduated), last_converged_step: lastConvergedStep } : undefined,
      // PER-EXPERT scored/training detail (surfaced so the UI shows EVERY expert
      // getting a value/delta, not just the active top-k). Pulls from the moe
      // object built during the step.
      per_expert: (stepRec.moe?.expert_topk || []).map((e) => ({
        expert: e.expert, value: e.value, active: e.active, role: e.role,
        mutation: e.mutation, topk_weight: e.topk_weight,
      })),
      per_expert_deltas: (stepRec.moe?.training_per_expert || []).map((e) => ({
        expert: e.expert, delta: e.delta, value: e.value, active: e.active,
      })),
      expert_values: stepRec.moe?.state?.expertValues || {},
      training_delta: stepRec.moe?.training_delta ?? 0,
      cumulative_scores: stepRec.moe?.cumulative_scores || [],
      moe_detail: stepRec.moe ? {
        expert_scores: stepRec.moe.expert_scores || [],
        active: stepRec.moe.active || [],
        per_layer: stepRec.moe.per_layer || [],
        layers_used: stepRec.moe.layers_used,
      } : undefined,
      // NEW-TOKEN SYSTEM: how new tokens are created + the current created list.
      new_token_system: {
        how: "Each step, the student's STUDENT_STEP output tokens are COMPRESSED into ONE new token whose VALUE = the sum of their token ids, folded into the valid vocab range (sum % n_vocab) so it is a MEANINGFUL, in-vocab token the model can actually emit. A fixed sentinel (COMPRESS_AS_TOKEN) marks the compression; when that new token appears in the model's top-k of the space AND a match is in the top-100 of the emitted tokens, it counts as a 500x value generation.",
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
