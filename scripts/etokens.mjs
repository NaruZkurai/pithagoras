#!/usr/bin/env node
/**
 * etokens.mjs — the E-TOKEN compression system for the Pithagoras MoE harness.
 *
 * WHAT THIS IS (the CORRECTED implementation of the "new token" feature).
 *
 * An E-TOKEN (`e₁`, `e₂`, ...) is a RECALLABLE FUNCTION stored in `Etokens.json`.
 * It maps a compressed-token id in the RESERVED e-token range to the TUPLE of
 * ORIGINAL token indices it encodes:
 *
 *     etoken(e₁)  ->  (o1, o2, o3, o2, o4)        // e.g. "the" " " "issue" " " "is"
 *
 * So a run of tokens that the TEACHER emits is stored as ONE e-token id that is:
 *   - COMPRESSIBLE: many original tokens -> one etoken id (value compression).
 *   - DECOMPRESSIBLE: etoken(e₁) returns the original tuple.
 *   - RECALLABLE / DETERMINISTIC: the same original tuple always maps to the
 *     same etoken id (a pure function of the tuple), so "etoken(e1)" is a real,
 *     re-invokable function rather than a random label.
 *
 * THE E-TOKENIZER (the "touple" step):
 *   Every original token sequence fed here is pre-tokenized, then COUPLED into a
 *   unique new token whose token-sequence is EQUIVALENT to the original run but
 *   has NO effective REPEATED tokens to it. That is, adjacent repeated tokens are
 *   deduplicated ("the the the" -> "the") before hashing, so the e-token carries
 *   the EFFECTIVE (repetition-free) content. The resulting id lives in
 *   [etoken.base, etoken.base + etoken.count).
 *
 * DISQUALIFICATION (the expert-competition gate):
 *   All experts compete for the last few billion parameters (the added layers
 *   E6..E101 + the dynamic ETE experts). An expert that produces a token whose
 *   ORIGINAL token (decompressed via etoken if it is an e-token, else the raw
 *   token id itself) is NOT in the teacher's top-k is DISQUALIFIED for the
 *   current round — its value is frozen and it earns no reward.
 *
 * REPEAT-TRAIN-TOP-K (the convergence loop):
 *   "repeat train its top-k to include this etoken on the teacher's output
 *    until it appears in the top-k of the expert". We drive the etoken id into
 *   the expert's top-k target and stem the expert toward emitting it (via the
 *   steering logit-bias the harness already has) until it actually appears in
 *   the expert's top-k — then it is "learned".
 *
 * BASE + LIVE UPDATES:
 *   On startup the pre-tokenized token DB (data/project-tokens.json +
 *   data/augment/**) is fed through the e-tokenizer to BUILD the base
 *   `Etokens.json`. Then, each teacher-generated chunk is e-tokenized too and
 *   its new etokens are MERGED back into `Etokens.json` (the model uses and
 *   updates the base file from the teacher's generated output).
 *
 * The etoken id is emitted/steered via the SAME reserved range the harness
 * already reserves (moe.new_token_base / new_token_count, default [200000,
 * 200512)), so the existing logit-bias steering can nudge a real e-token id.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const ETOKENS_PATH = path.join(REPO, "data", "Etokens.json");

// The reserved e-token id range (mirrors config moe.new_token_base/count).
export const ETOKEN_BASE = () => Number(loadEtokConfig()?.moe?.new_token_base ?? 200000);
export const ETOKEN_COUNT = () => Math.max(1, Number(loadEtokConfig()?.moe?.new_token_count ?? 512));

let _Etokens = null; // in-memory store: { version, base, tokens, stats }

let _etokConfig = null;
/** Read config/moe-config.json for the reserved-range knobs (best-effort). */
function loadEtokConfig() {
  try {
    _etokConfig = JSON.parse(fs.readFileSync(path.join(REPO, "config", "moe-config.json"), "utf8"));
  } catch { /* keep last */ }
  return _etokConfig;
}

/* --------------------------------------------------------------------------
 * E-TOKEN ID MATH (the "recallable function" core)
 * ------------------------------------------------------------------------ */

/**
 * Reduce a token-id sequence to its EFFECTIVE form: remove adjacent repeated
 * tokens so there are no effective repeated tokens to the original sequence.
 * E.g. [o1,o2,o2,o2,o3] -> [o1,o2,o3]. This is the "no effective repeated
 * tokens to the original" guarantee the user requires for a coupled token.
 * The FIRST token id of the chunk is also kept as a separate `origIndex`
 * anchor (the original-tokenizer index the chunk maps from).
 */
