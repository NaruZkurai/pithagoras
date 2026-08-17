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

// HIERARCHICAL PARENT id space — DISJOINT from the base e-token range (and from
// the student's vocab). Parent e-tokens (the nested "etoken that contains
// etokens + raw" nodes) content-address here so a parent can NEVER collide with
// one of its own child/base ids (which would create a self-referential cycle —
// the memory-rot dangling-ref bug). The harness steers base etoken ids within
// [base, base+count), but parents are STORE-INTERNAL compression ids (they never
// need to be emitted by the student), so this large disjoint range is free.
export const PARENT_BASE = () => Number(loadEtokConfig()?.etokens?.hierarchical?.parent_base ?? (ETOKEN_BASE() + ETOKEN_COUNT()));
export const PARENT_COUNT = () => Math.max(1024, Number(loadEtokConfig()?.etokens?.hierarchical?.parent_count ?? 1_000_000));

// ARRAY-INDICATOR id space — a third DISJOINT range. An ARRAY INDICATOR is a
// compact "promise" token that declares: "the following n tokens are stored as
// a representation of THIS array" (the interior values, without the structural
// `[ ] , , ,` tokens — "we aren't bound by the rules of the current ecosystem
// or the previous tokens in formula to positions, all contain sequence as a
// prefix"). In training it is the LAST-STEP TRUMP CARD: when an expert is tied
// (or about to die on a tie), emitting the correct ARRAY-INDICATOR (a promise
// kept within n tokens) wins it — the "I'm not gonna die" card.
export const IND_BASE = () => Number(loadEtokConfig()?.etokens?.array_indicator?.base ?? (PARENT_BASE() + PARENT_COUNT()));
export const IND_COUNT = () => Math.max(1024, Number(loadEtokConfig()?.etokens?.array_indicator?.count ?? 1_000_000));

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

/* --------------------------------------------------------------------------
 * TRUE-TERNARY E-TOKEN VALUES (store/use the e-token in TERNARY space)
 * ------------------------------------------------------------------------ */

/**
 * A stable ternary hash of a non-negative token id -> {-1, 0, +1}. Uses a fixed
 * integer mix so the SAME token id ALWAYS maps to the SAME ternary digit (this
 * is what makes the e-token's value consistent/reliable in ternary space, and
 * collapses repeated tokens to the same digit — no effective repeats).
 */
export function ternDigit(tokenId, salt = 0) {
  let x = (Number(tokenId) >>> 0) + salt * 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  const r = x % 3;
  return r === 0 ? -1 : (r === 1 ? 0 : 1);
}

/**
 * TRUE-TERNARY SIGNATURE of an etoken (its compressed VALUE in ternary space).
 * Maps each ORIGINAL token id of the etoken's tuple to a ternary digit
 * ({-1,0,+1}) — the true-ternary representation of the compressed value. The
 * same etoken (same tuple) always yields the same ternary vector, and it lives
 * in the same {-1,0,+1} space as the model's true-ternary weights, so an expert
 * can STORE this value in its ternary weights and reliably USE it (recall the
 * tuple by decompressing the etoken id). Returns { vector, length, ternary }.
 */
export function etokenTernary(ids) {
  const tuple = effectiveTuple(ids);
  const vector = tuple.map((t) => ternDigit(t));
  return { vector, length: vector.length, ternary: vector.slice() };
}

/**
 * A FIXED-SIZE ternary barrel for an etoken — a stable, length-`size` ternary
 * vector in {-1,0,+1} derived from the etoken id (NOT the variable-length
 * tuple). This is the "weight signature" an expert's ternary weights actually
 * hold so it can store + reliably use the e-token as a fixed-shape value in
 * ternary space. Deterministic per etoken id.
 */
export function etokenTernaryBarrel(eId, size = 32) {
  const n = Math.max(1, Math.floor(Number(size) || 32));
  const base = Number(eId);
  const vec = new Array(n);
  for (let i = 0; i < n; i++) vec[i] = ternDigit(base, i); // salt per position
  return vec;
}

