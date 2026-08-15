import { spawn } from "node:child_process";
import { statSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Filesystem sandbox for agent tool calls.
 *
 * Agent shell (and file) tool calls are routed here instead of pi's local
 * backend. Each session owns ONE long-lived Docker container that mounts ONLY
 * the session's workspace at /workspace — no other host paths, no host
 * permissions. The agent therefore cannot read or write anything outside its
 * workspace, no matter how it phrases the command.
 *
 * Because the container is persistent per session (not throwaway-per-command),
 * its $HOME — mounted to a per-session directory — keeps caches, installed
 * tools and background processes alive across commands, so a session behaves
 * like a real workstation and builds don't re-fetch every time.
 *
 * Lifecycle:
 *   - created lazily on the session's first bash command,
 *   - reused for every later command (docker exec),
 *   - removed when the session is deleted (destroySandboxContainer), never on
 *     mere inactivity — an idle session keeps its container warm until deleted.
 *
 * The portal still views and edits those same files normally: the workspace it
 * shows in the Files tab is the very directory bind-mounted into the container,
 * so "rwx from within the app" reads and writes the sandbox's one shared volume.
 *
 * Non-filesystem toolcalls (memories, skills, threads) never come here — they
 * are handled by portal extensions and are unaffected by the sandbox.
 */

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

/**
 * The sandbox image a session's bash commands run in.
 *
 * Resolved at call time (not module-load) so every session picks up the image
 * configured in the portal env — scripts/run-portal.sh sets PI_IMAGE to the
 * minimal Arch runner (pithagoras-runner-arch:latest). Evaluating it per
 * invocation also means a session launched before an env change isn't frozen
 * to a stale image for the life of the process.
 */
export function sandboxImage(): string {
  return process.env.PI_IMAGE || "pithagoras-runner:latest";
}

/** Directory that holds each session's persistent container home (caches). */
export function sandboxHomeRoot(): string {
  return process.env.SANDBOX_HOME_ROOT || "/tmp/pithagoras-sandbox-homes";
}

function passthroughEnv(): string[] {
  return [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "PI_PROVIDER",
    "PI_MODEL",
    "LLAMA_BASE_URL",
    "LLAMA_BASE",
  ].flatMap((key) => (process.env[key] ? ["-e", `${key}=${process.env[key]}`] : []));
}

/** Turn a session/workspace id into a docker-safe container name suffix. */
function containerSuffix(id: string): string {
  const safe = (id || "anon").replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
  return safe || "anon";
}

/** The deterministic container name for a session. */
export function sessionContainerName(sessionId: string): string {
  return `pithagoras-sess-${containerSuffix(sessionId)}`;
}

/** Run a docker command, streaming stdout+stderr, and resolve its exit code. */
function runDocker(
  args: string[],
  opts: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }
): { child: ReturnType<typeof spawn>; done: Promise<{ exitCode: number | null }> } {
  const { onData, signal, timeout } = opts;
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  // Kill only the docker command itself (e.g. a docker exec session). The
  // underlying session container is persistent and must NOT be removed here.
  const onAbort = () => {
    try {
      child.kill();
    } catch {
      /* best effort */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let timer: NodeJS.Timeout | undefined;
  if (timeout) timer = setTimeout(() => onAbort(), timeout * 1000);
  const done = new Promise<{ exitCode: number | null }>((resolve) => {
    child.on("error", () => resolve({ exitCode: null }));
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code });
    });
  });
  return { child, done };
}

/**
 * Run one bash command inside the session's persistent sandbox container.
 *
 * Matches pi's BashOperations.exec contract: stream combined output through
 * `onData` and resolve to `{ exitCode }`. `cwd` is ignored — inside the
 * container the working directory is always /workspace, the bind-mount of the
 * session workspace. The container is created on first use and reused on every
 * later command (docker exec), so per-session state survives across commands.
 */
