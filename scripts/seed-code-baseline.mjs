#!/usr/bin/env node
/**
 * seed-code-baseline.mjs
 * ----------------------
 * Feed the ENTIRE code database (this repo's source) in as input and derive
 * NEW-TOKEN PATTERNS from real code, producing a baseline for the generated
 * new-token system.
 *
 * The teacher-live harness's "new-token system" compresses the student's
 * STUDENT_STEP output tokens into ONE new token whose value = the sum of the
 * constituent token ids (a "footprint"). When a generated token matches one of
 * these footprint/created tokens, it earns a big compression reward.
 *
 * This script scans the code DB and produces a BASELINE set of code-token
 * patterns so "new" tokens that genuinely correspond to real code constructs
 * are recognized. We emit:
 *   - top_code_symbols  : the most frequent code identifiers / keywords
 *   - top_bigrams       : frequent 2-gram token sequences (how code reads)
 *   - chunk_hashes      : a stable integer hash per source chunk across files —
 *                          these are the "compressed token" values a baseline
 *                          expects, so the generated token system has a target.
 *
 * Output: config/moe/code-baseline.json  (loaded by the harness when present).
 *
 * Usage:
 *   node scripts/seed-code-baseline.mjs
 *   node scripts/seed-code-baseline.mjs --dir server,web,scripts,channels
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIRS = ["server", "web", "scripts", "channels"];
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css"]);

// Parse --dir a,b,c
const argv = process.argv.slice(2);
const dirArg = argv.find((a) => a.startsWith("--dir=")) || argv.find((a) => a === "--dir");
const dirs = dirArg && dirArg.includes("=")
  ? dirArg.split("=")[1].split(",").filter(Boolean)
  : DEFAULT_DIRS;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") continue;
      out.push(...walk(p));
    } else if (EXT.has(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

// A stable 32-bit integer hash (like a token id / footprint) for a chunk string.
function hash32(s) {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Extract code "symbols" (identifiers/keywords) from a source string.
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;
function extractSymbols(src) {
  const arr = src.match(IDENT) || [];
  const freq = {};
  for (const w of arr) { const k = w.toLowerCase(); freq[k] = (freq[k] || 0) + 1; }
  return freq;
}

function main() {
  const files = [];
  for (const d of dirs) files.push(...walk(path.join(ROOT, d)));
  console.log(`scanning ${files.length} files across [${dirs}]`);

  const symbolFreq = {};
  const bigramFreq = {};
  const chunkHashes = new Map(); // hash -> { count, example }
  let totalChars = 0;

  for (const f of files) {
    let src = "";
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    totalChars += src.length;
    // Symbols
    const sf = extractSymbols(src);
    for (const [k, v] of Object.entries(sf)) symbolFreq[k] = (symbolFreq[k] || 0) + v;
    // Bigrams of the identifier stream (how code "reads" token-to-token).
    const toks = src.match(IDENT) || [];
    for (let i = 0; i < toks.length - 1; i++) {
      const bg = toks[i].toLowerCase() + "\u0000" + toks[i + 1].toLowerCase();
      bigramFreq[bg] = (bigramFreq[bg] || 0) + 1;
    }
    // Chunk hashes: stable compressed-token values over ~64-char code windows.
    const step = 64;
    for (let i = 0; i + step <= src.length; i += step) {
      const chunk = src.slice(i, i + step);
      const h = hash32(chunk);
      const cur = chunkHashes.get(h) || { count: 0, example: chunk };
      cur.count++;
      chunkHashes.set(h, cur);
    }
  }

  const topSymbols = Object.entries(symbolFreq).sort((a, b) => b[1] - a[1]).slice(0, 300)
    .map(([s, c]) => ({ symbol: s, count: c }));
  const topBigrams = Object.entries(bigramFreq).sort((a, b) => b[1] - a[1]).slice(0, 200)
    .map(([bg, c]) => ({ bigram: bg, count: c }));
  const chunkHashesOut = [...chunkHashes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 500)
    .map(([h, v]) => ({ hash: h, count: v.count, example: v.example.replace(/[\r\n]+/g, " ").slice(0, 48) }));

  const baseline = {
    generated_at: new Date().toISOString(),
    source_dirs: dirs,
    file_count: files.length,
    total_chars: totalChars,
    summary: {
      note: "Baseline new-token patterns derived from the entire code DB. Used by the harness new-token system to recognize 'genuine' code tokens (via footprint/matching) for heavier compression rewards.",
      top_symbol_count: topSymbols.length,
      top_bigram_count: topBigrams.length,
      chunk_hash_count: chunkHashesOut.length,
    },
    top_code_symbols: topSymbols,
    top_bigrams: topBigrams,
    chunk_hashes: chunkHashesOut,
  };

  const outDir = path.join(ROOT, "config", "moe");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "code-baseline.json");
  fs.writeFileSync(outFile, JSON.stringify(baseline, null, 2));
  console.log(`wrote ${outFile}`);
  console.log(`  symbols=${topSymbols.length} bigrams=${topBigrams.length} chunkHashes=${chunkHashesOut.length}`);
}

main();
