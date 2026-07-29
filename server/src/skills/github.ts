import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Importing skills from a git repository.
 *
 * A skill is markdown, so this is a shallow clone and a copy — nothing is
 * executed, unlike a package install. What it *is* is a set of instructions the
 * agent will follow, which is its own kind of risk: only import from somewhere
 * you would take instructions from.
 */

export interface SkillSource {
  /** What was typed, kept so the import can be repeated to update. */
  spec: string;
  url: string;
  ref?: string;
  /** Subdirectory within the repository, when the spec pointed at one. */
  subpath?: string;
  importedAt: string;
}

/** Written beside SKILL.md so the origin survives a restart. */
export const SOURCE_FILE = ".source.json";

export function readSource(skillDir: string): SkillSource | null {
  try {
    return JSON.parse(readFileSync(path.join(skillDir, SOURCE_FILE), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Work out what to clone.
 *
 * Accepts what someone would actually paste: a shorthand, a repository URL, or
 * the URL of a subdirectory copied straight from the browser's address bar —
 * which carries `/tree/<branch>/<path>` and has to be taken apart.
 */
export function parseSpec(input: string): { url: string; ref?: string; subpath?: string } {
  const spec = input.trim().replace(/\.git$/, "");

  // https://github.com/user/repo/tree/main/skills/foo
  const tree = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/.exec(
    spec
  );
  if (tree) {
    return {
      url: `https://github.com/${tree[1]}/${tree[2]}.git`,
      ref: tree[3],
      subpath: tree[4] || undefined,
    };
  }

  // Any other URL: clone as given.
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(spec)) {
    const [url, ref] = spec.split("#");
    return { url: url.endsWith(".git") ? url : `${url}.git`, ref: ref || undefined };
  }

  // user/repo, user/repo#branch, user/repo/sub/dir
  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:\/(.*?))?(?:#(.+))?$/.exec(spec);
  if (shorthand) {
    return {
      url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
      ref: shorthand[4] || undefined,
      subpath: shorthand[3] || undefined,
    };
  }

  throw new Error(`Cannot tell what "${input}" points at. Try "user/repo" or a GitHub URL.`);
}

/** Directories holding a SKILL.md, found without descending into one. */
function findSkillDirs(root: string, depth = 0): string[] {
  if (depth > 4) return [];
  if (existsSync(path.join(root, "SKILL.md"))) return [root];

  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = path.join(root, name);
    try {
      if (statSync(full).isDirectory()) out.push(...findSkillDirs(full, depth + 1));
    } catch {
      // unreadable; skip
    }
  }
  return out;
}

/** Just enough frontmatter to describe a skill before importing it. */
function frontmatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};

  const read = (key: string) => {
    const line = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(block[1]);
    if (!line) return undefined;
    const raw = line[1].trim();
    // Quoted values are the common case now, since a description contains
    // colons; unquoted ones still have to work for hand-written skills.
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    return raw.replace(/^'|'$/g, "");
  };

  return { name: read("name"), description: read("description") };
}

export interface FoundSkill {
  /** Directory name, which is what it will be installed as. */
  name: string;
  description: string;
  /** Already present under the skills root. */
  installed: boolean;
  /** Path within the repository, for orientation. */
  from: string;
}

/** Clone and report what is in there, without installing anything. */
export async function previewFromGit(spec: string, destRoot: string): Promise<FoundSkill[]> {
  return withClone(spec, async ({ base, found }) =>
    found.map((dir) => {
      const meta = frontmatter(path.join(dir, "SKILL.md"));
      const name = meta.name?.trim() || path.basename(dir);
      return {
        name,
        description: meta.description?.trim() ?? "",
        installed: existsSync(path.join(destRoot, name)),
        from: path.relative(base, dir) || ".",
      };
    })
  );
}

export interface ImportResult {
  imported: string[];
  skipped: { name: string; reason: string }[];
}

/** Clone into a temporary directory, hand over what is inside, then clean up. */
async function withClone<T>(
  spec: string,
  use: (ctx: { base: string; found: string[]; url: string; ref?: string; subpath?: string }) => Promise<T>
): Promise<T> {
  const { url, ref, subpath } = parseSpec(spec);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pithagoras-skill-"));

  try {
    const args = ["clone", "--depth", "1", "--quiet"];
    if (ref) args.push("--branch", ref);
    args.push(url, tmp);
    try {
      await run("git", args, { timeout: 120_000 });
    } catch (e) {
      const detail = String((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
      throw new Error(detail.split("\n").slice(-2).join(" ") || `Could not clone ${url}`);
    }

    const base = subpath ? path.join(tmp, subpath) : tmp;
    if (!existsSync(base)) throw new Error(`"${subpath}" is not in that repository`);

    const found = findSkillDirs(base);
    if (!found.length) {
      throw new Error("No SKILL.md found there — a skill is a directory containing one");
    }
    return await use({ base, found, url, ref, subpath });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Copy the skills found into `destRoot`.
 *
 * Existing ones are skipped rather than overwritten unless asked — an import
 * that silently replaced something you had edited would be a bad surprise.
 */
export async function importFromGit(
  spec: string,
  destRoot: string,
  opts: { overwrite?: boolean; only?: string[] } = {}
): Promise<ImportResult> {
  return withClone(spec, async ({ base, found, url, ref, subpath }) => {
    const result: ImportResult = { imported: [], skipped: [] };
    const wanted = opts.only?.length ? new Set(opts.only) : null;

    for (const dir of found) {
      const meta = frontmatter(path.join(dir, "SKILL.md"));
      const name = meta.name?.trim() || path.basename(dir);
      if (wanted && !wanted.has(name)) continue;
      const dest = path.join(destRoot, name);

      if (existsSync(dest) && !opts.overwrite) {
        result.skipped.push({ name, reason: "already installed" });
        continue;
      }
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

      // The repository's own git metadata must not come along.
      cpSync(dir, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });

      const source: SkillSource = {
        spec,
        url,
        ref,
        subpath: subpath
          ? path.posix.join(subpath, path.relative(base, dir))
          : path.relative(base, dir) || undefined,
        importedAt: new Date().toISOString(),
      };
      writeFileSync(path.join(dest, SOURCE_FILE), JSON.stringify(source, null, 2) + "\n", "utf8");
      result.imported.push(name);
    }
    return result;
  });
}
