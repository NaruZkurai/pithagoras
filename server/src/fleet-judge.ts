/**
 * Fleet progress judge — let the small 4B base-models independently decide
 * whether the upgrade agent is making progress.
 *
 * The idea (from the self-training plan): the 27B doing the work can't be
 * trusted to self-assess; the fleet of cheap 4B models are INDEPENDENT judges.
 * They're each asked a single binary question over the agent's recent live
 * activity ("has it produced a usable action / is it moving toward a real file
 * edit?"). A majority verdict ("progress" vs "stuck") feeds back into the
 * monitoring loop — if the fleet says "stuck", escalate the nudging.
 *
 * Cheap by design: each 4B field is ~1GB, 4k context, one short completion each.
 * Judges are f2..f5 (the four AFTER the primary 4b-f1), a simple rotation.
 */

const JUDGE_PORTS = [6466, 6467, 6468, 6469]; // f2..f5 on 192.168.2.64
const HOST = process.env.FLEET_HOST || "192.168.2.64";
const TIMEOUT_MS = 15_000;

export interface FleetJudgeVerdict {
  /** Whether the majority says progress is being made. */
  progress: boolean;
  /** votes: model port -> yes/no/error */
  votes: Record<number, "yes" | "no" | "error">;
  /** Short reason from the majority (or from the first responding judge). */
  reason: string;
  /** true when NOT enough judges answered to call a verdict. */
  inconclusive: boolean;
}

/** Build the tiny judge prompt from the agent's recent, truncated activity. */
function judgePrompt(activity: string): string {
  return (
    "You are a progress judge for an autonomous coding agent. Below is its recent " +
    "activity log. Decide: is it making real progress toward producing a verified " +
    "source-file edit, or is it stuck/wasting time (only reading, talking, or " +
    "repeating)?\n\nRecent activity:\n" +
    activity.slice(0, 1200) +
    '\n\nReply with EXACTLY one line: "YES <short reason>" on a new file edit in progress, or "NO <short reason>" if it is stuck. Do not add anything else.'
  );
}

/** Ask one 4B model to judge; returns yes/no or throws. */
async function askJudge(port: number, prompt: string): Promise<string> {
  const res = await fetch(`http://${HOST}:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 24,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`judge :${port} HTTP ${res.status}`);
  const j: any = await res.json();
  const text: string = j?.choices?.[0]?.message?.content ?? "";
  return text.trim().toUpperCase();
}

function classify(raw: string): "yes" | "no" | "error" {
  if (/^YES/.test(raw)) return "yes";
  if (/^NO/.test(raw)) return "no";
  return "error";
}

/**
 * Run the fleet judge over the four 4B models. Loops over them so a slow or
 * down judge doesn't block the rest. Returns a majority verdict.
 */
export async function fleetJudge(activity: string): Promise<FleetJudgeVerdict> {
  const prompt = judgePrompt(activity);
  const votes: FleetJudgeVerdict["votes"] = {};
  const reasons: string[] = [];

  await Promise.all(
    JUDGE_PORTS.map(async (port) => {
      try {
        const raw = await askJudge(port, prompt);
        const v = classify(raw);
        votes[port] = v;
        if (v !== "error") reasons.push(`${port}:${v}:${raw.replace(/\s+/g, " ").slice(0, 80)}`);
      } catch {
        votes[port] = "error";
      }
    })
  );

  const yes = Object.values(votes).filter((v) => v === "yes").length;
  const no = Object.values(votes).filter((v) => v === "no").length;
  const answered = yes + no;
  const inconclusive = answered < 2; // need at least 2 of 4 to call it
  const progress = !inconclusive && yes > no;
  const reason = reasons[0] || (inconclusive ? "Too few judges answered." : "");

  return { progress, votes, reason, inconclusive };
}

/** The "other 4" model definition for readability elsewhere. */
export const FLEET_JUDGE_PORTS = JUDGE_PORTS;
