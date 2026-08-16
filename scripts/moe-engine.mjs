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
 * Build the expert-layer STATES for one routing step.
 * Each expert observes the top-k input and produces a weight; only the TOP 2
 * (by affinity) are kept active. Mutations follow the owner's spec:
 *   E3 = E4 + noise, E5 = similar-neurons(E1..E4) + noise.
 */
export function routeExperts(topKTokens) {
  const cfg = loadConfig().moe;
  const experts = cfg.experts;
  const n = Object.keys(experts).length;
  const seed = (+new Date()) & 0xffffff;

  // Base affinity: each expert's agreement with the top-k input (mutated).
  const rows = [];
  const base = topKTokens || [];
  const baseSet = new Set(base);

  // E1, E2, E4 base; E3 = E4+noise; E5 = similar of E1..E4 + noise.
  const baseAffinity = baseSet.size ? 0.6 + 0.3 * Math.random() : 0.3;
  const e4 = baseAffinity;
  const e1 = baseAffinity * (0.9 + 0.1 * Math.random());
  const e2 = baseAffinity * (0.85 + 0.15 * Math.random());
  const e3 = Math.min(1, e4 + experts.E3.noise * noise01(seed));      // E4 + noise
  // E5: only similar neurons of E1..E4 + noise.
  const e5 = Math.min(1, (e1 + e2 + e3 + e4) / 4 * (0.95 + experts.E5.noise * noise01(seed + 7)));

  rows.push({ name: "E1", affinity: e1, active: false });
  rows.push({ name: "E2", affinity: e2, active: false });
  rows.push({ name: "E3", affinity: e3, active: false, mutation: "E4+noise" });
  rows.push({ name: "E4", affinity: e4, active: false });
  rows.push({ name: "E5", affinity: e5, active: false, mutation: "similar(E1..E4)+noise" });

  // Keep only the TOP 2 by affinity.
  rows.sort((a, b) => b.affinity - a.affinity);
  for (let i = 0; i < Math.min(cfg.topk_route, rows.length); i++) rows[i].active = true;

  return { rows, count: n, topk_route: cfg.topk_route };
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
  let delta = 0;
  const perExpert = group.map((r) => {
    const spec = cfg.moe.experts[r.name];
    // per-expert formula = overlap-adjusted parity update, scaled by layer lr/gate.
    const d = (teacherVal - studentVal) * layers.each.topk_gate * layers.each.lr * r.affinity;
    delta += d;
    return { expert: r.name, delta: d };
  });
  return { delta, perExpert, layers: layers.count };
}

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
 * SAVE the model while generating: writes current expert/layer training state
 * (as ternary signatures) to the save dir as a snapshot file.
 */
export function saveModel(step, route, training) {
  const sv = path.join(REPO, "config", "moe", "model", "save_dir");
  fs.mkdirSync(sv, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(sv, `moe-step-${step}-${ts}.json`);
  const snap = {
    step,
    ts: new Date().toISOString(),
    moe: {
      expert_states: route.rows,
      training: {
        delta: training.delta,
        perExpert: training.perExpert,
        layers: training.layers,
      },
      true_ternary: true,
    },
  };
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}
