import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The agent is one long-lived pi session rooted at a fixed directory, separate
 * from the per-task sessions under the workspace root. Every channel is a door
 * into that same conversation rather than a conversation of its own, so the
 * agent keeps one memory of what it has been asked and told.
 *
 * Kept out of the workspace root deliberately: it is not a project you would
 * start a session against, and listing it as one would be misleading.
 */
export function agentHome(): string {
  const dir = path.resolve(process.env.AGENT_HOME || "/data/agent-home");
  mkdirSync(dir, { recursive: true });
  return dir;
}
