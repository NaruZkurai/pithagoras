import { Type } from "typebox";
import {
  getSkill,
  recordSkillUsage,
  searchSkillNames,
  searchSkillsCount,
  skillsByName,
  type SkillRow,
} from "../db.js";

/**
 * Skill search, as a tool the agent can call.
 *
 * The /btw philosophy: the search returns a lightweight numbered peek — names
 * and one-line descriptions, never the body — so looking for a skill does not
 * grow the context. The agent then loads the single skill it actually needs by
 * number, which is also recorded so the chat can list it for a human.
 */

const ok = (text: string) => ({ output: text, isError: false });

/** pi may hand args over as an object or a JSON string; normalise. */
function toolArgs(p: any): any {
  let a = p;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = {};
    }
  }
  return a ?? {};
}

/**
 * Score one skill against a task with the dedicated tiny ranking model.
 *
 * The model fills in a short FORM rather than free-text scoring — a tiny model
 * can answer small structured fields it cannot write coherent prose. Each
 * skill goes in its own fresh request (no history of the previous candidate),
 * so every score is judged independently, "as its own thing". The composite
 * 0-100 is computed here from the form, not left to the model.
 *
 * Talks straight to the second llama server (see serve-rank-model.sh), so the
 * main agent's context never grows from this.
 */
async function scoreSkillWithRankModel(
  task: string,
  skill: { name: string; description: string; content: string }
): Promise<{ score: number; reason: string }> {
  const base = (process.env.LLAMA_RANK_BASE_URL || "http://127.0.0.1:8081").replace(/\/$/, "");
  const model = process.env.PI_RANK_MODEL || "bonsai-1.7b";
  const system =
    "Fill in the form for ONE skill. Output only a JSON object, no other text: " +
    '{"relevant": 0 or 1 or 2, "coverage": 0 to 10, "fit": 0 to 10}. ' +
    "relevant: 0=unrelated, 1=partially related, 2=directly related.";
  const user =
    `FORM\nTask: ${task}\n` +
    `Skill name: ${skill.name}\n` +
    `Skill description: ${skill.description}\n\n` +
    "Fill the form:";
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: 80,
    }),
  });
  if (!res.ok) throw new Error(`ranking model HTTP ${res.status}`);
  const data: any = await res.json();
  // Strip template junk (think tags, im_* markers), keep the first JSON object.
  const clean = String(data?.choices?.[0]?.message?.content ?? "").replace(
    /<\/?think>|<\|im_\w+\|>/gi,
    ""
  );
  let form: Record<string, unknown> = {};
  try {
    form = JSON.parse(clean.match(/\{[\s\S]*?\}/)?.[0] ?? "{}");
  } catch {
    form = {};
  }
  const field = (key: string, lo: number, hi: number, dflt: number): number => {
    const n = Number(form[key]);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
  };
  const relevant = field("relevant", 0, 2, 0);
  const coverage = field("coverage", 0, 10, 0);
  const fit = field("fit", 0, 10, 0);
  // Relevance is half the value; coverage and fit split the rest.
  const score = Math.round((relevant / 2) * 40 + (coverage / 10) * 30 + (fit / 10) * 30);
  const relevance =
    relevant === 2 ? "directly related" : relevant === 1 ? "partially related" : "unrelated";
  return { score, reason: `${relevance}; coverage ${coverage}/10, fit ${fit}/10` };
}

/** System hint: one-keyword search, rank, pick by number. */
export function skillHint(): string {
  return [
    "You have a skill library. To find a skill, call skill_search with ONE keyword, refining until the numbered list is small enough to inspect (a more specific keyword if too long, a vaguer one if empty).",
    "If several candidates look relevant, call skill_rank with the task, your query and the candidate numbers — it scores each out of 100 independently and returns them sorted; pick the best.",
    "Load the chosen skill with skill_read (the only way to load one). If nothing fits, create a new skill with the skill-creator skill.",
    "Only end your message with the marker after you have actually loaded a skill: determined best skill <number> — done (the number you loaded). Don't spell out the skill name.",
  ].join(" ");
}

/**
 * Per-session search cache: identical queries in the same chat reuse the
 * ranked names instead of re-scoring (the pre-tokenized lexical scan).
 * Scoped by session so one chat's search never pollutes another's numbers;
 * a library re-index clears it naturally on restart (fresh process).
 */
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_DEPTH = 40;
const searchCache = new Map<string, { names: string[]; at: number }>();

function searchCacheKey(sessionId: string, q: string): string {
  return `${sessionId}\u0000${q.toLowerCase()}`;
}

/**
 * Ranked skill names for a query, cached per (session, query). Computes fresh
 * when absent or expired, then serves hits without any re-scoring.
 */
async function rankedSearch(
  sessionId: string,
  q: string,
  limit: number
): Promise<string[]> {
  const key = searchCacheKey(sessionId, q);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    return hit.names.slice(0, limit);
  }
  // Pure lexical scoring over the pre-tokenized mirrors — no model calls.
  const names = searchSkillNames(q, SEARCH_CACHE_DEPTH);
  searchCache.set(key, { names, at: Date.now() });
  return names.slice(0, limit);
}

