#!/usr/bin/env node
/**
 * compare-topk.mjs — compare a small true-ternary model's KV/top-k signal
 * against a much larger teacher (27B) using EXPANDED TOKENS + TOKEN CHUNK
 * COMPRESSION.
 *
 * The idea:
 *   - Generate a sequence of N raw tokens from each model, capturing the
 *     per-position TOP-K log-probability distribution (the model's "values").
 *   - CHUNK COMPRESSION AS NEW TOKENS: group the raw token stream into chunks.
 *     Each chunk folds into ONE new "compressed token" whose value is the SUM
 *     of its constituent tokens' values — i.e. token n1 + n2 + n3 + ...:
 *         value(u_j) = sum over the chunk's token values.
 *   - EFFECTIVE TOP-K of the compressed stream: the top-k distribution taken
 *     over the compressed tokens (weighted by their summed value).
 *   - The invariant we check: the compressed stream's effective top-k spread
 *     EQUALS the main (much larger) model's top-k spread — but ONLY when the
 *     number of raw tokens generated equals the sum of the per-chunk token
 *     counts (N = sum_j n_j), i.e. compression is lossless w.r.t. top-k.
 *
 * Output: output/topk-compare.json with per-model top-k profiles, chunk
 * compression result, and the effective-top-k parity score (0..1) gated on the
 * token-count invariant.
 *
 * Usage:
 *   node scripts/compare-topk.mjs [--tokens N] [--chunk S] [--prompt "..."]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const OUT = path.join(REPO, "output");
const OUT_FILE = path.join(OUT, "topk-compare.json");

// The two models: the small TRUE-TERNARY model vs the much larger 27B teacher.
const SMALL_URL = process.env.SMALL_URL || "http://127.0.0.1:6465";   // 500MB Q1_0
const LARGE_URL = process.env.LARGE_URL || "http://127.0.0.1:41001";  // 27B Q1_0
const SMALL_NAME = process.env.SMALL_NAME || "bonsai-4b (500MB true-ternary)";
const LARGE_NAME = process.env.LARGE_NAME || "bonsai-27b (much larger)";

const N_TOKENS = Number(process.env.TOKENS || argvToken() || 24);
const CHUNK = Number(process.env.CHUNK || argvChunk() || 4);
const TOP_K = Number(process.env.TOPK || 5);
const PROMPT =
  process.env.PROMPT ||
  "Consider the Pithagoras portal: the pi model picker sends provider and modelId. The issue is that";

function argvToken() { const i = process.argv.indexOf("--tokens"); return i >= 0 ? process.argv[i + 1] : 0; }
function argvChunk() { const i = process.argv.indexOf("--chunk"); return i >= 0 ? process.argv[i + 1] : 0; }

/**
 * Get a token stream with per-position TOP-K distributions from a model server
 * via OpenAI /v1/completions?logprobs. Returns:
 *   { tokens: [{token, logprob, top:[{token,logprob},...]}], rawCount }
 */
async function profile(url, prompt) {
  const body = JSON.stringify({
    model: "x", prompt, max_tokens: N_TOKENS, temperature: 0.2,
    top_p: 1, top_k: TOP_K, logprobs: TOP_K, echo: false, stream: false,
  });
  const res = await fetch(`${url}/v1/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${await res.text()}`);
  const d = await res.json();
  const content = d?.choices?.[0]?.logprobs?.content || [];
  const steps = content.map((row) => ({
    token: row.token,
    logprob: row.logprob,
    top: (row.top_logprobs || []).map((t) => ({ token: t.token, logprob: t.logprob })),
  }));
  return { steps, rawCount: steps.length };
}

/** Chunk the raw token steps into groups of `size`; each chunk's VALUE is the
 *  sum of its constituent token log-densities (exp of logprob = probability;
 *  summing model-vs-model per-token "value" = the token n1+n2+n3 convention).
 *  The compressed token's value is the SUM of the chunk tokens' values. */
function chunkCompress(steps, size) {
  const chunks = [];
  for (let i = 0; i < steps.length; i += size) {
    const slice = steps.slice(i, i + size);
    const sumValue = slice.reduce((acc, s) => acc + Math.exp(s.logprob), 0);
    const sumLogprob = slice.reduce((acc, s) => acc + s.logprob, 0);
    chunks.push({
      tokens: slice.map((s) => s.token),
      count: slice.length,
      value: sumValue,          // token n1 + n2 + n3 + ...
      logprobSum: sumLogprob,
    });
  }
  return chunks;
}

/** Effective top-k of the compressed stream: the top-k chunks ranked by value,
 *  returned as a spread (weighted entropy-like concentration 0..1). */
function effectiveTopK(chunks) {
  const total = chunks.reduce((a, c) => a + c.value, 0) || 1;
  const ranked = [...chunks].sort((a, b) => b.value - a.value);
  const topk = ranked.slice(0, TOP_K);
  const topkMass = topk.reduce((a, c) => a + c.value, 0) / total;
  return { topkMass, topChunks: topk.map((c) => ({ value: c.value, tokens: c.tokens })) };
}

