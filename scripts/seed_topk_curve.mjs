#!/usr/bin/env node
// One-time seed: rebuild output/live/topk-curve.jsonl with the CURRENT prompt's
// (config training.prompt) teacher top-k, so the file-only windowing references
// the right teacher output instead of a stale/old-prompt file.
//
// USAGE:
//   node scripts/seed_topk_curve.mjs [maxTokens]
//
// Does ONE teacher forward pass (no training loop teacher gens) — the teacher
// server must be up (default :41001). Backs up the old file to
// topk-curve.jsonl.bak then writes fresh rows.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const LIVE = path.join(REPO, "output", "live");
const CURVE = path.join(LIVE, "topk-curve.jsonl");

const TEACHER_URL = process.env.TEACHER_URL || "http://127.0.0.1:41001";
const MAX_TOKENS = Number(process.env.SEED_TOKENS || process.argv[2] || 8);
// The CPU teacher is slow on the FULL 41k shader prompt (and logprobs=60 is
// expensive). So we seed from the FIRST SEED_PROMPT_CHARS chars of the prompt
// with a modest VIEW_TOPK — fast enough (a few seconds) to get real,
// prompt-appropriate continuation tokens into topk-curve.jsonl.
const SEED_PROMPT_CHARS = Number(process.env.SEED_PROMPT_CHARS || 800);
const VIEW_TOPK = Number(process.env.VIEW_TOPK || 20);
const EMIT_TK = Number(process.env.EMIT_TK || 30);
const EMIT_TP = Number(process.env.EMIT_TP || 0.95);
const TEMP = Number(process.env.TEMP || 0.7);

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(REPO, "config", "moe-config.json"), "utf8"));
}

async function main() {
  const cfg = loadConfig();
  const fullPrompt = String(cfg?.training?.prompt ?? "").trim();
  if (!fullPrompt) { console.error("no training.prompt in config"); process.exit(1); }
  const prompt = fullPrompt.slice(0, SEED_PROMPT_CHARS); // truncated for speed
  console.log(`seeding teacher top-k from current prompt (${prompt.length}/${fullPrompt.length} chars, ${MAX_TOKENS} tokens, view-top-${VIEW_TOPK})...`);

  const body = JSON.stringify({
    model: "x", prompt, max_tokens: MAX_TOKENS, temperature: TEMP,
    top_p: EMIT_TP, top_k: EMIT_TK, logprobs: VIEW_TOPK, echo: false, stream: false,
  });
  const res = await fetch(`${TEACHER_URL}/v1/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
    signal: AbortSignal.timeout(Number(process.env.SEED_TIMEOUT || 600_000)),
  });
  if (!res.ok) {
    let detail = ""; try { detail = (await res.text()).slice(0, 400); } catch {}
    console.error(`teacher ${res.status}: ${detail}`); process.exit(1);
  }
  const d = await res.json();
  // The fork returns logprobs.content = [{ id/token_id, token, logprob, top_logprobs:[{id,token,logprob}] }]
  const content = d?.choices?.[0]?.logprobs?.content || [];
  if (!content.length) { console.error("no logprobs.content returned"); process.exit(1); }

  const rows = content.map((row, i) => {
    const teacherId = Number(row.id ?? row.token_id ?? 0);
    const teacherToken = row.token != null ? String(row.token) : null;
    const top = (row.top_logprobs || [])
      .map((t) => ({ id: Number(t.id ?? t.token_id ?? 0), token: t.token, logprob: Number.isFinite(t.logprob) ? t.logprob : 0 }))
      .sort((a, b) => b.logprob - a.logprob)
      .slice(0, VIEW_TOPK);
    return {
      step: i + 1,
      ctx: prompt.slice(0, 400),
      teacher_token: teacherToken,
      teacher_id: teacherId,
      top_k: top,
      top_k_size: top.length,
      ts: Date.now() + i,
    };
  });

  if (fs.existsSync(CURVE)) fs.copyFileSync(CURVE, CURVE + ".bak");
  fs.writeFileSync(CURVE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${rows.length} fresh rows to ${CURVE}`);
  console.log("tokens:", rows.map((r) => JSON.stringify(r.teacher_token)).join(" "));
}

main().catch((e) => { console.error(e); process.exit(1); });