/* --------------------------------------------------------------------------
 * 1-BIT KV COMPRESSION FLAG (the user's kv-compression identifier)
 *
 * "cant we just assign a 1bit identifier to the token's kv on compressed or
 *  not? like not compressed = -1/0 compressed = 1. leading value => compression
 *  algo => kv space savings?"
 *
 * Each token's KV value is a fixed-width TERNARY barrel {-1,0,+1} (true-ternary
 * space). The LEADING value (barrel[0]) is the 1-BIT compression identifier:
 *
 *     leading = +1   -> COMPRESSED: this kv is an e-token handle; the
 *                       compression algorithm reads the rest of the barrel and
 *                       decompresses it back to the ORIGINAL token tuple via
 *                       the recallable etoken(e1) table.
 *     leading = -1/0 -> NOT compressed: the kv is the raw token; there is no
 *                       etoken to expand (no tuple savings).
 *
 * So the compression ALGO branches on the leading bit: if 1 it decompresses
 * (kv holds a compact etoken handle instead of the full tuple => KV-SPACE
 * SAVINGS); if <=0 it treats the kv as the raw token. The savings number =
 * how much kv space the compression reclaims relative to the uncompressed form.
 * ------------------------------------------------------------------------ */

/** The 1-bit compression identifier: +1 = compressed, 0 = not compressed. */
export function kvCompressionFlag(compressed) {
  return compressed ? 1 : 0; // "not compressed = -1/0, compressed = 1"
}

/**
 * Build a token's KV BARREL with the LEADING-VALUE compression flag.
 * A fixed-width ternary vector (true-ternary space) whose FIRST element is the
 * 1-bit compression identifier and the remainder carries the value:
 *   - compressed=true : barrel[0]=+1, the rest derive from the etoken id
 *     (a compact handle that decompresses to the full tuple -> kv-space savings).
 *   - compressed=false: barrel[0]=0 (or -1), the rest IS the token's own
 *     ternary value (uncompressed — no savings).
 * `rawTokenId` is the token whose kv we are tagging. Returns the barrel.
 */
export function kvBarrel(rawTokenId, { compressed = false, width = 32, etokenId = null } = {}) {
  const n = Math.max(2, Math.floor(Number(width) || 32));
  const base = Number(etokenId != null ? etokenId : rawTokenId);
  const index = (base - ETOKEN_BASE()) % ETOKEN_COUNT();
  const barrel = new Array(n);
  barrel[0] = kvCompressionFlag(compressed); // THE 1-BIT LEADING COMPRESSION FLAG
  if (compressed) {
    // Encode the etoken's low INDEX positionally in base-3 (digits -1|0|+1 ->
    // 0|1|2) across the barrel, so the compression algo can DECODE the exact
    // etoken handle and decompress it. This makes the flag -> handle = exact.
    let rem = index;
    for (let i = 1; i < n; i++) {
      const d = rem % 3;           // 0|1|2
      barrel[i] = d === 0 ? -1 : (d === 1 ? 0 : 1); // map to {-1,0,+1}
      rem = Math.floor(rem / 3);
    }
  } else {
    // Not compressed: the rest of the barrel carries the token's OWN value
    // digits (stable hash), no etoken handle, no savings.
    for (let i = 1; i < n; i++) barrel[i] = ternDigit(base, i);
  }
  return barrel;
}

/**
 * THE COMPRESSION ALGORITHM. Reads the LEADING value of a kv barrel to decide
 * whether the token's kv is compressed, then (if compressed) decompresses the
 * etoken handle back to its ORIGINAL token tuple using the recallable
 * etoken(e1) table. Returns { compressed, decoded, tuple, label }.
 */
