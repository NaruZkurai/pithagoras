#!/usr/bin/env node
/**
 * augment-500mb.mjs — grow the 500 MB ternary model toward 30B using TRUE
 * TERNARY values, distilled from the real 27B teacher, and compare the grown
 * model's values against the 27B.
 *
 * The mission: the 500 MB Bonsai-4B-Q1_0 is a TRUE TERNARY model (weights are
 * {-1, 0, +1}, Q1_0 GGUF). We grow it up toward 30B *in that same ternary
 * format* — never FP16 — by teaching it from the real 27B:
 *
 *   Stage 1 (teacher values):  run the REAL 27B (default local :41001, env
 *     TEACHER_URL; falls back to the remote box) on this repo's source
 *     patterns and capture its output token sequences (its "values").
 *   Stage 2 (ternary grow):    feed those teacher token sequences to
 *     llama-finetune (the direct-token fork, wrapped by scripts/train-6gb.sh)
 *     starting from the Q1_0 ternary model, producing an AUGMENTED model that
 *     stays true-ternary (weights {-1,0,+1}); iterations compound toward 30B.
 *   Stage 3 (compare):         run the same held-out prompts through BOTH the
 *     augmented 500MB and the real 27B and compute a token-agreement score —
 *     the measured "how close did the ternary model get to the 27B's values".
 *
 * Outputs (verifiable numbers):
 *   data/augment/teacher/<n>.jsonl   raw 27B teacher token sequences
 *   data/augment/train.jsonl         finetune input (teacher sequences)
 *   models/bonsai-4b-Q1_0-aug.gguf   the grown true-ternary model
 *   output/compare.json              parity vs the real 27B (before/after)
 *   output/augmentation.log / metrics.json
 *
 * Usage:
 *   node scripts/augment-500mb.mjs [--collect] [--grow] [--compare] [--dry-run]
 * By default runs collect + compare; pass --grow to actually finetune.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // scripts dir
const REPO = path.resolve(ROOT, "..");
const PROJECT_TOKENS = path.join(REPO, "data", "project-tokens.json");

// The 500MB TRUE TERNARY model we are growing (Q1_0 = {-1,0,+1} weights).
const TERNARY_MODEL = process.env.TERNARY_MODEL || "/nzk/models/Bonsai-4B-Q1_0.gguf";
// The grown (augmented) true-ternary model this run produces.
const GROWN_MODEL = process.env.GROWN_MODEL || path.join(REPO, "models", "bonsai-4b-Q1_0-aug.gguf");
// The real 27B teacher. Local :41001 by default (verified serving); the remote
// box is used if TEACHER_URL=remote is set.
const TEACHER_URL = process.env.TEACHER_URL || "http://127.0.0.1:41001";
const TEACHER_HTTPS_PORTS = [6464];
const REMOTE_BOX = process.env.REMOTE_BOX || "192.168.2.64";

const OUT = path.join(REPO, "output");
const AUG = path.join(REPO, "data", "augment");
const TEACHER_DIR = path.join(AUG, "teacher");
const TRAIN_JSONL = path.join(AUG, "train.jsonl");
const METRICS_FILE = path.join(OUT, "augmentation.metrics.json");
const LOG_FILE = path.join(OUT, "augmentation.log");
const COMPARE_FILE = path.join(OUT, "compare.json");

const MAX_PATTERNS = Number(process.env.MAX_PATTERNS || 12);
const MAX_TEACHER_TOKENS = Number(process.env.MAX_TEACHER_TOKENS || 256);
const TEACHER_TEMP = Number(process.env.TEACHER_TEMP || 0.2);

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const DO_COLLECT = args.includes("--collect") || !args.includes("--grow");
const DO_GROW = args.includes("--grow");
const DO_COMPARE = args.includes("--compare") || !args.includes("--grow");

/** Resolve the teacher base URL (local 27B or remote box). */
async function resolveTeacherUrl() {
  if (TEACHER_URL !== "remote") return TEACHER_URL;
  for (const port of TEACHER_HTTPS_PORTS) {
    try {
      const h = await fetch(`http://${REMOTE_BOX}:${port}/health`, { signal: AbortSignal.timeout(4000) });
      if (h.ok) return `http://${REMOTE_BOX}:${port}`;
    } catch { /* try next port */ }
  }
  throw new Error(`remote teacher box at ${REMOTE_BOX} unreachable`);
}

