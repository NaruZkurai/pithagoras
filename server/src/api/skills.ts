import express, { type Router } from "express";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piAgentDir } from "../pi-settings.js";
import { isValidSlug, slugify } from "../slug.js";

/**
 * Skills are pi's, not the portal's: it discovers them, decides which are
 * offered to the model, and reports collisions between them. So the list here
 * comes from pi's own loader rather than a directory scan, which would disagree
 * with what the agent actually sees the moment a package ships one.
 *
 * Only skills under the agent directory can be edited. A skill that arrived
 * with a package belongs to that package — editing it in place would be undone
 * by the next update, silently.
 */

const skillsRoot = () => {
  const dir = path.join(piAgentDir(), "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
};

interface LoadedSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
  sourceInfo?: { scope?: string; origin?: string; path?: string };
}

/** pi's skill loader, which is not on the package's exports map. */
async function loadFromPi(): Promise<{ skills: LoadedSkill[]; diagnostics: any[] }> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const skills: any = await import(new URL("core/skills.js", entry).href);
  const pi: any = await import("@earendil-works/pi-coding-agent");
  return skills.loadSkills({
    cwd: skillsRoot(),
    agentDir: pi.getAgentDir(),
    includeDefaults: true,
  });
}

const isEditable = (filePath: string) => {
  const root = skillsRoot();
  return path.resolve(filePath).startsWith(root + path.sep);
};

/** The directory that owns a skill, which is what delete removes. */
const skillDir = (filePath: string) => path.dirname(path.resolve(filePath));

function readBody(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

const toApi = (s: LoadedSkill) => ({
  name: s.name,
  description: s.description,
  path: s.filePath,
  scope: s.sourceInfo?.scope ?? s.sourceInfo?.origin ?? "agent",
  editable: isEditable(s.filePath),
  // Only invocable as /skill:name, never chosen by the model on its own.
  manualOnly: Boolean(s.disableModelInvocation),
  content: isEditable(s.filePath) ? readBody(s.filePath) : "",
});

const template = (name: string, description: string, body: string) =>
  `---
name: ${name}
description: ${description}
---

${body.trim() || `# ${name}\n\nWhat to do, step by step. The description above is what the model reads\nwhen deciding whether this applies, so make it say when to use it.`}
`;

export function skillsRouter(): Router {
  const router = express.Router();

  router.get("/skills", async (_req, res) => {
    try {
      const { skills, diagnostics } = await loadFromPi();
      res.json({
        root: skillsRoot(),
        skills: skills.map(toApi),
        // Name collisions and unreadable files — pi reports them, so should we.
        diagnostics: (diagnostics ?? []).map((d: any) => ({
          type: d.type,
          message: d.message,
          path: d.path,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/skills", async (req, res) => {
    const { name, description, body } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }
    if (typeof description !== "string" || !description.trim()) {
      return res.status(400).json({
        error: "A description is required — it is what the model reads to decide if the skill applies",
      });
    }

    const slug = slugify(name);
    if (!isValidSlug(slug)) return res.status(400).json({ error: `"${name}" is not a usable name` });

    const dir = path.join(skillsRoot(), slug);
    if (existsSync(dir)) return res.status(409).json({ error: `"${slug}" already exists` });

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        template(slug, description.trim(), typeof body === "string" ? body : ""),
        "utf8"
      );
      res.json({ ok: true, name: slug, path: path.join(dir, "SKILL.md") });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/skills/:name", async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    try {
      const { skills } = await loadFromPi();
      const skill = skills.find((s) => s.name === req.params.name);
      if (!skill) return res.status(404).json({ error: "Not found" });
      if (!isEditable(skill.filePath)) {
        return res.status(400).json({
          error: "That skill came from a package — editing it here would be lost on its next update",
        });
      }
      writeFileSync(skill.filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/skills/:name", async (req, res) => {
    try {
      const { skills } = await loadFromPi();
      const skill = skills.find((s) => s.name === req.params.name);
      if (!skill) return res.json({ ok: true });
      if (!isEditable(skill.filePath)) {
        return res.status(400).json({ error: "That skill belongs to a package; remove the package" });
      }
      rmSync(skillDir(skill.filePath), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