export function kvCompressionAlgo(barrel) {
  if (!Array.isArray(barrel) || !barrel.length) return { compressed: false, decoded: [] };
  const lead = Number(barrel[0]);
  const compressed = lead === 1; // only +1 means compressed
  // Decode the etoken handle from the remaining digits (ternary mash) so we can
  // look it up: rebuild the deterministic etoken id (base + index).
  let eId = null;
  if (compressed) {
    // The rest of the barrel (digits 1..) positionally holds the etoken's low
    // index in base-3 (LSD first, matching kvBarrel): -1|0|+1 -> 0|1|2. Walk
    // from the LEAST-significant place (barrel[1]) up, exactly as the encoder
    // wrote it, so the exact etoken handle is recovered for decompression.
    let pow = 1;
    let idx = 0;
    for (let i = 1; i < barrel.length && pow < ETOKEN_COUNT(); i++) {
      const d = Number(barrel[i]);       // -1|0|+1
      idx += (d + 1) * pow;              // -> 0|1|2 at place pow
      pow *= 3;
    }
    eId = ETOKEN_BASE() + (idx % ETOKEN_COUNT());
    const t = etoken(eId);
    return { compressed: true, decoded: t ? t.slice() : [], tuple: t ? t.slice() : [], eId };
  }
  return { compressed: false, decoded: [], eId };
}

/**
 * KV-SPACE SAVINGS of compressing a token's kv into an etoken handle.
 *   - uncompressedBytes = kv size of the RAW token span (its tuple per element).
 *   - compressedBytes   = kv size of holding ONE etoken handle (compact).
 *   - savingsRatio      = 1 - compressed/uncompressed (>=0 means we saved space).
 * Returns { savingsRatio, uncompressedBytes, compressedBytes, tokensSaved }.
 */
export function kvSpaceSaving(rawTokenIds, etokenId = null, bytesPerElement = 2) {
  const tuple = effectiveTuple(rawTokenIds);
  const nRaw = tuple.length || 1;
  const uncompressedBytes = nRaw;                 // 1 element per original token
  const compressedBytes = etokenId != null ? 1 : nRaw; // 1 handle if etokenized
  const savingsRatio = uncompressedBytes > 0
    ? Math.max(0, 1 - compressedBytes / uncompressedBytes)
    : 0;
  return { savingsRatio, uncompressedBytes, compressedBytes, tokensSaved: nRaw - compressedBytes };
}


/**
 * Store the ternary value onto a recorded etoken (idempotent): persists
 * `ternary` (the true-ternary signature of the tuple) in Etokens.json so the
 * e-token's ternary value is recallable like its tuple. Called by
 * putEtoken() so every recorded etoken carries both its tuple AND ternary value.
 */
export function setEtokenTernary(id, vector) {
  if (!_Etokens) initEtokens();
  const key = String(id);
  if (_Etokens.tokens[key] === undefined) return null;
  if (!_Etokens.ternary) _Etokens.ternary = {};
  _Etokens.ternary[key] = (vector || []).map((v) => Math.max(-1, Math.min(1, Math.round(Number(v) || 0))));
  return _Etokens.ternary[key];
}

/** Recall the true-ternary value of an etoken (if stored); else compute it. */
export function etokenTernaryOf(eId) {
  if (!_Etokens) return null;
  const t = _Etokens.tokens[String(eId)];
  if (!Array.isArray(t)) return null;
  if (_Etokens.ternary && Array.isArray(_Etokens.ternary[String(eId)])) {
    return _Etokens.ternary[String(eId)].slice();
  }
  return etokenTernary(t).vector;
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

/* ==========================================================================
 * HIERARCHICAL / NESTED E-TOKENS  (the user's "etoken that contains etokens
 * + non etokens" — recursive context compression)
 *
 * An e-token's CONTENT can be a SEQUENCE OF ITEMS, where each item is either
 * a RAW token id or ANOTHER e-token id (in the reserved range). That lets a
 * repeated block of e-tokens collapse into ONE parent e-token id:
 *
 *     etoken(A) = [t1, t2, t3]
 *     etoken(B) = [t4, t5]
 *     etoken(C) = [A, B, t6]        <- C CONTAINS etokens (A,B) + a raw token
 *
 *     etoken(C) flattens -> [t1,t2,t3, t4,t5, t6]      (fully decoded, lossless)
 *
 * This is RECURSIVE ("much more compression"): a long repetitive prompt (the
 * 41k shader) can be stored as a TREE of e-token ids instead of the flat token
 * stream, so the KV / context footprint shrinks super-linearly when sequences
 * repeat. And because each e-token is a RECALLABLE, content-addressed anchor
 * (a "stronghold for memory rot"), repeated regions become durable IDs that
 * survive context pruning — the raw tokens can be dropped but the meaning is
 * pinned by the e-token, so forgetful conversations are much harder.
 *
 * BACKWARD COMPAT: `tokens[eId]` ALWAYS holds the FLATTENED (fully-expanded)
 * raw-token tuple, so every existing consumer (etoken(), scoring, delegation,
 * KV, ternary) keeps working unchanged. The nested structure lives in the new
 * `content[eId]` map; `etoken(eId)` flattens it recursively.
 * -------------------------------------------------------------------------- */

/** True if `id` is a BASE e-token id (lives in the reserved e-token range). */
export function isBaseEtokenId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n >= ETOKEN_BASE() && n < ETOKEN_BASE() + ETOKEN_COUNT();
}