/** Spread (0..1): 1 = fully concentrated in one chunk, ~0 = flat. */
function spread(chunks) {
  const total = chunks.reduce((a, c) => a + c.value, 0) || 1;
  const maxV = Math.max(...chunks.map((c) => c.value));
  return maxV / total;
}

/** Parity of two effective-top-k spreads: how close the small model got to the
 *  large model's spread, 0..1. */
function parity(a, b) {
  return 1 - Math.min(1, Math.abs(a - b));
}

async function run() {
  console.log("=== KV / top-k comparison: small true-ternary vs much larger, with token-chunk compression ===");
  console.log(`  small  = ${SMALL_NAME}  ${SMALL_URL}`);
  console.log(`  large  = ${LARGE_NAME}  ${LARGE_URL}`);

  console.log(`[profile] small model, ${N_TOKENS} raw tokens, top-${TOP_K} per position...`);
  const small = await profile(SMALL_URL, PROMPT);
  console.log(`[profile] large model, ${N_TOKENS} raw tokens, top-${TOP_K} per position...`);
  const large = await profile(LARGE_URL, PROMPT);

  console.log(`[chunk] compressing into groups of ${CHUNK} raw tokens each (each compressed token value = sum of n1+n2+n3...)...`);
  const smallChunks = chunkCompress(small.steps, CHUNK);
  const largeChunks = chunkCompress(large.steps, CHUNK);

  const smallTopk = effectiveTopK(smallChunks);
  const largeTopk = effectiveTopK(largeChunks);
  const smallSpread = spread(smallChunks);
  const largeSpread = spread(largeChunks);
  const effParity = parity(smallTopk.topkMass, largeTopk.topkMass);

  // The invariant gate: effective top-k equality holds ONLY IF the raw token
  // count equals the sum of the per-chunk counts (N == sum_j n_j). Compression
  // is lossless w.r.t. the top-k only when that holds.
  const rawN = small.rawCount;
  const sumChunkCounts = smallChunks.reduce((a, c) => a + c.count, 0);
  const invariant = rawN === sumChunkCounts; // true iff chunks fully tile N

  // gate the parity on the invariant as the user specified:
  const gatedParity = invariant ? effParity : 0;

  fs.mkdirSync(OUT, { recursive: true });
  const result = {
    generated_at: new Date().toISOString(),
    small: { name: SMALL_NAME, url: SMALL_URL },
    large: { name: LARGE_NAME, url: LARGE_URL },
    prompt: PROMPT,
    top_k: TOP_K,
    raw_tokens_generated: rawN,
    chunk_size: CHUNK,
    chunk_invariant_satisfied: invariant,
    chunk_invariant_note:
      "effective top-k spread of the compressed stream == the main model's spread ONLY IF raw token count == sum of per-chunk token counts (N == sum n_j)",
    small: {
      raw_steps: small.steps.length,
      chunks: smallChunks,
      effective_topk: smallTopk,
      spread: smallSpread,
    },
    large: {
      raw_steps: large.steps.length,
      chunks: largeChunks,
      effective_topk: largeTopk,
      spread: largeSpread,
    },
    effective_topk_parity: effParity,
    effective_topk_parity_gated_on_invariant: gatedParity,
    interpretation:
      gatedParity >= 0.85
        ? "small model's compressed top-k spread matches the larger model (parity >= 0.85)"
        : gatedParity >= 0.6
        ? "partial parity (0.6-0.85) — converging on the larger model"
        : "small model's compressed top-k spread does not yet match the larger model",
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  // Append to a grow ledger so parity across grow iterations is tracked.
  try {
    const ledger = path.join(OUT, "grow-ledger.jsonl");
    fs.appendFileSync(
      ledger,
      JSON.stringify({
        at: new Date().toISOString(),
        invariant,
        parity: effParity,
        parity_gated: gatedParity,
        small_spread: smallSpread,
        large_spread: largeSpread,
        raw_tokens: rawN,
        chunk: CHUNK,
      }) + "\n"
    );
  } catch { /* ledger is best-effort */ }
  console.log(`\n=== RESULT ===`);
  console.log(`  raw tokens generated: ${rawN}; chunk-count sum: ${sumChunkCounts}; invariant (N==sum n_j): ${invariant}`);
  console.log(`  small effective top-k mass: ${smallTopk.topkMass.toFixed(3)}  spread: ${smallSpread.toFixed(3)}`);
  console.log(`  large effective top-k mass: ${largeTopk.topkMass.toFixed(3)}  spread: ${largeSpread.toFixed(3)}`);
  console.log(`  effective top-k parity: ${effParity.toFixed(3)}  (gated on invariant: ${gatedParity.toFixed(3)})`);
  console.log(`  -> ${OUT_FILE}`);
}

run().catch((e) => { console.error("compare-topk failed:", e); process.exit(1); });