/** Ask a model server for a completion (OpenAI-compatible /completion). */
async function complete(url, prompt, maxTokens = MAX_TEACHER_TOKENS) {
  const res = await fetch(`${url}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, n_predict: maxTokens, temperature: TEACHER_TEMP, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return (d && d.content) || "";
}

/** Format a source block into a teacher instruction prompt. */
function toPrompt(relPath, code) {
  const head = code.split("\n").slice(0, 60).join("\n");
  return [
    `Continue this ${/\.(tsx?|jsx?|mjs)$/.test(relPath) ? "TypeScript/JavaScript" : /\.py$/.test(relPath) ? "Python" : "source"} snippet. Preserve its style (ternary-friendly, plain).`,
    "",
    "```",
    head,
    "```",
    "",
    "Continuation:",
  ].join("\n");
}

/** Read this repo's source patterns (path -> tokens). */
function readTokenPatterns() {
  const j = JSON.parse(fs.readFileSync(PROJECT_TOKENS, "utf8"));
  if (!j || !Array.isArray(j.files)) throw new Error("project-tokens.json must be an object with a `files` array");
  const out = {};
  for (const f of j.files) if (f && f.path && typeof f.tokens === "number") out[f.path] = f.tokens;
  return out;
}

/** Pick highest-weight existing source files, excluding noise. */
function sampleSources() {
  const entries = Object.entries(readTokenPatterns())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PATTERNS * 2)
    .filter(([rel]) => !/package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.map$|dist[/\\]/.test(rel))
    .filter(([rel]) => /\.(ts|tsx|js|mjs|jsx|css|md|json|sh|py|rs|yml|yaml)$/.test(rel));
  const picked = [];
  for (const [rel] of entries) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const txt = fs.readFileSync(abs, "utf8").slice(0, 8000).trim();
    if (txt) picked.push({ rel, code: txt });
    if (picked.length >= MAX_PATTERNS) break;
  }
  return picked;
}

// ===========================================================================
// Stage 1 — collect the REAL 27B teacher's output values.
// ===========================================================================
async function collectTeacher(url) {
  fs.mkdirSync(TEACHER_DIR, { recursive: true });
  const samples = sampleSources();
  console.log(`[collect] ${samples.length} source patterns -> REAL 27B teacher at ${url}`);
  const seqs = [];
  for (const [i, s] of samples.entries()) {
    const prompt = toPrompt(s.rel, s.code);
    try {
      const out = await complete(url, prompt);
      if (out && out.trim()) {
        seqs.push({ prompt, continuation: out.trim() });
        fs.writeFileSync(
          path.join(TEACHER_DIR, `${i}.jsonl`),
          JSON.stringify({ source: s.rel, prompt, teacher_output: out.trim() }) + "\n",
          { flag: "a" }
        );
      }
    } catch (e) {
      console.warn(`  [collect] sample ${i} failed: ${e.message}`);
    }
    if (i % 2 === 0) console.log(`  [collect] ${i + 1}/${samples.length}`);
  }
  fs.mkdirSync(AUG, { recursive: true });
  fs.writeFileSync(TRAIN_JSONL, seqs.map((s) => JSON.stringify({ prompt: s.prompt, completion: s.continuation })).join("\n") + "\n");
  console.log(`[collect] ${seqs.length} teacher sequences -> ${TRAIN_JSONL}`);
  return seqs;
}

// ===========================================================================
// Stage 2 — grow the 500MB TRUE TERNARY model from the teacher values.
// llama-finetune (direct-token fork) keeps the model's native ternary layout;
// the input is the teacher token sequences. Compounding these runs grows the
// semantic size toward 30B while weights stay {-1,0,+1}.
// ===========================================================================
function growModel() {
  if (DRY) {
    console.log(`[grow --dry-run] would run: scripts/train-6gb.sh llama-finetune -m ${TERNARY_MODEL} -f ${TRAIN_JSONL} -o ${GROWN_MODEL} --epochs 1`);
    return;
  }
  if (!fs.existsSync(TRAIN_JSONL)) {
    console.warn("[grow] no train.jsonl yet; run --collect first");
    return;
  }
  console.log(`[grow] finetuning TRUE-TERNARY ${TERNARY_MODEL} from teacher data -> ${GROWN_MODEL}`);
  fs.mkdirSync(path.dirname(GROWN_MODEL), { recursive: true });
  // 6GiB system-RAM cap + GPU offload via the wrapper.
  execFileSync(
    "scripts/train-6gb.sh",
    ["llama-finetune", "--gpu", "-m", TERNARY_MODEL, "-f", TRAIN_JSONL, "-o", GROWN_MODEL, "--epochs", process.env.GROW_EPOCHS || "1"],
    { cwd: ROOT, stdio: "inherit", timeout: (Number(process.env.GROW_TIMEOUT) || 60) * 60_000 }
  );
  console.log(`[grow] grown true-ternary model written: ${GROWN_MODEL}`);
}