/** True if `id` is a HIERARCHICAL PARENT e-token id (the disjoint store range). */
export function isParentEtokenId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n >= PARENT_BASE() && n < PARENT_BASE() + PARENT_COUNT();
}

/** True if `id` is an ARRAY-INDICATOR id (the compact array-promise range). */
export function isArrayIndicatorId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n >= IND_BASE() && n < IND_BASE() + IND_COUNT();
}

/** True if `id` is ANY e-token id (base, hierarchical parent, or array-indicator). */
export function isEtokenId(id) {
  return isBaseEtokenId(id) || isParentEtokenId(id) || isArrayIndicatorId(id);
}

/**
 * Content-address a HIERARCHICAL PARENT id from its FLATTENED raw-token tuple.
 * Maps into the DISJOINT parent range [PARENT_BASE(), PARENT_BASE()+count) so
 * a parent can never collide with a base/child etoken id (no self-reference
 * cycles) while remaining deterministic: the same flat tuple ALWAYS yields the
 * same parent id (recallable + content-addressed, a "stronghold for memory
 * rot"). Returns { id, index, label }.
 */
export function parentEtokenIdFor(flatIds) {
  const tuple = effectiveTuple(flatIds);
  const rawSum = tuple.reduce((a, v) => a + v, 0);
  const index = Math.abs(Math.trunc(rawSum)) % PARENT_COUNT();
  const id = PARENT_BASE() + index;
  return { id, index, label: `p${index + 1}` };
}

/* --------------------------------------------------------------------------
 * ARRAY-INDICATOR ("funny math": the compact array-promise / trump card)
 *
 * A token indicator that DECLARES: "the following n tokens are stored as a
 * representation of THIS ARRAY". Instead of emitting the structural token
 * spread of `[1,2,3,4,5,6,7,8,9,0]` (the brackets, commas, and each value as
 * separate tokens — "n tokens"), we emit ONE array-indicator id whose CONTENT
 * is the integer VALUES `[1,2,3,4,5,6,7,8,9,0]` directly:
 *
 *     arrayIndicatorFor([1,2,3,4,5,6,7,8,9,0]) -> id "q1234"
 *     etoken(q1234)   -> [1,2,3,4,5,6,7,8,9,0]     (a PROMISE KEPT within n)
 *     etokenDeep(q)   -> [1,2,3,4,5,6,7,8,9,0]     (the interior array values)
 *
 * "we aren't bound by the rules of the current ecosystem or the previous
 * tokens in formula to positions; all contain sequence as a prefix" — the
 * values do NOT have to be a position-prefix of anything; we store the bare
 * array. In TRAINING this is the LAST-STEP TRUMP CARD: when many experts are
 * TIED (or an expert is about to die on a tie), one that emits the CORRECT
 * array-indicator (a promise it will keep within n tokens) WINS — the
 * "I'm not gonna die" card.
 * ------------------------------------------------------------------------ */

/**
 * Content-address an ARRAY-INDICATOR id from an array of integer values. Maps
 * into the DISJOINT indicator range so it can never collide with a base/parent
 * id, and is deterministic (same values -> same id). Returns { id, values,
 * index, label }.
 */
