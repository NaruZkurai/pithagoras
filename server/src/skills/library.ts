import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { piAgentDir } from "../pi-settings.js";
import { builtinSkillsDir } from "../pi/sdk-client.js";
import { upsertSkill } from "../db.js";

/**
 * Index the skill library on disk into the database.
 *
 * pi normally lists every installed skill in the system prompt, which is fine
 * for a handful and a flood for hundreds. The portal keeps the same skills on
 * disk but indexes them here, and the agent searches this lightweight manifest
 * (names + descriptions) instead — so context stays small.
 */

const SKILL_FILE = "SKILL.md";

/** Unquote a YAML scalar (single/double quoted) and strip trailing comments. */
function yamlScalar(v: string | undefined): string {
  if (!v) return "";
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      s = JSON.parse(s);
    } catch {
      s = s.slice(1, -1);
    }
  } else {
    s = s.replace(/\s+#.*$/, "").trim();
  }
  return s;
}

/** Minimal YAML frontmatter parse: name + description from the `---` block. */
function parseFrontmatter(content: string): { name: string; description: string } {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return { name: "", description: "" };
  const block = m[1];
  const name = yamlScalar(/^\s*name\s*:\s*(.+?)\s*$/m.exec(block)?.[1]);
  const description = yamlScalar(/^\s*description\s*:\s*(.+?)\s*$/m.exec(block)?.[1]);
  return { name, description };
}

/** Index every skill on disk into the database. Fast — thousands fit in ms. */
export function syncSkillsLibrary(): void {
  const roots = [path.join(piAgentDir(), "skills"), builtinSkillsDir()].filter(
    (d): d is string => Boolean(d)
  );
  let added = 0;
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(root, entry, SKILL_FILE);
      if (!existsSync(file)) continue;
      try {
        const content = readFileSync(file, "utf8");
        const { name, description } = parseFrontmatter(content);
        upsertSkill({
          name: name || entry,
          description: description || name || entry,
          path: file,
          content,
        });
        added++;
      } catch {
        // An unreadable skill is skipped; it just won't be searchable.
      }
    }
  }
  console.log(`[portal] indexed ${added} skills into the library`);
}