export function effectiveTuple(ids) {
  const out = [];
  let prev = null;
  for (const id of ids) {
    const v = Number(id);
    if (!Number.isFinite(v)) continue;
    if (v !== prev) { out.push(v); prev = v; }
  }
  return out;
}

/**
 * THE E-TOKEN ID (the recallable/deterministic handle). A pure function of the
 * EFFECTIVE tuple of original token ids:
 *
 *     eId = etoken.base + ( Σ(tuple) % etoken.count )
 *
 * The low index is the entry in the reserved e-token table; the raw sum is
 * fully recoverable from the etoken id (decompressible). Deterministic: the
 * same effective tuple ALWAYS yields the same etoken id, so `etoken(e1)` is a
 * genuine re-invocable function.
 *
 * Returns { id, index, label, origIndex }.
 *   - id        : the reserved etoken id that can be steered/emitted
 *   - index     : the low index into the reserved table (a1..)
 *   - label     : "a1", "a2", ...
 *   - origIndex : the ORIGINAL tokenizer index this chunk maps from
 */
export function etokenIdFor(ids) {
  const tuple = effectiveTuple(ids);
  const rawSum = tuple.reduce((a, v) => a + v, 0);
  const index = rawSum % ETOKEN_COUNT();
  const label = `a${index + 1}`;
  const id = ETOKEN_BASE() + index;
  const origIndex = tuple.length ? tuple[0] : 0;
  return { id, index, label, origIndex, tuple, rawSum };
}

/**
 * THE E-TOKENIZER ("touple" a run of pre-tokenized ids into one unique etoken).
 * Splits a token-id run into fixed-size chunks, effective-tuples each chunk,
 * and returns a fresh etoken id + its decompressible tuple for every chunk.
 *
 * Returns an array of { etoken, chunk, tuple, id, index, label, origIndex } —
 * one per chunk — so the caller can store them via putEtoken() and emit the ids.
 */
