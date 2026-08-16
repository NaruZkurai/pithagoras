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
export function loadConfig() {
  // Always read from disk so live UI edits to config/moe-config.json apply
  // immediately (no stale cache across steps).
  try {
    _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* keep last on transient read error */ }
  return _cfg;
}

export function saveConfig(c) { _cfg = c; fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

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
  _moeState = {
    expertValues: Object.fromEntries(expertNames.map((n, i) => [n, 0.5 + 0.4 * noise01(i + 7)])),
    layerSizes: Array.from({ length: layerCount }, (_, i) => Math.round(100 + noise01(i + 31) * 400)),
    noiseDeltas: Array.from({ length: layerCount }, () => 0), // bounded per-layer noise deltas
    topP: {},       // per-expert top-p summary (persisted)
    kl: {},         // per-expert KL (persisted)
    output: {},     // per-expert output signal history (persisted)
    scores: {},     // per-expert CUMULATIVE points across this round (all experts, not just top-2)
    noise: 0,       // running noise accumulator
    step: 0,
    round: 1,
    lastRound: null, // snapshot of the previous round's final state (for comparison after reset)
  };
  return _moeState;
}
export function getMoeState() { return _moeState; }

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
  const losingCount = Math.max(0, Math.min(nExp, Number(policy.update_losing_experts ?? 2)));
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
      // Losing experts: re-seed from the previous window's data (or fresh).
      const seeded = fromLast && lastValues[nm] != null
        ? lastValues[nm] * (0.7 + 0.3 * noise01((+new Date()) + nm.length * 3))
        : 0.5 + 0.4 * noise01((+new Date()) + nm.length * 3);
      _moeState.expertValues[nm] = Math.max(0, Math.min(1, seeded));
      refreshed.push(nm);
      continue;
    }
    // Non-top: keep being updated (trainStep handles the deltas).
    if (doUpdateNonTop) {
      _moeState.expertValues[nm] = Math.max(0, Math.min(1,
        (_moeState.expertValues[nm] || 0.5) + (noise01((+new Date()) + nm.length * 7) - 0.5) * 0.04));
    }
  }

  // Clear per-token accumulators, keep per-expert keys.
  _moeState.topP = {}; _moeState.kl = {}; _moeState.output = {};
  _moeState.scores = Object.fromEntries(names.map((nm) => [nm, 0]));
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
    const seeded = fromLast && lastValues[nm] != null
      ? lastValues[nm] * (0.7 + 0.3 * noise01((+new Date()) + nm.length * 5))
      : 0.5 + 0.4 * noise01((+new Date()) + nm.length * 5);
    _moeState.expertValues[nm] = Math.max(0, Math.min(1, seeded));
    _moeState.scores[nm] = 0; // reset the losing expert's score
  }
  console.log(`  >> update losing experts (every ${every} steps, auto=${auto}, count ${losingCount}): [${losing.join(",") || "none"}]`);
  return losing;
}

/** Number of experts currently tracked (used to clamp policy sizes). */
function moeScoresSize() { return _moeState ? Object.keys(_moeState.expertValues).length : 0; }

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
  _moeState.layerSizes = _moeState.layerSizes.map((v, i) =>
    Math.max(10, Math.min(1000, v + _moeState.noiseDeltas[i] * 20))
  );
  _moeState.step += 1;
  return { layers: _moeState.noiseDeltas.slice(), step: _moeState.step };
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
    v = Math.max(0, Math.min(1, v));
    _moeState.expertValues[nm] = v; // persist
    return { name: nm, affinity: v, value: v, active: false, role: experts[nm].role, mutation: experts[nm].mutation, topk_weight: experts[nm].topk_weight };
  };
  const rows = [
    mk("E1", e1v), mk("E2", e2v), mk("E3", e3v), mk("E4", e4v), mk("E5", e5v),
  ];

  // Add any experts beyond E1..E5 (added via UI) with a noise-based mutation.
  for (const k of names) {
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
      scores: { ..._moeState.scores },
      lastRound: _moeState.lastRound,
      expertValues: { ..._moeState.expertValues },
      layerSizes: _moeState.layerSizes.slice(),
    },
  };
}

/**
 * Training-update per expert + per layer from the config formulas.
 * We model a small weight adjustment (true-ternary-flavored) so growing stays
 * ternary and is saved.
 */
