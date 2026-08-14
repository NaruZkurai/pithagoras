import { readFile, writeFile, access as fsAccess, mkdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * File-tool path translation for the sandbox.
 *
 * The bash sandbox mounts the workspace at `/workspace`, so an agent that ran
 * `pwd` has been told its root is `/workspace` and will write file paths as
 * `/workspace/...`. But the structured read/write/edit/grep tools run IN-PROCESS
 * against the host workspace, so that leading `/workspace` must be rewritten to
 * the workspace root before any of them touch the disk — otherwise a perfectly
 * valid `/workspace/skills/x.md` read either ENOENTs on the host or is refused
 * by the guard as "outside the sandbox".
 *
 * These definitions override pi's builtins (same trick as the bash sandbox: a
 * customTools entry with the same name wins) with operations that translate the
 * path, then do the real local work through node:fs.
 */

/** Map a container-rooted path to the host workspace path. */
export function translatePath(p: string, workspace: string): string {
  const ws = path.resolve(workspace);
  const abs = path.isAbsolute(p) ? p : path.resolve(ws, p);
  if (abs === "/workspace") return ws;
  if (abs.startsWith("/workspace/")) return path.join(ws, abs.slice("/workspace".length));
  return abs;
}

/** True when `p` is the workspace or strictly inside it. */
function inside(p: string, ws: string): boolean {
  if (p === ws) return true;
  return p.startsWith(ws.endsWith("/") ? ws : ws + "/");
}

/**
 * Translate the agent's path AND enforce the workspace boundary.
 *
 * Defense-in-depth on top of the guard: the structured tools now run through
 * our own node:fs, so even if the guard were ever bypassed, a path that
 * resolves outside the workspace is refused here rather than read/written on
 * the host with the portal's permissions. A `/workspace/...` path is always
 * inside; anything else must resolve under the workspace or it is refused.
 */
function translateChecked(p: string, workspace: string): string {
  const ws = path.resolve(workspace);
  const out = translatePath(p, ws);
  if (!inside(path.resolve(out), ws)) {
    throw new Error(`Refused: \`${p}\` is outside your filesystem sandbox. Use a \`/workspace/...\` or relative path.`);
  }
  return out;
}

/** The pi `pi` namespace exposes the create*ToolDefinition factories. */
export function sandboxedFileToolDefinitions(
  pi: any,
  workspace: string
): { name: string; tool: any }[] {
  const t = (p: string) => translateChecked(p, workspace);

  // read
  const read = pi.createReadToolDefinition(workspace, {
    operations: {
      readFile: async (abs: string) => readFile(t(abs)),
      access: async (abs: string) => {
        await fsAccess(t(abs));
      },
    },
  });

  // write
  const write = pi.createWriteToolDefinition(workspace, {
    operations: {
      writeFile: async (abs: string, content: string) => writeFile(t(abs), content),
      mkdir: async (dir: string) => mkdir(t(dir), { recursive: true }),
    },
  });

  // edit
  const edit = pi.createEditToolDefinition(workspace, {
    operations: {
      readFile: async (abs: string) => readFile(t(abs)),
      writeFile: async (abs: string, content: string) => writeFile(t(abs), content),
      access: async (abs: string) => {
        await fsAccess(t(abs));
      },
    },
  });

  // grep
  const grep = pi.createGrepToolDefinition(workspace, {
    operations: {
      isDirectory: (abs: string) => stat(t(abs)).then((s) => s.isDirectory()),
      readFile: async (abs: string) => (await readFile(t(abs))).toString("utf8"),
    },
  });

  return [
    { name: "read", tool: read },
    { name: "write", tool: write },
    { name: "edit", tool: edit },
    { name: "grep", tool: grep },
  ];
}
