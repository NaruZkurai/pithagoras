#!/usr/bin/env node
/**
 * pre-tokenize-project.mjs — pre-tokenize every file in a project against the
 * model's real tokenizer (the remote llama-server's /tokenize, or the local
 * fork's llama-tokens CLI), so the agent/model can ingest pre-computed tokens
 * instead of the model re-tokenizing raw text during a slow gather loop.
 *
 * This is the direct-token-input angle: the model's token stream IS the thing
 * we optimise. Baking per-file token IDs + counts means a runtime can feed the
 * project as tokens (no text→token work at inference), and the fleet/RL
 * tooling can reason over exact token budgets per file.
 *
 * Output (gitignored): a JSON manifest at data/project-tokens.json
 *   {
 *     "tokenizer": { "kind": "remote|llama-tokens", "model": "<id or path>" },
 *     "total_tokens": <int>,
 *     "files": [
 *       { "path": "server/src/index.ts", "chars": 24844, "tokens": 6513,
 *         "tokenIds": [ ...pre-computed ids... ] }
 *     ]
 *   }
 *
 * Usage:
 *   node server/scripts/pre-tokenize-project.mjs [projectDir]
 * Env:
 *   TOKENIZE_URL   (default http://192.168.2.64:6464/tokenize — the 27B)
 *   LLAMA_TOKENS   (path to fork's llama-tokens binary, if using it instead)
 *   OUT            (default $PWD/data/project-tokens.json)
 */
import path from "node:path";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const TOKENIZE_URL = process.env.TOKENIZE_URL || "http://192.168.2.64:6464/tokenize";
const LLAMA_TOKENS = process.env.LLAMA_TOKENS || "";
const OUT = process.env.OUT || path.join(process.cwd(), "data", "project-tokens.json");
const PROJ = process.argv[2] || process.cwd();

const EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  "data",
  "gitrepos",
  "vendor",
  ".cache",
]);
const MAX_PER_FILE = 10_000_000; // hard safety cap per file (bytes)

function walk(dir, out) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of ents) {
    if (EXCLUDE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile()) out.push(path.relative(PROJ, full));
  }
  return out;
}

async function tokenizeRemote(text) {
  const res = await fetch(TOKENIZE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text, add_special: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`tokenize HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j.tokens) ? j.tokens : [];
}

function tokenizeLocal(text) {
  // The fork's llama-tokens CLI. Writes text to a temp file to avoid argv
  // limits on large files. The exact flag shape may vary by the fork build;
  // the remote /tokenize path is the verified default.
  const bin = path.isAbsolute(LLAMA_TOKENS) ? LLAMA_TOKENS : LLAMA_TOKENS;
  const tmp = path.join(tmpdir(), `pretok-${Date.now()}.txt`);
  writeFileSync(tmp, text, "utf8");
  try {
    const out = execFileSync(bin, ["--input", tmp], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    });
    return out
      .split(/\s+/)
      .filter((x) => /^-?\d+$/.test(x))
      .map(Number);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

async function main() {
  const files = walk(PROJ, []);
  const useLocal = !!LLAMA_TOKENS;
  console.log(
    `${files.length} files to tokenize (tokenizer: ${useLocal ? "llama-tokens" : "remote " + TOKENIZE_URL})`
  );

  const manifest = {
    tokenizer: {
      kind: useLocal ? "llama-tokens" : "remote",
      model: useLocal ? process.env.TOKENIZER_MODEL || "" : TOKENIZE_URL,
    },
    total_tokens: 0,
    files: [],
  };

  let i = 0;
  for (const rel of files) {
    const full = path.join(PROJ, rel);
    let txt;
    try {
      if (statSync(full).size > MAX_PER_FILE) {
        console.log(`  skip (too big): ${rel}`);
        continue;
      }
      txt = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    let tokenIds;
    try {
      tokenIds = useLocal ? tokenizeLocal(txt) : await tokenizeRemote(txt);
    } catch (e) {
      console.warn(`  tokenize FAILED ${rel}: ${e.message}`);
      continue;
    }
    manifest.files.push({ path: rel, chars: txt.length, tokens: tokenIds.length, tokenIds });
    manifest.total_tokens += tokenIds.length;
    i += 1;
    if (i % 20 === 0) console.log(`  ...${i}/${files.length} tokenized`);
  }

  writeFileSync(OUT, JSON.stringify(manifest));
  console.log(
    `\nDone: ${manifest.files.length} files, ${manifest.total_tokens} total tokens`
  );
  console.log(`Manifest: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
