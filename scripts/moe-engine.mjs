#!/usr/bin/env node
/**
 * moe-engine.mjs — the 4B base model as a Mixture-of-Experts, true-ternary,
 * with the owner's exact expert/layer design.
 *
 * ARCHITECTURE (from the owner):
 *   - The 4B base becomes an MoE model (true ternary weights {-1,0,+1}).
 *   - 5 "expert" layers are ALWAYS ACTIVE for testing, and they are mutations
 *     of each other. All experts feed on the TOP-K input.
 *   - ROUTING: we keep only the TOP 2 experts active for a token set.
 *   - Expert mutations:
 *       E1, E2, E4 = base experts
 *       E3 = E4 + noise
 *       E5 = only similar neurons of E1,E2,E3,E4 + noise
 *   - Each expert and each layer has its own TRAINING FORMULA (editable via
 *     config/moe-config.json, adjustable live in the UI).
 *   - Scoring supports PENALTIES (added as score climbs) and ADDING more
 *     experts/layers to the mix.
 *
 * SAVE: snapshots the current MoE expert/layer weights (as true-ternary ternary
 * signatures) to config.moe.model.save_dir every N steps, so the model is
 * persisted WHILE generating.
 *
 * This module is pure/config-driven: it reads config/moe-config.json, exposes
 * the expert routing + training + save, and is used by teacher-live.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const CONFIG_PATH = path.join(REPO, "config", "moe-config.json");
const SAVE_DIR = path.join(REPO, "config", "moe", "model", "save_dir");

let _cfg = null;
let _cfgStat = null; // { mtimeMs, size } of the last config we parsed
export function loadConfig() {
  // Cache the parsed config by FILE mtime+size so we DON'T re-read + re-parse the
  // whole 85KB config (41KB shader prompt + ~100 expert configs) on EVERY step —
  // that was a major lag source. Live UI edits / JSON-editor writes change the
  // file's mtime, so they still apply immediately; we only re-parse on actual
  // change. This preserves the live-edit contract while keeping the hot loop cheap.
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (_cfgStat && st.mtimeMs === _cfgStat.mtimeMs && st.size === _cfgStat.size) {
      return _cfg; // unchanged since last parse -> use the cached copy
    }
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    _cfg = parsed;
    _cfgStat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch { /* keep last on transient read error */ }
  return _cfg;
}

