import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Project file tokens — the "use the file tokenized" capability.
 *
 * pre-tokenize-project.mjs writes data/project-tokens.json: for every project
 * file, its pre-tokenized token count (and optionally the raw token ids) via
 * the model's /tokenize direct-token API. These tools hand the agent that
 * pre-tokenized data on demand, so it can ask for a file's token cost / content
 * without re-tokenizing raw text in the slow gather loop or via bash cat.
 *
 *   - file_tokens        list counts (a cheap inventory lookup)
 *   - file_token_content  get a file's pre-tokenized content (capped)
 *
 * Only registered where a manifest exists; both return isError when the path is
 * not in the manifest.
 */
const ok = (text: string) => ({ output: text, isError: false });
const bad = (text: string) => ({ output: text, isError: true });

/** Load the pre-tokenized project manifest, or null. */
function manifest(): any[] | null {
  const m = path.join(process.cwd(), "data", "project-tokens.json");
  if (!existsSync(m)) return null;
  try {
    const j = JSON.parse(readFileSync(m, "utf8"));
    return Array.isArray(j?.files) ? j.files : null;
  } catch {
    return null;
  }
}

const MAX_CONTENT_CHARS = 6000;

export function projectTokenTools(pi: any, opts: { cwd: string }) {
  const cwd = opts.cwd;
  pi.registerTool({
    name: "file_tokens",
    label: "Get pre-tokenized file sizes",
    description:
      "Return the pre-tokenized token counts for project files (computed via the model's direct-token API). Pass one path to get that file's count; pass nothing to list the whole project. Use this to know a file's real token cost before reading it, instead of re-tokenizing or guessing.",
    promptSnippet:
      "file_tokens — pre-tokenized sizes (path [tokens]) from data/project-tokens.json",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "A project-relative file path, e.g. server/src/index.ts. Omit to list all." })
      ),
    }),
    async execute(_id: string, p: any) {
      const files = manifest() ?? [];
      if (!files.length) return bad("No pre-tokenized project manifest found. Run server/scripts/pre-tokenize-project.mjs first.");
      const rel = p?.path ? String(p.path).trim().replace(/^\.\//, "") : "";
      if (!rel) {
        let total = 0;
        const lines: string[] = [];
        for (const f of files.slice(0, 1500)) {
          total += Number(f.tokens) || 0;
          lines.push(`${f.path} [${f.tokens}]`);
        }
        return ok(`Project files (pre-tokenized):\n${lines.join("\n")}\n\nTotal: ${total} tokens across ${files.length} files.`);
      }
      const hit = files.find((f) => f.path === rel || f.path.endsWith("/" + rel));
      if (!hit) return bad(`Not in the pre-tokenized manifest: ${rel}. Omit path to list files.`);
      return ok(`${hit.path} [${hit.tokens} tokens]`);
    },
  });

  pi.registerTool({
    name: "file_token_content",
    label: "Read a file's pre-tokenized content",
    description:
      "Return a file's content together with its pre-tokenized token count (from the model's direct-token API manifest). Faster than re-tokenizing: the token count is already computed. Content is capped; for a big file use it to decide whether to read more via your normal file tools.",
    promptSnippet: "file_token_content — read file + its pre-tokenized token count",
    parameters: Type.Object({
      path: Type.String({ description: "Project-relative file path, e.g. server/src/index.ts." }),
    }),
    async execute(_id: string, p: any) {
      const files = manifest() ?? [];
      const rel = String(p?.path ?? "").trim().replace(/^\.\//, "");
      if (!rel) return bad("file_token_content needs a path.");
      const hit = files.find((f) => f.path === rel || f.path.endsWith("/" + rel));
      if (!hit) return bad(`Not in the pre-tokenized manifest: ${rel}. Omit path on file_tokens to list files.`);
      let content = "";
      try {
        content = readFileSync(path.join(cwd, hit.path), "utf8");
      } catch {
        content = "(could not read file from this workspace at runtime; use your normal file tools if needed)";
      }
      if (content.length > MAX_CONTENT_CHARS) content = content.slice(0, MAX_CONTENT_CHARS) + "\n… (truncated, see file_tokens for size) …";
      return ok(`${hit.path} [${hit.tokens} tokens]\n\`\`\`\n${content}\n\`\`\``);
    },
  });
}
