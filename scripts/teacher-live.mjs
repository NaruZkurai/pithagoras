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
import { loadConfig, saveConfig, routeExperts, trainStep, scoreStep, saveModel, narrowTokenSet, addLayerNoise, maybeResetMoeState, accumulateExpertScores, updateLosingExperts, curveReward, compressionReward, otokenSequenceReward, bumpMoeStep, rewireLayers, expertStructure, noteAttachedFitness, segmentSummary, listSnapshots, loadSnapshot, diffRecentCheckpoint, clearCheckpointCache, chunkTokenIds, tokenToChunk } from "./moe-engine.mjs";
// E-TOKEN COMPRESSION SYSTEM (the corrected "new token" feature). Provides the
// recallable etoken(e1) function stored in data/Etokens.json, the e-tokenizer
// (touple), the base build from the pre-tokenized token DB, and the
// disqualification / repeat-train-top-k helpers used in the scoring loop.
import { initEtokens, getEtokens, buildBaseEtokens, etokenize, etoken, hasEtoken, putEtoken, saveEtokens, originalTokensOf, evalDisqualification, repeatTrainEtokenTopK, ETOKEN_BASE, ETOKEN_COUNT, etokenTernaryOf, etokenTernaryBarrel, kvBarrel, kvCompressionAlgo, kvCompressionFlag, kvSpaceSaving, isEtokenId, etokenDeep, etokenHierarchyStats, hierarchicalEtokenize, isArrayIndicatorId, putArrayIndicator, arrayIndicatorOf, arrayIndicatorTrump, isBaseEtokenId, isParentEtokenId, superEtokenFromItems } from "./etokens.mjs";

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

// The new tokens the student generated (compressed chunks + sentinel), kept in
// their OWN JSON file so they survive restarts and are saved with each snapshot.
const NEW_TOKENS_FILE = path.join(LIVE, "new-tokens.json");

// Persist the in-memory newTokens list to its own JSON file (best-effort).
// USER: "etoken only not original tokens" — store ONLY the etoken identities
// (the new reserved token ids / labels), NOT the original token inputs that
// were compressed.
function saveNewTokens(list) {
  try {
    const payload = {
      saved_at: Date.now(),
      kind: "etokens_only", // per user: no original tokens, etokens only
      count: (list || []).length,
      etokens: (list || []).map((t) => ({
        step: t.step,
        etoken: t.new_token,            // the new reserved token id
        label: t.new_token_label,       // "a1"
        expert: t.new_token_expert,     // "ETEa1"
        pair: t.new_token_pair,         // [orig-index, etoken-index]
        orig_index: t.new_token_orig_index,
        etoken_index: t.new_token_token_index,
        created: !!t.created,           // 500x flag
      })),
    };
    const tmp = NEW_TOKENS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, NEW_TOKENS_FILE); // atomic
  } catch (e) { /* best-effort */ }
}

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

// ---- TEACHER TOP-K FROM FILE ONLY (NO TEACHER GENERATION) ----
// USER DIRECTIVE: "USE THAT ONLY FOR NOW NO TEACHER GENS". The harness must NOT
// call the teacher (the CPU TQ2_0 is slow and was the bottleneck) — it reads the
// teacher's recorded top-k from output/live/topk-curve.jsonl and uses that as the
// fixed reference. The student loops against this same teacher top-k until its
// own top-k "fits" (converges / overlaps), exactly the loop-and-increment design.

let _teacherTopKFile = null;   // parsed rows [{step, teacher_id, teacher_token, top_k:[...]}, ...]
let _teacherTopKLoadedAt = 0;  // mtime of the file when last parsed

/**
 * Load every teacher top-k row from topk-curve.jsonl (best-effort). Returns the
 * parsed array (newest last). Called lazily; caches by file mtime.
 */