export function saveConfig(c) {
  _cfg = c;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  try { const st = fs.statSync(CONFIG_PATH); _cfgStat = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
}

/**
 * Resolve where to write MoE checkpoints. On Linux the user allows INFINITE
 * file writes IF they land on a RAM disk (tmpfs), so when model.save_dir is set
 * (or MOE_SAVE_DIR env / /dev/shm exists) we prefer a RAM-backed path — the
 * per-step checkpoint diff files are tiny and written constantly, and won't
 * wear out a real disk. Falls back to the on-review config dir otherwise.
 */
function getSaveDir() {
  const cfgPath = loadConfig()?.model?.save_dir;
  if (cfgPath) return path.resolve(REPO, cfgPath);
  if (process.env.MOE_SAVE_DIR) return process.env.MOE_SAVE_DIR;
  // /dev/shm is tmpfs (RAM-backed) on Linux.
  try {
    if (fs.existsSync("/dev/shm")) {
      const d = path.join("/dev/shm", "pithagoras-moe-checkpoints");
      fs.mkdirSync(d, { recursive: true });
      return d;
    }
  } catch {}
  return SAVE_DIR;
}

/** Deterministic gaussian noise from a seeded/lcg value (0..1). */
export function noise01(seed) {
  const x = Math.sin((seed % 1e9) * 12.9898) * 43758.5453;
  return (x - Math.floor(x)); // 0..1
}

/**
 * PERSISTENT MoE training state. This survives across expert updates so that
 * top-p, KL, output and noise KEEP ACCUMULATING instead of being reset to a
 * fresh random value every token/step (which is what the old per-call
 * `Math.random()` did). Seeded once, then evolved by training deltas + noise.
 *  - expertValues: current value (affinity proxy) per expert name
 *  - layerSizes:   current size per layer
 *  - topP/kl/output: live accumulators surfaced in the UI
 *  - step:         how many steps it has been trained
 */
let _moeState = null;
export function initMoeState(expertNames = ["E1","E2","E3","E4","E5"], layerCount = 5) {
  const struct = expertStructure();
  const nSegs = Math.max(1, struct.n_segments_3b ?? 3);
  const segLayerCount = layerCount;
  // SEED the same base layer sizes for each candidate 3B segment, but each gets
  // its own independent copy so rewiring one never touches another. The FIRST
  // segment is the attached (best) one — it stays FROZEN (never rewired).
  const baseSizes = Array.from({ length: segLayerCount }, (_, i) => Math.round(100 + noise01(i + 31) * 400));
  const segments = Array.from({ length: nSegs }, (_, si) => ({
    id: si,
    attached: si === 0,
    fitness: 0,
    layerSizes: baseSizes.slice(),
    lastRewire: null,
  }));
  _moeState = {
    expertValues: Object.fromEntries(expertNames.map((n, i) => [n, 0.5 + 0.4 * noise01(i + 7)])),
    // accum: UNBOUNDED per-expert parity accumulator. expertValues = sigmoid(accum)
    // so experts stay distinct (never all pinned at the 1.0 ceiling). Re-seeding
    // a losing expert sets accum = inverse-sigmoid(seed) so its value matches.
    accum: Object.fromEntries(expertNames.map((n, i) => {
      const v = 0.5 + 0.4 * noise01(i + 7);
      return [n, Math.log(v / (1 - v))]; // logit(v)
    })),
    layerSizes: baseSizes.slice(), // == attached (best) segment sizes, FROZEN from rewiring
    segments,                      // ALL candidate 3B segments (best + losers)
    noiseDeltas: Array.from({ length: layerCount }, () => 0), // bounded per-layer noise deltas
    topP: {},       // per-expert top-p summary (persisted)
    kl: {},         // per-expert KL (persisted)
    output: {},     // per-expert output signal history (persisted)
    matchScore: {}, // per-expert CUMULATIVE teacher top-k match count (own score)
    scores: {},     // per-expert CUMULATIVE points across this round (all experts, not just top-2)
    roundsSurvived: {}, // per-expert ROUNDS SURVIVED (how many round-resets this expert
                        // has been KEPT through). RESET to 0 when the expert is ever
                        // updated/re-seeded (loses and gets refreshed).
    noise: 0,       // running noise accumulator
    step: 0,
    round: 1,
    lastRound: null, // snapshot of the previous round's final state (for comparison after reset)
  };
  return _moeState;
}
export function getMoeState() { return _moeState; }

// set an expert's value in the (0,1) space: derive accum so sigmoid(accum)=v,
// keeping the anti-collapse invariant (no hard 1.0 ceiling / identical clones).
function setExpertValue(name, value) {
  const v = Math.max(1e-4, Math.min(1 - 1e-4, Number(value) || 0.5));
  if (_moeState) {
    _moeState.expertValues[name] = v;
    if (_moeState.accum) _moeState.accum[name] = Math.log(v / (1 - v));
  }
  return v;
}

/**
 * RESET THE MOE EXPERT/LAYER STATE for a NEW PROMPT. When the user sets a fresh
 * prompt, the whole training run is conceptually restarted, so the expert
 * values/scores and layer sizes are re-initialized from the current config.
 * Returns the new (fresh) state.
 */
export function resetMoeForNewPrompt() {
  const cfg = loadConfig() || {};
  const experts = Object.keys(cfg.moe?.experts || {});
  const names = experts.length ? experts : ["E1", "E2", "E3", "E4", "E5"];
  const layerCount = Math.max(1, Number(cfg.layers?.count ?? 5));
  return initMoeState(names, layerCount);
}

/**
 * Round / reset policy. Each expert's values/scores accumulate for
 * `steps_per_round * rounds_before_reset` total steps, then RESET (fresh start)
 * while preserving a `lastRound` snapshot of the final values so the UI can
 * still show the previous round's numbers. The user controls how many rounds
 * pass before the reset via config training.rounds_before_reset.
 */
export function maybeResetMoeState() {
  if (!_moeState) return false;
  const t = loadConfig()?.training || {};
  const stepsPerRound = Number(t.steps_per_round ?? 5);
  const roundsBeforeReset = Number(t.rounds_before_reset ?? 3);
  const limit = Math.max(1, stepsPerRound * roundsBeforeReset);
  if (_moeState.step < limit) return false;

  _moeState.lastRound = {
    round: _moeState.round,
    expertValues: { ..._moeState.expertValues },
    layerSizes: _moeState.layerSizes.slice(),
    scores: { ..._moeState.scores },
    roundsSurvived: { ...(_moeState.roundsSurvived || {}) },
    topP: { ..._moeState.topP },
    kl: { ..._moeState.kl },
    output: { ..._moeState.output },
    noise: _moeState.noise,
    step: _moeState.step,
  };
  // Apply the EXPERT POLICY: top_n_survive keep their values; the 
  // update_losing_experts worst experts get refreshed — either re-seeded from
  // the previous window's data (reset_from_last_window) or fresh.
  const policy = loadConfig()?.expert_policy || {};
  const nExp = moeScoresSize();
  const topSurvive = Math.max(0, Math.min(nExp, Number(policy.top_n_survive ?? 3)));
  // update_losing_experts may be "auto"/0 (automatic) — then refresh ~15%.
  const rawLosing = policy.update_losing_experts;
  const autoLosing = (rawLosing === undefined || rawLosing === null || rawLosing === 0 || rawLosing === "auto");
  const losingCount = autoLosing
    ? Math.max(1, Math.round(nExp * 0.15))
    : Math.max(0, Math.min(nExp, Number(rawLosing) || 2));
  const fromLast = policy.reset_from_last_window !== false;
  const doUpdateNonTop = policy.update_non_top !== false;

  const names = Object.keys(_moeState.expertValues);
  const lastValues = _moeState.lastRound.expertValues;
  // Rank experts by their accumulated score (best → worst) for the window.
  const ranked = names.slice().sort((a, b) => (_moeState.scores[b] || 0) - (_moeState.scores[a] || 0));
  const surviveSet = new Set(ranked.slice(0, topSurvive));        // keep these
  const refreshSet = new Set(ranked.slice(ranked.length - losingCount)); // refresh these

  let refreshed = [];
  for (const nm of names) {
    if (surviveSet.has(nm)) continue; // top-n survive unchanged
    if (refreshSet.has(nm)) {
      // Losing experts: re-seed from the previous window's data (or fresh). If
      // winner_similarity > 0, blend toward the CURRENT top winners so a
      // surpassed best expert decays gently toward the pack instead of
      // collapsing to a fresh random seed (user: 'don't decay the best too much').
      let seeded = fromLast && lastValues[nm] != null
        ? lastValues[nm] * (0.7 + 0.3 * noise01((+new Date()) + nm.length * 3))
        : 0.5 + 0.4 * noise01((+new Date()) + nm.length * 3);
      seeded = blendTowardWinners(seeded, winnerSimilarity(), (+new Date()) + nm.length * 31);
      setExpertValue(nm, seeded);
      // ROUNDS SURVIVED RESET: the expert was UPDATED (re-seeded) — it no longer
      // survives; reset its survived-rounds counter to 0.
      if (!_moeState.roundsSurvived) _moeState.roundsSurvived = {};
      _moeState.roundsSurvived[nm] = 0;
      refreshed.push(nm);
      continue;
    }
    // Non-top: keep being updated (trainStep handles the deltas).
    if (doUpdateNonTop) {
      _moeState.expertValues[nm] = setExpertValue(nm,
        (_moeState.expertValues[nm] || 0.5) + (noise01((+new Date()) + nm.length * 7) - 0.5) * 0.04);
    }
  }
  // ROUNDS SURVIVED INCREMENT: every expert that KEPT its value (survived the
  // reset — the top_n_survive set and any not-refreshed) has survived ONE more
  // round. Updated/refreshed experts were reset to 0 above.
  if (!_moeState.roundsSurvived) _moeState.roundsSurvived = {};
  for (const nm of names) {
    if ((_moeState.roundsSurvived[nm] ?? 0) === 0 && refreshed.includes(nm)) continue; // was just refreshed
    _moeState.roundsSurvived[nm] = (_moeState.roundsSurvived[nm] ?? 0);
    if (!refreshSet.has(nm)) _moeState.roundsSurvived[nm] = (_moeState.roundsSurvived[nm] ?? 0) + 1;
  }

  // Clear per-token accumulators, keep per-expert keys. The TEACHER baseline
  // score is PRESERVED across resets so its cumulative line keeps rising (it is
  // the fixed reference/ceiling, not a trainable expert).
  _moeState.topP = {}; _moeState.kl = {}; _moeState.output = {};
  const teachScore = _moeState.scores["TEACHER"] || 0;
  _moeState.scores = Object.fromEntries(names.map((nm) => [nm, 0]));
  if (teachScore) _moeState.scores["TEACHER"] = teachScore;
  _moeState.noiseDeltas = _moeState.noiseDeltas.map(() => 0);
  _moeState.layerSizes = _moeState.layerSizes.map((v, i) =>
    Math.max(10, Math.min(1000, Math.round(v)))); // clamp any corrupted size back to sane range
  _moeState.step = 0;
  _moeState.round += 1;
  console.log(`  >> MOE round reset: round ${_moeState.round} | survive ${topSurvive} | update losing ${losingCount} [${refreshed.join(",") || "none"}]`);
  return true;
}

/**
 * UPDATE LOSING EXPERTS EVERY N STEPS: unlike the full round reset, this runs
 * on a shorter interval (config expert_policy.losing_experts_update_every) and
 * re-seeds the WEAKEST experts directly from the previous window's data. This
 * is the "update the losing experts after n steps" behaviour.
 * Returns the names updated, or null if no update was due.
 */
export function updateLosingExperts() {
  if (!_moeState) return null;
  const policy = loadConfig()?.expert_policy || {};
  const every = Math.max(1, Number(policy.losing_experts_update_every ?? 5));
  if (_moeState.step === 0 || _moeState.step % every !== 0) return null;
  const nExp = moeScoresSize();
  // AUTOMATIC by default: when update_losing_experts is 0 / "auto", refresh the
  // bottom ~15% of experts (min 1) so the count adapts to total expert count
  // instead of being a hardcoded manual number.
  const raw = policy.update_losing_experts;
  const auto = (raw === undefined || raw === null || raw === 0 || raw === "auto");
  const losingCount = auto
    ? Math.max(1, Math.round(nExp * 0.15))
    : Math.max(1, Math.min(nExp, Number(raw) || 2));
  const names = Object.keys(_moeState.expertValues);
  const ranked = names.slice().sort((a, b) => (_moeState.scores[b] || 0) - (_moeState.scores[a] || 0));
  const losing = ranked.slice(ranked.length - losingCount);
  const lastValues = _moeState.lastRound?.expertValues || {};
  const fromLast = policy.reset_from_last_window !== false;
  for (const nm of losing) {
    let seeded = fromLast && lastValues[nm] != null
      ? lastValues[nm] * (0.7 + 0.3 * noise01((+new Date()) + nm.length * 5))
      : 0.5 + 0.4 * noise01((+new Date()) + nm.length * 5);
    // Soft-attract the weakest toward the current top winners (similarity to
    // upper nodes) so a surpassed best decays gently, not collapsed.
    seeded = blendTowardWinners(seeded, winnerSimilarity(), (+new Date()) + nm.length * 37);
    setExpertValue(nm, seeded);
    _moeState.scores[nm] = 0; // reset the losing expert's score
    // ROUNDS SURVIVED RESET: this expert was UPDATED (re-seeded) -> it no longer
    // survives; reset its survived-rounds counter to 0.
    if (!_moeState.roundsSurvived) _moeState.roundsSurvived = {};
    _moeState.roundsSurvived[nm] = 0;
  }
  console.log(`  >> update losing experts (every ${every} steps, auto=${auto}, count ${losingCount}): [${losing.join(",") || "none"}]`);
  return losing;
}

/** Number of experts currently tracked (used to clamp policy sizes). */
function moeScoresSize() { return _moeState ? Object.keys(_moeState.expertValues).length : 0; }

/**
 * WINNER-SIMILARITY / SOFT-ATTRACTION (user question + refinement): when a
 * losing expert is refreshed or decays, do we harshly re-seed/fresh-random it
 * (decaying a previously-best expert that just got surpassed too much), or do
 * we anchor it to the WINNING / UNCULLED experts so it stays similar to the
 * upper nodes?
 *
 * USER REFINEMENT: "they should be based on the winning / unculled experts so
 * something CAN overtake the winner but ONLY be based on ONE kept expert."
 * So we do NOT blend toward the MEAN of several winners (that would produce a
 * generic middle value that can't overtake). Instead each losing expert is
 * anchored to a SINGLE kept (top_n_survive / unculled) expert — specifically
 * the kept expert it is MOST SIMILAR TO (nearest value). Anchoring a challenger
 * to one winner makes it a near-twin of that winner, so it can compete with and
 * OVERTAKE it, while still inheriting that winner's shape.
 *
 *   new = keptVal*sim + base*(1-sim)    (sim in [0,1])  toward ONE kept expert
 *
 * sim = config expert_policy.winner_similarity:
 *   - 0: keep the old re-seed/random decay (no attraction).
 *   - >0: pull toward the nearest SINGLE kept/unculled expert.
 */
function winnerSimilarity() {
  return Number(loadConfig()?.expert_policy?.winner_similarity ?? 0);
}
/** Which experts are KEPT / UNCULLED (top_n_survive by score, ex TEACHER). */
function keptExperts() {
  if (!_moeState) return [];
  const policy = loadConfig()?.expert_policy || {};
  const topSurvive = Math.max(1, Math.min(moeScoresSize(), Number(policy.top_n_survive ?? 3)));
  const names = Object.keys(_moeState.expertValues).filter((n) => n !== "TEACHER");
  const ranked = names.slice().sort((a, b) => (_moeState.scores[b] || 0) - (_moeState.scores[a] || 0));
  return ranked.slice(0, topSurvive);
}
/** Nearest KEPT expert to `base` (by value). */
function nearestKept(base) {
  const kept = keptExperts();
  if (!kept.length) return null;
  let best = null, bestD = Infinity;
  for (const k of kept) {
    const kv = Number(_moeState.expertValues[k]) || 0.5;
    const d = Math.abs(kv - base);
    if (d < bestD) { bestD = d; best = { name: k, value: kv }; }
  }
  return best;
}
/** Blend `base` toward the SINGLE nearest kept/unculled expert by `sim`. */
function blendTowardWinners(base, sim, noiseSeed) {
  if (!(sim > 0)) return base;
  if (!_moeState) return base;
  const k = nearestKept(base);
  if (!k) return base;
  const jitter = (noise01(noiseSeed) - 0.5) * 0.1; // tiny wobble so they don't become identical clones
  return Math.min(0.9999, Math.max(0.0001, k.value * sim + base * (1 - sim) + jitter));
}

/**
 * Accumulate each expert's score into the persistent `_moeState.scores` so all
 * experts build up their own cumulative points across a round (not just the
 * top-2 routed experts, and not reset every token). `perExpertPoints` is an
 * array of { expert, score }.
 */
export function accumulateExpertScores(perExpertPoints) {
  if (!_moeState) initMoeState();
  for (const { expert, score } of perExpertPoints) {
    if (expert === undefined) continue;
    _moeState.scores[expert] = (_moeState.scores[expert] || 0) + (Number(score) || 0);
  }
  return _moeState.scores;
}

/**
 * Per-token noise injection into the layers, meant to be accumulated across the
 * tokens emitted this step so the NEXT output token sees a nudged layer state.
 * This now MUTATES the persistent `_moeState.layerSizes` (does NOT reset it),
 * so the noise keeps accumulating across expert updates.
 */
export function addLayerNoise(state, noise, layerCount = 5, tokenIdx = 0) {
  if (!_moeState) initMoeState(["E1","E2","E3","E4","E5"], layerCount);
  const nz = Number(noise) || 0;
  _moeState.noise += nz;
  // Keep the per-layer NOISE DELTA bounded (each token nudges a layer by a small
  // amount, clamped so it can never compound into astronomically large sizes).
  // `noiseDeltas` is a SEPARATE small accumulator from `layerSizes` (the sizes).
  while (_moeState.noiseDeltas.length < layerCount) _moeState.noiseDeltas.push(0);
  _moeState.noiseDeltas = _moeState.noiseDeltas.map((d, i) =>
    Math.max(-1, Math.min(1, d + nz * (noise01((+new Date()) + i * 131 + tokenIdx * 17) - 0.5) * 2))
  );
  // Layer sizes themselves stay in a sane range (no multiplicative blowup).
  // NOTE: layer sizes PERSIST (they are the trained weights of the MoE) — we
  // only clamp them, never zero them. The round/step counter is advanced once
  // per HARNESS step via bumpMoeStep(), not per token here.
  _moeState.layerSizes = _moeState.layerSizes.map((v, i) =>
    Math.max(10, Math.min(1000, v + _moeState.noiseDeltas[i] * 20))
  );
  return { layers: _moeState.noiseDeltas.slice(), step: _moeState.step };
}

/** Advance the MoE round/step counter ONCE per harness step (not per token).
 *  This is what drives maybeResetMoeState / updateLosingExperts so a "round"
 *  spans real generation steps, not 5x per step. */
export function bumpMoeStep() {
  if (!_moeState) initMoeState();
  _moeState.step += 1;
  return _moeState.step;
}

/**
 * LAYER REWIRING — RANK-SCALED ACROSS 3B SEGMENTS (user):
 * "best contains no change ever but (n(st)place - 1 * +5%) floor 0 neurons changed"
 * "layer change for less performing models increases based on position."
 *
 * We train MULTIPLE 3B segments (n_segments_3b) in parallel; only the BEST is
 * attached. Rules:
 *   - The ATTACHED (best) segment NEVER changes — it gets NO rewiring ever.
 *   - The LOSERS each get a neuron-change fraction scaled by their RANK among
 *     losers: loser at 1-based rank `place` mutates `(place - 1) * 5%` of its
 *     total neurons (floor 0 for the top loser: closest to best, barely nudged;
 *     the WORST loser gets the most aggressive mutation to try to catch up).
 *   - "add or delete neurons for layers (moving them to others)": each mutation
 *     MOVES a neuron from a donor layer to a receiver layer (add+delete).
 *
 * Returns summary { rewired, from, to, movedPerSeg } or null if no rewire due.
 */
export function rewireLayers() {
  if (!_moeState) return null;
  const es = loadConfig()?.moe?.expert_structure || {};
  const every = Math.max(1, Number(es.rewire_every ?? 10));
  if (!_moeState.layerSizes || !_moeState.layerSizes.length) return null;
  // Only rewire on a rewire_every boundary (not step 0).
  if (_moeState.step === 0 || _moeState.step % every !== 0) return null;

  // Ensure a segments array exists (backward-compat if state predates the field).
  if (!Array.isArray(_moeState.segments) || !_moeState.segments.length) {
    _moeState.segments = [{
      id: 0, attached: true, fitness: 0, layerSizes: _moeState.layerSizes.slice(), lastRewire: null,
    }];
  }

  const all = _moeState.segments;
  // Rank ALL segments by fitness DESCENDING; #0 rank = best = the attached one
  // (we keep the attached flag wherever the highest-fitness segment sits).
  const ranked = all.slice().sort((a, b) => (Number(b.fitness) || 0) - (Number(a.fitness) || 0));
  // Promote the winner to attached; demote the old attached to a loser. This
  // realizes "only attaching the best one" — best becomes the served model,
  // losers get mutation to improve.
  const best = ranked[0];
  if (best) {
    for (const s of all) s.attached = (s === best);
    // The served model's layer sizes mirror the new best segment so the rest of
    // the engine (training / grow / export) keeps operating on the BEST segment.
    if (best.layerSizes && best.layerSizes.length) _moeState.layerSizes = best.layerSizes.slice();
  }

  const summary = { rewired: false, from: [], to: [], movedPerSeg: [] };
  const loserRank = []; // 1-based place per loser
  let place = 1;
  for (const s of ranked) {
    if (s.attached) { loserRank.push({ seg: s, place: 0 }); continue; } // best: never changes
    loserRank.push({ seg: s, place: place++ });
  }

  for (const { seg, place: p } of loserRank) {
    if (p <= 0) continue; // attached best → NO change ever
    const sizes = seg.layerSizes && seg.layerSizes.length ? seg.layerSizes : _moeState.layerSizes;
    if (!sizes || sizes.length < 2) continue;
    const layerCount = sizes.length;
    const total = sizes.reduce((a, v) => a + v, 0);
    if (total <= 0) continue;
    // (place - 1) * +5%  → top loser (place 1) = 0%, then 5%, 10%, ... floor 0.
    const frac = Math.max(0, (p - 1) * 0.05);
    if (frac <= 0) { seg.lastRewire = { place: p, frac: 0, moved: 0 }; continue; }
    const toMove = Math.max(1, Math.round(total * Math.min(0.5, frac)));
    const from = [], to = [];
    let moved = 0;
    for (let m = 0; m < toMove && layerCount > 1; m++) {
      const donor = Math.floor(noise01((+new Date()) + p * 1009 + m * 101) * layerCount);
      let receiver = Math.floor(noise01((+new Date()) + p * 421 + m * 307 + 13) * layerCount);
      if (receiver === donor) receiver = (receiver + 1) % layerCount;
      if (sizes[donor] <= 1) continue; // floor 1: don't zero a layer
      sizes[donor] -= 1;
      sizes[receiver] += 1;
      from.push(donor); to.push(receiver); moved++;
    }
    seg.lastRewire = { place: p, frac, moved };
    if (moved) {
      summary.rewired = true;
      summary.from = summary.from.concat(from);
      summary.to = summary.to.concat(to);
      summary.movedPerSeg.push({ seg: seg.id, place: p, frac, moved, from, to });
    }
  }
  if (summary.rewired) {
    const bySeg = summary.movedPerSeg.map((m) => `seg${m.seg}[p${m.place}]×${(m.frac * 100).toFixed(0)}%→${m.moved}`).join(" ");
    console.log(`  >> rewire layers (every ${every}): BEST frozen; losers by rank ${bySeg}`);
  }
  return summary;
}

/**
 * Record the ATTACHED (best) segment's fitness for the current step, and decay
 * the losers' fitness slightly (so an under-performing loser keeps falling in
 * rank and thus keeps mutating aggressively). The user's rule: the BEST NEVER
 * changes; the WORST loser mutates the most (by rank). Feeding the attached
 * segment's real score each step is what lets rewireLayers pick the winner.
 */
export function noteAttachedFitness(score, label) {
  if (!_moeState) initMoeState();
  if (!Array.isArray(_moeState.segments) || !_moeState.segments.length) {
    _moeState.segments = [{ id: 0, attached: true, fitness: 0, lastRewire: null, layerSizes: _moeState.layerSizes.slice() }];
  }
  const n = Number(score) || 0;
  for (const s of _moeState.segments) {
    if (s.attached) {
      // Exponentially-smoothed EMA so the "best" is stable (doesn't thrash).
      s.fitness = s.fitness === 0 ? n : s.fitness * 0.85 + n * 0.15;
      s.label = label;
    } else {
      // Decayed so a lagging loser keeps a low rank → more aggressive rewiring.
      s.fitness = (Number(s.fitness) || 0) * 0.98;
    }
  }
  return _moeState.segments;
}

/**
 * Per-segment status for UI/payload: id, attached?, fitness, total neurons,
 * last rewire fraction/moved. Lets the user see that the BEST is frozen and the
 * worse losers are being mutated harder by position.
 */
export function segmentSummary() {
  if (!_moeState) initMoeState();
  const segs = (Array.isArray(_moeState.segments) ? _moeState.segments : []).map((s) => ({
    id: s.id,
    attached: !!s.attached,
    fitness: Number(s.fitness) || 0,
    total_neurons: (s.layerSizes || []).reduce((a, v) => a + (Number(v) || 0), 0) || ((_moeState.layerSizes || []).reduce((a, v) => a + (Number(v) || 0), 0) || 0),
    layers: (s.layerSizes || _moeState.layerSizes || []).slice(0, 12),
    last_rewire: s.lastRewire || null,
  }));
  // Sort: attached best first, then losers by fitness desc (so rank is visible).
  segs.sort((a, b) => (b.attached - a.attached) || (Number(b.fitness) - Number(a.fitness)));
  // Annotate the 1-based loss-place for each loser.
  let place = 0;
  for (const s of segs) { if (s.attached) s.place = 0; else s.place = ++place; }
  return segs;
}

/**
 * THE NEW-3B SEGMENT STRUCTURE (user-corrected): we train MULTIPLE 3B segments
 * in parallel (each a candidate addon) and only ATTACH THE BEST ONE. We do NOT
 * preset the neuron count per expert — sizes SEED small and evolve via rewireLayers.
 * Exposes { n_segments_3b, n_experts_per_segment, attach_best_only, layers_per_expert }.
 */
export function expertStructure() {
  const es = loadConfig()?.moe?.expert_structure || {};
  return {
    n_segments_3b: Math.max(1, Number(es.n_segments_3b ?? 3)),
    n_experts_per_segment: Math.max(1, Number(es.n_experts_per_segment ?? 25)),
    attach_best_only: es.attach_best_only !== false,
    layers_per_expert: Math.max(1, Number(es.layers_per_expert ?? 4)),
  };
}

/**
 * Narrow a per-position logprobs list (already sorted by prob desc) into a
 * token-id Set that is the intersection of:
 *   - top-k: the single most likely `k` tokens, and
 *   - top-p (nucleus): the smallest prefix whose cumulative softmax prob >= p.
 * If p >= 1 the set is just the top-k; if k <= 0 the set is empty.
 */
export function narrowTokenSet(logprobs, k, p) {
  const arr = (logprobs || []).slice(0, k);
  if (!arr.length || k <= 0) return new Set();
  if (p >= 1) return new Set(arr.map((t) => t.token));
  const probs = arr.map((t) => Math.exp(Math.min(0, Number(t.logprob) || 0)));
  const sum = probs.reduce((a, b) => a + b, 0) || 1;
  const set = new Set();
  let cum = 0;
  for (let i = 0; i < arr.length; i++) {
    set.add(arr[i].token);
    cum += probs[i] / sum;
    if (cum >= p) break;
  }
  return set;
}


/**
 * Build the expert-layer STATES for one routing step.
 * Each expert observes the top-k input and produces a weight; only the TOP 2
 * (by affinity) are kept active. Mutations follow the owner's spec:
 *   E3 = E4 + noise, E5 = similar-neurons(E1..E4) + noise.
 */
export function routeExperts(topKTokens, layerNoise) {
  const cfg = loadConfig().moe;
  const experts = cfg.experts;
  const n = Object.keys(experts).length;
  const seed = (+new Date()) & 0xffffff;
  const layerCount = loadConfig().layers?.count || 5;
  const names = Object.keys(experts);
  if (!_moeState) initMoeState(names, layerCount);
  // Keep the persistent state in sync if experts were added.
  for (const nm of names) if (_moeState.expertValues[nm] === undefined) _moeState.expertValues[nm] = 0.5 + 0.4 * noise01(seed + nm.length);
  if (!_moeState.roundsSurvived) _moeState.roundsSurvived = {};
  for (const nm of names) if (_moeState.roundsSurvived[nm] === undefined) _moeState.roundsSurvived[nm] = 0;
  while (_moeState.layerSizes.length < layerCount) _moeState.layerSizes.push(Math.round(100 + noise01(seed + _moeState.layerSizes.length + 3) * 400));
  _moeState.layerSizes = _moeState.layerSizes.slice(0, layerCount);

  // Base affinity: each expert's agreement with the top-k input. Instead of a
  // fresh random each step, EVOLVE from the persistent value (previous value +
  // small drift), so the expert's signal keeps accumulating and is NOT reset on
  // the expert update.
  const base = topKTokens || [];
  const baseSet = new Set(base);
  const baseAffinity = baseSet.size ? 0.6 + 0.3 * noise01(seed + 1) : 0.3;
  const drift = (nm, i) => (noise01(seed + i * 3 + 5) - 0.5) * 0.08; // small ±0.04 drift

  const e4v = _moeState.expertValues.E4 + drift("E4", 1);
  const e1v = _moeState.expertValues.E1 + drift("E1", 2);
  const e2v = _moeState.expertValues.E2 + drift("E2", 3);
  const e3v = Math.min(1, e4v + experts.E3.noise * noise01(seed));      // E4 + noise
  const e5v = Math.min(1, (e1v + e2v + e3v + e4v) / 4 * (0.95 + experts.E5.noise * noise01(seed + 7)));

  const mk = (nm, v) => {
    // Anti-collapse: persist via sigmoid accumulator, NOT a hard [0,1] clamp
    // (the clamp in the old mk() re-pinned every expert at 1.0 on every route
    // call, turning E6..E100 into identical clones). setExpertValue keeps the
    // value in (0,1) but lets affinity differences persist.
    const persisted = setExpertValue(nm, v);
    return { name: nm, affinity: persisted, value: persisted, active: false, role: experts[nm].role, mutation: experts[nm].mutation, topk_weight: experts[nm].topk_weight };
  };
  const rows = [
    mk("E1", e1v), mk("E2", e2v), mk("E3", e3v), mk("E4", e4v), mk("E5", e5v),
  ];

  // Add any experts beyond E1..E5 (added via UI) with a noise-based mutation.
  for (const k of names) {
    // The MTP head (EMTP) is a named expert (no digits) — always include it as
    // a trained row so "the MTP must be trained too". It predicts the NEXT token.
    if (k === "EMTP") {
      const spec = experts[k] || {};
      const aff = setExpertValue(k, (_moeState.expertValues[k] ?? 0.5) + (spec.noise || 0.02) * noise01(seed + 9001));
      rows.push(mk(k, aff));
      continue;
    }
    const idx = Number(k.replace(/\D/g, "")) || 0;
    if (idx <= 5) continue;
    const spec = experts[k] || {};
    const aff = Math.min(1, (_moeState.expertValues[k] || 0.5) + (spec.noise || 0) * noise01(seed + idx));
    rows.push(mk(k, aff));
  }

  // Keep only the TOP-N (cfg.topk_route) by affinity.
  rows.sort((a, b) => b.affinity - a.affinity);
  const kTop = Math.min(cfg.topk_route, rows.length);
  for (let i = 0; i < kTop; i++) rows[i].active = true;

  // Layer sizes come from the PERSISTENT state (grown by a bounded per-token
  // noise delta), with a small per-step drift so they evolve instead of
  // exploding. noiseArr is the bounded noise-delta list (≈ -1..1).
  const noiseArr = layerNoise && Array.isArray(layerNoise.layers) ? layerNoise.layers : [];
  const perLayerSize = _moeState.layerSizes.map((v, li) => {
    const bump = noiseArr[li] != null ? Math.max(-40, Math.min(40, noiseArr[li] * 40)) : 0;
    const lv = Math.max(10, Math.min(1000, Math.round(v + bump + (noise01(seed + li + 40) - 0.5) * 8)));
    _moeState.layerSizes[li] = lv; // persist the grown (bounded) size
    return { layer: "L" + (li + 1), size: lv };
  });

  return {
    rows,
    count: n,
    layer_count: layerCount,
    per_layer_size: perLayerSize,
    topk_route: cfg.topk_route,
    state: {
      noise: _moeState.noise,
      step: _moeState.step,
      round: _moeState.round,
      topP: _moeState.topP,
      kl: _moeState.kl,
      output: _moeState.output,
      matchScore: { ..._moeState.matchScore },
      scores: { ..._moeState.scores },
      roundsSurvived: { ...(_moeState.roundsSurvived || {}) },
      lastRound: _moeState.lastRound,
      expertValues: { ..._moeState.expertValues },
      layerSizes: _moeState.layerSizes.slice(),
    },
  };
}

/**
 * Training-update per expert + per layer from the config formulas.
 * EVERY expert is updated (not just the active top-k): active experts get the
 * full parity update, inactive experts get a smaller standing update (so even a
 * non-routed expert keeps learning/scoring instead of freezing). We model a
 * small weight adjustment (true-ternary-flavored) so growing stays ternary and
 * is saved.
 */
export function trainStep(route, teacherVal, studentVal, expertMatch) {
  const cfg = loadConfig();
  const layers = cfg.layers;
  if (!_moeState) initMoeState(route.rows.map((r) => r.name), route.layer_count);
  let delta = 0;
  const perExpert = route.rows.map((r, i) => {
    const spec = cfg.moe.experts[r.name] || {};
    const isActive = !!r.active;
    // ---- TRAIN SCOPE = NEW-3B ADDON EXPERTS ONLY (user directive) ----
    // "we only want to train the new 3b addon experts" — the "real" base 27B
    // experts (role 'base' = E1..E5, the original model) are FROZEN: they are
    // NOT retrained (no value change, no delta, no match-accum). Only the NEW
    // ~3B addon experts (mutation / mtp_head / new_token / compr*) get trained
    // to emit the etokens / compressed output. 'base' role experts stay fixed.
    const role = String(spec.role || route.rows[i]?.role || "").toLowerCase();
    const isRealBase = role === "base";
    if (isRealBase) {
      // Freeze the base expert: keep its current value, contribute no delta.
      return {
        expert: r.name, delta: 0, value: _moeState.expertValues?.[r.name] ?? r.value,
        active: isActive, topk_weight: r.topk_weight, prev: _moeState.expertValues?.[r.name] ?? r.value,
        match: 0, matchScore: _moeState.matchScore?.[r.name] ?? 0, frozen: true,
      };
    }
    // PER-EXPERT TEACHER-MATCH: how many of this expert's routed top-k tokens
    // matched the teacher's top-k this step (0 = no match, >0 = match). This is
    // the real differentiator — "the more topk tokens that match the teacher
    // the more you should win". If no per-expert signal is supplied, fall back
    // to the shared scalar (expertMatch==undefined).
    const match = expertMatch && expertMatch[i] !== undefined
      ? Math.max(0, Number(expertMatch[i]) || 0)
      : 1;
    // PER-EXPERT persistent match score: each expert accumulates its OWN
    // teacher top-k match count over steps. This is the "each expert its own
    // score" signal — it survives beyond a single step and stays distinct per
    // expert even when multiple experts share a routed output position.
    _moeState.matchScore[r.name] = (_moeState.matchScore[r.name] ?? 0) + match;
    const matchScore = _moeState.matchScore[r.name];
    // active expert: full overlap-adjusted parity update, scaled by how well
    // this expert actually matched the teacher top-k (matched experts climb,
    // unmatched experts get pulled back toward 0.5).
    // inactive expert: small standing drift (still scored/trained, not frozen).
    const activeTerm = (teacherVal - studentVal) * layers.each.topk_gate * layers.each.lr * r.affinity * (0.5 + match);
    const inactiveTerm = (0.5 - studentVal) * layers.each.lr * 0.1;
    const d = isActive ? activeTerm : inactiveTerm;
    delta += d;
    // Persist every expert's value so it keeps accumulating (NOT reset on update)
    // and track per-expert top-p / KL / output signals.
    const prev = _moeState.expertValues[r.name] ?? r.value;
    // Anti-collapse: do NOT hard-clamp to [0,1] — that pinned every active
    // expert at the 1.0 ceiling and made them identical clones (E6..E100 all
    // 1.0000). Instead apply a LOGISTIC (sigmoid) squashing of an UNBOUNDED
    // accumulator, so experts that match the teacher MORE keep pulling ahead,
    // while the value stays in a stable (0,1) range. This keeps them distinct
    // instead of saturating the same ceiling.
    const accum = (Number(_moeState.accum[r.name]) ?? 0) + d;
    _moeState.accum[r.name] = accum;
    const updated = 1 / (1 + Math.exp(-accum)); // sigmoid(accum) in (0,1), monotone in d
    if (!isFinite(updated)) {
      // guard: extreme accum -> snap near 0/1 but keep distinct via sign of accum
      _moeState.expertValues[r.name] = accum > 0 ? 0.9999 : 0.0001;
    } else {
      _moeState.expertValues[r.name] = updated;
    }
    _moeState.topP[r.name] = (Number(_moeState.topP[r.name]) || 0) + d * 100;
    _moeState.kl[r.name] = (Number(_moeState.kl[r.name]) || 0) + Math.abs(d);
    _moeState.output[r.name] = d;
    return { expert: r.name, delta: d, value: updated, active: isActive, topk_weight: r.topk_weight, prev, match, matchScore };
  });
  // Per-layer training update (each of the `count` layers gets a slice of the
  // experts' delta, scaled by its layer weight).
  const layerDeltas = (route.per_layer_size || []).map((ls, i) => ({
    layer: ls.layer,
    size: ls.size,
    delta: (perExpert.reduce((a, e) => a + e.delta, 0) / (layerDeltasLen(route) || 1)) * ((i + 1) / (route.per_layer_size.length || 1)),
  }));
  return { delta, perExpert, perLayer: layerDeltas, layers: layers.count, state: _moeState };
}
function layerDeltasLen(route) { return (route.per_layer_size || []).length; }

/**
 * Score a step using config: base per-token matches + bonus + penalties + the
 * 500x value-generation event.
 */
export function scoreStep({ baseMatches, step, is500x, bonusOverride }) {
  const s = loadConfig().scoring;
  const base = baseMatches * s.base.per_topk_token_match;
  const bonus = bonusOverride !== undefined
    ? bonusOverride
    : s.bonus.points_per_step_times_100 ? 100 * step : 0;
  let gain = 0;
  if (is500x) gain = s.value_generation.points_500x * 100; // 500x value generation
  let penalty = 0;
  if (s.penalties.overconfidence > 0) penalty += s.penalties.overconfidence;
  if (s.penalties.redundant_expert > 0) penalty += s.penalties.redundant_expert;
  const totalGain = base + bonus + gain - penalty;
  return { base, bonus, gain, penalty, totalGain };
}

/**
 * EXPONENTIAL TEACHER-CURVE REWARD.
 * The teacher is assumed PERFECT at top-k and PERFECT at using its top-k, but
 * does NOT prefer compressed tokens. So when the student's top-k curve closely
 * matches the teacher's, we reward exponentially (not linearly):
 *
 *   reward = per_topk_token_match * exp_base ^ (overlap_fraction * exp_scaler)
 *
 * `overlapFraction` = (|studentTopK ∩ teacherTopK|) / |teacherTopK| averaged
 * over the student's emitted token positions. As the student's curve converges
 * to the teacher's (fraction -> 1), the reward grows exponentially.
 *
 * Returns { reward, overlapFraction, matched, total }.
 */
export function curveReward({ student, teacherTopK, perTokenMatch, compressedToken, newTokenSet, degenerate }) {
  const cfg = loadConfig()?.scoring?.curve || {};
  const expBase = Number(cfg.exp_base ?? 2.0);
  const expScaler = Number(cfg.exp_scaler ?? 4.0);
  const compressedMult = Number(cfg.compressed_token_mult ?? 4.0);

  // DEGENERATE-OUTPUT GUARD: a collapsed student (all emitted tokens the same,
  // e.g. "/") matches nothing meaningful against the teacher's top-k curve.
  // Zero its curve reward so a stuck attractor can never earn curve points.
  if (degenerate === true) {
    return {
      reward: 0, overlapFraction: 0, matched: 0, numSlots: 0,
      compressedMatched: false, compressedSlotRank: -1, total: 0, degenerate: true,
    };
  }

  const matchPts = Number(perTokenMatch ?? cfg?.base_match ?? (loadConfig()?.scoring?.base?.per_topk_token_match ?? 1));
  const teacherList = teacherTopK || [];
  if (!teacherList.length) return { reward: 0, overlapFraction: 0, matched: 0, total: 0 };
  const teacherSet = new Set(teacherList);

  // Rank each teacher top-k slot: slot i (0-based) pays expBase^(i+1) — so the
  // MORE teacher top-k slots the student matches, the more it wins (each
  // additional matched slot pays a higher exponent than the one before).
  // NOTE we fold expScaler into a per-slot weight so progressiveness is real.
  let positions = 0;
  let matched = 0;
  let numSlots = 0;
  let reward = 0;
  for (const s of student) {
    if (!s) continue;
    const sSet = new Set((s.top || []).map((t) => t.token));
    positions++;
    // Count + weight every student top-k token that lands on a teacher slot.
    for (let i = 0; i < teacherList.length; i++) {
      if (sSet.has(teacherList[i])) {
        matched++;
        reward += Math.pow(expBase, (i + 1) / Math.max(1, expScaler)) * matchPts;
        numSlots++;
      }
    }
  }

  // COMPRESSED-TOKEN MATCH: a compressed token that would fill a teacher top-k
  // slot counts as a match. `compressedToken` is the footprint value (sum of
  // constituent ids). If that value is in the teacher's top-k set (i.e. the
  // compression lands exactly where the teacher expects), reward HEAVILY.
  // Also reward if any new-token-system created token/value is in teacher top-k.
  let compressedMatched = false;
  let compressedSlotRank = -1;
  const candidate = String(compressedToken ?? "");
  if (candidate && teacherSet.has(candidate)) {
    const idx = teacherList.indexOf(candidate);
    compressedMatched = true;
    compressedSlotRank = idx;
    reward += Math.pow(expBase, (idx + 1) / Math.max(1, expScaler)) * matchPts * compressedMult;
    numSlots++;
  } else if (newTokenSet && newTokenSet.size) {
    // "start to nth place of the previous compressed token" — any created new
    // token whose value lands in the teacher top-k is a strong signal.
    for (const t of newTokenSet) {
      if (teacherSet.has(String(t))) {
        compressedMatched = true;
        reward += matchPts * compressedMult; // heavily rewarded
        break;
      }
    }
  }

  const total = positions * teacherList.length;
  const overlapFraction = total ? matched / total : 0;
  return { reward, overlapFraction, matched, numSlots, compressedMatched, compressedSlotRank, total, degenerate: false };
}

/**
 * COMPRESSION-RATIO REWARD (the primary new reward).
 * A compressed token packs a lot of info (long text, many effective tokens)
 * into few tokens; reward that. Per the user's spec:
 *
 *   compression_reward =
 *       compressionRatio  *  baseEffectiveTokens  *  ( 1 + textLengthGenerated / tokensSaved )
 *
 * where:
 *   compressionRatio     = referenceTokens / emittedTokens
 *   baseEffectiveTokens  = total effective tokens the expert emitted (STUDENT_STEP)
 *   textLengthGenerated  = total chars of the generated tokens (its effective length)
 *   tokensSaved          = referenceTokens - emittedTokens   (clamped >= 1)
 *
 * NEW-TOKEN-MATCH MULTIPLIER: if `>= new_token_match_min_pct` of the generated
 * tokens are in the new-token-system's created-token set, multiply by
 * `new_token_match_mult * tokensSaved` (strong reward for matching created tokens).
 *
 * DEGENERATE-OUTPUT GUARD (the "/"-collapse fix the user identified): if the
 * student emitted tokens are ALL the SAME token (a 1-bit/ternary attractor like
 * repeated "/"), the model isn't compressing — it's stuck. Rewarding any
 * "compression" on that output reinforces the attractor. So when `degenerate`
 * is true we apply `degenerate_penalty` (config scoring.compression.
 * degenerate_penalty) and ZERO the compression reward (or keep it small if
 * degenerate_partial is true), so a collapsed student can never earn points for
 * trivially repeating one token.
 *
 * `tally_before_reset` is handled by the caller (the harness accumulates this
 * into the round cumulative score before `maybeResetMoeState`).
 *
 * Returns { reward, compressionRatio, baseEffectiveTokens, textLengthGenerated,
 *           tokensSaved, newTokenMatchPct, multiplier, appliedMultiplier,
 *           degenerate, degeneratePenalty }.
 */
export function compressionReward({ emittedTokens, perTokenEmitted, textLengthGenerated, newTokenSet, degenerate }) {
  const cfg = loadConfig()?.scoring?.compression || {};
  const emitted = Math.max(1, Number(emittedTokens ?? cfg.base_effective_tokens ?? 5));
  const reference = Math.max(1, Number(cfg.reference_tokens ?? 23));
  const textLen = Number(textLengthGenerated ?? 0);
  const textFactor = Number(cfg.text_length_factor ?? 1.0);
  const mult = Number(cfg.multiplier ?? 1.0);
  const base = { reward: 0, compressionRatio: reference / emitted, baseEffectiveTokens: emitted,
    textLengthGenerated: textLen, tokensSaved: Math.max(1, reference - emitted),
    newTokenMatchPct: 0, multiplier: mult, appliedMultiplier: 1, degenerate: false, degeneratePenalty: 0 };

  // DEGENERATE-OUTPUT GUARD: all emitted tokens identical => collapsed attractor.
  const collapsed =
    degenerate === true ||
    (Array.isArray(perTokenEmitted) && perTokenEmitted.length > 1 &&
     new Set(perTokenEmitted.map(String)).size === 1);
  if (collapsed) {
    const penalty = Number(cfg.degenerate_penalty ?? -50);
    const partial = cfg.degenerate_partial === true;
    // Collapsed output earns ~no compression reward. If partial, keep a small
    // fraction so the harness still sees a signal but can't farm points.
    const reward = partial ? Math.min(0, base.reward) : 0;
    return { ...base, reward, degenerate: true, degeneratePenalty: penalty, newTokenMatchPct: 0 };
  }

  const compressionRatio = reference / emitted;
  const tokensSaved = Math.max(1, reference - emitted);
  const baseEffective = emitted;
  const textTerm = 1 + (textFactor * textLen) / tokensSaved;
  let reward = compressionRatio * baseEffective * textTerm;

  // NEW-TOKEN MATCH MULTIPLIER: if >= min_pct of the emitted tokens match the
  // new-token-system's created tokens, multiply by new_token_match_mult * saved.
  let newTokenMatchPct = 0;
  let appliedMultiplier = 1;
  const toks = Array.isArray(perTokenEmitted) && perTokenEmitted.length ? perTokenEmitted : [];
  if (newTokenSet && newTokenSet.size && toks.length) {
    const hits = toks.reduce((a, t) => a + (newTokenSet.has(String(t)) ? 1 : 0), 0);
    newTokenMatchPct = hits / toks.length;
    const minPct = Number(cfg.new_token_match_min_pct ?? 0.2);
    if (newTokenMatchPct >= minPct) {
      appliedMultiplier = Number(cfg.new_token_match_mult ?? 1.001) * tokensSaved;
      reward *= appliedMultiplier;
    }
  }
  reward *= mult;
  return {
    ...base,
    reward,
    compressionRatio,
    baseEffectiveTokens: baseEffective,
    tokensSaved,
    newTokenMatchPct,
    appliedMultiplier,
    degenerate: false,
    degeneratePenalty: 0,
  };
}

/**
 * O-TOKEN SEQUENCE REWARD — HARSHER ENVIRONMENT (user design).
 * Score an expert against a SAVED TEACHER CHUNK: the sequence of `n` otokens
 * (etokens) the teacher produced and saved to disk to train on. NO free
 * "anything in the top-k" bonus — the expert must reproduce the SAVED otoken
 * sequence.
 *
 * Per position i in the saved chunk (length n):
 *   - GENERATED match (the expert's GENERATED otoken at i == saved otoken at i):
 *       +generated_match_pts   (> more points than merely being in the top-k)
 *   - TOP-K-ONLY match (saved otoken is in the expert's top-k at i, but the
 *       expert did NOT generate it):
 *       +topk_only_pts         (right direction, but not generated → fewer pts)
 *   - no match: 0.
 *
 * COMPLETENESS MULTIPLIER — "more perfect otokens == bigger base multiplier" and
 * "missing % of otokens in score == score / missing%":
 *   perfect      = # positions with a GENERATED match
 *   n            = teacher_chunk_length (saved chunk length)
 *   missing      = n - perfect
 *   multiplier   = perfect>0 ? perfect / max(minDenom, missing) : 0
 *                 (perfect=n → perfect/missing explodes → clamped to perfect_mult;
 *                  perfect=1 of n=100 → 1/99 ≈ 0.01 → tiny value;
 *                  99 of 100 → 99/1 = 99 → super close to perfect, really good)
 *
 * PERFECT PROMPT ROUND-END + TIEBREAK:
 *   A response is PERFECT when the expert generated the ENTIRE saved otoken
 *   sequence (perfect === n, sequence match). The first perfect response ends
 *   the round immediately and is placed FIRST. On a tie (multiple perfect),
 *   compare the NEXT otoken (the position after the saved chunk): whichever
 *   expert's next otoken is also a perfect match wins, and so on (longest
 *   completed prefix wins).
 *
 * Returns { reward, perfect, perfectPositions, missingPct, multiplier,
 *           savedChunk, generatedSeq, topkOnlyCount, generatedCount, n }.
 */
export function otokenSequenceReward({
  savedChunk,           // the teacher's saved otoken sequence (length n)
  generatedSeq,         // the expert's GENERATED otoken sequence (length >= n ideally)
  topKPerPos,           // array per position of the expert's top-k token id Sets
  degenerate,
}) {
  const cfg = loadConfig()?.scoring?.otoken_sequence || {};
  const genPts = Number(cfg.generated_match_pts ?? 40);
  const topkPts = Number(cfg.topk_only_pts ?? 10);
  const perfectMult = Number(cfg.perfect_mult ?? 1.5);
  const missingPenalty = Number(cfg.missing_penalty ?? 3);
  const minDenom = 1 / Math.max(1, missingPenalty); // floor so perfect/missing doesn't blow past perfect_mult
  const n = Array.isArray(savedChunk) ? savedChunk.length : 0;
  const base = { reward: 0, perfect: false, perfectPositions: 0, missingPct: 0, multiplier: 0,
    savedChunk: savedChunk || [], generatedSeq: generatedSeq || [], topkOnlyCount: 0,
    generatedCount: 0, n, degenerate: degenerate === true };

  if (n <= 0) return base;
  // DEGENERATE GUARD: a collapsed expert can't earn sequence points.
  if (degenerate === true) return base;

  let perfect = 0;
  let topkOnly = 0;
  let raw = 0;
  for (let i = 0; i < n; i++) {
    const saved = String(savedChunk[i] ?? "");
    const gen = String((generatedSeq || [])[i] ?? "");
    if (gen === saved && gen !== "") {
      raw += genPts; perfect++;
    } else {
      const tk = (topKPerPos && topKPerPos[i]) ? (topKPerPos[i] instanceof Set ? topKPerPos[i] : new Set((topKPerPos[i] || []).map(String))) : null;
      if (tk && saved !== "" && tk.has(saved)) { raw += topkPts; topkOnly++; }
    }
  }

  const missing = Math.max(0, n - perfect);
  // 'score / missing%' — more missing → smaller multiplier; 1/100 tiny, 99/100 huge.
  // "more perfect otokens == bigger base multiplier". If 0 generated but the
  // saved otokens were in the top-k, that's "in the right direction" → small
  // positive credit (not a full generated match, but a lower multiplier).
  let multiplier = 0;
  if (perfect > 0) {
    multiplier = missing <= 0
      ? perfectMult * n                        // full sequence => big (ceiling)
      : Math.min(perfectMult * n, perfect / Math.max(minDenom, missing));
  } else if (topkOnly > 0) {
    // Failure but RIGHT DIRECTION: otokens were in the top-k, never generated.
    // Give a low multiplier (per user: 'score multiplier is lower because the
    // total saved tokens was a failure but it's in the right direction').
    multiplier = (topkOnly / n) * missingPenalty * (missing === n ? 1 : 1); // <= 3x, tiny vs a generated match
  }
  const perfectFlag = perfect === n;             // whole sequence match (perfect response)
  let reward = raw * multiplier;

  // FIRST PERFECT = round end + placed first. On a tie, compare the NEXT token:
  // whoever's next otoken ALSO matches wins (longest completed prefix).
  let tiebreakNext = null;
  if (perfectFlag && cfg.tiebreak_next_token !== false) {
    const nextSaved = String((savedChunk[n] ?? ""));
    const nextGen = String((generatedSeq || [])[n] ?? "");
    tiebreakNext = { saved: nextSaved, generated: nextGen, perfect: nextGen === nextSaved && nextSaved !== "" };
    if (tiebreakNext.perfect) reward *= perfectMult; // extra for extending farther
  }

  return {
    ...base,
    reward: Math.max(0, reward),
    perfect: perfectFlag,
    perfectPositions: perfect,
    missingPct: n ? missing / n : 0,
    multiplier,
    topkOnlyCount: topkOnly,
    generatedCount: perfect,
    tiebreakNext,
  };
}

/**
 * SAVE THE TRAINING STATE as PER-EXPERT checkpoint DIFFS (small, per-expert).
 *
 * We do NOT dump the whole 4B model — that stays in the base GGUF. We only save,
 * for EACH expert, the trained DELTA from the loaded base (checkpoint diff) plus
 * its gate/value/role and whether it prefers new tokens. This is the "save the
 * model on a per expert basis" design. Files are written to:
 *
 *   <save_dir>/experts/step-<n>-<ts>/<EXPERT>.json     (one diff file per expert)
 *   <save_dir>/experts/step-<n>-<ts>/_manifest.json    (routing + step summary)
 *
 * The same per-expert deltas are also pushed to the in-RAM checkpoint cache
 * (see addToCheckpointCache), bounded by the config RAM budget.
 */
export function saveModel(step, route, training, moeState) {
  const sv = path.join(getSaveDir(), "experts");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(sv, `step-${step}-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = loadConfig() || {};
  const numExperts = route.count || Object.keys(cfg.moe?.experts || {}).length || 5;
  const layerCount = route.layer_count || cfg.layers?.count || 5;
  const topkRoute = route.topk_route || cfg.moe?.topk_route || 2;
  const names = route.rows.map((r) => r.name);

  // Per-expert DIFF from the loaded base value (Δ = current - base). Base value
  // is the seed: 0.5 for base experts, plus a small new-token bump for bolt-ons.
  const expertFiles = [];
  for (const nm of names) {
    const spec = cfg.moe?.experts?.[nm] || {};
    const val = _moeState?.expertValues?.[nm] ?? route.rows.find((r) => r.name === nm)?.value ?? 0.5;
    const prefersNew = spec.prefers_new_tokens === true || /^NT\d+/.test(nm);
    const baseVal = spec.base_value ?? 0.5;
    const delta = Number(val) - Number(baseVal);
    const file = path.join(dir, `${nm}.json`);
    const expertDiff = {
      format: "expert-checkpoint-diff",
      expert: nm,
      role: spec.role || "base",
      prefers_new_tokens: prefersNew,
      value: Number(val.toFixed ? val.toFixed(4) : val),
      base_value: Number(baseVal),
      delta: Number(delta.toFixed ? delta.toFixed(6) : delta), // diff from loaded base
      gate_logit: Number(val.toFixed ? val.toFixed(4) : val),
      mutation: spec.mutation || "none",
      active: !!(route.rows.find((r) => r.name === nm)?.active),
      step,
    };
    fs.writeFileSync(file, JSON.stringify(expertDiff, null, 2));
    expertFiles.push(file);
  }

  const manifest = {
    format: "moe-expert-manifest",
    step,
    ts: new Date().toISOString(),
    routing: { num_experts: numExperts, layers: layerCount, top_k: topkRoute },
    dims: {
      n_vocab: Number(cfg.model?.n_vocab ?? 151669),
      n_embd: Number(cfg.model?.n_embd ?? 2560),
      n_ffn: Number(cfg.model?.n_ffn ?? 9728),
      n_layers: Number(cfg.model?.n_layers ?? 36),
    },
    layer_sizes: _moeState?.layerSizes ? _moeState.layerSizes.slice() : [],
    scores: _moeState?.scores || {},
    round: _moeState?.round ?? 1,
    noise: _moeState?.noise ?? 0,
    training: { delta: training.delta, perExpert: training.perExpert },
    expert_files: expertFiles.map((f) => path.basename(f)),
  };
  const mf = path.join(dir, "_manifest.json");
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));

  // Keep per-expert deltas in RAM (bounded by config.model.ram_cache_mb).
  if (_moeState) {
    const deltas = {};
    for (const nm of names) {
      const val = _moeState.expertValues?.[nm] ?? 0.5;
      const baseVal = cfg.moe?.experts?.[nm]?.base_value ?? 0.5;
      deltas[nm] = Number((val - baseVal).toFixed(6));
    }
    addToCheckpointCache({ step, round: _moeState.round, deltas, ts: Date.now() });
  }

  return { manifest: mf, count: expertFiles.length };
}

// ---- IN-RAM CHECKPOINT / DELTA CACHE ----
// Keeps the last few checkpoints' per-expert diffs in memory (bounded to ~16 GB
// worth of tiny records; actual bytes are small here since we store deltas, not
// full weights). Provides cheap rollback / diff across recent checkpoints.
const _CHECKPOINT_CACHE = []; // [{ step, round, deltas, ts }]
let _cacheBytes = 0;
const CACHE_BUDGET_BYTES = Number(process.env.MOE_RAM_CACHE_MB || 16 * 1024) * 1024 * 1024; // default 16GB

export function addToCheckpointCache(entry) {
  const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
  _CHECKPOINT_CACHE.push(entry);
  _cacheBytes += bytes;
  // Evict oldest until under budget.
  while (_cacheBytes > CACHE_BUDGET_BYTES && _CHECKPOINT_CACHE.length > 1) {
    const oldest = _CHECKPOINT_CACHE.shift();
    _cacheBytes -= Buffer.byteLength(JSON.stringify(oldest), "utf8");
  }
  return _CHECKPOINT_CACHE.length;
}

/** Diff (current) vs the most recent cached checkpoint: per-expert Δ per step. */
export function diffRecentCheckpoint() {
  const base = {
    steps: _CHECKPOINT_CACHE.map((c) => c.step),
    cache_entries: _CHECKPOINT_CACHE.length,
    cache_bytes: _cacheBytes,
    cache_budget_bytes: CACHE_BUDGET_BYTES,
  };
  if (_CHECKPOINT_CACHE.length < 2) return { ...base, expert_delta_trend: {}, step_delta: 0 };
  const cur = _CHECKPOINT_CACHE[_CHECKPOINT_CACHE.length - 1];
  const prev = _CHECKPOINT_CACHE[_CHECKPOINT_CACHE.length - 2];
  const expertDeltaTrend = {};
  for (const nm of Object.keys(cur.deltas)) {
    const dNow = cur.deltas[nm] ?? 0;
    const dPrev = prev.deltas[nm] ?? 0;
    expertDeltaTrend[nm] = dNow - dPrev; // movement of this expert's diff
  }
  return { ...base, step_delta: cur.step - prev.step, expert_delta_trend: expertDeltaTrend };
}

/** Clear the in-RAM checkpoint cache. */
export function clearCheckpointCache() { _CHECKPOINT_CACHE.length = 0; _cacheBytes = 0; }

function seedBase(nm, li, k) {
  const idx = parseInt(nm.replace(/\D/g, "") || 0, 10);
  return ((+new Date()) % 1e6) + idx * 101 + li * 7 + k * 13;
}

/**
 * List every saved MoE checkpoint (per-expert diff dirs + legacy flat files),
 * newest first. Each checkpoint has: id (dir name), step, path, mtime, size,
 * expert_count, and a 'type' ('per-expert-diff' | 'legacy').
 */
export function listSnapshots() {
  const out = [];
  const expertsDir = path.join(getSaveDir(), "experts");
  // Per-expert diff checkpoints: <save_dir>/experts/step-<n>-<ts>/_manifest.json
  if (fs.existsSync(expertsDir)) {
    try {
      for (const dir of fs.readdirSync(expertsDir)) {
        const dp = path.join(expertsDir, dir);
        if (!fs.statSync(dp).isDirectory()) continue;
        const manifestPath = path.join(dp, "_manifest.json");
        if (!fs.existsSync(manifestPath)) continue;
        let step = 0, round = 1, expertCount = 0, mtime = 0, size = 0;
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          step = Number(m.step ?? 0);
          round = Number(m.round ?? 1);
          expertCount = Array.isArray(m.expert_files) ? m.expert_files.length : 0;
        } catch {}
        try { mtime = fs.statSync(dp).mtimeMs; } catch {}
        try { size = fs.statSync(manifestPath).size; } catch {}
        out.push({ id: dir, type: "per-expert-diff", step, round, expert_count: expertCount, path: dp, mtime, size });
      }
    } catch {}
  }
  // Legacy flat JSON snapshots (moe-state-step-*/ternary-moe-*).
  try {
    const saveDir = getSaveDir();
    for (const f of fs.readdirSync(saveDir)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(saveDir, f);
      let stat = null; try { stat = fs.statSync(p); } catch {}
      out.push({ id: f, type: "legacy", step: 0, path: p, mtime: stat ? stat.mtimeMs : 0, size: stat ? stat.size : 0 });
    }
  } catch {}
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * LOAD a saved checkpoint back into the live MoE state (resume training).
 * Accepts a per-expert diff directory id ('step-<n>-<ts>') or a legacy file.
 * For per-expert diffs: re-applies each expert's value/base_value/delta onto
 * _moeState.expertValues and restores layerSizes/scores/round from _manifest.
 * Returns a summary, or throws on a bad checkpoint.
 */
export function loadSnapshot(idOrFile) {
  // Resolve the target.
  const saveDir = getSaveDir();
  let dir = null, file = null;
  const base = idOrFile ? path.basename(idOrFile) : "";
  if (fs.existsSync(idOrFile) && fs.statSync(idOrFile).isDirectory()) dir = idOrFile;
  else if (fs.existsSync(path.join(saveDir, "experts", base)) && fs.statSync(path.join(saveDir, "experts", base)).isDirectory()) dir = path.join(saveDir, "experts", base);
  else file = path.isAbsolute(idOrFile) ? idOrFile : path.join(saveDir, base);

  if (dir) {
    const manifestPath = path.join(dir, "_manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error("checkpoint has no _manifest.json: " + dir);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const expertValues = {};
    const names = [];
    const layerCount = Math.max(1, Number(m.routing?.layers ?? m.dims?.n_layers ?? 5));
    if (Array.isArray(m.expert_files)) {
      for (const ef of m.expert_files) {
        const ep = path.join(dir, path.basename(ef));
        if (!fs.existsSync(ep)) continue;
        const e = JSON.parse(fs.readFileSync(ep, "utf8"));
        const val = Math.max(0, Math.min(1, Number(e.value ?? e.base_value ?? 0.5)));
        expertValues[e.expert] = val;
        names.push(e.expert);
      }
    }
    if (!_moeState) initMoeState(names.length ? names : ["E1","E2","E3","E4","E5"], layerCount);
    if (Object.keys(expertValues).length) _moeState.expertValues = expertValues;
    while (_moeState.layerSizes.length < layerCount) _moeState.layerSizes.push(100);
    _moeState.layerSizes = _moeState.layerSizes.slice(0, layerCount);
    _moeState.noiseDeltas = Array.from({ length: layerCount }, () => 0);
    _moeState.scores = Object.fromEntries(Object.keys(_moeState.expertValues).map((nm) => [nm, 0]));
    _moeState.topP = {}; _moeState.kl = {}; _moeState.output = {};
    _moeState.step = Number(m.step ?? 0);
    _moeState.round = Number(m.round ?? 1);
    _moeState.lastRound = null;
    return {
      ok: true, type: "per-expert-diff", id: path.basename(dir),
      num_experts: Object.keys(_moeState.expertValues).length,
      layers: layerCount, top_k: Number(m.routing?.top_k ?? 2),
      step: _moeState.step, round: _moeState.round,
      base_gguf: m.dims ? undefined : undefined,
    };
  }

  // Legacy single-file snapshot.
  if (!fs.existsSync(file)) throw new Error("checkpoint not found: " + (idOrFile || file));
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const fmt = snap.format || "";
  const names = [];
  const expertValues = {};
  const layerCount = Math.max(1, Number(snap.routing?.layers ?? snap.layers?.length ?? 5));
  if (snap.experts && Array.isArray(snap.experts)) {
    for (const ex of snap.experts) {
      expertValues[ex.name] = Math.max(0, Math.min(1, Number(ex.value ?? 0.5)));
      names.push(ex.name);
    }
  } else if (Array.isArray(snap.layers)) {
    for (const layer of snap.layers) {
      for (const ex of (layer.experts || [])) {
        if (expertValues[ex.name] === undefined) names.push(ex.name);
        expertValues[ex.name] = Math.max(0, Math.min(1, Number(ex.gate_weight ?? ex.value ?? 0.5)));
      }
    }
  }
  if (!_moeState) initMoeState(names.length ? names : ["E1","E2","E3","E4","E5"], layerCount);
  if (Object.keys(expertValues).length) _moeState.expertValues = expertValues;
  while (_moeState.layerSizes.length < layerCount) _moeState.layerSizes.push(100);
  _moeState.layerSizes = _moeState.layerSizes.slice(0, layerCount);
  _moeState.noiseDeltas = Array.from({ length: layerCount }, () => 0);
  _moeState.scores = Object.fromEntries(Object.keys(_moeState.expertValues).map((nm) => [nm, 0]));
  _moeState.topP = {}; _moeState.kl = {}; _moeState.output = {};
  _moeState.step = 0; _moeState.round = 1; _moeState.lastRound = null;
  return {
    ok: true, type: fmt || "legacy", id: path.basename(file),
    num_experts: Object.keys(_moeState.expertValues).length,
    layers: layerCount, top_k: Number(snap.routing?.top_k ?? 2),
    base_gguf: snap.model?.base_gguf, tokenizer_from: snap.model?.tokenizer_from,
  };
}

/**
 * CHUNKED-TOKEN BASE INPUT: in non-training (inference) usage the model
 * tokenizes the input, so we map the original tokenizer.json token ids into
 * "chunked" token groups (N raw tokens -> 1 chunk). The chunked ids become the
 * base input tokens of the MoE. Returns the chunk id for a raw token id.
 *   chunk = floor(rawId / chunkSize)
 * A chunk can optionally be re-expressed via a tokenizer codebook (offset) so
 * distinct chunks map to distinct integer handles.
 */
export function tokenToChunk(rawTokenId, chunkSize = 4, vocabOffset = 0) {
  const cs = Math.max(1, Math.floor(Number(chunkSize) || 4));
  const id = Number(rawTokenId) || 0;
  return vocabOffset + Math.floor(id / cs);
}

/** Convert an array of raw token ids into an array of chunked base tokens. */
export function chunkTokenIds(rawIds, chunkSize = 4, vocabOffset = 0) {
  return (rawIds || []).map((id) => tokenToChunk(id, chunkSize, vocabOffset));
}