export function arrayIndicatorIdFor(values) {
  const arr = (values || []).map(Number).filter((v) => Number.isFinite(v));
  const rawSum = arr.reduce((a, v) => a + v, 0) + arr.length * 0x9e3779b9; // salt by length so [1,2] != [1,2,3-part]
  const index = Math.abs(Math.trunc(rawSum)) % IND_COUNT();
  const id = IND_BASE() + index;
  return { id, index, label: `q${index + 1}`, values: arr };
}

/**
 * Record + return an ARRAY-INDICATOR etoken: content = the array VALUES (the
 * interior numbers, without structural `[ ] ,` tokens — "funny math"). It is a
 * promise kept within n tokens: etoken(id) returns the full array. Deterministic
 * (same array -> same indicator), so repeated arrays collapse to one id.
 * Returns { id, values, content, isNew }.
 */
export function putArrayIndicator(values, { live = true, audit = null, save = true } = {}) {
  if (!_Etokens) initEtokens();
  const arr = (values || []).map(Number).filter((v) => Number.isFinite(v));
  if (!arr.length) return null;
  const { id } = arrayIndicatorIdFor(arr);
  const key = String(id);
  const existing = _Etokens.content ? _Etokens.content[key] : undefined;
  const isNew = existing === undefined && _Etokens.tokens[key] === undefined;
  if (!_Etokens.content) _Etokens.content = {};
  // Prefer keeping the LONGEST/most-detailed content for a colliding id.
  if (existing === undefined || arr.length >= (existing || []).length) {
    _Etokens.content[key] = arr.slice();
    _Etokens.tokens[key] = arr.slice();
    setEtokenTernary(key, etokenTernary(arr).vector);
  }
  if (isNew) {
    if (live) _Etokens.stats.live_added = (_Etokens.stats.live_added || 0) + 1;
    else _Etokens.stats.base_etokens = (_Etokens.stats.base_etokens || 0) + 1;
    _Etokens.stats.total = (_Etokens.stats.total || 0) + 1;
    if (audit) {
      _Etokens.history.push({ ts: Date.now(), id: key, content: arr, live, audit });
      if (_Etokens.history.length > 200) _Etokens.history.shift();
    }
  }
  _Etokens.stats.updated_at = new Date().toISOString();
  if (save !== false) saveEtokens();
  return { id: key, values: arr, content: arr.slice(), isNew };
}

/** The array VALUES promised by an array-indicator id (or null if not one). */
export function arrayIndicatorOf(eId) {
  if (!isArrayIndicatorId(eId) || !_Etokens) return null;
  const c = _Etokens.content ? _Etokens.content[String(eId)] : null;
  if (Array.isArray(c)) return c.slice();
  const t = _Etokens.tokens[String(eId)];
  return Array.isArray(t) ? t.slice() : null;
}

/**
 * The TRUMP-CARD scoring helper. When many experts are TIED on the otoken
 * sequence, the expert that emitted an ARRAY-INDICATOR whose PROMISED array
 * (decompressed values) matches the SAVED target sequence WINS — "a promise
 * kept within n tokens" / the "I'm not gonna die" card.
 *
 *   savedValues        : the target array to match (e.g. the saved otoken
 *                        content, or the tie-break next-otoken tuple).
 *   candidateIndId     : the array-indicator id an expert emitted (or null).
 *   tieThreshold       : how close the rewards must be to count as a tie.
 *   expertReward       : the expert's current reward.
 *   bestOtherReward    : the best OTHER expert reward (the one it ties/beats).
 * Returns { isTrump, matched, values, promiseKept } — isTrump when the
 * candidate is a correct array-indicator that ties-or-beats the best and its
 * promised array equals savedValues (the promise is KEPT).
 */
export function arrayIndicatorTrump({ savedValues, candidateIndId, expertReward = 0, bestOtherReward = 0, tieThreshold = 0.5 } = {}) {
  if (candidateIndId == null || !isArrayIndicatorId(candidateIndId)) {
    return { isTrump: false, matched: false, promiseKept: false, values: [] };
  }
  const promised = arrayIndicatorOf(candidateIndId);
  const saved = (savedValues || []).map(Number);
  const matched = !!promised && promised.length === saved.length
    && promised.every((v, i) => v === saved[i]);
  const withinTie = Math.abs(Number(expertReward) - Number(bestOtherReward)) <= Math.max(1e-9, Number(tieThreshold));
  return {
    isTrump: matched && withinTie,
    matched,
    promiseKept: matched,
    values: promised || [],
  };
}