export function sandboxBashOperations(
  workspace: string,
  limits: SandboxLimits,
  sessionId?: string
) {
  const ws = path.resolve(workspace);
  const name = sessionContainerName(sessionId ?? "");
  const homeDir = path.join(sandboxHomeRoot(), containerSuffix(sessionId ?? ""));

  let ownerUid = 0;
  let ownerGid = 0;
  try {
    const st = statSync(ws);
    ownerUid = st.uid;
    ownerGid = st.gid;
  } catch {
    /* fall back to root if the workspace can't be stat'd */
  }

  /** Create the persistent container the first time a command runs. */
  const ensureContainer = async (): Promise<void> => {
    // Already exists and is running? Reuse it.
    const inspect = spawn("docker", ["inspect", "-f", "{{.State.Running}}", name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = await new Promise<string>((resolve) => {
      let out = "";
      inspect.stdout?.on("data", (d) => (out += d.toString()));
      inspect.on("exit", (code) => resolve(code === 0 && out.trim() === "true" ? "true" : ""));
    });
    if (running === "true") return;

    // Either never created or stopped. Remove any stale container, then start
    // fresh with a per-session HOME so caches/tools persist across commands.
    try {
      await new Promise<void>((resolve) => {
        const rm = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
        rm.on("exit", () => resolve());
        rm.on("error", () => resolve());
      });
    } catch {
      /* best effort */
    }
    mkdirSync(homeDir, { recursive: true });
    try {
      const chown = spawn("docker", ["run", "--rm", "-v", `${homeDir}:/h`, sandboxImage(), "chown", "-R", `${ownerUid}:${ownerGid}`, "/h"]);
      await new Promise<void>((resolve) => {
        chown.on("exit", () => resolve());
        chown.on("error", () => resolve());
      });
    } catch {
      /* best effort */
    }

    console.log(`[sandbox] creating persistent container ${name} (workspace=${ws}, home=${homeDir})`);
    const args = [
      "run",
      "-d", // detached, long-lived; we exec in per command
      "--name",
      name,
      "--label",
      "pithagoras.managed=true",
      "--label",
      `pithagoras.session=${sessionId ?? ""}`,
      // The image's ENTRYPOINT is `pi`; for a long-lived shell backend we
      // override it and keep a bash loop alive so `docker exec` re-enters a
      // running process.
      "--entrypoint",
      "bash",
      // Run as the workspace owner so writes to the mounted workspace work,
      // with caps dropped and nothing else mounted.
      "--user",
      `${ownerUid}:${ownerGid}`,
      // The per-session home is mounted at /home/runner (the image's runner
      // home) and chowned to the workspace owner, so caches/tools persist
      // across commands without tripping HOME ownership checks.
      "-e",
      "HOME=/home/runner",
      "-w",
      "/workspace",
      "-v",
      `${ws}:/workspace`,
      "-v",
      `${homeDir}:/home/runner`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      `${limits.memoryMb}m`,
      "--memory-swap",
      `${limits.memoryMb}m`,
      "--cpus",
      String(limits.cpus),
      "--pids-limit",
      String(limits.pidsLimit),
      ...passthroughEnv(),
      sandboxImage(),
      "-lc",
      // A minimal sleep keeps the container "running" so docker exec works,
      // while not burning CPU. Interactive jobs later attach via exec.
      "while :; do sleep 3600; done",
    ];
    await new Promise<void>((resolve, reject) => {
      const run = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      run.stderr?.on("data", (d) => (err += d.toString()));
      run.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `docker run exited ${code}`))));
      run.on("error", (e) => reject(e));
    });
  };

  return {
    exec: async (
      command: string,
      _cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      }
    ): Promise<{ exitCode: number | null }> => {
      const { onData, signal, timeout, env } = options;
      if (signal?.aborted) throw new Error("aborted");

      try {
        await ensureContainer();
      } catch (e) {
        console.warn(`[sandbox] ${name} could not start: ${(e as Error).message}`);
        // Surface the failure to the agent instead of silently failing.
        onData(Buffer.from(`[sandbox] container unavailable: ${(e as Error).message}\n`));
        return { exitCode: 1 };
      }

      const args = ["exec", "-i", name, "bash", "-lc", command];
      if (env) {
        // Fold extra env vars into the command prefix since docker exec cannot
        // take -e for an already-running container.
        const prefix = Object.entries(env)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
          .join(" ");
        if (prefix) args[args.length - 1] = `${prefix} ${command}`;
      }
      const wrapper = { onData, signal, timeout };
      const { done } = runDocker(args, wrapper);
      return done;
    },
  };
}

/**
 * Remove a session's persistent sandbox container. Called when the session is
 * deleted, never on mere inactivity (an idle session keeps its container warm).
 */
export async function destroySandboxContainer(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const name = sessionContainerName(sessionId);
  await new Promise<void>((resolve) => {
    const rm = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    rm.on("exit", () => resolve());
    rm.on("error", () => resolve());
  });
  console.log(`[sandbox] destroyed container ${name}`);
}

/** The resource limits sandboxed tool calls share with the container executor. */
export function sandboxLimits(): SandboxLimits {
  return {
    memoryMb: Number(process.env.TASK_MEMORY_MB) || 2048,
    cpus: Number(process.env.TASK_CPUS) || 2,
    pidsLimit: Number(process.env.TASK_PIDS_LIMIT) || 512,
  };
}
