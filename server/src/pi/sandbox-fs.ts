import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

/**
 * Filesystem sandbox for agent tool calls.
 *
 * Agent shell (and file) tool calls are routed here instead of pi's local
 * backend. Each command runs in a throwaway Docker container that mounts ONLY
 * the session's workspace at /workspace — no other host paths, no host
 * permissions. The agent therefore cannot read or write anything outside its
 * workspace, no matter how it phrases the command.
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

const IMAGE = process.env.PI_IMAGE || "pithagoras-runner:latest";

/** Credentials pi needs passed through to talk to the model provider. */
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

/**
 * Run one bash command inside the sandbox container.
 *
 * Matches pi's BashOperations.exec contract: stream combined output through
 * `onData` and resolve to `{ exitCode }`. `cwd` (the host workspace path) is
 * ignored — inside the sandbox the working directory is always /workspace, the
 * bind-mount of that same workspace.
 *
 * The container runs as the workspace's owner uid:gid so it can read and write
 * its own workspace (the exact files the portal shows in the Files tab), while
 * still holding no capabilities and seeing nothing else of the host. HOME is
 * pointed at a scratch dir so ephemeral package/home writes stay inside the
 * sandbox rather than leaking anywhere meaningful.
 */
export function sandboxBashOperations(workspace: string, limits: SandboxLimits) {
  const ws = path.resolve(workspace);
  let ownerUid = 0;
  let ownerGid = 0;
  try {
    const st = statSync(ws);
    ownerUid = st.uid;
    ownerGid = st.gid;
  } catch {
    /* fall back to root if the workspace can't be stat'd */
  }

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

      const name = `pithagoras-bash-${randomBytes(5).toString("hex")}`;
      const args = [
        "run",
        "-i",
        "--rm",
        "--name",
        name,
        "--label",
        "pithagoras.managed=true",
        // The image's ENTRYPOINT is `pi`; for a raw shell we need `bash` itself.
        "--entrypoint",
        "bash",
        // Run as the workspace owner so writes to the mounted workspace work,
        // but with caps dropped and nothing else mounted.
        "--user",
        `${ownerUid}:${ownerGid}`,
        "-e",
        "HOME=/tmp",
        "-w",
        "/workspace",
        "-v",
        `${ws}:/workspace`,
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
        ...(env ? Object.entries(env).flatMap(([k, v]) => (v != null ? ["-e", `${k}=${v}`] : [])) : []),
        ...passthroughEnv(),
        IMAGE,
        "-lc",
        command,
      ];

      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      // Abort: tear the container down, which drives `exit` to a non-zero code.
      const onAbort = () => {
        try {
          spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
        } catch {
          /* best effort */
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      // `timeout` seconds -> a safety net docker run doesn't get on its own.
      let timer: NodeJS.Timeout | undefined;
      if (timeout) {
        timer = setTimeout(() => onAbort(), timeout * 1000);
      }

      return new Promise<{ exitCode: number | null }>((resolve) => {
        child.on("error", () => resolve({ exitCode: null }));
        child.on("exit", (code) => {
          if (timer) clearTimeout(timer);
          resolve({ exitCode: code });
        });
      });
    },
  };
}

/** The resource limits sandboxed tool calls share with the container executor. */
export function sandboxLimits(): SandboxLimits {
  return {
    memoryMb: Number(process.env.TASK_MEMORY_MB) || 2048,
    cpus: Number(process.env.TASK_CPUS) || 2,
    pidsLimit: Number(process.env.TASK_PIDS_LIMIT) || 512,
  };
}