/**
 * Recursively flatten a list of CONTENT ITEMS into a fully-expanded raw-token
 * tuple. Each item is a number: either a RAW token id (non-etoken) or a NESTED
 * e-token id (in the reserved range) that is itself expanded. Cycle-guarded so
 * a corrupt store can never hang the decoder. Returns a flat array of raw ids.
 */
export function flattenItems(items, seen = new Set()) {
  const out = [];
  for (const item of items || []) {
    const v = Number(item);
    if (!Number.isFinite(v)) continue;
    if (isEtokenId(v)) {
      if (seen.has(v)) continue; // cycle guard — never re-enter the same id
      const key = String(v);
      const sub = (_Etokens && _Etokens.content && Array.isArray(_Etokens.content[key]))
        ? _Etokens.content[key]
        : ((_Etokens && Array.isArray(_Etokens.tokens[key])) ? _Etokens.tokens[key] : null);
      if (Array.isArray(sub) && sub.length) {
        seen.add(v);
        out.push(...flattenItems(sub, seen));
        seen.delete(v);
      }
    } else {
      out.push(v);
    }
  }
  return out;
}

/**
 * `etoken(eId)` -> the FULLY-DECODED raw-token tuple (recursively expanded if
 * the e-token contains nested e-tokens). Backward compatible: if the store has
 * no `content` for this id (flat/legacy e-token), returns the stored tuple.
 */
export function etoken(eId) { // overrides the flat-only version below
  if (!_Etokens) return null;
  const key = String(eId);
  if (_Etokens.content && Array.isArray(_Etokens.content[key])) {
    return flattenItems(_Etokens.content[key]);
  }
  const t = _Etokens.tokens[key];
  return Array.isArray(t) ? t.slice() : null;
}

/**
 * `etokenDeep(eId)` -> the NESTED content structure (the item list of raw-token
 * ids and nested e-token ids), for recursive inspection. Returns null if the
 * e-token has no nested structure (it is a flat/legacy e-token).
 */
export function etokenDeep(eId) {
  if (!_Etokens || !_Etokens.content) return null;
  const key = String(eId);
  if (Array.isArray(_Etokens.content[key])) return _Etokens.content[key].slice();
  return null;
}

/**
 * Content-address a PARENT e-token from a list of content ITEMS. The parent's
 * id is a pure function of the FLATTENED effective tuple, so the SAME decoded
 * content ALWAYS maps to the SAME parent id (deterministic, recallable). Stores
 * the nested `content` (raw + e-token refs) AND the flattened `tokens` tuple so
 * etoken() stays lossless. Returns { id, content, flat, isNew }.
 */
export function superEtokenFromItems(items, { live = true, audit = null, save = true } = {}) {
  if (!_Etokens) initEtokens();
  const flat = flattenItems(items);
  if (!flat.length) return null;
  // Keep the ORIGINAL item list (raw + nested e-token refs) exactly for
  // recursive structure; flatten only for the deterministic id + flat table.
  // CRITICAL: parents content-address in the DISJOINT parent range, so a parent
  // id can NEVER equal one of its own child/base ids (no self-reference cycle).
  const { id, label, index } = parentEtokenIdFor(flat);
  const key = String(id);
  const eff = effectiveTuple(flat);
  const existingContent = _Etokens.content ? _Etokens.content[key] : undefined;
  const isNew = existingContent === undefined && _Etokens.tokens[key] === undefined;
  const itemArr = (items || []).map(Number).filter((v) => Number.isFinite(v));
  if (!_Etokens.content) _Etokens.content = {};
  // Record BOTH the nested structure and the flattened tuple. If the id already
  // existed (collision on the flattened sum) we keep the richer nested form.
  if (existingContent === undefined || itemArr.length >= (existingContent || []).length) {
    _Etokens.content[key] = itemArr;
    _Etokens.tokens[key] = eff;
    setEtokenTernary(key, etokenTernary(eff).vector);
  }
  if (isNew) {
    if (live) _Etokens.stats.live_added = (_Etokens.stats.live_added || 0) + 1;
    else _Etokens.stats.base_etokens = (_Etokens.stats.base_etokens || 0) + 1;
    _Etokens.stats.total = (_Etokens.stats.total || 0) + 1;
    if (audit) {
      _Etokens.history.push({ ts: Date.now(), id: key, content: itemArr, flat: eff, live, audit });
      if (_Etokens.history.length > 200) _Etokens.history.shift();
    }
  }
  _Etokens.stats.updated_at = new Date().toISOString();
  if (save !== false) saveEtokens();
  return { id: key, content: itemArr, flat: eff, label, index, isNew };
}

