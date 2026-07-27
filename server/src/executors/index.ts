import { spawn } from "node:child_process";
import path from "node:path";
import { PiRpcClient } from "../pi-rpc.js";

export type ExecutorKind = "host" | "container";

export interface LaunchOptions {
  sessionId: string;
  /** Absolute path of the workspace pi should work in (as seen by this process). */
  workspacePath: string;
  provider?: string;
  model?: string;
}

export interface Executor {
  readonly kind: ExecutorKind;
  launch(opts: LaunchOptions): PiRpcClient;
  /** Best-effort cleanup of anything left behind outside the child process. */
  cleanup?(sessionId: string): Promise<void>;
}

function piArgs(opts: LaunchOptions, sessionDir: string): string[] {
  const args = ["--mode", "rpc", "--session-dir", sessionDir];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** Environment passed through to pi — provider credentials plus a sane PATH. */
function piEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // pi writes nothing interactive; make sure it never tries.
    CI: "1",
    TERM: "dumb",
  };
}

/**
 * Runs pi as a child process of the portal, working directly on mounted workspace
 * directories. Fast and simple; pi has the portal's own permissions, so this
 * assumes you trust the tasks you submit.
 */
export class HostExecutor implements Executor {
  readonly kind = "host" as const;

  constructor(private readonly sessionRoot: string) {}

  launch(opts: LaunchOptions): PiRpcClient {
    const sessionDir = path.join(this.sessionRoot, opts.sessionId);
    const child = spawn("pi", piArgs(opts, sessionDir), {
      cwd: opts.workspacePath,
      env: piEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new PiRpcClient(child);
  }
}

/**
 * Runs pi inside a throwaway Docker container with only the workspace directory
 * mounted, so a task cannot reach the rest of the host.
 *
 * `docker run -i` keeps stdin open, which is what the JSONL protocol needs, and
 * the container is labelled so a crashed portal can still find and reap it.
 */
export class ContainerExecutor implements Executor {
  readonly kind = "container" as const;

  constructor(
    private readonly image: string,
    private readonly sessionRoot: string,
    private readonly limits: { memoryMb: number; cpus: number; pidsLimit: number }
  ) {}

  launch(opts: LaunchOptions): PiRpcClient {
    const containerName = `pithagoras-${opts.sessionId}`;
    const sessionDir = path.join(this.sessionRoot, opts.sessionId);

    const passthrough = [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "PI_PROVIDER",
      "PI_MODEL",
    ].flatMap((key) => (process.env[key] ? ["-e", `${key}=${process.env[key]}`] : []));

    const args = [
      "run",
      "-i",
      "--rm",
      "--name",
      containerName,
      "--label",
      "pithagoras.session=" + opts.sessionId,
      "--label",
      "pithagoras.managed=true",
      "-w",
      "/workspace",
      "-v",
      `${opts.workspacePath}:/workspace`,
      "-v",
      `${sessionDir}:/sessions`,
      // Same hardening posture as the sandboxes: no extra capabilities, no
      // privilege escalation, and hard resource ceilings.
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      `${this.limits.memoryMb}m`,
      "--memory-swap",
      `${this.limits.memoryMb}m`,
      "--cpus",
      String(this.limits.cpus),
      "--pids-limit",
      String(this.limits.pidsLimit),
      ...passthrough,
      this.image,
      "pi",
      ...piArgs({ ...opts }, "/sessions"),
    ];

    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    return new PiRpcClient(child);
  }

  async cleanup(sessionId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const rm = spawn("docker", ["rm", "-f", `pithagoras-${sessionId}`], { stdio: "ignore" });
      rm.on("exit", () => resolve());
      rm.on("error", () => resolve());
    });
  }
}

export function buildExecutor(kind: ExecutorKind, sessionRoot: string): Executor {
  if (kind === "container") {
    return new ContainerExecutor(
      process.env.PI_IMAGE || "pithagoras-runner:latest",
      sessionRoot,
      {
        memoryMb: Number(process.env.TASK_MEMORY_MB) || 2048,
        cpus: Number(process.env.TASK_CPUS) || 2,
        pidsLimit: Number(process.env.TASK_PIDS_LIMIT) || 512,
      }
    );
  }
  return new HostExecutor(sessionRoot);
}
