import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { getModelServer, listModelServers, type ModelServerRow } from "./db.js";

/**
 * Model-server manager — spawns and stops llama.cpp (either the stock
 * llama-server or the Rust llama-rs server) so the portal can launch models
 * from the UI and kill them again. Each row in model_servers is one server;
 * the manager owns the child process while it runs.
 */

interface RunningServer {
  proc: ChildProcess;
  startedAt: number;
  /** True when brought up lazily (on demand) — eligible for idle shutdown. */
  lazy: boolean;
}

const running = new Map<string, RunningServer>();
/** Last time each managed server was used, for the idle power-saving sweep. */
const lastUsed = new Map<string, number>();

/** Flags differ between the stock llama-server and the Rust llama-rs server. */
function buildArgs(s: ModelServerRow): string[] {
  const isRs = s.bin.includes("llama-rs");
  const args: string[] = ["-m", s.model];
  if (s.alias) args.push("--alias", s.alias);
  if (isRs) {
    args.push("--ctx-size", String(s.ctx), "--gpu-layers", String(s.ngl));
    if (s.parallel) args.push("--parallel", String(s.parallel));
    if (s.threads) args.push("-t", String(s.threads));
  } else {
    args.push(
      "-c",
      String(s.ctx),
      "-ngl",
      String(s.ngl),
      "--host",
      "127.0.0.1",
      "-t",
      String(s.threads)
    );
    if (s.parallel) args.push("--parallel", String(s.parallel));
    if (s.no_kv_offload) args.push("--no-kv-offload");
  }
  args.push("--port", String(s.port));
  if (s.extra_args) args.push(...s.extra_args.split(/\s+/).filter(Boolean));
  return args;
}

async function health(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export function isRunning(name: string): boolean {
  const r = running.get(name);
  return !!r && r.proc.exitCode === null;
}

/** Mark a managed server as used right now (keeps it alive past the idle window). */
export function touchModelServer(name: string): void {
  lastUsed.set(name, Date.now());
}

/**
 * Ensure the managed server bound to `port` is serving — lazily started on
 * demand, so nothing is pinned at boot (power saving). Returns true once the
 * port answers /health; accepts whatever is already serving (managed or not).
 */
export async function ensureModelServer(port: number): Promise<boolean> {
  const s = listModelServers().find((x) => x.port === port);
  if (!s) return health(port);
  try {
    if (!isRunning(s.name) && !(await health(s.port))) {
      await start(s.name);
      console.log(`[portal] model server up (lazy): ${s.name} on :${s.port}`);
    }
    const r = running.get(s.name);
    if (r) {
      r.lazy = true;
      touchModelServer(s.name);
    }
    return await health(s.port);
  } catch {
    return false;
  }
}

export async function status(s: ModelServerRow): Promise<{
  name: string;
  port: number;
  running: boolean;
  healthy: boolean;
  managed: boolean;
  pid: number | null;
}> {
  const r = running.get(s.name);
  const managed = !!r && r.proc.exitCode === null;
  const healthy = await health(s.port);
  return {
    name: s.name,
    port: s.port,
    running: managed || healthy,
    healthy,
    managed,
    pid: managed && r ? (r.proc.pid ?? null) : null,
  };
}

/** Start a server by name; waits until its /health answers or it dies. */
export async function start(name: string): Promise<void> {
  const s = getModelServer(name);
  if (!s) throw new Error(`no model server '${name}'`);
  if (isRunning(name)) return;
  if (!existsSync(s.bin)) throw new Error(`binary not found: ${s.bin}`);
  if (!existsSync(s.model)) throw new Error(`model file not found: ${s.model}`);
  if (await health(s.port))
    throw new Error(`port ${s.port} is already serving — stop it first or pick another port`);

  const proc = spawn(s.bin, buildArgs(s), { stdio: "ignore" });
  running.set(name, { proc, startedAt: Date.now(), lazy: false });
  proc.on("exit", (code) => {
    if (running.get(name)?.proc === proc) running.delete(name);
  });

  for (let i = 0; i < 90; i++) {
    if (await health(s.port)) return;
    if (proc.exitCode !== null)
      throw new Error(`model server exited (code ${proc.exitCode}) — check the model path`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`model server on :${s.port} did not become healthy in time`);
}

export async function stop(name: string): Promise<void> {
  const r = running.get(name);
  if (!r) return;
  const p = r.proc;
  try {
    p.kill("SIGTERM");
  } catch {
    // already gone
  }
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(undefined);
    }, 4000);
    p.once("exit", () => {
      clearTimeout(t);
      resolve(undefined);
    });
  });
  running.delete(name);
}

/** Start every server marked enabled on boot — unless lazy mode is on. */
export async function startEnabled(): Promise<void> {
  const lazy = (process.env.LAZY_MODELS ?? "1") !== "0";
  if (lazy) {
    console.log("[portal] lazy model servers: none pinned at boot; started on demand");
    return;
  }
  for (const s of listModelServers()) {
    if (!s.enabled) continue;
    try {
      await start(s.name);
      console.log(`[portal] model server up: ${s.name} on :${s.port}`);
    } catch (e) {
      console.warn(`[portal] model server '${s.name}' not started: ${(e as Error).message}`);
    }
  }
}

let idleTimer: NodeJS.Timeout | null = null;

/**
 * Periodically stop lazily-started servers that have been idle too long.
 * `isBusy` is consulted first (e.g. any running session keeps the main model
 * alive). Only on-demand servers are ever idle-stopped — never ones started
 * by hand or by auto-start.
 */
export function startIdleSweeper(isBusy: () => boolean): void {
  stopIdleSweeper();
  const idleMs = Number(process.env.LAZY_IDLE_MS || 15 * 60 * 1000);
  if (!Number.isFinite(idleMs) || idleMs <= 0) return;
  idleTimer = setInterval(async () => {
    if (isBusy()) return;
    const now = Date.now();
    for (const s of listModelServers()) {
      const r = running.get(s.name);
      if (!r || !r.lazy || r.proc.exitCode !== null) continue;
      const last = lastUsed.get(s.name) ?? r.startedAt;
      if (now - last > idleMs) {
        console.log(`[portal] model server '${s.name}' idle — stopping to save power`);
        await stop(s.name);
      }
    }
  }, Math.min(idleMs, 60_000));
}

export function stopIdleSweeper(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** Kill everything the manager spawned (portal shutdown). */
export async function shutdownModelServers(): Promise<void> {
  for (const name of [...running.keys()]) {
    try {
      await stop(name);
    } catch {
      // ignore
    }
  }
}
