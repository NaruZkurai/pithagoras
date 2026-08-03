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
}

const running = new Map<string, RunningServer>();

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
  running.set(name, { proc, startedAt: Date.now() });
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

/** Start every server marked enabled on boot (skips ports already serving). */
export async function startEnabled(): Promise<void> {
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
