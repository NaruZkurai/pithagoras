#!/usr/bin/env node
/**
 * format-openai-prompt.mjs
 * -------------------------
 * Turn an arbitrary prompt (e.g. a Unity shader + its compile errors) into an
 * OpenAI-compatible input that ALSO uses DIRECT TOKEN INPUT and ingests the
 * custom NEW-TOKENS compression formula, so the model's token compression
 * system can recognize compressed "new token" footprints.
 *
 * Steps:
 *   1. Reads the prompt (a file path arg, or stdin if piped).
 *   2. Formats it as OpenAI chat messages (system + user).
 *   3. PRE-TOKENIZES it via the local direct-token server's /tokenize endpoint
 *      -> raw token ids (direct token input).
 *   4. Bundles the custom NEW-TOKENS formula (compression mapping) so the
 *      harness / consumer can ingest the compressed-token scheme.
 *
 * Usage:
 *   node scripts/format-openai-prompt.mjs "path/to/prompt.txt"
 *   cat prompt.txt | node scripts/format-openai-prompt.mjs
 *   node scripts/format-openai-prompt.mjs prompt.txt --url http://127.0.0.1:6465 --model bonsai-4b
 *   node scripts/format-openai-prompt.mjs prompt.txt --save config/moe/prompts/shard-1.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argv() {
  const a = { _: [], url: "http://127.0.0.1:6465", model: "bonsai-4b", save: null,
              chunk_size: 4, vocab_offset: 0 };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k === "--url") a.url = args[++i];
    else if (k === "--model") a.model = args[++i];
    else if (k === "--save") a.save = args[++i];
    else if (k === "--chunk-size") a.chunk_size = Number(args[++i]);
    else if (k === "--vocab-offset") a.vocab_offset = Number(args[++i]);
    else a._.push(k);
  }
  return a;
}

/** The custom NEW-TOKENS compression formula the system ingests. */
function newTokensFormula(chunkSize = 4, vocabOffset = 0) {
  return {
    how: "Compression: STUDENT_STEP output tokens are compressed into ONE new token whose VALUE = the sum of their constituent token ids (footprint).",
    sentinel: 999993, // COMPRESS_AS_TOKEN
    per_step: 5,
    create_rule: "new_token = sum(input tokens); footprint = sum(ids)",
    chunking: {
      chunk_size: chunkSize,
      vocab_offset: vocabOffset,
      mapping: `chunk_id = vocab_offset + floor(rawTokenId / chunk_size)`,
      note: "When re-tokenizing text at inference, group N raw tokens into one chunked base token so the MoE sees stable chunk tokens.",
    },
    ingests: [
      "generated tokens that equal a new-token footprint count as new-token matches",
      "raw text can be pre-passed -> /tokenize -> chunked ids for direct token input",
    ],
  };
}

/** Call the direct-token server's /tokenize to get raw token ids for a string. */
async function tokenize(url, model, text) {
  const res = await fetch(`${url}/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`/tokenize HTTP ${res.status} on ${url}`);
  const d = await res.json();
  return Array.isArray(d.tokens) ? d.tokens : [];
}

/** chunk ids: https://... group raw tokens -> chunk tokens. */
function chunkIds(rawIds, chunkSize = 4, vocabOffset = 0) {
  const cs = Math.max(1, Math.floor(chunkSize) || 4);
  return rawIds.map((id) => vocabOffset + Math.floor(Number(id || 0) / cs));
}

async function main() {
  const a = argv();
  let prompt = "";
  if (a._.length) {
    const p = path.isAbsolute(a._[0]) ? a._[0] : path.join(ROOT, a._[0]);
    prompt = fs.readFileSync(p, "utf8");
  } else {
    // stdin
    prompt = fs.readFileSync(0, "utf8");
  }
  if (!prompt.trim()) { console.error("empty prompt"); process.exit(1); }

  const system = "You are analyzing a Unity shader. Diagnose the shader compile errors precisely and provide a corrected HLSL shader. Consider the token compression system: new tokens are created by summing constituent token ids (footprint), and raw text is pre-tokenized then chunked for direct token input.";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  // Pre-tokenize the whole conversation (direct token input).
  const fullText = system + "\n\n" + prompt;
  let rawIds = [];
  try { rawIds = await tokenize(a.url, a.model, fullText); }
  catch (e) { console.error("WARN tokenize failed:", e.message); rawIds = []; }
  const chunked = chunkIds(rawIds, a.chunk_size, a.vocab_offset);

  const payload = {
    format: "openai-direct-token-input",
    model: a.model,
    messages,
    messages_tokens: rawIds,          // pre-tokenized (direct token input)
    messages_chunked_ids: chunked,    // chunked base tokens for the MoE
    max_tokens: 1024,
    temperature: 0.7,
    top_p: 0.95,
    top_k: 100,
    logprobs: 40,                     // view-top-k for scoring
    stream: false,
    return_logprobs: true,
    new_token_system: newTokensFormula(a.chunk_size, a.vocab_offset), // ingestible
  };

  const out = JSON.stringify(payload, null, 2);
  if (a.save) {
    const p = path.isAbsolute(a.save) ? a.save : path.join(ROOT, a.save);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, out);
    console.log("wrote", p);
  } else {
    console.log(out);
  }
  console.error(`\n# summary: tokens=${rawIds.length} chunked=${chunked.length} url=${a.url} model=${a.model}`);
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
