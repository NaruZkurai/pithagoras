import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { upsertCheckpoint } from "./db.js";

const exec = promisify(execFile);

/** Max bytes of the captured diff we keep per checkpoint (keep it cheap). */
const MAX_DIFF_BYTES = 64 * 1024;

/**
 * Capture the workspace git state at one timeline point and store it as a
 * checkpoint for (sessionId, seq). If the dir is not a git repo, nothing is
 * stored. Idempotent: a checkpoint already present for the (session, seq) is
 * left untouched.
 *
 * The checkpoint records the HEAD it was captured at, the list of changed file
 * paths (git status --porcelain), and the actual unstaged diff patch (capped).
 * Storing the patch at capture time keeps it accurate to that exact moment even
 * as the repo later moves on — essential for the "what code was this message
 * anchored to?" use case.
 */
export async function captureCheckpoint(
  sessionId: string,
  seq: number,
  dir: string
): Promise<void> {
  try {
    const head = await exec("git", ["-C", dir, "rev-parse", "--short", "HEAD"])
      .then((r) => r.stdout.trim())
      .catch(() => "");

    let dirtyList: string[] = [];
    let diff = "";
    const status = await exec("git", ["-C", dir, "status", "--porcelain"])
      .then((r) => r.stdout)
      .catch(() => "");
    for (const line of status.split("\n")) {
      if (!line.trim()) continue;
      // "XY path" — keep the status letters + path; strip quoting from rename/copy.
      const pathPart = line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() ?? "";
      dirtyList.push(`${line.slice(0, 2)} ${pathPart.trim()}`);
    }

    if (dirtyList.length) {
      diff = await exec("git", ["-C", dir, "diff", "--no-color"])
        .then((r) => r.stdout)
        .catch(() => "");
    }

    if (!head && !dirtyList.length) return; // not a git repo / nothing to record
    if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
      diff = diff.slice(0, MAX_DIFF_BYTES) + "\n…(truncated)";
    }

    upsertCheckpoint({
      session_id: sessionId,
      seq,
      head,
      dirty: JSON.stringify(dirtyList),
      diff,
    });
  } catch {
    // Swallow git errors — a checkpoint is best-effort and never fatal.
  }
}