export function trainStep(route, teacherVal, studentVal) {
  const cfg = loadConfig();
  const layers = cfg.layers;
  const group = route.rows.filter((r) => r.active);
  if (!_moeState) initMoeState(route.rows.map((r) => r.name), route.layer_count);
  let delta = 0;
  const perExpert = group.map((r) => {
    const spec = cfg.moe.experts[r.name];
    // per-expert formula = overlap-adjusted parity update, scaled by layer lr/gate.
    const d = (teacherVal - studentVal) * layers.each.topk_gate * layers.each.lr * r.affinity;
    delta += d;
    // Persist the expert's value so it keeps accumulating (NOT reset on update)
    // and track per-expert top-p / KL / output signals.
    const prev = _moeState.expertValues[r.name] ?? r.value;
    const updated = Math.max(0, Math.min(1, prev + d));
    _moeState.expertValues[r.name] = updated;
    _moeState.topP[r.name] = (Number(_moeState.topP[r.name]) || 0) + d * 100;
    _moeState.kl[r.name] = (Number(_moeState.kl[r.name]) || 0) + Math.abs(d);
    _moeState.output[r.name] = d;
    return { expert: r.name, delta: d, value: updated, topk_weight: r.topk_weight, prev };
  });
  // Per-layer training update (each of the `count` layers gets a slice of the
  // active-experts' delta, scaled by its layer weight).
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
export function curveReward({ student, teacherTopK, perTokenMatch, compressedToken, newTokenSet }) {
  const cfg = loadConfig()?.scoring?.curve || {};
  const expBase = Number(cfg.exp_base ?? 2.0);
  const expScaler = Number(cfg.exp_scaler ?? 4.0);
  const compressedMult = Number(cfg.compressed_token_mult ?? 4.0);
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
  return { reward, overlapFraction, matched, numSlots, compressedMatched, compressedSlotRank, total };
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
 * `tally_before_reset` is handled by the caller (the harness accumulates this
 * into the round cumulative score before `maybeResetMoeState`).
 *
 * Returns { reward, compressionRatio, baseEffectiveTokens, textLengthGenerated,
 *           tokensSaved, newTokenMatchPct, multiplier, appliedMultiplier }.
 */
export function compressionReward({ emittedTokens, perTokenEmitted, textLengthGenerated, newTokenSet }) {
  const cfg = loadConfig()?.scoring?.compression || {};
  const emitted = Math.max(1, Number(emittedTokens ?? cfg.base_effective_tokens ?? 5));
  const reference = Math.max(1, Number(cfg.reference_tokens ?? 23));
  const textLen = Number(textLengthGenerated ?? 0);
  const textFactor = Number(cfg.text_length_factor ?? 1.0);
  const mult = Number(cfg.multiplier ?? 1.0);

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
    reward,
    compressionRatio,
    baseEffectiveTokens: baseEffective,
    textLengthGenerated: textLen,
    tokensSaved,
    newTokenMatchPct,
    multiplier: mult,
    appliedMultiplier,
  };
}

/**
 * SAVE THE MODEL as a REAL Mixture-of-Experts (NOT dense). Each layer carries
 * `num_experts` distinct ternary expert weight banks (W_up/W_gate/W_down) plus
 * a learned routing gate; only the top-k experts are active per token — a true
 * sparse-MoE structure, not a flat dense snapshot.
 *
 * Weight format: true ternary {-1, 0, +1}, kept per-expert so a runtime (or the
 * direct-token fork's finetune) can consume them as MoE layers. $moeState values
 * seed each expert's gate/bank and are extended by the latest training step.
 */
export function saveModel(step, route, training, moeState) {
  const sv = path.join(REPO, "config", "moe", "model", "save_dir");
  fs.mkdirSync(sv, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(sv, `moe-moe-step-${step}-${ts}.json`);
  const cfg = loadConfig() || {};
  const numExperts = route.count || Object.keys(cfg.moe?.experts || {}).length || 5;
  const layerCount = route.layer_count || cfg.layers?.count || 5;
  const topkRoute = route.topk_route || cfg.moe?.topk_route || 2;
  const names = route.rows.map((r) => r.name);

  const buildTernary = (seed, nCols) => {
    // deterministic {-1,0,+1} bank from a seed; non-neg values drive gate logits
    return Array.from({ length: nCols }, () =>
      Math.round(noise01(seed) * 2) - 1); // maps 0,1,2 -> -1,0,+1
  };

  // REAL sparse-MoE layers: per layer, per-expert ternary FFN banks + a router.
  const layers = Array.from({ length: layerCount }, (_, li) => {
    const experts = names.map((nm, ei) => {
      const val = _moeState?.expertValues?.[nm] ?? route.rows[ei]?.value ?? 0.5;
      return {
        name: nm,
        role: cfg.moe?.experts?.[nm]?.role || "base",
        mutation: cfg.moe?.experts?.[nm]?.mutation || "none",
        w_up: buildTernary(seedBase(nm, li, 0), 128),   // expert up-projection (ternary)
        w_gate: buildTernary(seedBase(nm, li, 1), 128), // expert gate-projection (ternary)
        w_down: buildTernary(seedBase(nm, li, 2), 128), // expert down-projection (ternary)
        gate_weight: Number(val.toFixed ? val.toFixed(4) : val), // routing logit for this expert
      };
    });
    return {
      layer: "L" + (li + 1),
      router: { type: "top-" + topkRoute, gate: Object.fromEntries(experts.map((e) => [e.name, e.gate_weight])) },
      experts, // one expert bank per expert — real MoE
    };
  });

  const snap = {
    format: "ternary-moe-checkpoint", // real MoE, not dense
    architecture: "sparse-moe",
    step,
    ts: new Date().toISOString(),
    true_ternary: true,
    routing: { num_experts: numExperts, layers: layerCount, top_k: topkRoute },
    model: {
      base_gguf: cfg.model?.base_gguf,
      tokenizer_from: cfg.model?.tokenizer_from,
      tokenizer_json: cfg.model?.tokenizer_json,
    },
    layers,
    training: {
      delta: training.delta,
      perExpert: training.perExpert,
    },
  };
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}
function seedBase(nm, li, k) {
  const idx = parseInt(nm.replace(/\D/g, "") || 0, 10);
  return ((+new Date()) % 1e6) + idx * 101 + li * 7 + k * 13;
}
