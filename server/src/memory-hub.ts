import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * TencentDB Agent Memory hub — the "NK Tools" background memory server.
 *
 * The stack is deployed as Docker daemons (see /nzk/git/TencentDB-Agent-Memory):
 *   - MemoryCore  :8420  (the memory kernel — /v2/conversation/add for raw L0)
 *   - MemoryPanel :8125  (control-plane UI backend)
 *   - MemoryKnowledge :8424
 *   - MemoryProxy :8096  (LLM-facing gateway)
 *
 * This module only talks to it from the portal side: a health probe for the
 * NK Tools status light, and a best-effort push of stashed conversations into
 * the L0 conversation store so they're queryable from the hub. Nothing here
 * blocks the portal when the hub is down.
 */

export const MEMORY_ENDPOINTS = {
  core: process.env.MEMORY_CORE_URL || "http://127.0.0.1:8420",
  panel: process.env.MEMORY_PANEL_URL || "http://127.0.0.1:8125",
  knowledge: process.env.MEMORY_KNOWLEDGE_URL || "http://127.0.0.1:8424",
  proxy: process.env.MEMORY_PROXY_URL || "http://127.0.0.1:8096",
};

const SERVICE_ID = process.env.MEMORY_SERVICE_ID || "default";

/** The admin user key (sk-mem-…). Env wins; falls back to the deployed file. */
function adminKey(): string {
  if (process.env.MEMORY_ADMIN_KEY) return process.env.MEMORY_ADMIN_KEY;
  const candidates = [
    "/nzk/git/TencentDB-Agent-Memory/deploy/global-images/.admin-key",
    path.join(process.env.HOME ?? "", ".config/tdai-memory/admin-key"),
    path.join(process.env.HOME ?? "", ".tdai-memory.admin-key"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8").trim();
    } catch {
      // try the next candidate
    }
  }
  return "";
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
    // Any HTTP response means the daemon is up; 404/503 still count as "there".
    return res.status >= 200 && res.status < 600;
  } catch {
    return false;
  }
}

export interface MemoryHubStatus {
  running: boolean;
  services: { core: boolean; panel: boolean; knowledge: boolean; proxy: boolean };
  /** Present when the whole stack is unreachable. */
  error?: string;
}

export async function memoryHubStatus(): Promise<MemoryHubStatus> {
  const [core, panel, knowledge, proxy] = await Promise.all([
    probe(MEMORY_ENDPOINTS.core),
    probe(MEMORY_ENDPOINTS.panel),
    probe(MEMORY_ENDPOINTS.knowledge),
    probe(MEMORY_ENDPOINTS.proxy),
  ]);
  return {
    running: core || panel, // the memory kernel is what actually matters
    services: { core, panel, knowledge, proxy },
    error: core || panel ? undefined : "memory hub unreachable",
  };
}

/**
 * Push a stashed conversation into the hub's L0 (raw conversation) store so it
 * is queryable there via /recall and /conversation/search. Best-effort: the
 * caller marks the stash `pushed` on success and otherwise keeps it local.
 */
export async function pushStashToMemory(opts: {
  stashId: string;
  messages: { role: "user" | "assistant"; content: string }[];
}): Promise<{ ok: boolean; detail?: string }> {
  const messages = opts.messages
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content.slice(0, 8192),
    }))
    .slice(0, 100);
  if (messages.length === 0) return { ok: false, detail: "no user/assistant messages to push" };

  const key = adminKey();
  try {
    const res = await fetch(`${MEMORY_ENDPOINTS.core}/v2/conversation/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key || "local"}`,
        "x-tdai-service-id": SERVICE_ID,
        ...(key ? { "x-tdai-user-key": key } : {}),
      },
      body: JSON.stringify({
        session_id: `stash-${opts.stashId}`,
        messages,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `http ${res.status} ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