/**
 * Find the most frequent CONTIGUOUS SUBSEQUENCE (bigram or trigram, or any
 * sweep length) of length>=2 among an item list. Returns the highest-count
 * subsequence with count >= minRepeat (a repeat is what makes a parent e-token
 * worth creating), or null if none. `len` lets callers sweep length.
 */
function mostFrequentSubseq(items, len, minRepeat = 2) {
  const counts = new Map();
  for (let i = 0; i + len <= items.length; i++) {
    const key = JSON.stringify(items.slice(i, i + len));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null, bestCount = 0;
  for (const [k, c] of counts) {
    if (c >= minRepeat && c > bestCount) { bestKey = k; bestCount = c; }
  }
  return bestKey ? { subseq: JSON.parse(bestKey), count: bestCount } : null;
}

/**
 * GREEDY RECURSIVE E-TOKEN PACKING ("hierarchical etokenize"). 
 *   Level 0: base e-tokens from `etokenize(ids)` (content = raw chunk tuple).
 *   Then repeatedly find the most-repeated contiguous subsequence of e-token/
 *   raw items, fuse it into a PARENT e-token (content = that subsequence), and
 *   replace every occurrence. Repeating this NESTS parents inside parents
 *   ("etoken that contains etokens"), which is what gives "much more
 *   compression" on repetitive prompts.
 *
 * Returns { created, base, items }: `created` = list of {id, content, flat,
 * level} to putEtoken; `base` = the level-0 base e-tokens; `items` = the final
 * packed top-level item list (parent ids + leftover raw).
 */
export function hierarchicalEtokenize(ids, opts = {}) {
  const chunkSize = Math.max(1, Math.floor(Number(opts.chunkSize ?? 4)) || 4);
  const maxDepth = Math.max(1, Math.floor(Number(opts.maxDepth ?? 3)) || 3);
  const minRepeat = Math.max(2, Math.floor(Number(opts.minRepeat ?? 2)) || 2);
  const maxFuses = Math.max(1, Math.floor(Number(opts.maxFuses ?? 64)) || 64);
  const sweepLen = Math.max(2, Math.floor(Number(opts.sweepLen ?? 3)) || 3); // try up to this length
  const arr = (ids || []).filter((v) => Number.isFinite(Number(v)));
  if (arr.length < 2) return { created: [], base: [], items: arr.slice() };

  // LEVEL 0 — base e-tokens (each content = its raw chunk tuple).
  const base = etokenize(arr, chunkSize);
  let items = base.map((b) => b.id).slice(); // top-level item list = base e-token ids
  const created = [];
  const depthOf = new Map(); // etokenId -> depth
  base.forEach((b) => depthOf.set(String(b.id), 1));

  let fuses = 0;
  for (let depth = 2; depth <= maxDepth && fuses < maxFuses; depth++) {
    let fusedThisPass = false;
    for (let len = Math.min(sweepLen, items.length); len >= 2 && !fusedThisPass; len--) {
      const hit = mostFrequentSubseq(items, len, minRepeat);
      if (!hit) continue;
      // Create a parent e-token whose CONTENT = the repeated subsequence
      // (which may itself contain nested e-token ids -> recursion).
      const par = superEtokenFromItems(hit.subseq, { live: true, audit: `hier@depth${depth}`, save: false });
      if (!par) continue;
      created.push({ id: par.id, content: par.content, flat: par.flat, level: depth });
      depthOf.set(par.id, depth);
      // Replace every occurrence of the subsequence with the parent id.
      const nxt = [];
      const sl = hit.subseq.length;
      const sig = hit.subseq.map(String).join(",");
      for (let i = 0; i < items.length; ) {
        const seg = items.slice(i, i + sl).map(String).join(",");
        if (seg === sig) { nxt.push(Number(par.id)); i += sl; }
        else { nxt.push(items[i]); i += 1; }
      }
      items = nxt;
      fusedThisPass = true;
      fuses++;
      if (fuses >= maxFuses) break;
    }
    if (!fusedThisPass) break; // no reducible repeats left at this depth
  }
  return { created, base, items };
}

/** Hierarchy metrics over the store (for the UI / /etokens endpoint). */
export function etokenHierarchyStats() {
  let nestedCount = 0, maxDepth = 0, sumFlat = 0, sumContent = 0;
  const content = _Etokens?.content || {};
  for (const k of Object.keys(content)) {
    const items = content[k];
    if (!Array.isArray(items) || !items.length) continue;
    const hasNested = items.some((it) => isEtokenId(it));
    if (hasNested) nestedCount++;
    sumContent += items.length;
    // depth = 1 + max nested depth.
    const deep = (id, seen) => {
      if (seen.has(id)) return 1;
      seen.add(id);
      const c = content[String(id)];
      let d = 1;
      if (Array.isArray(c)) {
        for (const it of c) if (isEtokenId(it)) d = Math.max(d, 1 + deep(it, seen));
      }
      seen.delete(id);
      return d;
    };
    maxDepth = Math.max(maxDepth, deep(Number(k), new Set()));
  }
  const flatTok = _Etokens?.tokens || {};
  for (const k of Object.keys(flatTok)) if (Array.isArray(flatTok[k])) sumFlat += flatTok[k].length;
  return {
    nested_count: nestedCount,
    max_etoken_depth: maxDepth,
    tree_count: Object.keys(content).length,
    total_content_items: sumContent,
    total_flat_tokens: sumFlat,
  };
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
    version: 3,           // v3 adds `content` (hierarchical/nested e-tokens)
    base: false,          // true once built from the pre-tokenized token DB
    etoken_base: ETOKEN_BASE(),
    etoken_count: ETOKEN_COUNT(),
    tokens: {},           // { "<etokenId>": [origIds...] }  -- FLATTENED tuple, etoken(e) decompresses here
    content: {},          // { "<etokenId>": [item...] }       -- NESTED structure (raw ids + e-token refs)
    ternary: {},          // { "<etokenId>": [-1|0|+1,...] }    -- the e-token's TRUE-TERNARY value
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
export function putEtoken({ id, tuple, live = true, audit = null, save = true, content = null }) {
  if (!_Etokens) initEtokens();
  const key = String(id);
  const eff = effectiveTuple(tuple);
  const existing = _Etokens.tokens[key];
  const isNew = existing === undefined;
  // Keep the ORIGINAL tuple exactly (not the deduped one) so decompression is
  // lossless; the effective/dedup form is used only for the deterministic hash.
  _Etokens.tokens[key] = Array.isArray(tuple) ? tuple.map(Number) : eff;
  // If a NESTED structure is provided (the e-token CONTAINS e-tokens + raw
  // tokens), record it so etoken() can flatten it recursively. Otherwise a
  // flat e-token has no `content` entry (its tuple IS the content).
  if (content != null) {
    const itemArr = (Array.isArray(content) ? content : []).map(Number).filter((v) => Number.isFinite(v));
    if (itemArr.length) {
      if (!_Etokens.content) _Etokens.content = {};
      _Etokens.content[key] = itemArr;
    }
  }
  // Store the TRUE-TERNARY value of the etoken too, so the expert can store +
  // reliably use the e-token as a value in ternary space.
  setEtokenTernary(key, etokenTernary(tuple).vector);
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
    // Legacy v1/v2 stores have no `content` map — ensure it exists (empty) so
    // the hierarchical path doesn't choke on old data.
    if (loaded.content === undefined) loaded.content = {};
    _Etokens = loaded;
    if (Number(loaded.version) < 3) loaded.version = 3;
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
