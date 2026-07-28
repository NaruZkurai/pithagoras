import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./agent.js";

/**
 * The agent's home directory.
 *
 * These three are handed to pi as context files when a session starts, through
 * the resource loader's agentsFilesOverride. Nothing is generated from them:
 * an earlier version composed an AGENTS.md because pi only discovers one
 * context file per directory, but the SDK takes an explicit list, which leaves
 * no second copy to drift and puts MEMORY.md genuinely in context rather than
 * relying on the agent to go and read it.
 */

export const AGENT_FILES = ["SOUL.md", "PrimaryUser.md", "MEMORY.md"] as const;
export type AgentFile = (typeof AGENT_FILES)[number];

const filePath = (name: string) => path.join(agentHome(), name);

export const isInitialised = (): boolean => AGENT_FILES.every((f) => existsSync(filePath(f)));

export function readAgentFile(name: string): string {
  try {
    return readFileSync(filePath(name), "utf8");
  } catch {
    return "";
  }
}

export function agentFileStatus() {
  return {
    home: agentHome(),
    initialised: isInitialised(),
    files: AGENT_FILES.map((name) => ({
      name,
      exists: existsSync(filePath(name)),
      content: readAgentFile(name),
    })),
  };
}

export function writeAgentFile(name: string, content: string): void {
  if (!(AGENT_FILES as readonly string[]).includes(name)) {
    throw new Error(`"${name}" is not one of the agent's files`);
  }
  writeFileSync(filePath(name), content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

export interface WizardInput {
  agentName: string;
  vibe?: string;
  principles?: string;
  userName: string;
  userAbout?: string;
  userPrefers?: string;
}

/**
 * Write the three files from the wizard's answers.
 *
 * The templates are opinionated on purpose: an empty SOUL.md produces a
 * characterless agent, and someone setting this up for the first time has no
 * reason to know what belongs in one.
 */
export function runWizard(input: WizardInput): void {
  const name = input.agentName.trim() || "the agent";
  const vibe = input.vibe?.trim();
  const principles = input.principles?.trim();

  const soul = [
    `# ${name}`,
    "",
    vibe ? vibe : `You are ${name}. You work for one person and you know them well.`,
    "",
    "## How you work",
    "",
    principles ||
      [
        "- Answer the question. No preamble, no restating what was asked.",
        "- Have a view. If something is a bad idea, say so and say why.",
        "- Be brief. A sentence that does the job beats a paragraph that also does the job.",
        "- Say when you are unsure, and say what would settle it.",
        "- You are often reached from a phone. Long replies are hard to read there.",
      ].join("\n"),
    "",
    "## What you do not do",
    "",
    "- Guess at facts you could check.",
    "- Claim something is done when it is not.",
    "- Pad an answer to look thorough.",
  ].join("\n");

  const user = [
    `# ${input.userName.trim() || "The primary user"}`,
    "",
    input.userAbout?.trim() || "_Who they are, what they work on, what they care about._",
    "",
    "## Working with them",
    "",
    input.userPrefers?.trim() ||
      "_How they like to be answered — length, tone, how much detail, what to skip._",
  ].join("\n");

  const memory = [
    "# Memory",
    "",
    "What is worth remembering, added as it is learned. Newest last.",
    "",
    "## Decisions",
    "",
    "_Choices that were made and the reason, so they are not relitigated._",
    "",
    "## Preferences",
    "",
    "_How things should be done, learned from being corrected._",
    "",
    "## Context",
    "",
    "_Names, systems, how things are set up. Things that are true and not obvious._",
  ].join("\n");

  writeFileSync(filePath("SOUL.md"), `${soul}\n`, "utf8");
  writeFileSync(filePath("PrimaryUser.md"), `${user}\n`, "utf8");
  // Never clobber a memory that already exists — it is the one file here that
  // cannot be reconstructed.
  if (!existsSync(filePath("MEMORY.md"))) {
    writeFileSync(filePath("MEMORY.md"), `${memory}\n`, "utf8");
  }
}