/** An ExtensionFactory — every session can search the library. */
export function skillTools(pi: any, ctx: { sessionId: string }): void {
  pi.registerTool({
    name: "skill_search",
    label: "Search the skill library",
    description:
      "Search the skill library for a skill matching your task. Give ONE keyword (a single word). Returns a compact numbered list — number, name, short description. If the list is too long to inspect, call again with a more specific keyword to narrow it; if it's empty, call again with a vaguer keyword. Pick one by number, then call skill_read.",
    promptSnippet: "skill_search — find numbered skill matches",
    parameters: Type.Object({
      query: Type.String({ description: "A single keyword for the task" }),
      limit: Type.Optional(Type.Number({ description: "How many matches (default 5)" })),
    }),
    async execute(_id: string, p: any) {
      const args = toolArgs(p);
      const q = String(args?.query ?? "").trim().slice(0, 200);
      if (!q) return ok("Give one keyword to search for.");
      const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
      // Ranked once per (chat, query) and cached: identical searches reuse
      // the scores instead of re-scoring.
      const names = await rankedSearch(ctx.sessionId ?? "", q, limit);
      const rows = skillsByName(names);
      if (!rows.length)
        return ok("No skills match. Retry skill_search with a vaguer keyword, or create a new skill with the skill-creator skill.");
      const total = searchSkillsCount(q);
      const list = JSON.stringify(
        rows.map((r, i) => ({
          number: i + 1,
          name: r.name,
          description: r.description,
        })),
        null,
        2
      );
      // Tell it how many matched so it can narrow a too-big list to fit.
      return total > rows.length
        ? `${list}\n(${total} total — refine with a more specific keyword to narrow this list)`
        : list;
    },
  });

  pi.registerTool({
    name: "skill_rank",
    label: "Score candidate skills out of 100 for your task",
    description:
      "Scores each candidate skill's value to your task out of 100. Each one is judged independently by a dedicated tiny model (the previous one is forgotten first), then the list comes back sorted best-first with one-line reasons. Use after skill_search when several skills look relevant, then load the best with skill_read.",
    promptSnippet: "skill_rank — score candidates out of 100, pick the best",
    parameters: Type.Object({
      task: Type.String({ description: "Your task, as written" }),
      query: Type.String({ description: "The keyword(s) you searched with (same as skill_search)" }),
      numbers: Type.Array(Type.Number({ description: "Candidate numbers from skill_search" })),
    }),
    async execute(_id: string, p: any) {
      const args = toolArgs(p);
      const task = String(args?.task ?? "").trim().slice(0, 500);
      const q = String(args?.query ?? "").trim().slice(0, 200);
      const rawNumbers: unknown[] = Array.isArray(args?.numbers) ? args.numbers : [];
      const numbers = rawNumbers.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1);
      if (!task) return ok("Pass the task so candidates can be scored against it.");
      if (!q) return ok("Pass the keyword(s) you searched with so the candidate numbers resolve.");
      if (!numbers.length) return ok("Pass at least one candidate number from skill_search.");
      const names = await rankedSearch(ctx.sessionId ?? "", q, Math.max(...numbers, 1));
      const candidates = numbers
        .map((n) => ({ n, row: names[n - 1] ? getSkill(names[n - 1]!) : undefined }))
        .filter((x): x is { n: number; row: SkillRow } => !!x.row);
      if (!candidates.length)
        return ok("None of those numbers matched the search. Run skill_search again.");
      try {
        // Each candidate is scored in its own fresh requests — the ranking
        // model literally forgets the previous one, so every score is its own
        // thing. Repetition (PI_RANK_REPS > 1) fires a few form-fills in
        // parallel and averages them to smooth a noisy scorer.
        const reps = Math.max(1, Math.min(8, Number(process.env.PI_RANK_REPS) || 1));
        const scored = await Promise.all(
          candidates.map(async ({ n, row }) => {
            const tries = await Promise.all(
              Array.from({ length: reps }, () => scoreSkillWithRankModel(task, row))
            );
            const score = Math.round(tries.reduce((s, t) => s + t.score, 0) / tries.length);
            const reason =
              tries.sort((a, b) => Math.abs(a.score - score) - Math.abs(b.score - score))[0]
                ?.reason ?? "";
            return { number: n, name: row.name, score, reason };
          })
        );
        scored.sort((a, b) => b.score - a.score || a.number - b.number);
        return ok(JSON.stringify({ best: scored[0], ranked: scored }, null, 2));
      } catch (e) {
        // Ranking model down — degrade gracefully; the agent can still pick.
        return ok(
          `Ranking model unavailable (${(e as Error).message}). Pick from the search list yourself with skill_read.`
        );
      }
    },
  });

  pi.registerTool({
    name: "skill_read",
    label: "Load one skill's instructions",
    description:
      "Load the full instructions of the skill you chose (by number from skill_search). Call this once for the skill you picked — loading one keeps the conversation small.",
    promptSnippet: "skill_read — load the chosen skill's instructions",
    parameters: Type.Object({
      number: Type.Number({ description: "The skill's number from the skill_search results" }),
      query: Type.String({ description: "The same keywords you searched with" }),
    }),
    async execute(_id: string, p: any) {
      const args = toolArgs(p);
      const q = String(args?.query ?? "").trim().slice(0, 200);
      const n = Number(args?.number);
      if (!q || !Number.isFinite(n) || n < 1) {
        return ok("Pass the query you searched with and the skill's number from the results.");
      }
      const names = await rankedSearch(ctx.sessionId ?? "", q, Math.max(n, 1));
      const name = names[n - 1];
      const skill = name ? getSkill(name) : undefined;
      if (!skill) return ok("That number is out of range for this search. Run skill_search again.");
      // Only the chosen skill's instructions enter the conversation, and the
      // choice is recorded so the chat can list what was used.
      if (ctx.sessionId) recordSkillUsage(ctx.sessionId, skill.name);
      return ok(JSON.stringify({ name: skill.name, instructions: skill.content }, null, 2));
    },
  });
}