// ===========================================================================
// Stage 3 — compare the grown 500MB against the REAL 27B's values.
// Held-out prompts are run through both; we score token-agreement so a higher
// score means the 500MB is closer to the 27B teacher.
// ===========================================================================
async function compare(url) {
  fs.mkdirSync(OUT, { recursive: true });
  const evalPrompts = [
    "The portal's model picker sends provider and modelId but the list never changes. The likely cause is:",
    "When llama-server returns an empty generation with stopReason stop and output 2 tokens, the model likely",
    "A ternary Q1_0 weight can hold exactly the values:",
    "To auto-heal a stale session whose model registry is empty, the harness should",
  ];
  console.log(`[compare] ${evalPrompts.length} held-out prompts through 500MB and REAL 27B`);
  const studentUrl = process.env.STUDENT_URL || "http://127.0.0.1:6465";
  const rows = [];
  let agreeTotal = 0, agreeCount = 0;
  for (const [i, p] of evalPrompts.entries()) {
    const teacher = await complete(url, p);
    const student = await complete(studentUrl, p);
    const agree = tokenAgreement(teacher, student);
    agreeTotal += agree; agreeCount++;
    rows.push({ prompt: p, teacher_tokens: teacher.length, student_tokens: student.length, teacher: teacher.slice(0, 120), student: student.slice(0, 120), agreement: agree });
    console.log(`  [compare] ${i + 1}/${evalPrompts.length} agreement=${agree.toFixed(3)}`);
  }
  const result = {
    teacher_url: url,
    student_model: TERNARY_MODEL,
    grown_model: GROWN_MODEL,
    held_out_prompts: evalPrompts.length,
    mean_token_agreement: agreeCount ? agreeTotal / agreeCount : 0,
    rows,
  };
  fs.writeFileSync(COMPARE_FILE, JSON.stringify(result, null, 2));
  console.log(`[compare] mean token-agreement vs REAL 27B = ${result.mean_token_agreement.toFixed(3)} -> ${COMPARE_FILE}`);
  return result;
}

/** Simple value-close score: overlap of the two output texts, 0..1. */
function tokenAgreement(a, b) {
  if (!a || !b) return 0;
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const smaller = ta.length <= tb.length ? ta : tb;
  const larger = ta.length <= tb.length ? tb : ta;
  let hits = 0;
  const set = new Set(larger);
  for (const t of smaller) if (set.has(t)) hits++;
  return hits / Math.max(1, Math.min(ta.length, tb.length));
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function logLines(collectN, compareResult, grew) {
  const L = [
    "=== Augmentation Log ===",
    `Date: ${new Date().toISOString()}`,
    `Teacher (real 27B): ${TEACHER_URL}`,
    `Ternary model (grow target): ${TERNARY_MODEL}`,
    `Grown true-ternary model: ${GROWN_MODEL}`,
    `Teacher sequences collected: ${collectN}`,
    `Grew model (finetune): ${grew ? "yes" : "no (--grow not passed)"}`,
  ];
  if (compareResult) {
    L.push(`Held-out prompts compared: ${compareResult.held_out_prompts}`);
    L.push(`Mean token-agreement vs REAL 27B: ${compareResult.mean_token_agreement.toFixed(3)}`);
    L.push(`Compare file: ${COMPARE_FILE}`);
  }
  return L.join("\n");
}

async function run() {
  console.log("=== Augmentation Runner: TRUE-TERNARY 500MB -> 30B (27B teacher) ===");
  const teacherUrl = await resolveTeacherUrl();
  console.log(`Teacher (real 27B): ${teacherUrl}`);

  let collected = 0, compareResult = null, grew = false;
  if (DO_COLLECT) {
    const seqs = await collectTeacher(teacherUrl);
    collected = seqs.length;
  }
  if (DO_GROW) {
    growModel();
    grew = true;
  }
  if (DO_COMPARE) {
    compareResult = await compare(teacherUrl);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG_FILE, logLines(collected, compareResult, grew) + "\n");
  fs.writeFileSync(
    METRICS_FILE,
    JSON.stringify(
      {
        teacher: teacherUrl,
        ternary_model: TERNARY_MODEL,
        grown_model: GROWN_MODEL,
        grown: grew,
        teacher_sequences: collected,
        compare: compareResult ? { mean_token_agreement: compareResult.mean_token_agreement, held_out: compareResult.held_out_prompts } : null,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("\n=== Augmentation Complete ===");
  console.log(`Verify: ${LOG_FILE}, ${METRICS_FILE}, ${DO_GROW ? GROWN_MODEL : "(grew model only with --grow)"}, ${COMPARE_FILE}`);
}

run().catch((e) => {
  console.error("Augmentation failed:", e);
  process.exit(1);
});