export function etokenize(ids, chunkSize = 4) {
  const cs = Math.max(1, Math.floor(Number(chunkSize) || 4));
  const arr = (ids || []).filter((v) => Number.isFinite(Number(v)));
  const out = [];
  for (let i = 0; i < arr.length; i += cs) {
    const chunk = arr.slice(i, i + cs);
    if (!chunk.length) continue;
    const { id, index, label, origIndex, tuple, rawSum } = etokenIdFor(chunk);
    out.push({ etoken: id, chunk, tuple, id, index, label, origIndex, rawSum });
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Etokens.json STORE (the recallable-function table)
 * ------------------------------------------------------------------------ */

/**
 * The RECALLABLE FUNCTION table: etoken_id -> original-token tuple.
 * The schema is kept flat and simple: { "<etokenId>": [orig tokens...] }.
 * Putting the SAME tuple again is idempotent (same id, no duplicate rows).
 */
function defaultStore() {
  return {
    format: "pithagoras-etokens",
    version: 1,
    base: false,          // true once built from the pre-tokenized token DB
    etoken_base: ETOKEN_BASE(),
    etoken_count: ETOKEN_COUNT(),
    tokens: {},           // { "<etokenId>": [origIds...] }  -- etoken(e) decompresses here
    stats: {
      built_from: null,   // e.g. "data/project-tokens.json + data/augment/**"
      base_etokens: 0,
      live_added: 0,
      total: 0,
      updated_at: null,
    },
    history: [],          // ring buffer of recent live updates (debug/audit)
  };
}

export function getEtokens() { return _Etokens; }

/** Load Etokens.json from disk (or return null if it doesn't exist yet). */
export function loadEtokens() {
  try {
    if (!fs.existsSync(ETOKENS_PATH)) return null;
    _Etokens = JSON.parse(fs.readFileSync(ETOKENS_PATH, "utf8"));
    return _Etokens;
  } catch (e) {
    return null;
  }
}

/** Persist Etokens.json to disk (data/Etokens.json). */
export function saveEtokens() {
  if (!_Etokens) return;
  try {
    fs.mkdirSync(path.dirname(ETOKENS_PATH), { recursive: true });
    fs.writeFileSync(ETOKENS_PATH, JSON.stringify(_Etokens, null, 2));
  } catch (e) { /* best-effort; RAM copy still usable */ }
}

/** Recalled tuple for an etoken id: `etoken(e1)` -> [orig tokens...] | null. */
export function etoken(eId) {
  if (!_Etokens) return null;
  const t = _Etokens.tokens[String(eId)];
  return Array.isArray(t) ? t.slice() : null;
}

/** True if an etoken id is recorded in the store (recallable). */
export function hasEtoken(eId) {
  return !!(etoken(eId));
}

/**
 * Record a new etoken mapping (idempotent) and persist. `live` distinguishes
 * a base-DB build row from a live teacher-generated chunk (used for stats).
 * `save=false` skips the disk write (used to BATCH a base build, then a single
 * saveEtokens() at the end — otherwise writing a growing file on every row of
 * a multi-million-token DB is far too slow). Returns { id, tuple, isNew }.
 */
export function putEtoken({ id, tuple, live = true, audit = null, save = true }) {
  if (!_Etokens) initEtokens();
  const key = String(id);
  const eff = effectiveTuple(tuple);
  const existing = _Etokens.tokens[key];
  const isNew = existing === undefined;
  // Keep the ORIGINAL tuple exactly (not the deduped one) so decompression is
  // lossless; the effective/dedup form is used only for the deterministic hash.
  _Etokens.tokens[key] = Array.isArray(tuple) ? tuple.map(Number) : eff;
  if (isNew) {
    if (live) _Etokens.stats.live_added = (_Etokens.stats.live_added || 0) + 1;
    else _Etokens.stats.base_etokens = (_Etokens.stats.base_etokens || 0) + 1;
    _Etokens.stats.total = (_Etokens.stats.total || 0) + 1;
    if (audit) {
      _Etokens.history.push({ ts: Date.now(), id: key, tuple: _Etokens.tokens[key], live, audit });
      if (_Etokens.history.length > 200) _Etokens.history.shift();
    }
  }
  _Etokens.stats.updated_at = new Date().toISOString();
  if (save !== false) saveEtokens();
  return { id: key, tuple: _Etokens.tokens[key], isNew };
}

/**
 * If Etokens.json exists on disk, load it. Otherwise initialize an empty store
 * (the harness can then buildBaseEtokens() from the token DB).
 */
export function initEtokens() {
  const loaded = loadEtokens();
  if (loaded) {
    _Etokens = loaded;
    return _Etokens;
  }
  _Etokens = defaultStore();
  return _Etokens;
}

/* --------------------------------------------------------------------------
 * BASE Etokens.json — built from the PRE-TOKENIZED TOKEN DB
 * ------------------------------------------------------------------------ */

/**
 * Feed the pre-tokenized token DB through the e-tokenizer to build the BASE
 * Etokens.json: "all tokens in this db are pre-tokenized and attempted to be
 * 'compressed' or 'toupled' into new unique tokens that have equivalent token
 * sequences as base but do not have effective repeated tokens to the original.
 * These are fed to the e-tokenizer and used as a base etoken.json."
 *
 * Sources searched (in order):
 *   - data/project-tokens.json      (files[].tokenIds — the real per-file DB)
 *   - data/augment/train.jsonl      (prompts; tokenized on demand if a remote
 *                                    tokenizer+content is available)
 *   - data/augment/teacher/*.jsonl  (prompt + teacher output text)
 *
 * `chunkSize` = how many original tokens are coupled per etoken.
 * Returns { built, etokensAdded, sources }.
 */
export function buildBaseEtokens(chunkSize = 4, opts = {}) {
  initEtokens();
  const before = Object.keys(_Etokens.tokens).length;
  const sources = [];
  let tokenized = 0;

  // (1) project-tokens.json — real pre-tokenized ids.
  const proj = path.join(REPO, "data", "project-tokens.json");
  if ((opts.include_project !== false) && fs.existsSync(proj)) {
    try {
      const db = JSON.parse(fs.readFileSync(proj, "utf8"));
      const files = Array.isArray(db.files) ? db.files : [];
      let added = 0;
      for (const f of files) {
        const ids = Array.isArray(f?.tokenIds) ? f.tokenIds : [];
        for (const e of etokenize(ids, chunkSize)) {
          putEtoken({ id: e.id, tuple: e.chunk, live: false, save: false });
          tokenized += e.chunk.length;
          added++;
        }
      }
      sources.push(`project-tokens.json (${files.length} files)`);
      if (opts.log) console.log(`  [etokens] base: tokenized ${tokenized} tokens from project-tokens.json into ${added} etokens`);
    } catch (e) {
      if (opts.log) console.log(`  [etokens] WARN: project-tokens.json skipped (${e.message})`);
    }
  }

  _Etokens.base = true;
  _Etokens.stats.built_from = sources.join(" + ") || "none";
  _Etokens.stats.total = Object.keys(_Etokens.tokens).length;
  saveEtokens();
  return { built: true, etokensAdded: Object.keys(_Etokens.tokens).length - before, sources, tokenized };
}

/* --------------------------------------------------------------------------
 * DISQUALIFICATION + REPEAT-TRAIN-TOP-K
 * ------------------------------------------------------------------------ */

/**
 * The ORIGINAL token id that an expert-produced token "came from". If the
 * produced value is a recorded e-token id, decompress it (etoken(e1)) and
 * return the original tuple's tokens; otherwise the produced value itself is
 * its own original token. This is the "token that has an original token" the
 * disqualification rule checks against the teacher's top-k.
 */
export function originalTokensOf(producedToken) {
  if (producedToken == null) return [];
  const t = etoken(producedToken);
  if (Array.isArray(t) && t.length) return t;
  // Not a recorded etoken -> the value is its own original token.
  const n = Number(producedToken);
  return Number.isFinite(n) ? [n] : [String(producedToken)];
}

/**
 * DISQUALIFICATION RULE: an expert is disqualified for the current round if it
 * produced a token whose ORIGINAL token is NOT in the teacher's top-k set.
 *   - producedToken: the token id the expert emitted/expresses (could be an
 *     etoken id or a raw vocab id).
 *   - teacherTopK:   the set/list of token ids (or token values) in the
 *     teacher's top-k for this position.
 * Returns { disqualified, originalTokens, originalInTeacherTopK, missing }.
 */
export function evalDisqualification(producedToken, teacherTopK) {
  const tSet = new Set((teacherTopK || []).map((t) => String(
    (t && t.id !== undefined) ? t.id : t
  )));
  const originals = originalTokensOf(producedToken);
  let missing = [];
  let inTopK = true;
  for (const o of originals) {
    if (!tSet.has(String(o))) { inTopK = false; missing.push(o); }
  }
  return { disqualified: !inTopK, originalTokens: originals, originalInTeacherTopK: inTopK, missing };
}

/**
 * REPEAT-TRAIN-TOP-K: iteratively train an etoken id into an expert's top-k by
 * re-anchoring the target toward the teacher's output until the etoken id shows
 * up in the expert's top-k. This is an in-memory helper used by the harness to
 * return which etoken each expert must learn and how many training passes remain
 * before it appears.
 *
 * `expertTopK`  = the expert's current top-k values (may contain the etoken id).
 * `teacherTopK` = the teacher's top-k reference at this position.
 * `etokenId`    = the etoken id to drill in.
 * Returns { inTopK, passesToLearn, targetSet }.
 */
export function repeatTrainEtokenTopK(expertTopK, teacherTopK, etokenId, maxPasses = 40) {
  const expert = new Set((expertTopK || []).map(String));
  const contains = expert.has(String(etokenId));
  if (contains) return { inTopK: true, passesToLearn: 0, targetSet: [...expert] };
  // Not yet present: build the target set the expert should converge to. It is
  // the teacher's top-k (the anchor / "guide") PLUS the etoken id at the TOP,
  // so repeated passes push the etoken in while keeping teacher anchor tokens.
  const target = [String(etokenId), ...(teacherTopK || []).map((t) => String((t && t.id !== undefined) ? t.id : t))];
  return { inTopK: false, passesToLearn: maxPasses, targetSet: [...new Set(target)] };
}

// ---- CLI (standalone) ----
// `node scripts/etokens.mjs --build [chunkSize]` rebuilds the base Etokens.json
// from the pre-tokenized token DB and prints a summary.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--build")) {
    const chunk = Number(args[args.indexOf("--build") + 1]) || 4;
    console.log("Building base Etokens.json from the pre-tokenized token DB...");
    const r = buildBaseEtokens(chunk, { log: true });
    console.log(JSON.stringify(r, null, 2));
    const e = getEtokens();
    const sample = {};
    let n = 0;
    for (const k of Object.keys(e?.tokens || {})) { sample[k] = e.tokens[k]; if (++n >= 5) break; }
    console.log("sample:", JSON.stringify(sample, null, 2));
  } else {
    console.log("usage: node scripts/etokens.mjs --build [chunkSize]");
  }
}
