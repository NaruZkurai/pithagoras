#!/usr/bin/env node
/**
 * check-teacher-student-alignment.mjs
 *
 * Quantitatively measures whether the STUDENT model can converge toward the
 * TEACHER at all, by comparing their token distributions over the same prompt.
 *
 * WHY: the MoE training harness (teacher-live) scores the student on how many
 * of its top-k tokens overlap the teacher's top-k, and fires a "500x" when the
 * compressed new token appears in the teacher's top-k. But if the student and
 * teacher produce DISJOINT token preferences at the same position (the student
 * never even ranks the teacher's top tokens in its top-100), then overlap and
 * 500x can NEVER fire — no amount of steering/sampling/context can bridge a gap
 * when the target tokens aren't in the candidate set at all. This script proves
 * that gap in one shot (it was the definitive diagnosis 2026-08-16 that the
 * served TQ1_0 student was broken: incoherent multilingual garbage + disjoint
 * top-k vs the teacher).
 *
 * Usage:
 *   node scripts/check-teacher-student-alignment.mjs \
 *     [teacherUrl] [studentUrl] [promptText]
 *   (defaults: teacher :41001, student :6466, the portal prompt)
 */
import fs from "node:fs";

const TEACHER = process.argv[2] || "http://127.0.0.1:41001";
const STUDENT = process.argv[3] || "http://127.0.0.1:6466";
const PROMPT = process.argv[4] ||
  "Consider the Pithagoras portal: the pi model picker sends provider and modelId.";

async function tokenize(url, text) {
  const r = await fetch(`${url}/tokenize`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  const d = await r.json();
  return d.tokens || [];
}

async function topAt(url, ids, n) {
  const r = await fetch(`${url}/v1/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "x", prompt: ids, max_tokens: 1,
      temperature: 0.7, top_p: 0.99, top_k: n, logprobs: n, stream: false,
    }),
  });
  const d = await r.json();
  const c = d?.choices?.[0]?.logprobs?.content?.[0];
  const top = (c?.top_logprobs || []).map((x) => ({ id: x.id, token: x.token, logprob: x.logprob }));
  return { chosenToken: c?.token, top };
}

async function main() {
  const ids = await tokenize(TEACHER, PROMPT);
  console.log(`teacher: ${TEACHER}\nstudent: ${STUDENT}\nprompt tokens: ${ids.length}`);

  const teacher = await topAt(TEACHER, ids, 20);
  const student = await topAt(STUDENT, ids, 100);

  const tTop = teacher.top;
  const sIds = new Set(student.top.map((x) => x.id));
  const sTokens = new Set(student.top.map((x) => x.token));

  const overlap = tTop.filter((x) => sIds.has(x.id));
  const sample = (x, n) => x.slice(0, n).map((t) => `${t.token}(${t.id})`).join(", ");

  console.log("\nteacher top-20:");
  console.log("  " + sample(tTop, 20));
  console.log("student top-100 sample:");
  console.log("  " + sample(student.top, 20));
  console.log("\nteacher top-k tokens ALSO in student top-100:", overlap.length);
  for (const o of overlap) console.log(`  MATCH: ${o.token} (${o.id})`);
  console.log(`\nstudent chosen token: ${student.chosenToken}`);

  if (overlap.length === 0) {
    console.log("\n>>> DISJOINT: student never ranks teacher's top-k in its top-100.");
    console.log(">>> Overlap-based training + 500x cannot converge with this student —");
    console.log(">>> the student model must be rebuilt/realigned with the teacher (model-level fix).");
    process.exit(1);
  } else {
    console.log(`\n>>> Aligned ${overlap.length}/${tTop.length} teacher top-k in student top-100 — training viable.`);
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