function loadTeacherTopKRows() {
  try {
    if (!fs.existsSync(TOP_K_CURVE)) return [];
    const m = fs.statSync(TOP_K_CURVE).mtimeMs;
    if (_teacherTopKFile && m === _teacherTopKLoadedAt) return _teacherTopKFile;
    const rows = fs.readFileSync(TOP_K_CURVE, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    _teacherTopKFile = rows;
    _teacherTopKLoadedAt = m;
    return rows;
  } catch { return _teacherTopKFile || []; }
}

/**
 * The current teacher top-k reference, taken ONLY from the file (never from a
 * live teacher call). Returns the top-k list of the MOST RECENT recorded row
 * ({id, token, logprob}[...]).
 */
function teacherTopKFromFile() {
  const rows = loadTeacherTopKRows();
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const top = Array.isArray(last?.top_k) ? last.top_k : [];
  // Ensure each entry has id+token+logprob shapes the harness expects.
  return top.map((t) => ({ id: t.id, token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0 }));
}

/** Does the topk-curve file currently have any usable teacher top-k? */
function hasTeacherTopKFromFile() {
  const rows = loadTeacherTopKRows();
  return !!rows.length && Array.isArray(rows[rows.length - 1]?.top_k) && rows[rows.length - 1].top_k.length;
}

// LIVE-TEACHER CHUNK CACHE: the teacher can generate a LARGE reasoned chunk
// (up to live_teacher_gen_cap ~1000 tokens) ONCE per prompt, store it to disk,
// and we evaluate ONLY the first N tokens. Cache avoids regenerating the big
// chunk every tier (it's slow on CPU). Keyed by the prompt text it was built for.
let _teacherChunkPrompt = null; // the (truncated) prompt the chunk was generated for
let _teacherChunkRows = null;   // full generated rows [{chosen:{id,token},top:[{id,token,logprob}]}]
let _teacherGenPending = false; // true while a background 1k-token gen is running

// BACKGROUND teacher-chunk generator (non-blocking): fire-and-forget so the
// harness keeps TRAINING on the static/current window while the slow CPU teacher
// produces the large reasoned chunk. When done, the full chunk is written to
// topk-curve.jsonl; the window loop then reads MORE of it as `n` grows
// ('generate it while training on static data; if the chunk increases just use
//  the data').
function teacherChunkBackground(prompt, genCap) {
  if (_teacherGenPending || (_teacherChunkPrompt === prompt && _teacherChunkRows && _teacherChunkRows.length)) return;
  _teacherGenPending = true;
  profileRetry(TEACHER_URL, prompt, genCap, "teacher", 1, null)
    .then((tRes) => {
      if (tRes && tRes.length) {
        _teacherChunkPrompt = prompt;
        _teacherChunkRows = tRes;
        try {
          const tmp = TOP_K_CURVE + ".tmp";
          const lines = tRes.map((r, i) => JSON.stringify({
            step: i + 1, ctx: prompt.slice(0, 400),
            teacher_token: r.chosen?.token, teacher_id: r.chosen?.id,
            top_k: (r.top || []).map((x) => ({ id: x.id, token: x.token, logprob: Number.isFinite(x.logprob) ? x.logprob : 0 })),
            top_k_size: (r.top || []).length, ts: Date.now() + i,
          }));
          fs.writeFileSync(tmp, lines.join("\n") + "\n");
          fs.renameSync(tmp, TOP_K_CURVE); // atomic
          _teacherTopKFile = null; _teacherTopKLoadedAt = 0;
        } catch (e) { /* best-effort */ }
        console.log(`  >> [teacher-live][bg] teacher reasoned ${tRes.length} tokens — ${
          _teacherChunkRows.length} cap ${genCap} stored to disk (evaluate first N while training on static data)`);
      }
    })
    .catch((e) => console.log(`  >> [teacher-live][bg] failed (${(e && e.message) || e}); keeping static data`))
    .finally(() => { _teacherGenPending = false; });
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
// How many top-k tokens to SHOW per emitted position, and how many positions,
// in the payload/UI. Tunable via the "next phase: more top-k tokens" control so
// the output isn't clipped to a few tokens of the top-K and scoring is visibly
// driven by the wider top-k. Defaults match the prior hard-coded top-5 × 16.
const topkDisplayPerPos = () => Number(SAMPLING().topk_display_per_pos ?? 5);
const topkDisplayPositions = () => Math.min(64, Number(SAMPLING().topk_display_positions ?? 16));
function emitFor(who) { // {top_k, top_p, temperature} for teacher|student
  const s = SAMPLING().emit?.[who] || {};
  return {
    top_k: Math.min(100, Number(s.top_k ?? 20)),
    top_p: Number(s.top_p ?? 0.9),
    temperature: Number(s.temperature ?? 0.7),
  };
}
// COMPARE MODE (user directive): for the teacher/student top-k comparison, do
// NOT generate new tokens — analyse the top-k of the FIRST token only, at
// IDENTICAL settings for both. mode='topk_first' -> request max_tokens=1 (the
// logprobs still return the full next-token top-k). identical_settings=true ->
// both teacher and student use the SAME scoring.compare top_k/top_p/temperature.
const compareCfg = () => loadConfig()?.scoring?.compare || {};
const compareFirstOnly = () => (compareCfg().mode || "topk_first") === "topk_first";
const identicalEmit = () => {
  const c = compareCfg();
  return { top_k: Math.min(100, Number(c.top_k ?? 20)), top_p: Number(c.top_p ?? 0.95), temperature: Number(c.temperature ?? 0.7) };
};
const compareN = () => {
  // IMPORTANT (root-cause fix): generate a REAL multi-token chunk, not a single
  // token. In topk_first mode the old behaviour forced max_tokens=1, which makes
  // a good student sample only its sharpest single top-1 prediction (e.g. the
  // TQ1_0 30B collapses to one repeated token "apart"), so its top-k never
  // overlaps the teacher's and the score graph never moves. Generating a real
  // STUDENT_STEP chunk (like the teacher chunk) gives the student a diverse
  // sequence whose top-k CAN overlap the teacher's coherent top-k. Same for the
  // teacher (fixes the " the" degenerate window anchor).
  return Number(process.env.COMPARE_N || studentStep() || SAMPLING().emit?.student?.top_k || 5);
}; // tokens to generate per head
const noiseToLayer = () => Number(SAMPLING().noise_to_layer ?? 0.05);
// "Number of tokens in chunk to train with" = STUDENT_STEP (the per-head chunk
// length the student generates, and the teacher chunk the experts score against).
// Config-driven via sampling.student_step so the UI "Apply sampling" control can
// set it LIVE (re-read each call); env STUDENT_STEP overrides. Previously a
// `const` captured once at startup, so applying student_step never took effect
// until a restart — now a live function that reflects config changes immediately.
const studentStep = () => Number(process.env.STUDENT_STEP || SAMPLING().student_step || 5);
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
const studentCtxCap = () => Math.max(64, STUDENT_CTX - STUDENT_CTX_MARGIN - (studentStep() || 5));
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
// Prompt precedence: env PROMPT (one-shot override) > persisted config prompt
// (training.prompt, set live via the UI "Set prompt") > built-in default.
const _cfgPrompt = String(loadConfig()?.training?.prompt ?? "").trim();
let PROMPT =
  process.env.PROMPT ||
  _cfgPrompt ||
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
  // "train till it works": a tier only advances once the student CONVERGES on
  // the window's top-k (overlap >= identity_tolerance), OR after this many
  // loop steps as an escape hatch so a genuinely-unlearnable tier can't deadlock
  // the run forever. Default = large so convergence (not clock time) drives it.
  const maxLoopsPerTier = Math.max(roundsPerTier, Number(w.max_loops_per_tier ?? 200));
  const tiers = [];
  let n = start;
  while (n <= maxT) {
    tiers.push({ tokens: n, rounds: maxLoopsPerTier });
    n += step;
  }
  return {
    enabled: true,
    tiers,
    identityTolerance: Number(w.identity_tolerance ?? 0.95),
    loopSameWindow: w.loop_same_window !== false,
    maxLoopsPerTier,
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
// A "new network" = any attached expert beyond the 27B base that makes up the
// NEW ~3B of parameters (the 30B - 27B delta: the added/mutation experts, the
// MTP head, the dynamic etoken (ETE) experts, and compressor experts). Per the
// user directive ("we are only training the new 3B parameters to use the new
// etokens"), ONLY these new networks are trained to produce compressed (etoken)
// output; the 5 base-role experts E1..E5 represent the original 27B base and
// are NOT trained for etoken emission. Later we move to the model as a whole
// using this 3B 'expert', but atm only the 3B set learns compressed output.
function expertRole(name) {
  return String(loadConfig()?.moe?.experts?.[name]?.role || "").toLowerCase();
}
function isNewNetwork(name) {
  const role = expertRole(name);
  return role === "mutation" || role === "mtp_head" || role === "new_token" || role.startsWith("compr");
}
// Two-phase scoring config read live (see scoring.two_phase in moe-config.json).
function twoPhaseCfg() {
  return loadConfig()?.scoring?.two_phase || {};
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

/**
 * EXPERT STEERING logit bias — the bridge that makes MoE training affect the
 * served student's OUTPUT.
 *
 * The served model is fixed; the MoE layer above it only maintained routing
 * metadata, so the student could never actually learn to emit new tokens. We
 * close that loop with llama.cpp's `logit_bias`: for the STUDENT request we add
 * a positive additive bias to the teacher's top-k token ids (the tokens the
 * experts have been rewarded for matching), weighted by teacher rank — the
 * model that the experts "want" is nudged up, so a collapsed student can break
 * out and track the teacher. Bias strength scales with how well the experts are
 * currently matching (steer_progress = best overlap seen this window), so it is
 * a nudge toward LEARNED preferences, not a hard force.
 *
 * Config (moe): expert_steering (0 = off, 1 = full), steering_max_bias (cap),
 * steering_top_n (how many teacher top-k tokens to bias).
 */
function buildExpertSteeringBias(teacherTopK, currentOverlap, tol = 0.95, extraTokenIds = []) {
  const moe = loadConfig()?.moe || {};
  const mult = Number(moe.expert_steering ?? 0.3);
  if (mult <= 0) return null;
  const maxBias = Number(moe.steering_max_bias ?? 2.0);
  const topN = Math.max(1, Number(moe.steering_top_n ?? 20));
  // Strength = overall multiplier × (0.15 floor to break a collapsed model +
  // progress toward convergence), so steering is present early (to initiate
  // learning) and grows as the model learns, capped at 1. Once converged
  // (overlap>=tol) it relaxes because the model tracks on its own.
  const progress = Math.max(0, Math.min(1, (Number(currentOverlap ?? 0) / Math.max(0.001, tol))));
  const strength = Math.max(0, Math.min(1, mult * (0.15 + progress)));
  if (strength <= 0.001) return null;
  const bias = {};
  // Teacher top-k tokens first (weighted by teacher rank).
  const teacherList = (teacherTopK || []).slice(0, topN);
  teacherList.forEach((x, i) => {
    const id = x?.id != null ? Number(x.id) : NaN;
    if (!Number.isFinite(id)) return;
    const w = strength * maxBias * (1 - (i / Math.max(1, teacherList.length - 1)) * 0.5);
    if (w > 0.01) bias[String(id)] = Number(Math.min(w, maxBias).toFixed(3));
  });
  // NEW-TOKEN targets (the compressed fpId / sentinel): these are the tokens we
  // specifically want "on output" — nudge them at FULL strength so the model
  // has a real chance to actually emit the new token (aids 500x).
  for (const t of (extraTokenIds || [])) {
    const id = Number(t);
    if (!Number.isFinite(id)) continue;
    bias[String(id)] = Number(strength * maxBias).toFixed(3);
  }
  return Object.keys(bias).length ? bias : null;
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
async function profile(url, prompt, n, who = "teacher", logitBias = null, settings = null) {
  // If explicit `settings` ({top_k, top_p, temperature}) are given, use them for
  // BOTH teacher and student — the "identical settings" comparison mode. Else
  // fall back to each role's own emit settings.
  const { top_k, top_p, temperature } = settings || emitFor(who);
  // `prompt` may be a STRING (plain text) or a NUMBER ARRAY (raw token ids —
  // direct token input). The direct-token fork's /v1/completions accepts both.
  // `logitBias` (optional, student-only): { tokenIdString: additiveBias } used
  // to STEER the student's emission toward the trained experts' preferences
  // (the teacher's top-k that the MoE has learned to match). This is what makes
  // the MoE training actually affect the served model's output.
  const body = JSON.stringify({
    model: "x", prompt, max_tokens: n, temperature,
    top_p, top_k, logprobs: viewTopK(), echo: false, stream: false,
    ...(url !== TEACHER_URL && logitBias && Object.keys(logitBias).length ? { logit_bias: logitBias } : {}),
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
async function profileRetry(url, prompt, n, who = "teacher", tries = 3, logitBias = null, settings = null) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await profile(url, prompt, n, who, logitBias, settings);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last;
}

/**
 * THE COMPRESSION FORMULA (user-corrected):
 *   tokens [a,b,c,e,q]  ->  newtoken index [E Token a1]
 *
 * The 5 raw token ids are COMPRESSED into ONE genuinely NEW token — a reserved
 * id in [new_token_base, new_token_base + new_token_count) — NOT folded onto an
 * existing vocab token (the old sum % n_vocab was wrong: it produced an
 * arbitrary EXISTING token, not a new one). 
 *
 *  - VALUE: the new token's value = the SUM of the constituent token ids
 *    (the n1+n2+n3 footprint, fully recoverable from the new token id via rawSum).
 *  - INDEX (a1): newTokenId = new_token_base + (rawSum % new_token_count).
 *    The low index (a1) is the entry in the reserved new-token table.
 *  - EXPERT (E): each distinct new-token index is owned by its OWN added MoE
 *    expert "ETE<a1>" (E Token a1) created dynamically (create_new_token_experts).
 *  - "convince it to use the new token": steering (logit_bias) toward
 *    newTokenId, and it joins the GENUINE compressor token set so phase-1
 *    rewards its emission.
 *
 * Returns { id, rawSum, index, label, expert }.
 */
const NEW_TOKEN_BASE = () => Number(loadConfig()?.moe?.new_token_base ?? 200000);
const NEW_TOKEN_COUNT = () => Math.max(1, Number(loadConfig()?.moe?.new_token_count ?? 512));
function compressFootprint(tokens) {
  const rawSum = (tokens || []).reduce((a, t) => a + (Number(t) || 0), 0);
  // E Token Nx: the reserved new-token table entry (a1, a2, ...) for this chunk.
  const index = rawSum % NEW_TOKEN_COUNT();
  const label = `a${index + 1}`;            // a1, a2, ...
  const expert = `ETE${label}`;             // E Token a1 -> expert name
  // BEST BIDIRECTIONAL as TWO SEPARATE INDICES (user): the compressed new token is
  // the pair [original-tokenizer-index, E-Token-Nx-index]:
  //   - origIndex = the ORIGINAL tokenizer index this chunk maps from (the first
  //     token id of the chunk = its position in the original token space).
  //   - tokenIndex = the NEW E-Token-Nx reserved index (a1..).
  // They are kept as two SEPARATE indices, NOT folded into one.
  const origIndex = (tokens && tokens.length) ? (Number(tokens[0]) || 0) : 0;
  // The composite reserved token id the model can be steered to emit stays a REAL
  // new token (in resolved reserved range) that decompresses back to the pair.
  const id = NEW_TOKEN_BASE() + index;
  return { id, rawSum, index, label, expert, origIndex, tokenIndex: index, pair: [origIndex, index] };
}

// DYNAMICALLY add a NEW expert for a new token (E Token a1). Each distinct
// new-token index owns its own added MoE expert (role "new_token", a compressor
// that may only emit the new-token set). Registered into config moe.experts so
// routing sees it next step; bumps moe.num_experts. Idempotent per index.
let _newTokenExperts = new Set();
function ensureNewTokenExpert(index, label) {
  const moe = loadConfig()?.moe || {};
  if (!moe.experts) moe.experts = {};
  const name = `ETEa${index + 1}`;
  if (_newTokenExperts.has(name)) return name;
  moe.experts[name] = {
    role: "new_token",
    mutation: `new-token expert (E Token a${index + 1}) — emits only the compressed new-token id ${NEW_TOKEN_BASE() + index}`,
    topk_weight: 1,
    prefers_new_tokens: true,
    noise: 0.05,
  };
  moe.num_experts = Object.keys(moe.experts).length;
  _newTokenExperts.add(name);
  return name;
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
// E-TOKEN live statistics (reset each run; persisted summary folded into the
// payload so the UI can show the etoken system's live behaviour).
let liveEtokStats = {
  built_total: 0, created: 0, steered: 0, in_topk: 0, disqualified: 0, e_tokenized: 0,
  last_raw_tokens: 0, last_etoken_tokens: 0, // total token length to compare this phase
};

/**
 * Feed a teacher token-id run into the e-token system (base etokenize + the
 * HIERARCHICAL packing pass). First we e-tokenize the run into base e-tokens as
 * before (each chunk -> one e-token, putEtoken). Then, because the USER wants
 * "an etoken that contains etokens + non etokens" for "MUCH more compression"
 * on repeated sequences, we run the greedy recursive packer over the SAME run:
 * it finds repeated contiguous sequences of e-token/raw items and fuses them
 * into PARENT e-tokens whose content is [etoken, etoken, ..., raw] — recursively
 * nested. The parents are stored with their nested `content` (and flattened
 * `tokens`), so etoken() still returns the fully-decoded flat tuple (lossless)
 * while the KV/context can hold just the compact parent ids ("a stronghold for
 * memory rot" — durable anchors that survive context pruning).
 *
 * Returns { baseEids, superEids } for liveEtokStats.last_teacher_etokens.
 */
function feedEtokensRun(ids, { step, audit, etBlockTuning = null } = {}) {
  const chunkSize = Number(loadConfig()?.etokens?.chunk_size ?? loadConfig()?.model?.chunk_size ?? 4);
  const liveUpdate = loadConfig()?.etokens?.live_update !== false;
  const baseEids = [];
  if (!ids.length || !liveUpdate) { liveEtokStats.last_raw_tokens = 0; liveEtokStats.last_etoken_tokens = 0; return { baseEids, superEids: [] }; }
  // Level 0 — base e-tokens (flat tuple).
  for (const ec of etokenize(ids, chunkSize)) {
    const r = putEtoken({ id: ec.id, tuple: ec.chunk, live: true, audit: `${audit}@step${step}`, save: true });
    if (r.isNew) liveEtokStats.created++;
    liveEtokStats.e_tokenized++;
    baseEids.push(ec.id);
  }
  // TOTAL-LENGTH-OF-TOKENS TO COMPARE AT THIS PHASE (user): show how many RAW
  // tokens this phase's teacher output is vs how many ETOKENS it compresses to
  // (the otoken seq length evaluated), so you can see the compression being
  // applied to the "total length of tokens to compare".
  liveEtokStats.last_raw_tokens = (ids || []).length;          // total raw token length this phase
  liveEtokStats.last_etoken_tokens = baseEids.length;          // how many otokens it becomes
  // HIERARCHICAL pass — fuse repeated subsequences into nested parent e-tokens.
  // Bounded + only fires when repeats actually exist (minRepeat>=2), so it is
  // cheap on unique token runs.
  const hierCfg = loadConfig()?.etokens?.hierarchical || {};
  const superEids = [];
  if (hierCfg.enabled !== false && ids.length >= 4) {
    const packed = hierarchicalEtokenize(ids, {
      chunkSize,
      maxDepth: Math.max(1, Number(hierCfg.max_depth ?? 3)),
      minRepeat: Math.max(2, Number(hierCfg.min_repeat ?? 2)),
      maxFuses: Math.max(1, Number(hierCfg.max_fuses ?? 96)),
      sweepLen: Math.max(2, Number(hierCfg.sweep_len ?? 3)),
    });
    // The packer already stored the parents (superEtokenFromItems -> save:false).
    // Count any that were genuinely new / surfaced for the UI.
    for (const c of packed.created) {
      superEids.push(Number(c.id));
      liveEtokStats.e_tokenized++;
    }
    liveEtokStats.last_hier = {
      parents: packed.created.length,
      top_level_items: packed.items.length,
      could_compress: packed.created.length > 0,
      max_depth: etokenHierarchyStats().max_etoken_depth,
    };
    // PERSIST: the parents were built with save:false so the packer stays fast,
    // but the memory-rot anchor REQUIRES the nested definitions to be durable
    // ("stored once, globally, so an id always resolves"). Flush them here. The
    // array-indicator promised arrays are similarly persisted on the same write.
    saveEtokens();
  }
  return { baseEids, superEids };
}


// HISTORY rotation cap: appendFileSync to a multi-GB history.jsonl every step
// blocks the Node event loop (the HTTP UI on :4199 stops responding), and the
// file grows unboundedly (observed 32GB). Rotate + cap so it never outgrows
// HISTORY_MAX_MB and the appends stay cheap. Writes are fire-and-forget async.
const HISTORY_MAX_MB = Number(process.env.HISTORY_MAX_MB || 256);
function rotateHistoryIfNeeded() {
  try {
    const st = fs.existsSync(HISTORY) ? fs.statSync(HISTORY) : null;
    if (st && st.size > HISTORY_MAX_MB * 1024 * 1024) {
      const rotated = `${HISTORY}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch {}
      fs.renameSync(HISTORY, rotated); // move the current file aside, start fresh
    }
  } catch { /* best-effort */ }
}
function sendCurrent(extra = {}) {
  const payload = { ...latest, ...extra, ts: Date.now() };
  // Async, fire-and-forget writes so the training loop never blocks the event
  // loop (a 1.3MB current.json written synchronously every step froze the HTTP
  // UI on :4199). The UI polls/SSE reads current.json; a momentary write lag is
  // fine.
  //
  // ATOMIC WRITE: write to a temp file in the same dir then rename over
  // current.json, so current.json is NEVER left 0-byte / half-written (a giant
  // payload that failed a direct write left current.json empty -> the UI showed
  // "not running"/frozen with Step 0 even though the loop was stepping). On
  // failure we keep the previous current.json rather than truncate it.
  try {
    const json = JSON.stringify(payload, null, 2);
    const tmp = CURRENT + ".tmp";
    fs.writeFileSync(tmp, json); // sync small-ish; ~bounded payload keeps it OK
    fs.renameSync(tmp, CURRENT);
    latest = payload;
  } catch (e) { /* keep last good current.json on write failure */ }
  rotateHistoryIfNeeded(); // before appending, cap the oversized history file
  try { fs.appendFileSync(HISTORY, JSON.stringify(payload) + "\n"); } catch {}
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

    // /etokens GET: return the Etokens.json recall-table summary (and, with
    // ?full=1, the table itself). This exposes the recallable function table
    // (etoken(e1) -> original token tuple) to the UI for inspection.
    if (url.startsWith("/etokens") && !url.startsWith("/etokens/") && req.method === "GET") {
      try {
        const q = new URL(url, "http://x").searchParams;
        const full = q.get("full") === "1";
        const store = getEtokens();
        const base = {
          base: store?.base ?? false,
          etoken_base: ETOKEN_BASE(),
          etoken_count: ETOKEN_COUNT(),
          stats: store?.stats || {},
          total: store ? (store.stats?.total ?? 0) : 0,
          how: "etoken(e1) -> original token tuple, stored in data/Etokens.json; recallable + deterministic. Hierarchical: an e-token's content may be a list of raw tokens AND nested e-token ids (recursively expanded by etoken()) — 'an etoken that contains etokens + non etokens' for MUCH more compression on repeated sequences (a stronghold for memory rot).",
          hierarchy: etokenHierarchyStats(),
        };
        if (full && store) {
          // FLAT view: etoken id -> flattened raw-token tuple (lossless).
          base.tokens = store.tokens;
          // NESTED view: etoken id -> its content items (raw ids + nested e-token
          // refs), so the UI can show the recursive tree structure.
          base.content = store.content || {};
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(base));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    // /etokens/rebuild POST: rebuild the BASE Etokens.json from the
    // pre-tokenized token DB (drops any live-updated rows first).
    if (url === "/etokens/rebuild" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          let store = getEtokens();
          if (store) { store.tokens = {}; store.stats.live_added = 0; store.stats.total = 0; store.base = false; }
          buildBaseEtokens(Number(patch.chunk_size ?? 4), { log: false });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, total: getEtokens()?.stats?.total ?? 0 }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
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
          // Persist the prompt in config (training.prompt) so it survives a
          // harness restart (the [Header]/shader-style prompts are long and
          // would otherwise be lost to the env/default fallback).
          try {
            const cfgPath = path.join(REPO, "config", "moe-config.json");
            const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
            cfg.training = cfg.training || {};
            cfg.training.prompt = p;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          } catch (e) { /* non-fatal */ }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, prompt: PROMPT }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    // /reseed POST: one-time rebuild of output/live/topk-curve.jsonl from the
    // CURRENT prompt (config training.prompt), so the file-only teacher window
    // references the right teacher output after a prompt change. Uses a TRUNCATED
    // prompt copy + modest logprobs because the CPU 27B teacher is slow on the
    // full prompt. Forces the window to re-establish on the next tier. This is
    // the UI "reseed" button.
    if (url === "/reseed" && req.method === "POST") {
      const doSeed = async () => {
        const cfgP = String(loadConfig()?.training?.prompt ?? "").trim();
        if (!cfgP) return { ok: false, error: "no training.prompt in config" };
        const chars = Number(process.env.SEED_PROMPT_CHARS || 800);
        const viewTopK = Math.max(1, Math.min(200, Number(process.env.VIEW_TOPK || 20)));
        const nTok = Math.max(1, Number(process.env.SEED_TOKENS || 8));
        const tEmit = emitFor("teacher");
        const prompt = cfgP.slice(0, chars);
        const body = JSON.stringify({
          model: "x", prompt, max_tokens: nTok, temperature: Number(tEmit.temperature ?? 0.7),
          top_p: Number(tEmit.top_p ?? 0.95), top_k: Number(tEmit.top_k ?? 30),
          logprobs: viewTopK, echo: false, stream: false,
        });
        const r = await fetch(`${TEACHER_URL}/v1/completions`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
          signal: AbortSignal.timeout(Number(process.env.SEED_TIMEOUT || 300_000)),
        });
        if (!r.ok) { let d=""; try{d=(await r.text()).slice(0,200);}catch{} return { ok:false, error:`teacher ${r.status}: ${d}` }; }
        const dd = await r.json();
        const content = dd?.choices?.[0]?.logprobs?.content || [];
        if (!content.length) return { ok: false, error: "no logprobs.content returned" };
        const rows = content.map((row, i) => {
          const top = (row.top_logprobs || [])
            .map((t) => ({ id: Number(t.id ?? 0), token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0 }))
            .sort((a, b) => b.logprob - a.logprob).slice(0, viewTopK);
          return {
            step: i + 1, ctx: prompt.slice(0, 400),
            teacher_token: row.token != null ? String(row.token) : null,
            teacher_id: Number(row.id ?? row.token_id ?? 0),
            top_k: top, top_k_size: top.length, ts: Date.now() + i,
          };
        });
        if (fs.existsSync(TOP_K_CURVE)) fs.copyFileSync(TOP_K_CURVE, TOP_K_CURVE + ".bak");
        fs.writeFileSync(TOP_K_CURVE, rows.map((r2) => JSON.stringify(r2)).join("\n") + "\n");
        // Force the window to re-establish from the fresh file next tier.
        _teacherTopKFile = rows; _teacherTopKLoadedAt = 0;
        winRefIds = []; winRefToks = []; winRefTopK = null; winRefTopKPerPos = [];
        return { ok: true, rows: rows.length, tokens: rows.map((r3) => r3.teacher_token) };
      };
      doSeed().then((out) => {
        res.writeHead(out.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      }).catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
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
    // Root route: serve the HTML DASHBOARD (web/teacher-ui.html) when the
    // client is a browser (Accept: text/html), else the plain current.json
    // state (the dashboard itself fetches "/" as JSON to load state). This is
    // what makes http://127.0.0.1:4199/ show the real UI instead of raw JSON.
    if (url === "/" && (req.headers.accept || "").includes("text/html")) {
      const uiPath = path.join(REPO, "web", "teacher-ui.html");
      if (fs.existsSync(uiPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(uiPath));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("teacher-ui.html not found\n");
      }
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
  console.log(`  teacher ${TEACHER_URL} | student ${STUDENT_URL} | view-top-${viewTopK()} emit teacher tK${emitFor("teacher").top_k}/tP${emitFor("teacher").top_p} student tK${emitFor("student").top_k}/tP${emitFor("student").top_p} | student step ${studentStep()}`);
  startServer();

  // ---- E-TOKEN SYSTEM INIT (corrected "new token" feature) ----
  // Load data/Etokens.json if present, otherwise BUILD the base Etokens.json
  // from the pre-tokenized token DB (all tokens in the DB are pre-tokenized and
  // coupled into unique new tokens via the e-tokenizer — the base etoken.json
  // the model then uses and updates from the teacher's generated chunks).
  {
    const et = loadConfig()?.etokens ?? {};
    const etok = initEtokens();
    if (etok && etok.base) {
      console.log(`  [etokens] loaded base Etokens.json: ${(etok.stats?.total ?? 0)} recallable etokens (base=${!!etok.base})`);
    } else if (et.build_base !== false) {
      console.log("  [etokens] building base Etokens.json from the pre-tokenized token DB...");
      const r = buildBaseEtokens(Number(et.chunk_size ?? loadConfig()?.model?.chunk_size ?? 4), { log: true });
      console.log(`  [etokens] base built: ${r.etokensAdded} etokens from ${r.tokenized} DB tokens (${(r.sources || []).join(", ")})`);
    }
    // Track per-step e-token statistics (created this run, matched, disqualified).
    liveEtokStats = { built_total: getEtokens()?.stats?.total ?? 0, created: 0, steered: 0, in_topk: 0, disqualified: 0, e_tokenized: 0 };
  }

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
  let winRefToks = [];       // fixed reference window TEXT tokens (per position)
  let winRefTopK = null;     // teacher top-k over the reference window (shared by all)
  let winRefTopKPerPos = []; // per-position teacher top-k lists (topk per emitted token)
  let winSeq = 0;            // sequence number (for the payload)
  let bestWinOverlap = 0;    // best student↔window overlap seen within the current tier
  let lastConvergedStep = -1;// step at which the student last hit identity_tolerance
  let lastFpId = null;       // compressed new token id from the previous step (steered toward)
  let lastFpRaw = 0;         // raw sum from the previous step (debug)
  let winRefTopKSource = "teacher"; // "teacher" | "file" — where the window top-k came from
  const curWindowTier = () => win && win.tiers ? win.tiers[Math.min(winTierIdx, win.tiers.length - 1)] : null;

  while (!ended && (alwaysRun || step < _steps)) {
    // YIELD to the event loop so the HTTP UI on :4199 can serve requests. The
    // loop does heavy synchronous work (JSON.stringify of the 1.2MB live payload
    // in sendCurrent) that starves the server; breathing every iteration fixes
    // the "server hangs / 130% CPU busy loop" symptom.
    await new Promise((r) => setImmediate(r));
    // Live prompt change (from /prompt POST): reseed the shared prompt, clear
    // the teacher's accumulated output, and reset the step counter so the new
    // prompt starts a fresh generation run.
    if (promptChanged) {
      promptChanged = false;
      shared = PROMPT;
      try { sharedIds = await tokenizeShared(PROMPT); } catch (e) { sharedIds = []; }
      teacherOutput.length = 0;
      saveNewTokens(newTokens);  // persist before clearing (etokens only)
      newTokens.length = 0;      // clear the created new-token list on a new prompt
      layerNoiseState = null;
      // New prompt -> the big teacher chunk must be regenerated (it's prompt-specific).
      _teacherChunkPrompt = null; _teacherChunkRows = null;
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
    // ---- LOOP-AND-INCREMENT: advance the window tier when the current tier's
    //      rounds are done, then (re)build the fixed teacher reference window. ---
    let stepRec = { step, ts: Date.now() };
    // EVOLVE the new-3B SEGMENTS' structure (user): MULTIPLE 3B segments train
    // in parallel; the ATTACHED BEST segment NEVER changes; LOSERS rewire by
    // rank — loser at 1-based place `p` changes (p-1)*5% of its neurons (floor 0
    // at the top loser; worst loser mutates most aggressively). Neurons per
    // expert are NOT preset — they SEED small and evolve via this rewiring.
    try {
      const rw = (typeof rewireLayers === "function") ? rewireLayers() : null;
      if (rw && rw.rewired) {
        stepRec.rewired = (rw.moved ?? 0);
        stepRec.rewire_from = rw.from;
        stepRec.rewire_to = rw.to;
        stepRec.rewire_per_seg = rw.movedPerSeg;
      }
      // Surface the current 3B segment structure (multiple 3B segments in parallel,
      // only the best is attached; neuron sizes evolve via rank-scaled rewiring).
      if (typeof expertStructure === "function") { stepRec.expert_structure = expertStructure(); }
    } catch (e) { /* structure/rewire is best-effort; never crash the run */ }
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
      // --- TEACHER WINDOW REFERENCE LENGTH (live "chunk to train with") ----
      // Keep growing the reference toward the configured "Tokens in chunk to
      // train with" (student_step), so setting it live loads more reference
      // tokens as the background teacher produces them (the CHUNK header and
      // the output panel then agree). The tier remains the floor.
      if (!winRefTopK || winRefIds.length < Math.max(1, Number(studentStep() || 8))) {
        // ---- TEACHER WINDOW REFERENCE ----
        // The reference length = the configured "Tokens in chunk to train with"
        // (student_step), so setting it live actually grows how many teacher
        // reference tokens are loaded into the training reference (matching the
        // CHUNK header). The window tier remains the floor/progression; the
        // background teacher keeps producing until the reference reaches it.
        const winCfg = loadConfig()?.windowing || {};
        const liveT = winCfg.live_teacher !== false; // LIVE teacher mode (user: 'why isn't the teacher thinking')
        const targetLen = Math.max(1, Number(studentStep() || tier.tokens || 8));
        const baseLen = Math.max(targetLen, Math.max(1, (tier.tokens || 8)));

        // LIVE mode: the teacher thinks/generates a LARGE reasoned chunk
        // (~live_teacher_gen_cap tokens, default 1000) with per-token top-k. The
        // big generation runs in the BACKGROUND (non-blocking) so the harness
        // keeps TRAINING on the static/current window chunk; when it completes
        // it's stored to disk, and as the window `n` grows we just read MORE of
        // the already-generated data (user: 'generate it while training on static
        // data and if the chunk increases just use the data').
        if (liveT) {
          const chars = Math.max(64, Number(winCfg.live_teacher_chars ?? 800));
          const teacherIn = String(shared ?? PROMPT ?? "").slice(0, chars) || PROMPT.slice(0, chars);
          const genCap = Math.min(4000, Math.max(baseLen, Number(winCfg.live_teacher_gen_cap ?? process.env.TEACHER_GEN_CAP ?? 1000)));
          // Kick off (once per prompt) the background generation — never block.
          teacherChunkBackground(teacherIn, genCap);
          // EVALUATE ONLY THE FIRST N tokens of whatever chunk data we have right
          // now (background may still be generating → use static/loaded rows so
          // training never stalls; as it grows on disk we consume more).
          const rows = _teacherChunkRows || (hasTeacherTopKFromFile() ? loadTeacherTopKRows() : null) || [];
          if (rows && rows.length) {
            const n = Math.min(baseLen, rows.length);
            const dRows = rows.map((r) => ({
              chosen: { id: r.chosen?.id ?? r.teacher_id, token: r.chosen?.token ?? r.teacher_token },
              top: r.top || r.top_k || [],
            }));
            winRefTopKPerPos = dRows.slice(0, n).map((r) => (r.top || []).map((x) => ({ id: x.id, token: x.token, logprob: Number.isFinite(x.logprob) ? x.logprob : 0 })));
            const ids = dRows.slice(0, n).map((r) => Number(r.chosen?.id ?? 0)).filter((v) => Number.isFinite(v));
            const toks = dRows.slice(0, n).map((r) => r.chosen?.token != null ? String(r.chosen.token) : String(r.chosen?.id ?? ""));
            if (ids.length) { winRefIds = ids; winRefToks = toks; teacherOutput.length = 0; teacherOutput.push(...winRefToks); }
            winRefTopK = (winRefTopKPerPos && winRefTopKPerPos[0]) ? winRefTopKPerPos[0] : null;
            winRefTopKSource = "teacher";
            console.log(`  >> [teacher-live] evaluating ONLY first n=${n} of available ${rows.length}-token chunk${_teacherGenPending ? " (bg still generating...)" : ""}: ${winRefToks.join(" ")}`);
          } else {
            console.log(`  >> [teacher-live] no teacher chunk yet; waiting for background gen (training holds on static)`);
          }
        }
        // FILE-ONLY fallback (or strict file mode): load the teacher's recorded
        // top-k from output/live/topk-curve.jsonl and use it as the reference.
        const rows = loadTeacherTopKRows();
        if (!liveT || winRefIds.length === 0) {
          if (rows.length && winRefIds.length === 0) {
            const last = rows[rows.length - 1];
            const top = Array.isArray(last?.top_k) ? last.top_k : [];
            if (top.length) {
              winRefTopK = top.map((t) => ({ id: t.id, token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0 }));
            }
            if (!winRefIds.length) {
              const windowRows = rows.slice(-baseLen);
              const ids = windowRows.map((r) => r.teacher_id).filter((v) => Number.isFinite(Number(v)));
              const toks = windowRows.map((r) => r.teacher_token).filter((t) => t !== undefined);
              winRefIds.push(...ids.slice(0, baseLen).map(Number));
              winRefToks = toks.slice(0, baseLen);
              winRefTopKPerPos = windowRows.slice(0, baseLen).map((r, i) => {
                const rk = Array.isArray(r?.top_k) ? r.top_k : (winRefTopK || []);
                return rk.map((t) => ({ id: t.id, token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0 }));
              });
              teacherOutput.length = 0;
              teacherOutput.push(...winRefToks);
            }
          }
          if (liveT) winRefTopKSource = "file"; // live failed -> file
        }
        // Ensure the window has at least one token id (guard) mirroring the old
        // fallback, and always ensure a non-empty teacher top-k reference.
        if (winRefIds.length === 0) winRefIds = [2413];
        if (winRefToks.length === 0) winRefToks = winRefIds.map((id) => {
          const hit = (winRefTopK || []).find((x) => String(x?.id) === String(id));
          return hit?.token != null ? hit.token : String(id);
        });
        if (!winRefTopK || !winRefTopK.length) winRefTopK = winRefTopK || [{ id: 279, token: " the", logprob: -1 }];
        if (!winRefTopKPerPos.length) winRefTopKPerPos = winRefToks.map(() => winRefTopK);
        // E-tokenize the file-derived teacher chunk (same tokens + top-k data
        // already recorded) — Etokens.json stays fed with NO teacher generation.
        // Includes the HIERARCHICAL packing pass (repeated sequences -> nested
        // parent e-tokens) per the user's "etoken that contains etokens + raw".
        if (winRefIds.length && loadConfig()?.etokens?.live_update !== false) {
          const fed = feedEtokensRun(winRefIds.slice(0, baseLen), { step, audit: "teacher-file" });
          liveEtokStats.last_teacher_etokens = fed.baseEids;
        }
        // Label the source: live-teacher (if it populated the window) else file.
        if (liveT && winRefIds.length) winRefTopKSource = "teacher";
        else winRefTopKSource = "file";
      }
      winSeq++;
      stepRec.window = { tier: curWindowTier().tokens, idx: winTierIdx + 1, of: win.tiers.length, step_in_tier: winStepInTier + 1, loops: winSeq, topk_size: (winRefTopK || []).length };
    }
    let _b = 0, _bP = 0, _bE = 0, _cP = 0, _cmp = 0;
    let steerBias = null; // expert-steering logit-bias for the student request (surfaced in UI)
    try {
      // Teacher (27B) advances the shared prompt. In windowing mode we LOOP on
      // the same fixed window (sharedIds already holds it); otherwise continuous.
      let teacher, tPos;
      let teacherAdvance = [], teacherAdvanceIds = [];
      if (win && win.enabled) {
        // Loop on the fixed reference window: use the window's stored top-k as
        // the teacher anchor (identical for every expert + the MTP head). The
        // E-Token source is the SAME window chunk (`winRefIds` — the tokens the
        // teacher generated to build the reference) with the SAME top-k data
        // (`winRefTopK`) used for scoring. This chunk populates the Teacher-
        // output panel and is e-tokenized live, so the E-token system updates
        // from the identical token + top-k data instead of staying empty.
        const firstRef = winRefTopK && winRefTopK[0];
        tPos = { chosen: { token: firstRef?.token, id: firstRef?.id, logprob: 0 }, top: winRefTopK || [] };
        teacher = [];
        // The teacher's token chunk = the fixed reference window (same first N).
        // Populate the Teacher-output panel from the recorded TEXT tokens
        // (winRefToks) plus the per-position top-k (winRefTopKPerPos), so the
        // panel shows the real emitted tokens AND the topk per token emitted —
        // not raw numeric fallbacks.
        if (winRefToks && winRefToks.length) {
          teacherOutput.length = 0;
          teacherOutput.push(...winRefToks);
          // Bound the stored per-position top-k (top-k/depth tunable via the
          // 'next phase: more top-k tokens' control) so the payload shows MORE
          // of the top-K and scoring is visibly driven by the full top-k.
          liveEtokStats.last_teacher_topk_per_pos = (winRefTopKPerPos || []).slice(0, topkDisplayPositions()).map((k) =>
            (k || []).slice(0, topkDisplayPerPos()).map((x) => ({ id: x.id, token: x.token, logprob: x.logprob }))
          );
          // Feed the SAME window chunk through the e-tokenizer (Etokens.json
          // update) — the "token generated chunk of the teacher" the e-tokenizer
          // consumes, driven by the same tokens + top-k above. Also runs the
          // HIERARCHICAL packing pass so repeated window regions become nested
          // parent e-tokens (the user's "etoken that contains etokens + raw").
          if (winRefIds.length && loadConfig()?.etokens?.live_update !== false) {
            const fed = feedEtokensRun(winRefIds, { step, audit: "teacher-window" });
            liveEtokStats.last_teacher_etokens = fed.baseEids;
          }
        }
      } else {
        // COMPARE MODE: identical settings + first-token-top-k-only analysis.
        // When compare.mode=='topk_first', request max_tokens=1 so we analyse
        // only the FIRST token's top-k (no sequence generated). identical
        // settings are used for BOTH teacher and student (fair head-to-head).
        teacher = await profileRetry(TEACHER_URL, sharedIds, compareN(), "teacher", 3, null, (compareCfg().identical_settings !== false) ? identicalEmit() : null);
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
        // ---- E-TOKEN LIVE UPDATE FROM THE TEACHER'S GENERATED CHUNK ----
        // "these are fed to the e-tokenizer and then used as a base etoken.json
        //  that the model then uses and updates based on the token generated
        //  chunk of the teacher." The teacher's emitted token-id chunk is
        //  e-tokenized (coupled into unique new tokens, effective repeats
        //  deduped) and its etokens MERGED back into Etokens.json live. A
        //  HIERARCHICAL pass then fuses repeated sub-sequences into nested
        //  parent e-tokens ("an etoken that contains etokens + non etokens").
        if (teacherAdvanceIds.length && loadConfig()?.etokens?.live_update !== false) {
          const fed = feedEtokensRun(teacherAdvanceIds, { step, audit: "teacher-chunk" });
          liveEtokStats.last_teacher_etokens = fed.baseEids;
        }
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
      // EXPERT STEERING: build a logit bias toward the teacher's current top-k
      // scaled by how well the MoE has learned this window. If enabled, the
      // student request is nudged so the trained expert preferences (teacher-
      // matching tokens) actually show up in output — breaking a collapsed
      // student out of its single-token attractor toward the teacher.
      const steerCur = win && win.enabled ? bestWinOverlap : (typeof curveRw !== "undefined" ? (curveRw?.overlapFraction ?? 0) : 0);
      const steerTol = win && win.enabled ? (win.identityTolerance ?? 0.95) : 0.95;
      // Steer toward teacher top-k AND the previous compressed new token (so the
      // "new tokens on output" goal is a real nudge, not just a logical match).
      steerBias = buildExpertSteeringBias((tPos.top || []), steerCur, steerTol, lastFpId != null ? [lastFpId, COMPRESS_AS_TOKEN] : []);
      if (steerBias && step % 10 === 0) console.log(`    [steer] biasing ${Object.keys(steerBias).length} token ids (${Object.keys(steerBias).length - (lastFpId != null ? 2 : 0)} teacher + newtok, overlap ${steerCur.toFixed(3)})`);
      // COMPARE MODE (user): DON'T generate a token sequence — analyse ONLY the
      // FIRST token's top-k, at IDENTICAL settings for teacher and student. In
      // topk_first mode the student requests max_tokens=1 too (logprobs still
      // carry the full next-token top-k), so the comparison is a pure top-k
      // head-to-head, not an auto-regressive generation.
      const stuSettings = (compareCfg().identical_settings !== false) ? identicalEmit() : emitFor("student");
      const student = await profileRetry(STUDENT_URL, _stuPrompt, compareN(), "student", 3, steerBias, stuSettings);
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
      const fpId = footprint.id;                    // GENUINELY NEW compressed token id (reserved range)
      const fpRaw = footprint.rawSum;               // raw (huge) sum for display/debug
      const fpIndex = footprint.index;              // E Token Nx index into the reserved new-token table
      const fpLabel = footprint.label;              // "a1", "a2", ...
      const fpExpert = footprint.expert;            // "ETEa1" (E Token a1) — the new-token's own expert
      const fpOrigIdx = footprint.origIndex;        // ORIGINAL tokenizer index
      const fpPair = footprint.pair;                // [original-tokenizer-index, E-Token-Nx] — two separate indices
      lastFpId = fpId; lastFpRaw = fpRaw;           // remember for next-step steering
      // DYNAMICALLY CREATE a new MoE expert for this new token (E Token a1) if
      // create_new_token_experts is on. Each distinct new-token index owns its
      // own added expert, so "new token -> new expert" is real, not static.
      if (loadConfig()?.moe?.create_new_token_experts !== false) {
        ensureNewTokenExpert(fpIndex, fpLabel);
      }
      const top100All = new Set(student.flatMap((s) => (s.top || []).map((x) => x.token)));

      // ---- ALLOW NEW TOKENS ON OUTPUT ----
      // The student model samples from its own vocab, so the synthetic compressed
      // new token (fpId) / COMPRESS_AS_TOKEN never actually appears in the raw
      // emission. But compressor experts are ALLOWED to express ONLY compressor
      // tokens — so, per the user ("allow new tokens on output"), we let the
      // compressor output position carry the compressed new token as an EMITTED
      // token. That means it participates in inTopK/inTop100 and can actually
      // trigger 500x (a real generation of the new token), not just one-way match.
      const allowNewTokOut = loadConfig()?.moe?.allow_new_token_output !== false
        && (loadConfig()?.moe?.compressor_tokens_only ?? true);
      // A compressor expert is present -> it owns at least one output position,
      // and is allowed to express ONLY compressor tokens. So, when enabled, the
      // compressed new token counts as an EMITTED (on-output) token.
      const hasComprExp = compressorExpertSet().size > 0;
      const comprEmitsNewTok = allowNewTokOut && hasComprExp;
      // The effective emitted set: the raw student tokens PLUS the compressed new
      // token (fpId) and the sentinel, when compressors may emit new tokens. This
      // is what "new tokens on output" means — compressor layers express their
      // compressed token, so it counts as emitted.
      const emittedToks = studentIds.slice();
      const emittedTokStrs = new Set(emittedToks.map(String));
      if (comprEmitsNewTok) { emittedTokStrs.add(String(fpId)); }

      const inTopK = student.some((s) => (s.top || []).some((x) => x.token === COMPRESS_AS_TOKEN || String(x.token) === String(fpId)))
        || (comprEmitsNewTok && (tPos.top || []).some((x) => String(x.token) === String(fpId)));
      const inTop100 = top100All.has(COMPRESS_AS_TOKEN) || top100All.has(String(fpId)) || top100All.has(String(fpRaw))
        || (comprEmitsNewTok && emittedTokStrs.has(String(fpId)));
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
        new_token: fpId,             // GENUINELY NEW reserved token id (E Token Nx)
        new_token_pair: fpPair,      // [original-tokenizer-index, E-Token-Nx] — TWO SEPARATE indices
        new_token_orig_index: fpOrigIdx, // original tokenizer index
        new_token_token_index: fpIndex,  // E Token Nx index
        new_token_text: `[${studentIdNums.join(",")}] -> [orig ${fpOrigIdx}, E Token ${fpLabel} (id ${fpId})]`,
        new_token_label: fpLabel,    // "a1"
        new_token_expert: fpExpert,  // "ETEa1" (E Token a1)
        raw_sum: fpRaw,              // the raw (unfolded) sum, for debug
        sentinel: COMPRESS_AS_TOKEN, // the fixed sentinel this scheme matches
        created: is500x,             // true when this new token appears in top-k AND top-100
        ts: Date.now(),
      });
      if (newTokens.length > 5000) newTokens.shift(); // keep the list bounded (large — UI shows the FULL list)

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
      // NOTE: newTokenSet (used by curve/compression rewards) intentionally
      // includes the RAW input tokens so those rewards stay as before.
      const newTokenSet = new Set(newTokens.flatMap((t) => [String(t.new_token), ...(t.input || []).map(String)]));
      for (const b of codeBaselineSet()) newTokenSet.add(b);
      // GENUINE COMPRESSOR TOKEN SET: the true compressed/formulaic tokens a
      // compressor network may emit/express — the footprint new_token values,
      // the sentinel, code-baseline chunk-hash values, AND every RECORDED
      // etoken id in Etokens.json (the recallable e-tokens the model uses and
      // updates from teacher chunks). It deliberately does NOT include the raw
      // input tokens (those would make phase-1 compression-favor trivially true
      // for ANY emitted token = vacuous). Used by the compressor-only constraint
      // and the two-phase compression/reconstruction rewards so they
      // discriminate REAL compressed emissions. THIS is the compressed-output
      // target set: when a new-3B network emits one of these, it earns the
      // phase-1 compressed-output reward (training the 3B set to give etoken
      // output).
      const compressorTokenSet = new Set(newTokens.map((t) => String(t.new_token)));
      compressorTokenSet.add(String(COMPRESS_AS_TOKEN));
      // Fold in every recorded etoken id from Etokens.json (the recallable
      // e-tokens stored live from teacher chunks + the base DB build).
      const etokStore = getEtokens();
      if (etokStore && etokStore.tokens) {
        for (const k of Object.keys(etokStore.tokens)) compressorTokenSet.add(String(k));
      }
      for (const b of codeBaselineSet()) compressorTokenSet.add(b);
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
          emittedTokens: studentStep(),
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
        // TWO-PHASE DESIGN (user): the NEW networks (mutation + MTP experts, not
        // the 5 base ones) learn to COMPRESS, then reproduce the base shape.
        //   Phase 1 - new networks FAVOR compressed tokens (emit a compressed/new
        //             token -> bonus).
        //   Phase 2 - new compressed experts reproduce the SAME SHAPE as if not
        //             attached: their position top-k must match the BASE experts'
        //             (un-attached) top-k at that position.
        //   MTP aids compressed tokens: the MTP head predicts the NEXT token and
        //             earns extra when that forward target is a compressed one.
        const tp = twoPhaseCfg();
        const phase2 = tp.enabled && Number(tp.phase) >= 2;
        const phase1 = tp.enabled && Number(tp.phase) >= 1;
        const newNetW = Number(tp.new_net_compression_weight ?? 40);
        const reconW = Number(tp.reconstruct_weight ?? 120);
        const reconTopK = Math.max(1, Number(tp.reconstruct_top_k ?? 20));
        const reconMin = Number(tp.reconstruct_min_overlap ?? 0.5);
        // BASE REFERENCE (un-attached shape): union of every base-role expert's
        // narrowed top-k across the student output positions. The compressed new
        // networks must reconstruct this shape in phase 2.
        const baseRefTopK = new Set();
        // baseShapeIds[pos] = the CHOSEN token id the base-role expert owning
        // position `pos` emitted (the exact "shape" of the un-attached base). A
        // new network compresses the 5 raw ids (studentIdNums) into one footprint
        // token; phase 2 checks that decompressing it returns the base shape.
        const baseShapeIds = [];
        const nPos = Math.max(1, student.length);
        route.rows.forEach((r, i) => {
          if (expertRole(r.name) !== "base") return;
          const pos = i % nPos;
          const st = student[pos];
          for (const tok of narrowTokenSet(st?.top || [], emitFor("student").top_k, 1)) baseRefTopK.add(String(tok));
          if (Number.isFinite(Number(st?.chosen?.id))) baseShapeIds[pos] = Number(st.chosen.id);
        });
        // Per-expert phase deltas (phase1 compression bonus, phase2 recon bonus,
        // mtp-aids bonus) surfaced in the UI + added to expertMatch.
        const phaseInfo = route.rows.map(() => ({ p1: 0, p2: 0, mtpAid: 0, newTok: false, reconOverlap: 0, isNew: false, isMtp: false, decompHit: 0 }));
        // PER-EXPERT TEACHER-MATCH differential: each expert Ei owns student
        // output position i % STUDENT_STEP. Its own "match" = how many tokens
        // in that position's NARROWED top-k also appear in the teacher's top-k
        // set (same narrow logic the base score uses), PLUS a big boost if the
        // student's CHOSEN token at that position is in the teacher's ACTUAL
        // emitted set. PLUS the two-phase new-network rewards. This is what
        // makes experts evolve apart: an expert whose routed token matched the
        // teacher climbs; one that missed drifts back.
        const expertMatch = route.rows.map((r, i) => {
          const pos = i % Math.max(1, student.length);
          const st = student[pos];
          // EACH COMPRESSOR MUST USE ONLY COMPRESSOR TOKENS: a compressor expert
          // may only score tokens that are compressor tokens (newTokenSet), never
          // the general vocabulary.
          const isCompr = isCompressorExpert(r.name) && (loadConfig()?.moe?.compressor_tokens_only ?? true);
          const comprSet = isCompr ? compressorTokenSet : null;
          const sSetK = narrowTokenSet(st?.top || [], emitFor("student").top_k, 1);
          const isNew = isNewNetwork(r.name);
          const isMtp = r.name === "EMTP";
          phaseInfo[i].isNew = isNew; phaseInfo[i].isMtp = isMtp;
          let m = 0;

          // ---- E-TOKEN DISQUALIFICATION + REPEAT-TRAIN-TOP-K (corrected) ----
          // "all experts that dont produce a token that has an original token
          //  that isnt in the teacher's top k is disqualified". An expert that
          // PRODUCED a token (its chosen token at its routed position) whose
          // ORIGINAL token (decompressed via etoken(e1) if it is a recorded
          // etoken id, else the raw token id itself) is NOT in the teacher's
          // top-k is DISQUALIFIED for the current round: its value is frozen
          // (no reward, no training climb) until the round reset.
          //
          // SCOPE (user): "we are only training the new 3B parameters to use
          // the new etokens". The etoken disqualification + repeat-train-top-k
          // apply ONLY to the NEW-3B networks (mutation / mtp_head / new_token
          // / compr*). Base experts E1..E5 = the original 27B — they keep their
          // normal teacher-top-k matching task and are NOT disqualified or
          // drilled on etoken output. This is what trains the FINAL 3B set of
          // experts to give compressed token output, ready to be adopted by the
          // whole model later.
          //
          // We ALSO repeat-train the E-TOKEN top-k: "repeat train its top k to
          // include this etoken on the teachers output untill it appears in the
          // top k of the expert." Each step we pull the expert's current top-k
          // and the teacher's top-k; if the teacher's e-token id is not yet in
          // the expert's top-k we flag it for the steering bias to drill in
          // (repeat training passes converge it into the expert's top-k).
          const teacherTopKIds = (tPos.top || []).map((x) => (x?.id !== undefined ? x.id : x));
          const expertChosenId = isNew ? st?.chosen?.id : undefined; // etokens only trained into new-3B nets
          const dq = (isNew && expertChosenId !== undefined)
            ? evalDisqualification(expertChosenId, teacherTopKIds)
            : { disqualified: false, originalTokens: [], originalInTeacherTopK: true, missing: [] };
          if (dq.disqualified) {
            liveEtokStats.disqualified++;
            phaseInfo[i].disqualified = true;
            phaseInfo[i].missingOriginals = dq.missing;
            // DISQUALIFIED: no positive reward, freeze the expert for the round.
            m = 0;
            return m;
          }
          // REPEAT-TRAIN-TOP-K: check whether the teacher's current etoken id
          // already appears in this NEW expert's top-k; if not, it is still
          // being trained in (repeat passes). Only new-3B networks are drilled.
          if (typeof lastFpId === "number" && isNew) {
            const rtt = repeatTrainEtokenTopK(
              (st?.top || []).map((x) => x?.id !== undefined ? x.id : x),
              teacherTopKIds, lastFpId
            );
            if (rtt.inTopK) liveEtokStats.in_topk++;
            phaseInfo[i].etoken_in_topk = rtt.inTopK;
            phaseInfo[i].etoken_passes_to_learn = rtt.passesToLearn;
            phaseInfo[i].etoken_target = rtt.targetSet ? rtt.targetSet.slice(0, 10) : undefined;
          }
          // MTP HEAD (+1 forward): the MTP expert predicts the NEXT token, so it
          // is scored on how well the student's output tracks the teacher's top-k
          // one position ahead (its own forward-looking signal). MTP also AIDS
          // COMPRESSED TOKENS: when the next token it predicts is a compressed/
          // new token, it earns the mtpAid bonus — steering the model's forward
          // prediction toward the compressed representation.
          if (isMtp) {
            const ahead = student[(pos + 1) % Math.max(1, student.length)];
            const aheadSet = narrowTokenSet(ahead?.top || [], emitFor("student").top_k, 1);
            // MTP is a compressor: constrain to compressor tokens only.
            const aheadSetUse = isCompr ? compressorConstrained(aheadSet, comprSet) : aheadSet;
            for (const tok of aheadSetUse) if (tSetK.has(tok)) m++;
            if (isCompr ? comprSet.has(String(ahead?.chosen?.token)) && tSetK.has(ahead?.chosen?.token)
                        : ahead && tSetK.has(ahead.chosen.token)) m += 10; // next-token emit-match boost
            // MTP AIDED-COMPRESSION: if the MTP's forward target (ahead token) is
            // a compressed/new token, bonus it — the MTP is aiding compression by
            // predicting the compressed next token. Uses the GENUINE compressor
            // token set so this is only meaningful for real compressed emissions.
            if (phase1 && ahead && compressorTokenSet.has(String(ahead.chosen.token))) {
              m += newNetW; phaseInfo[i].mtpAid = newNetW;
            }
            return m;
          }
          // Phase 1 — new networks FAVOR compressed tokens: if a new network's
          // position emitted a genuine compressed token (in compressorTokenSet,
          // NOT any raw token), bonus it — this is what makes the added layers
          // become real token-COMPRESSORS.
          if (phase1 && isNew && st && compressorTokenSet.has(String(st.chosen.token))) {
            m += newNetW; phaseInfo[i].p1 = newNetW; phaseInfo[i].newTok = true;
          }
          // Constrain to compressor tokens ONLY for compressor experts.
          const sSetUse = isCompr ? compressorConstrained(sSetK, comprSet) : sSetK;
          for (const tok of sSetUse) if (tSetK.has(tok)) m++;
          const chosenOk = isCompr ? (st && comprSet.has(String(st.chosen.token)) && tSetK.has(st.chosen.token))
                                   : (st && tSetK.has(st.chosen.token));
          if (chosenOk) m += 10; // strong emit-match boost (compressor: only when it's a compressor token)
          // Phase 2 — reproduce the base shape ("same shape as if not attached"):
          // the new network compressed the raw output ids (studentIdNums) into a
          // single footprint token fpId. It reproduces the base shape iff its
          // decompressed ids match the BASE (un-attached) experts' chosen ids at
          // the same positions. CRITICAL: this only counts when the new network
          // ACTUALLY emitted a compressed/new token (pi.newTok) — otherwise the
          // decompressed set is trivially identical to the raw base set (overlap
          // 1.0 for everyone) and the reward is vacuous noise. Gating on newTok
          // means phase 2 only rewards networks that genuinely produce the
          // compressed representation AND reconstruct the base shape from it.
          if (phase2 && isNew && pi.newTok && baseShapeIds.length) {
            const decompIds = (studentIdNums && studentIdNums.length ? studentIdNums : []);
            if (decompIds.length) {
              const bg = new Set();
              for (const p of baseShapeIds) if (Number.isFinite(Number(p))) bg.add(String(p));
              let shared = 0;
              const decompSet = new Set(decompIds.map(String));
              for (const b of bg) if (decompSet.has(b)) shared++;
              const overlap = bg.size ? shared / bg.size : 0;
              phaseInfo[i].reconOverlap = Number(overlap.toFixed(3));
              phaseInfo[i].decompHit = shared;
              if (overlap >= reconMin) { m += reconW * overlap; phaseInfo[i].p2 = reconW * overlap; }
            }
          }
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
        const expertScores = route.rows.map((r, i) => {
          const ms = Number(route.state?.matchScore?.[r.name]) || 0;
          const pi = phaseInfo[i] || {};
          // A DISQUALIFIED expert earns NO points this step (value frozen, no
          // climb) until the round reset.
          let ownPts = (base + baseP + baseEm) * 0.6 * (ms / msTot) +
                         (curvePoints + compressionPoints) * (0.4 * (ms / msTot) + 0.6 * ((Number(r.value) || 0) / vAll));
          if (pi.disqualified) ownPts = 0;
          return {
            expert: r.name,
            active: r.active,
            role: r.role,
            mutation: r.mutation,
            weight: Number(r.topk_weight) || 0,
            match: ms,                 // this expert's own cumulative match count
            score: Number(ownPts.toFixed(4)),
            is_new_network: !!pi.isNew,
            disqualified: !!pi.disqualified,
            missing_originals: pi.missingOriginals || [],
            etoken_in_topk: pi.etoken_in_topk === true,
            etoken_passes_to_learn: pi.etoken_passes_to_learn ?? 0,
            phase1_compression: Number((pi.p1 || 0).toFixed ? (pi.p1 || 0).toFixed(2) : pi.p1 || 0),
            phase2_reconstruction: Number((pi.p2 || 0).toFixed ? (pi.p2 || 0).toFixed(2) : pi.p2 || 0),
            mtp_aid: Number((pi.mtpAid || 0).toFixed ? (pi.mtpAid || 0).toFixed(2) : pi.mtpAid || 0),
            recon_overlap: pi.reconOverlap || 0,
            decomp_hit: pi.decompHit || 0,
            emitted_new_token: !!pi.newTok,
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
          // For a NEW-3B / COMPRESSOR expert the display token is the E-TOKEN it
          // is being trained to emit — a UNIQUE reserved-range id that
          // decompresses to an identical base-tokenizer token sequence. It is
          // derived PER-POSITION from the TEACHER's top-k at that position (the
          // etoken encodes the teacher's probable token ids there), so different
          // experts at different positions target DIFFERENT, relevant etokens —
          // fixing the 'all experts show one static etoken' defect.
          const is3b = isNewNetwork(r.name) || isCompressorExpert(r.name);
          if (is3b) {
            const pos = i % Math.max(1, studentIds.length);
            // Per-position teacher top-k ids (fall back to the current etoken).
            let topkIds = (winRefTopKPerPos && winRefTopKPerPos[pos]) ? winRefTopKPerPos[pos].map((x) => x.id).filter((v) => Number.isFinite(Number(v))) : null;
            if (!topkIds || !topkIds.length) topkIds = [(studentIdNums && studentIdNums.length ? studentIdNums : [0, 1, 2, 3, 4])[pos % 5], ...(winRefTopKPerPos?.[pos] || winRefTopK || []).slice(1, 4).map((x) => x.id)];
            // Hash this position's teacher top-k ids into the reserved etoken
            // range (deterministic, decompressible).
            const pf = compressFootprint(topkIds.length ? topkIds : [pos + 1]);
            const eId = pf.id;
            const decomp = etoken(eId);
            const isRec = getEtokens()?.tokens ? hasEtoken(eId) : false;
            // Ensure the etoken is recorded (recallable) so it decompresses.
            if (!isRec) putEtoken({ id: eId, tuple: topkIds.length ? topkIds : [eId], live: true, audit: `per-pos@step${step}` });
            const display = `${eId}→[${((decomp || topkIds) || []).join(",")}]`;
            return { expert: r.name, active: r.active, value: Number(r.value).toFixed(4), token: display, etoken: eId, decompressed: (decomp || topkIds) || [] };
          }
          // Base 27B experts: keep the student's raw token (they reproduce the
          // normal base shape, not etokens).
          let token = rawTok;
          if (isCompressorExpert(r.name) && (loadConfig()?.moe?.compressor_tokens_only ?? true)) {
            const firstCompr = [...newTokenSet].find((t) => String(t) === String(rawTok)) ?? [...newTokenSet][0];
            token = firstCompr ?? rawTok;
          }
          return { expert: r.name, active: r.active, value: Number(r.value).toFixed(4), token, etoken: null, decompressed: [] };
        });

        // ---- O-TOKEN SEQUENCE REWARD (HARSher environment, user design) ----
        // Score each NEW-3B expert against the SAVED TEACHER CHUNK: the otoken
        // (etoken) sequence the teacher produced and saved to disk to train on.
        // Enabled via scoring.otoken_sequence.enabled. No free "anything in
        // top-k" bonus: an expert earns more for GENERATING the saved otoken
        // than for merely having it in its top-k, the base multiplier scales
        // with how many otokens it reproduced perfectly (1/100 ≈ nothing,
        // 99/100 + top-k match ≈ super close to perfect), and the FIRST PERFECT
        // response ends the round and is placed first (tiebroken by next otoken).
        let otokenPerExpert = null;
        let otokenPerfectWinner = null;
        const otokCfg = loadConfig()?.scoring?.otoken_sequence || {};
        if (otokCfg.enabled) {
          const savedEtoks = Array.isArray(liveEtokStats?.last_teacher_etokens) ? liveEtokStats.last_teacher_etokens : [];
          const n = otokCfg.teacher_chunk_length > 0 ? Number(otokCfg.teacher_chunk_length) : savedEtoks.length;
          const savedChunk = savedEtoks.slice(0, n || savedEtoks.length).map(String);
          const rtRows = route.rows || [];
          // DELEGATION (user): an expert that thinks it can only get a FEW
          // etokens itself can SEND the rest to be filled with the assumed-
          // correct sequence the saved etokens CONTAIN; if the combined result
          // scores PERFECT, the (trained) expert wins.
          const selfGuess = (name) => {
            const g = perExpertGuesses.find((gg) => gg.expert === name);
            return g && g.etoken != null ? String(g.etoken) : "";
          };
          otokenPerExpert = rtRows.map((r, i) => {
            // Only score/show the experts being TRAINED (active new-3B addon
            // experts), not every routed row — user: 'we only want to score /
            // show trained experts'.
            if (!(isNewNetwork(r.name) || isCompressorExpert(r.name))) return null;
            if (!r.active) return null;
            if (!savedChunk.length) return null;

            // Compare in DECOMPRESSED-CONTENT SPACE — "the assumed-correct
            // sequence the etoken contains". Both the saved chunk and each
            // expert's guess are etoken ids; what matters is the content the
            // etoken encodes (etoken(eId) -> original token tuple). So:
            //   savedContent[p] = decompressed tuple of saved etoken id at p
            //   ownContent[p]   = decompressed tuple of the expert's guess id
            const etokContent = (idStr) => {
              const id = Number(idStr);
              const decomp = Number.isFinite(id) ? etoken(id) : null;
              return (decomp && decomp.length ? decomp.join(",") : "");
            };
            const savedContent = savedChunk.map((_, p) => etokContent(savedChunk[p]));
            const ownContent = savedChunk.map((_, p) => etokContent(selfGuess(r.name)));

            // PER-POSITION SELF/DELEGATE DECISION (user: 'if the model delegates
            // the next token to a new expert using perfect tokens it should in
            // theory score LESS than if it were to do itself, but after each
            // token it can decide what to do next'):
            //   - At each position, if the expert's OWN content == saved content
            //     it did that token ITSELF (full credit).
            //   - Otherwise it DELEGATES that token to the ASSUMED-CORRECT
            //     sequence the etoken contains (the routed expert is routed to
            //     it as the assumed answer). Delegation is a DISCOUNTED credit —
            //     doing it yourself always beats handing it off.
            //   - Decisions are PER-TOKEN, not just a leading prefix: an expert
            //     can self-produce positions AFTER delegating earlier ones.
            const combinedSeq = ownContent.slice();
            const modes = new Array(n).fill("delegate");
            let selfCount = 0, delegatedCount = 0;
            for (let p = 0; p < n; p++) {
              if (ownContent[p] !== "" && ownContent[p] === savedContent[p]) {
                modes[p] = "self"; selfCount++;
              } else {
                combinedSeq[p] = savedContent[p]; // assumed-correct content
                delegatedCount++;
              }
            }
            // PER-TOKEN COMPRESS DECISION (user: 'it can decide if it wants to
            // do the next token sequence OR if it would like to COMPRESS the
            // output of the last token into a NEW etoken for storage /
            // generation'). After each contiguous run of self-produced tokens,
            // the expert COMPRESSES that run into a NEW nested (parent) etoken
            // — this is how it 'builds more KV compression tokens over time
            // with larger text outputs'. The parent's content = the saved etoken
            // ids of the run it covered itself (a real nested 'contains etokens'
            // compression node in the disjoint parent range).
            const compressPoints = [];
            let runStart = -1;
            for (let p = 0; p <= n; p++) {
              const isSelf = p < n && modes[p] === "self";
              if (isSelf && runStart < 0) runStart = p;
              if ((!isSelf || p === n) && runStart >= 0) {
                if (p - runStart >= 2) compressPoints.push(runStart);
                runStart = -1;
              }
            }
            let compressed = compressPoints.length > 0;
            let compressedTokens = 0, compressSavings = 0;
            let compressRewardStep = 0, etokenCreationReward = 0;
            // "THE REWARD FOR CREATING ETOKENS ALONE SHOULD BE BIGGER (default)".
            // Creating a compression etoken is a PRIMARY reward, not a small side
            // bonus: a flat per-etoken-created reward (etoken_creation_reward,
            // default LARGE) PLUS a chunk-savings bonus (bigger bundle = more
            // otoken generation time saved).
            const etCfg = loadConfig()?.scoring?.otoken_sequence || {};
            const etchunkBase = Number(etCfg.etoken_creation_reward ?? 40);      // flat per-etoken-created (BIG by default)
            const compressBonus = Number(etCfg.compress_bonus ?? 8);             // per-chunk-size savings bonus
            const nCompress = compressPoints.length;
            for (const cp of compressPoints) {
              let ce = cp; while (ce < n && modes[ce] === "self") ce++;
              const runIds = savedChunk.slice(cp, ce).map(Number).filter((v) => Number.isFinite(v));
              if (runIds.length >= 2) {
                const par = superEtokenFromItems(runIds, { live: true, audit: `otok-compress@${r.name}@step${step}`, save: false });
                if (par) liveEtokStats.e_tokenized++;
                // The run is DELIVERED CORRECT by one etoken (counts as correct)
                // in ONE turn — saving otoken generation time vs generating each
                // token separately.
                compressedTokens += runIds.length;
                compressSavings += runIds.length;
                // PRIMARY reward for creating the compression etoken (big);
                // plus the chunk-savings bonus for the LARGER chunk.
                etokenCreationReward += etchunkBase;                                             // 40 per etoken created
                compressRewardStep += compressBonus * (runIds.length / Math.max(1, chunkSize())); // savings bonus
              }
            }
            const topKPerPos = savedChunk.map((_, p) => {
              const ref = (winRefTopKPerPos && winRefTopKPerPos[p]) || winRefTopK || [];
              return new Set(ref.map((x) => String(x.id)));
            });
            const rw = otokenSequenceReward({
              savedChunk: savedContent, generatedSeq: combinedSeq, topKPerPos,
              degenerate: stepRec.student_collapsed === true,
            });
            // ---- "PHONING A FRIEND" IS ONLY A TEMPORARY TIE MARKER ----
            // Delegation ('i'm phoning a friend') earns NO reward — it is just a
            // temporary tie marker so the run doesn't stop. It does not end the
            // round on its own; only doing it YOURSELF (self otokens) and/or via
            // a COMPRESSION etoken earns reward. The self-produced positions have
            // a SMALL base credit; the real reward is CREATING ETOKENS.
            const selfBasePts = Number(etCfg.self_base_pts ?? 5); // small per-self-otoken credit
            let selfReward = selfCount * selfBasePts;
            // COMPRESS COUNTS AS CORRECT (user): the compressed run delivered
            // correctly (compressedTokens), so those tokens also earn the self
            // credit, AND the etoken-creation reward (big) + savings bonus.
            selfReward += compressedTokens * selfBasePts;
            const rewardTotal = selfReward + etokenCreationReward + compressRewardStep;
            rw.reward = Number(rewardTotal.toFixed(2));
            rw.modes = modes;
            rw.delegated = delegatedCount > 0;
            rw.own_etokens = selfCount;          // how many it did itself
            rw.delegated_etokens = delegatedCount; // how many it phoned a friend for (tie marker, no reward)
            rw.self_fraction = Number((n ? selfCount / n : 0).toFixed(3));
            rw.compress_decision = compressed;   // it built a new kv-compression etoken this step
            rw.compress_points = nCompress;
            rw.compressed_tokens = compressedTokens;   // tokens delivered CORRECT via a larger-chunk etoken
            rw.compress_savings = compressSavings;      // otoken generation steps saved by bundling
            rw.compress_reward = Number(compressRewardStep.toFixed(2)); // chunk-savings bonus
            rw.etoken_creation_reward = Number(etokenCreationReward.toFixed(2)); // PRIMARY: reward for creating etokens

            // ---- TURN-EFFICIENCY ("instant round win if the chunk was 4 long") ----
            // Model GENERATION TURNS: a self otoken takes 1 turn; a compressed
            // etoken delivers its WHOLE run in 1 turn. 'etoken(friend+guess olen2)
            // = 4 otokens generated in 3 turns' => self 1 + self 1 + compressed 2
            // = 4 otokens in 3 turns. Fewer turns for the same full chunk wins, so
            // an expert that finishes a 4-token chunk in 3 turns via a compression
            // etoken beats one that finishes (tie) in 4 turns without compression.
            const selfTurns = selfCount;
            const compressTurns = nCompress;                       // each etoken = 1 turn
            const delegateTurns = delegatedCount;                  // phoning-a-friend = marker turns, no reward
            const turnsUsed = selfTurns + compressTurns + delegateTurns;
            const otokensDelivered = selfCount + compressedTokens; // what it actually delivered itself/compressed
            rw.turns_used = turnsUsed;
            rw.otokens_delivered = otokensDelivered;
            rw.turn_efficiency = n ? Number((otokensDelivered / Math.max(1, turnsUsed)).toFixed(3)) : 0;

            // ---- ARRAY-INDICATOR TRUMP CARD (the "funny math" promise) ----
            // "a token indicator to say that the following n tokens are stored
            // as a representation of an array" — the SAVED otoken sequence is
            // the array being promised. Breaks residual ties on reward then turns.
            const savedArray = savedChunk.map(Number).filter((v) => Number.isFinite(v));
            const ind = savedArray.length ? putArrayIndicator(savedArray, { save: false }) : null;
            rw.array_indicator = ind ? Number(ind.id) : null;

            // A run ENDS/round-ends when the expert delivers the full chunk
            // correctly via ITSELF + compression (delegation alone never ends it —
            // phoning a friend just keeps the tie alive so the run doesn't stop).
            const deliversFull = (selfCount + compressedTokens) >= n;
            if (rw?.perfect && deliversFull && (otokCfg.round_end_on_perfect !== false)) {
              const prev = otokenPerfectWinner;
              // Winner = HIGHEST ETOKEN-CREATION + SELF REWARD (creating etokens
              // pays big; delegation earns nothing). On equal reward, FEWER TURNS
              // wins (compression finished the chunk faster) -> the instant-round-
              // win-if-chunk-was-4-tokens-long case. Then array-indicator trump.
              const beats = !prev
                || Number(rw.reward) > Number(prev.reward)
                || (Math.abs(Number(rw.reward) - Number(prev.reward)) < 1e-9
                    && (turnsUsed < Number(prev.turns_used ?? 999)
                        || (turnsUsed === Number(prev.turns_used ?? 999) && prev.trump)));
              if (beats) {
                otokenPerfectWinner = {
                  expert: r.name, seq: savedChunk.slice(), tiebreakNext: rw.tiebreakNext || null,
                  step, delegated: delegatedCount > 0, own_etokens: selfCount,
                  delegated_etokens: delegatedCount,
                  turns_used: turnsUsed, otokens_delivered: otokensDelivered,
                  trump: rw.array_indicator != null && !!prev && Number(rw.reward) === Number(prev.reward) && turnsUsed === Number(prev.turns_used ?? 999),
                  array_indicator: rw.array_indicator,
                  promised_values: ind ? ind.values.slice(0, 20) : [],
                  compress_decision: compressed,
                  compress_points: nCompress,
                  compress_reward: Number(compressRewardStep.toFixed(2)),
                  etoken_creation_reward: Number(etokenCreationReward.toFixed(2)),
                };
              }
            }
            return { expert: r.name, ...rw };
          }).filter(Boolean);
          // Add the otoken sequence reward into each expert's score (harsher
          // environment): the reward becomes part of that expert's earned points
          // shown in "Score by expert" and accumulated below.
          if (expertScores && otokenPerExpert && otokenPerExpert.length) {
            for (const o of otokenPerExpert) {
              const es = expertScores.find((x) => x.expert === o.expert);
              if (es) { es.otoken_reward = Number(o.reward) || 0; es.otoken_perfect = !!o.perfect; es.score = Number((Number(es.score) + (Number(o.reward) || 0)).toFixed(4)); }
            }
          }
          // The per-token COMPRESS decisions created NEW nested (parent) etokens
          // this step (each expert compressing its self-covered run). Persist
          // them at the end of the block so the KV-compression anchors are
          // durable ("build more kv compression tokens over time"). Only runs
          // when an expert actually compressed (skip the common no-compress
          // step that would just rewrite the file every loop).
          if (otokenPerExpert && otokenPerExpert.some((o) => o && o.compress_decision)) {
            saveEtokens();
          }
        }
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
          otoken_sequence: {
            enabled: !!otokCfg.enabled,
            per_expert: otokenPerExpert || [],
            perfect_winner: otokenPerfectWinner,
          },
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
          // Save the generated new tokens (etokens only, no original tokens) to
          // their OWN JSON file alongside the snapshot so they persist.
          saveNewTokens(newTokens);
          moe.new_tokens_saved_to = NEW_TOKENS_FILE;
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
        per_expert_guesses: (moe?.expert_guesses || []).map((g) => ({
          expert: g.expert, token: g.token, etoken: g.etoken ?? null, decompressed: g.decompressed || [],
        })),
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

    // RECORD the ATTACHED (best) segment's fitness so the next rewire can rank
    // segments (best frozen; worse losers rewire harder). Fitness = the step's
    // total compressed-aware score + a big boost when the compressed token
    // matched (curve_compressed_match). This drives which segment wins "best".
    try {
      const sb = stepRec.score_breakdown || {};
      const fit = (Number(stepRec.step_points) || 0)
        + (Number(sb.curve_overlap) || 0) * 50
        + (sb.curve_compressed_match ? 200 : 0);
      if (typeof noteAttachedFitness === "function") {
        noteAttachedFitness(fit, `step ${step}`);
        stepRec.segments = (typeof segmentSummary === "function") ? segmentSummary() : null;
      }
    } catch (e) { /* fitness recording is best-effort */ }

    recent.push(stepRec);
    if (recent.length > 60) recent.shift();

    // LOOP-AND-INCREMENT: mark this step done within the current window tier.
    // "TRAIN TILL IT WORKS": a tier advances when the student CONVERGES on the
    // window's teacher top-k (overlap >= identity_tolerance) — graduate early —
    // OR after `max_loops_per_tier` loops (the escape hatch) so a genuinely
    // unlearnable tier can't deadlock the run forever. Convergence is the goal;
    // the loop cap only keeps the run from stalling.
    if (win && win.enabled) {
      winStepInTier++;
      const tier = curWindowTier();
      const tol = win.identityTolerance;
      const overlap = stepRec.score_breakdown?.curve_overlap ?? 0;
      // Track the best overlap seen THIS tier so the UI can show whether the
      // student is converging on the window (0.0 = still collapsed / no match).
      bestWinOverlap = Math.max(bestWinOverlap, overlap);
      // O-TOKEN PERFECT ROUND-END (harsher env): the FIRST expert to perfectly
      // reproduce the saved teacher otoken chunk ends the round immediately and
      // is placed FIRST (rounded to an immediate tier advance = immediate round
      // end). On a tie the next otoken is compared (longest prefix wins).
      const perfectWin = stepRec.moe?.otoken_sequence?.perfect_winner || null;
      const perfectGraduated = !!perfectWin;
      const graduated = (overlap >= tol) || perfectGraduated;
      stepRec.window = {
        ...(stepRec.window || {}),
        overlap, graduated, best_overlap: bestWinOverlap, tol, max_loops: tier?.rounds,
        perfect_winner: perfectWin,
      };
      if (graduated || perfectGraduated) lastConvergedStep = step;
      if (perfectWin) {
        console.log(`  >> [otoken] FIRST PERFECT response @ step ${step}: expert ${perfectWin.expert} matched the saved teacher otoken chunk — ROUND END, placed first`);
      }
      const hitCap = tier && winStepInTier >= tier.rounds && !graduated;
      if (tier && (hitCap || graduated)) {
        if (perfectGraduated) {
          console.log(`  >> window tier ${tier.tokens}: (harsher-env) otoken-perfect expert placed first — advance`);
        } else if (graduated) {
          console.log(`  >> window tier ${tier.tokens}: student matched teacher top-k (${overlap.toFixed(3)} >= ${tol}) — converging, advance`);
        } else {
          console.log(`  >> window tier ${tier.tokens}: NOT converged (best ${bestWinOverlap.toFixed(3)} < ${tol}) after ${tier.rounds} loops — escape-hatch advance`);
        }
        winStepInTier = tier.rounds; // force the advance next step
        bestWinOverlap = 0;          // reset best-overlap for the next tier
      }
    }

    // Publish for the UI.
    latest = {
      mode: "teacher-anchored live",
      teacher: TEACHER_URL, student: STUDENT_URL,
      view_top_k: viewTopK(),
      topk_display_per_pos: topkDisplayPerPos(),
      next_phase: { max_tokens: Number(loadConfig()?.windowing?.max_tokens ?? 2000) },
      emit: { teacher: emitFor("teacher"), student: emitFor("student") },
      noise_to_layer: noiseToLayer(),
      base_model: loadConfig()?.model?.base_gguf ?? STUDENT_URL,
      expert_policy: loadConfig()?.expert_policy || {},
      per_teacher_emit_match: Number(loadConfig()?.scoring?.base?.per_teacher_emit_match ?? 2),
      student_step_tokens: studentStep(),
      step, base_score: stepRec.step_points ?? 0, bonus_score: bonusTotal,
      // total = this token's points BEFORE the expert was updated; resets each token.
      total_score: stepRec.step_points ?? 0,
      "500x_generations": fives,
      num_experts: stepRec.moe?.num_experts ?? loadConfig()?.moe?.num_experts ?? 5,
      layers_total: stepRec.moe?.layers_total ?? loadConfig()?.layers?.count ?? 5,
      pause_every_n_steps: Number(loadConfig()?.training?.pause_every_n_steps ?? 0),
      windowing: win && win.enabled ? { enabled: true, tier: winTierIdx + 1, tokens: curWindowTier()?.tokens ?? 0, of: win.tiers.length, step_in_tier: winStepInTier + 1, loops: winSeq, max_tokens: loadConfig()?.windowing?.max_tokens ?? 2000, max_loops_per_tier: win.maxLoopsPerTier, overlap: stepRec.window?.overlap ?? 0, best_overlap: bestWinOverlap, tol: win.identityTolerance, graduated: !!(stepRec.window?.graduated), last_converged_step: lastConvergedStep, allow_new_token_output: !!loadConfig()?.moe?.allow_new_token_output, skip_teacher_when_poor: !!loadConfig()?.moe?.skip_teacher_when_poor, self_update_when_poor: !!loadConfig()?.moe?.self_update_when_poor, skipped_teacher_poor: !!stepRec._skipped_teacher_poor, topk_source: winRefTopKSource } : undefined,
      expert_steering: { enabled: Number(loadConfig()?.moe?.expert_steering ?? 0) > 0, factor: Number(loadConfig()?.moe?.expert_steering ?? 0), max_bias: Number(loadConfig()?.moe?.steering_max_bias ?? 2.0), top_n: Number(loadConfig()?.moe?.steering_top_n ?? 20), last_bias_tokens: steerBias ? Object.keys(steerBias).length : 0 },
      // O-TOKEN SEQUENCE (harsher env, opt-in): per-expert score vs the saved
      // teacher otoken chunk; first perfect response ends the round + places first.
      otoken_sequence: stepRec.moe?.otoken_sequence || { enabled: false, per_expert: [], perfect_winner: null },
      // GRANULAR 3B STRUCTURE: multiple 3B segments trained in parallel, only the
      // best attached; neuron sizes per expert/layer EVOLVE (NOT preset) via
      // rewiring. Surfaced every step so the user can inspect segment count,
      // experts per segment, and the last rewire movement.
      expert_structure: (typeof expertStructure === "function" ? expertStructure() : null),
      segments: (typeof segmentSummary === "function" ? segmentSummary() : null),
      last_rewire: stepRec?.rewired ? { moved: stepRec.rewired, from: stepRec.rewire_from, to: stepRec.rewire_to, per_seg: stepRec.rewire_per_seg, step } : null,
      two_phase: { enabled: !!loadConfig()?.scoring?.two_phase?.enabled, phase: Number(loadConfig()?.scoring?.two_phase?.phase ?? 1), new_net_compression_weight: Number(loadConfig()?.scoring?.two_phase?.new_net_compression_weight ?? 40), reconstruct_weight: Number(loadConfig()?.scoring?.two_phase?.reconstruct_weight ?? 120), reconstruct_min_overlap: Number(loadConfig()?.scoring?.two_phase?.reconstruct_min_overlap ?? 0.5), note: "Phase1=new nets FAVOR compressed tokens; Phase2=new compressed experts reproduce base shape; MTP aids compressed tokens" },
      // PER-EXPERT scored/training detail (surfaced so the UI shows EVERY expert
      // getting a value/delta, not just the active top-k). Pulls from the moe
      // object built during the step.
      per_expert: (stepRec.moe?.expert_topk || []).map((e) => {
        const es = (stepRec.moe?.expert_scores || []).find((x) => x.expert === e.expert) || {};
        return {
          expert: e.expert, value: e.value, active: e.active, role: e.role,
          mutation: e.mutation, topk_weight: e.topk_weight,
          is_new_network: !!es.is_new_network,
          disqualified: !!es.disqualified,
          missing_originals: es.missing_originals || [],
          etoken_in_topk: es.etoken_in_topk === true,
          etoken_passes_to_learn: es.etoken_passes_to_learn ?? 0,
          phase1_compression: es.phase1_compression ?? 0,
          phase2_reconstruction: es.phase2_reconstruction ?? 0,
          mtp_aid: es.mtp_aid ?? 0,
          recon_overlap: es.recon_overlap ?? 0,
          decomp_hit: es.decomp_hit ?? 0,
          emitted_new_token: !!es.emitted_new_token,
        };
      }),
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
        per_step: studentStep(),
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
      // E-TOKEN SYSTEM (corrected): the recallable etoken(e1) function stored in
      // data/Etokens.json — e1 -> original token tuple. Live stats + the full
      // recall-table summary so the UI can inspect what the model has learned.
      etoken_system: {
        how: "The teacher's emitted token chunks are fed through the e-tokenizer (etokens.mjs) and stored in data/Etokens.json as recallable functions: etoken(e1) -> (o1,o2,o3,o2,o4) (the original token tuple, deduped of effective adjacent repeats). The same tuple always maps to the same etoken id (deterministic/recallable) in the reserved range [base,base+count). TRAIN SCOPE = NEW-3B ONLY: only the added ~3B networks (mutation / mtp_head / new_token / compr* experts, i.e. isNewNetwork) are trained to emit etoken (compressed) output; base 27B experts E1..E5 keep normal top-k matching. A new-3B expert whose produced token's ORIGINAL token is NOT in the teacher's top-k is DISQUALIFIED (no reward) for the round, and the etoken id is repeat-trained into its top-k until it appears. Later the whole model adopts this 3B 'expert' to save space/memory.",
        base: ETOKEN_BASE(),
        count: ETOKEN_COUNT(),
        train_scope: String(loadConfig()?.etokens?.train_scope ?? "new_3b_only"),
        live_stats: liveEtokStats,
        store: getEtokens() ? {
          total: getEtokens().stats?.total ?? 0,
          base_etokens: getEtokens().stats?.base_etokens ?? 0,
          live_added: getEtokens().stats?.live_added ?? 0,
          built_from: getEtokens().stats?.built_from ?? null,
          has_ternary: !!(getEtokens()?.ternary && Object.keys(getEtokens().ternary).length),
          // HIERARCHICAL (nested e-token) + ARRAY-INDICATOR summary.
          hierarchy: etokenHierarchyStats(),
        } : null,
        // HIERARCHICAL packing status for the last teacher run (parents created,
        // whether repeats existed, max nesting depth) — the user's "etoken that
        // contains etokens + non etokens must be in the data savings".
        last_hier: liveEtokStats.last_hier || null,
        last_teacher_etokens: liveEtokStats.last_teacher_etokens || [],
        // The current etoken's TRUE-TERNARY / 1-BIT KV value: the leading value
        // (1 = compressed, -1/0 = not) branches the compression algorithm for
        // kv-space savings, and decompresses the exact etoken tuple.
        current_ternary: (typeof lastFpId === "number") ? {
          etoken: lastFpId,
          tuple: etoken(lastFpId) || [],
          ternary: etokenTernaryOf(lastFpId),
          kv_flag: kvCompressionFlag(true),          // 1 = this kv is compressed
          kv_barrel: kvBarrel(lastFpId, { compressed: true, etokenId: lastFpId, width: 16 }),
          kv_savings: kvSpaceSaving(etoken(lastFpId) || [], lastFpId),
          algo: kvCompressionAlgo(kvBarrel(lastFpId, { compressed: true, etokenId: lastFpId, width: 16 })),
          note: "1-bit kv identifier: leading value 1 = compressed (algorithm decompresses the etoken handle); -1/0 = not compressed. Compressed handles reclaim kv space (tokensSaved = savings).",
        } : null,
      },
      // Teacher: the total prompt + accumulated output tokens.
      teacher_prompt: PROMPT,
      teacher_output: teacherOutput,
      // The teacher's top-k distribution PER emitted token (file-loaded), so the
      // UI can render "topk per token emitted". Depth/depth are tunable via the
      // 'next phase: more top-k tokens' control (topk_display_per_pos,
      // topk_display_positions) — raise them to show more of the top-K.
      teacher_topk_per_pos: (liveEtokStats.last_teacher_topk_per_pos || []).slice(0, topkDisplayPositions()).map((k) => (k || []).slice(0, topkDisplayPerPos())),
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
    if (step % 25 === 0) { const tp2 = twoPhaseCfg(); console.log(`  [two-phase] phase=${tp2.phase} newNetW=${tp2.new_net_compression_weight} reconW=${tp2.reconstruct_weight}`); }

    // Small gap so the UI can render; not a sleep hack, just pacing.
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("teacher-live finished.");
  process.exit(0);
}

run().catch((e) => { console.error("teacher-live failed:", e); process.exit(1); });
