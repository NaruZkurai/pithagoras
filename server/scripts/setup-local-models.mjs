#!/usr/bin/env node
/**
 * setup-local-models.mjs — bring up a LOCAL fallback so the upgrade harness
 * (and any session) can run even when the remote model box 192.168.2.64 is
 * offline.
 *
 *   - main   : Bonsai-27B on 127.0.0.1:41001 @ 126000 ctx (no-kv-offload so a
 *              huge context fits without GPU OOM)  → pi `local/bonsai-27b`
 *   - subagent: Bonsai-4B (the ~500MB model) on 127.0.0.1:6465              →
 *              pi `local-4b/bonsai-4b`
 *
 * It upserts the model_servers rows, edits ~/.pi/agent/models.json so pi knows
 * the ids, launches the servers, and verifies /health.
 *
 * Usage:
 *   node server/scripts/setup-local-models.mjs
 * Env: PORTAL_URL, PORTAL_PASS, HOME (for ~/.pi). --no-run to only print.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORTAL = process.env.PORTAL_URL || "http://localhost:4100";
const PASS = process.env.PORTAL_PASS || "deathlover";
const MODELS_JSON = path.join(
  process.env.AGENT_HOME || path.join(homedir(), ".pi"),
  "agent",
  "models.json"
);
const BIN = "/nzk/bin/llama-turbo-latest/llama-server";
const NO_RUN = process.argv.includes("--no-run");

const MODEL_27B = "/nzk/models/Bonsai-27B-Q1_0.gguf";
const MODEL_4B = "/nzk/models/Bonsai-4B-Q1_0.gguf";

// GPU-only by default: offload ALL layers to the GPU (-ngl 99) so the model
// runs on the RTX, NOT CPU. CPU-only (-ngl 0) previously pegged every core at
// ~950% and made the portal UI unresponsive. KV cache stays on CPU
// (no_kv_offload=1) so a 126k context doesn't OOM the 12GB GPU; the compute —
// the expensive part — is on the GPU either way.
const GPU_NGL = 99;

const SERVERS = [
  {
    name: "bonsai-local",
    host: "",
    bin: BIN,
    model: MODEL_27B,
    alias: "bonsai-27b",
    port: 41001,
    ngl: GPU_NGL,
    ctx: 126000,
    threads: 4,
    parallel: 1,
    no_kv_offload: 1,
    extra_args: "",
    draft_model: "",
    draft_ngl: 0,
    runtime: "stock",
    enabled: 1,
  },
  {
    name: "bonsai-4b-local",
    host: "",
    bin: BIN,
    model: MODEL_4B,
    alias: "bonsai-4b",
    port: 6465,
    ngl: GPU_NGL,
    ctx: 4096,
    threads: 4,
    parallel: 1,
    no_kv_offload: 1,
    extra_args: "",
    draft_model: "",
    draft_ngl: 0,
    runtime: "stock",
    enabled: 1,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await fetch(`${PORTAL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "", password: PASS }),
  });
  const sc = res.headers.get("set-cookie") || "";
  return sc.split(";")[0];
}

/** Ensure the pi models.json knows the local ids. Preserves everything else. */
function patchModelsJson() {
  if (!existsSync(MODELS_JSON)) {
    console.log(`models.json missing at ${MODELS_JSON} — skipping (create it or set AGENT_HOME).`);
    return;
  }
  const j = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
  j.providers ||= {};

  // Main local 27B on 41001.
  const local = (j.providers.local ||= {
    baseUrl: "http://127.0.0.1:41001/v1",
    api: "openai-completions",
    apiKey: "local",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    models: [],
  });
  local.models ||= [];
  if (!local.models.some((m) => m.id === "bonsai-27b")) {
    local.models.push({
      id: "bonsai-27b",
      name: "Bonsai 27B (local llama.cpp :41001, 126k)",
      reasoning: true,
      input: ["text"],
      contextWindow: 126000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    console.log("  + local/bonsai-27b");
  }

  // Local 4B subagent on 6465.
  const sub = (j.providers["local-4b"] ||= {
    baseUrl: "http://127.0.0.1:6465/v1",
    api: "openai-completions",
    apiKey: "local",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    models: [],
  });
  sub.models ||= [];
  if (!sub.models.some((m) => m.id === "bonsai-4b")) {
    sub.models.push({
      id: "bonsai-4b",
      name: "Bonsai 4B (local llama.cpp :6465, ~500MB)",
      reasoning: false,
      input: ["text"],
      contextWindow: 4096,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    console.log("  + local-4b/bonsai-4b");
  }

  if (!NO_RUN) {
    writeFileSync(MODELS_JSON, JSON.stringify(j, null, 2) + "\n");
    console.log(`wrote ${MODELS_JSON}`);
  }
}

async function upsertServer(cookie, s) {
  const res = await fetch(`${PORTAL}/api/models/servers`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(s),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) console.log(`  upsert ${s.name}: FAIL ${JSON.stringify(j)}`);
  else console.log(`  upsert ${s.name}: ok -> :${s.port}`);
  return res.ok;
}

async function startServer(cookie, name) {
  const res = await fetch(`${PORTAL}/api/models/servers/${encodeURIComponent(name)}/start`, {
    method: "POST",
    headers: { cookie },
    signal: AbortSignal.timeout(120_000),
  });
  const j = await res.json().catch(() => ({}));
  console.log(`  start ${name}: ${res.ok ? "dispatched" : "FAIL " + JSON.stringify(j)}`);
  return res.ok;
}

async function checkHealth(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return false;
}

async function main() {
  for (const f of [MODEL_27B, MODEL_4B, BIN]) {
    if (!existsSync(f)) console.error(`missing: ${f}`);
  }

  console.log("patching pi models.json...");
  patchModelsJson();
  if (NO_RUN) {
    console.log("(--no-run) would upsert+start:\n" + SERVERS.map((s) => `  ${s.name} :${s.port} ${s.model}`).join("\n"));
    return;
  }

  const cookie = await login();
  console.log("upserting model servers...");
  for (const s of SERVERS) await upsertServer(cookie, s);

  console.log("launching local models...");
  for (const s of SERVERS) await startServer(cookie, s.name);

  console.log("waiting for health...");
  const results = await Promise.all(
    SERVERS.map(async (s) => [s, await checkHealth(s.port)])
  );
  for (const [s, ok] of results) {
    console.log(`  :${s.port} ${s.name} → ${ok ? "UP" : "DOWN"}`);
  }
  const allUp = results.every(([, ok]) => ok);
  console.log(allUp ? "LOCAL MODELS READY (bonast-27b@41001, bonsai-4b@6465)." : "SOME LOCAL MODELS DID NOT COME UP.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
