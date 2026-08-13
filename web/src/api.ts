export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface Session {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  pinned: boolean;
  live?: boolean;
  /** Per-session overrides, used to paint the composer pills before any fetch. */
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  /** How the session came to exist. */
  kind?: "task" | "agent" | "routine";
}

/** A set of instructions the agent pulls in when the description matches. */
export interface Skill {
  name: string;
  description: string;
  path: string;
  scope: string;
  /** Only skills under the agent directory can be changed here. */
  editable: boolean;
  /** Invocable as /skill:name, never chosen by the model itself. */
  manualOnly: boolean;
  /** On disk but unparseable — pi is not loading it. */
  broken: boolean;
  /** Off means pi is not loading it at all — not merely hidden here. */
  enabled: boolean;
  /** Set when it was imported rather than written here. */
  source: SkillSource | null;
  content: string;
}

/** Where an imported skill came from, so it can be updated later. */
export interface SkillSource {
  spec: string;
  url: string;
  ref?: string;
  subpath?: string;
  importedAt: string;
}

/** A skill sitting in a repository, before you decide to take it. */
export interface FoundSkill {
  name: string;
  description: string;
  installed: boolean;
  from: string;
}

export interface SkillDiagnostic {
  type: string;
  message: string;
  path?: string;
}

/** A skill a session's agent actually used, with content for a human to read. */
export interface UsedSkill {
  name: string;
  description: string;
  content: string;
  usedAt: string;
}

/** llama.cpp server lifecycle, for the sidebar status dot. */
export type ServerState = "down" | "starting" | "idle" | "busy";

/** A llama.cpp server the portal can launch / stop from the UI. */
export interface ModelServer {
  name: string;
  host: string;
  bin: string;
  model: string;
  alias: string;
  port: number;
  ngl: number;
  ctx: number;
  threads: number;
  parallel: number;
  no_kv_offload: number;
  extra_args: string;
  draft_model: string;
  draft_ngl: number;
  enabled: number;
  /** True for the server pi talks to (the one LLAMA_BASE_URL points at). */
  main?: boolean;
  status: {
    name: string;
    host: string;
    port: number;
    remote: boolean;
    running: boolean;
    healthy: boolean;
    managed: boolean;
    pid: number | null;
    state: ServerState;
  };
}

/** A folder listing for the model/bin picker. */
export interface ModelFsEntry {
  name: string;
  path: string;
}
/** The filesystem picker result for choosing a model or llama binary. */
export interface ModelFs {
  path: string;
  parent: string;
  home: string;
  defaultModelDir: string;
  dirs: ModelFsEntry[];
  models: ModelFsEntry[];
  bins: ModelFsEntry[];
}

/** Work the agent does on a schedule. */
export interface Routine {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  /** "schedule" = cron/one-off timing; "message" = fires after an agent reply. */
  trigger: "schedule" | "message";
  /** "any" = every chat (or its own session); "session" = a chosen chat. */
  target: "any" | "session";
  /** The chat a targeted routine is bound to. */
  targetSessionId: string | null;
  /** The target chat's title, resolved for display. */
  targetTitle: string | null;
  /** Five-field cron, or an @shorthand. Empty for a one-off. */
  schedule: string;
  /** ISO instant for a one-off, instead of a schedule. */
  runAt: string | null;
  mode: "once" | "repeats";
  /** A one-off that has already happened. */
  done: boolean;
  instructions: string;
  freshSession: boolean;
  /** null inherits the portal default; "" means this one never reports. */
  reportChannel: string | null;
  reportTarget: string | null;
  /** When a run last reached a person through the report tool. */
  lastReportAt: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  lastOutput: string | null;
  lastMs: number | null;
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One exchange inside a message thread. */
export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** A side-chat attached to one message — the thread agent's whole context. */
export interface Thread {
  id: string;
  sessionId: string;
  parentSeq: number;
  parentRole: string;
  parentText: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessage[];
}

/** A thread as it appears in a session's thread list. */
export interface ThreadMeta {
  id: string;
  parentSeq: number;
  parentRole: string;
  parentText: string;
  messageCount: number;
  lastMessage: string | null;
  lastRole: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A conversation stashed into a thread (and usually the memory hub). */
export interface Stash {
  id: string;
  sessionId: string;
  threadId: string;
  parentSeq: number;
  parentRole: string;
  parentText: string;
  messageCount: number;
  pushed: boolean;
  createdAt: string;
}

/** A stash as it appears on the NK Tools list, with its session's title. */
export interface StashMeta extends Stash {
  sessionTitle: string;
}

/** A repository the portal can open as a workspace. */
export interface Repo {
  id: string;
  name: string;
  path: string;
  git: { branch: string; commit: string; dirty: boolean };
  createdAt: string;
}

/** A callable chat variable: one chat atom (message/thought/tool/shell). */
export interface Ccv {
  id: string;
  sessionId: string;
  seq: number;
  idx: number;
  type: "message" | "thinking" | "tool_call" | "tool_result" | "shell";
  owner: "user" | "assistant" | "tool";
  content: string;
  memory: boolean;
  edited: boolean;
  createdAt: string;
  sessionTitle?: string;
}

/**
 * The git checkpoint a message was anchored to: the workspace git state at
 * that timeline point.
 */
export interface Checkpoint {
  seq: number;
  head: string;
  dirty: string[];
  diff: string;
}

/** Whether the background memory hub daemon is reachable. */
export interface MemoryHubStatus {
  running: boolean;
  services: { core: boolean; panel: boolean; knowledge: boolean; proxy: boolean };
  error?: string;
}

/** A single memory the hub is holding (persona / episodic / instruction). */
export interface MemoryAtom {
  id: string;
  type: "persona" | "episodic" | "instruction";
  content: string;
  background?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The agent's home directory and the files that define it. */
export interface AgentSetup {
  home: string;
  initialised: boolean;
  files: { name: string; exists: boolean; content: string }[];
}

/** A conversation that reached the agent through a channel. */
export interface AgentSession extends Session {
  /** The package-supplied conversation key, prefixed with the channel id. */
  channel_key: string;
  channel: { slug: string; name: string; kind: string | null; present: boolean } | null;
}

export interface Workspace {
  name: string;
  path: string;
  isGit: boolean;
}

/** One entry in a session workspace directory listing. */
export interface WorkspaceEntry {
  name: string;
  /** Workspace-relative path (always /-separated). */
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: string;
}

/** One entry in the Files-page workspace listing. */
export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

/** A file read for preview/editing (path only set by the session explorer). */
export interface FileContent {
  path?: string;
  content?: string;
  binary?: boolean;
  size: number;
}

export interface PortalEvent {
  seq: number;
  type: string;
  payload: any;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  authStatus: () =>
    json<{ authRequired: boolean; authed: boolean; user?: string }>("/api/auth/status"),
  login: (password: string, username?: string) =>
    json<{ ok: true; user?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password, username }),
    }),
  workspaces: () => json<{ root: string; workspaces: Workspace[] }>("/api/workspaces"),
  createWorkspace: (name: string) =>
    json<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  sessions: () => json<{ sessions: Session[]; executor: string }>("/api/sessions"),
  createSession: (workspace: string, title?: string) =>
    json<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace, title }),
    }),
  renameSession: (id: string, title: string) =>
    json<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => json<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  prompt: (id: string, message: string, behavior?: "followUp" | "steer") =>
    json<{ ok: true }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message, ...(behavior ? { behavior } : {}) }),
    }),
  respondUi: (sessionId: string, id: string, payload: { value?: unknown; cancelled?: boolean }) =>
    json<{ ok: boolean }>(`/api/sessions/${sessionId}/ui-response`, {
      method: "POST",
      body: JSON.stringify({ id, ...payload }),
    }),

  // Workspace file explorer — scoped to the session's workspace.
  listFiles: (id: string, path?: string) =>
    json<{ workspace: string; path: string; entries: WorkspaceEntry[] }>(
      `/api/sessions/${id}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`
    ),
  readFile: (id: string, path: string) =>
    json<FileContent>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`),
  mcp: () => json<McpConfigView>("/api/mcp"),
  saveMcpServer: (name: string, entry: McpServerEntry, from?: string) =>
    json<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ entry, from }),
    }),
  deleteMcpServer: (name: string) =>
    json<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" }),
  saveMcpSettings: (settings: Record<string, unknown>) =>
    json<{ ok: true }>("/api/mcp/settings", {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),
  importMcp: (text: string) =>
    json<{ ok: true; added: string[]; skipped: { name: string; reason: string }[] }>(
      "/api/mcp/import",
      { method: "POST", body: JSON.stringify({ text }) }
    ),
  saveMcpRaw: (content: string) =>
    json<{ ok: true }>("/api/mcp/raw", { method: "PUT", body: JSON.stringify({ content }) }),

  skills: () =>
    json<{ root: string; skills: Skill[]; diagnostics: SkillDiagnostic[] }>("/api/skills"),
  previewSkillImport: (spec: string) =>
    json<{ spec: string; found: FoundSkill[] }>("/api/skills/preview-import", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  importSkills: (spec: string, only: string[], overwrite: boolean) =>
    json<{ ok: true; imported: string[]; skipped: { name: string; reason: string }[] }>(
      "/api/skills/import",
      { method: "POST", body: JSON.stringify({ spec, only, overwrite }) }
    ),
  updateSkill: (name: string) =>
    json<{ ok: true; imported: string[] }>(`/api/skills/${encodeURIComponent(name)}/update`, {
      method: "POST",
    }),

  createSkill: (name: string, description: string, body?: string) =>
    json<{ ok: true; name: string; path: string }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body }),
    }),
  saveSkill: (name: string, content: string) =>
    json<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  setSkillEnabled: (name: string, enabled: boolean) =>
    json<{ ok: true; enabled: boolean }>(`/api/skills/${encodeURIComponent(name)}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  deleteSkill: (name: string) =>
    json<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  /** Skills a session's agent actually used, with content to read. */
  usedSkills: (sessionId: string) =>
    json<{ skills: UsedSkill[] }>(`/api/sessions/${sessionId}/skills`),

  // Model servers — launch / stop llama.cpp from the UI.
  modelServers: () => json<{ servers: ModelServer[] }>("/api/models/servers"),
  saveModelServer: (input: {
    name: string;
    host?: string;
    bin?: string;
    model?: string;
    alias?: string;
    port?: number;
    ngl?: number;
    ctx?: number;
    threads?: number;
    parallel?: number;
    no_kv_offload?: boolean;
    extra_args?: string;
    draft_model?: string;
    draft_ngl?: number;
    enabled?: boolean;
  }) =>
    json<{ ok: true; server?: ModelServer }>("/api/models/servers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  // Browse a folder on disk for the model/bin picker.
  modelFs: (path?: string) =>
    json<ModelFs>(`/api/models/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  startModelServer: (name: string) =>
    json<{ ok: true }>(`/api/models/servers/${encodeURIComponent(name)}/start`, {
      method: "POST",
    }),
  stopModelServer: (name: string) =>
    json<{ ok: true }>(`/api/models/servers/${encodeURIComponent(name)}/stop`, {
      method: "POST",
    }),
  deleteModelServer: (name: string) =>
    json<{ ok: true }>(`/api/models/servers/${encodeURIComponent(name)}`, { method: "DELETE" }),

  people: () => json<{ people: Person[] }>("/api/people"),
  toolRules: () => json<{ rules: ToolRule[] }>("/api/tool-rules"),
  addToolRule: (rule: {
    role: string;
    tool: string;
    pattern: string;
    note?: string;
    /** Narrows the rule to one person; omitted, it applies to the whole role. */
    personKey?: string;
  }) =>
    json<{ rules: ToolRule[] }>("/api/tool-rules", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  deleteToolRule: (id: string) =>
    json<{ rules: ToolRule[] }>(`/api/tool-rules/${id}`, { method: "DELETE" }),
  updatePerson: (key: string, patch: { name?: string; role?: Role; notes?: string }) =>
    json<{ person: Person }>(`/api/people/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  forgetPerson: (key: string) =>
    json<{ ok: true }>(`/api/people/${encodeURIComponent(key)}`, { method: "DELETE" }),

  routines: () => json<{ routines: Routine[] }>("/api/routines"),
  reportTargets: () =>
    json<{ targets: ReportTarget[]; default: ReportTo | null }>("/api/routines/report-targets"),
  setReportDefault: (to: ReportTo | null) =>
    json<{ default: ReportTo | null }>("/api/routines/report-default", {
      method: "PUT",
      body: JSON.stringify(to ?? {}),
    }),
  createRoutine: (input: {
    name: string;
    trigger?: "schedule" | "message";
    schedule?: string;
    runAt?: string;
    instructions?: string;
    target?: "any" | "session";
    targetSessionId?: string | null;
    reportChannel?: string | null;
    reportTarget?: string | null;
  }) =>
    json<Routine>("/api/routines", { method: "POST", body: JSON.stringify(input) }),
  updateRoutine: (
    id: string,
    patch: {
      name?: string;
      slug?: string;
      trigger?: "schedule" | "message";
      schedule?: string;
      runAt?: string;
      instructions?: string;
      enabled?: boolean;
      freshSession?: boolean;
      target?: "any" | "session";
      targetSessionId?: string | null;
      reportChannel?: string | null;
      reportTarget?: string | null;
    }
  ) => json<Routine>(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoutine: (id: string) => json<{ ok: true }>(`/api/routines/${id}`, { method: "DELETE" }),
  runRoutine: (id: string) => json<Routine>(`/api/routines/${id}/run`, { method: "POST" }),
  previewSchedule: (schedule: string) =>
    json<{ expression: string; runs: string[] }>("/api/routines/preview", {
      method: "POST",
      body: JSON.stringify({ schedule }),
    }),
  routineSessions: (id: string) =>
    json<{ sessions: Session[] }>(`/api/routines/${id}/sessions`),

  // Message threads — a side-chat on one message with an isolated agent.
  threads: (sessionId: string) =>
    json<{ threads: ThreadMeta[] }>(`/api/sessions/${sessionId}/threads`),
  createThread: (sessionId: string, input: { seq: number; role: string; text: string }) =>
    json<Thread>(`/api/sessions/${sessionId}/threads`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getThread: (id: string) => json<Thread>(`/api/threads/${id}`),
  sendThreadMessage: (id: string, text: string) =>
    json<Thread>(`/api/threads/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  deleteThread: (id: string) => json<{ ok: true }>(`/api/threads/${id}`, { method: "DELETE" }),

  // Conversation stashes — archive a session into a thread + the memory hub.
  stashSession: (sessionId: string, input: { seq: number; role: string; text: string }) =>
    json<{ stash: Stash; thread: Thread }>(`/api/sessions/${sessionId}/stash`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  stashes: () => json<{ stashes: StashMeta[] }>(`/api/stashes`),
  deleteStash: (id: string) => json<{ ok: true }>(`/api/stashes/${id}`, { method: "DELETE" }),

  // NK Tools — background memory hub status.
  memoryStatus: () => json<MemoryHubStatus>(`/api/nk/status`),

  // Everything the memory hub is holding.
  memories: () =>
    json<{ atoms: MemoryAtom[]; stashes: StashMeta[]; error?: string }>(`/api/nk/memories`),

  // CCVs — callable chat variables (hashed chat atoms).
  ccvs: (sessionId: string) => json<{ ccvs: Ccv[] }>(`/api/sessions/${sessionId}/ccvs`),
  ccv: (id: string) => json<{ ccv: Ccv }>(`/api/ccvs/${id}`),
  ccvMemories: () => json<{ ccvs: Ccv[] }>(`/api/ccvs/memories`),
  updateCcv: (id: string, patch: { content?: string; memory?: boolean }) =>
    json<{ ccv: Ccv }>(`/api/ccvs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  checkpoint: (sessionId: string, seq: number) =>
    json<{ checkpoint: Checkpoint }>(`/api/sessions/${sessionId}/checkpoints/${seq}`),

  // Repositories the portal can open as workspaces.
  repos: () => json<{ repos: Repo[] }>(`/api/repos`),
  addRepo: (path: string, name?: string) =>
    json<{ repo: Repo }>(`/api/repos`, { method: "POST", body: JSON.stringify({ path, name }) }),

  agentSetup: () => json<AgentSetup>("/api/agent/setup"),
  runAgentWizard: (input: {
    agentName: string;
    vibe?: string;
    userName: string;
    userAbout?: string;
    userPrefers?: string;
  }) => json<AgentSetup>("/api/agent/setup", { method: "POST", body: JSON.stringify(input) }),
  saveAgentFile: (name: string, content: string) =>
    json<AgentSetup>(`/api/agent/files/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  /** Any session by id, including agent and routine ones the task list omits. */
  session: (id: string) => json<Session>(`/api/sessions/${id}`),
  startAgentChat: (title?: string) =>
    json<Session>("/api/agent/sessions", { method: "POST", body: JSON.stringify({ title }) }),

  agentSessions: () =>
    json<{ sessions: AgentSession[]; agentHome: string }>("/api/agent/sessions"),

  pinSession: (id: string, pinned: boolean) =>
    json<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),

  abort: (id: string) => json<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),

  /** Cheap: never starts pi. Stats are null when the session is not live. */
  config: (id: string) => json<PiConfig>(`/api/sessions/${id}/config`),
  /** Starts pi if needed — only called when the model picker is opened. */
  models: (id: string) => json<PiConfig>(`/api/sessions/${id}/models`),
  setConfig: (id: string, patch: ConfigPatch) =>
    json<{ ok: true; applied: string[]; state: PiState }>(`/api/sessions/${id}/config`, {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  compact: (id: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/compact`, { method: "POST" }),

  commands: (id: string) => json<{ commands: PiCommand[] }>(`/api/sessions/${id}/commands`),
  piSettings: () => json<{ path: string; content: string }>("/api/pi-settings"),
  savePiSettings: (content: string) =>
    json<{ ok: true; path: string; note: string }>("/api/pi-settings", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  settings: () =>
    json<{
      /** What pi is launched with once every fallback is applied. */
      settings: GlobalSettings;
      /** Only the values the portal was explicitly given. */
      stored: Partial<GlobalSettings>;
      /** What an unset field falls back to: env, else pi's settings.json. */
      defaults: GlobalSettings;
      piSettingsPath: string;
      executor: string;
      workspaceRoot: string;
    }>("/api/settings"),
  saveSettings: (patch: Partial<GlobalSettings>) =>
    json<{ settings: GlobalSettings; note: string }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  channels: () =>
    json<{
      channels: Channel[];
      kinds: ChannelKind[];
      broken: BrokenChannelPackage[];
      agentHome: string;
      channelsDir: string;
    }>("/api/channels"),
  installChannelPackage: (spec: string) =>
    json<{ ok: true; output: string }>("/api/channel-packages", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  removeChannelPackage: (name: string) =>
    json<{ ok: true }>(`/api/channel-packages/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  createChannel: (kind: string, name: string, config: Record<string, string>) =>
    json<Channel>("/api/channels", {
      method: "POST",
      body: JSON.stringify({ kind, name, config }),
    }),
  updateChannel: (
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      config?: Record<string, string>;
      instructions?: string;
      slug?: string;
      relayProgress?: boolean;
      relayTools?: boolean;
    }
  ) =>
    json<Channel>(`/api/channels/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteChannel: (id: string, alsoSessions = false) =>
    json<{ ok: true; stranded: number; deleted: number }>(
      `/api/channels/${id}${alsoSessions ? "?sessions=delete" : ""}`,
      { method: "DELETE" }
    ),

  extensions: () =>
    json<{ extensions: ExtensionInfo[]; settingsPath: string }>("/api/extensions"),
  setExtensionSetting: (key: string, value: unknown) =>
    json<{ ok: true }>("/api/extensions/settings", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),

  packages: () => json<{ output: string }>("/api/packages"),
  installPackage: (spec: string) =>
    json<{ ok: true; output: string }>("/api/packages", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  removePackage: (spec: string) =>
    json<{ ok: true; output: string }>("/api/packages", {
      method: "DELETE",
      body: JSON.stringify({ spec }),
    }),
  updatePackages: () =>
    json<{ ok: true; output: string }>("/api/packages/update", { method: "POST" }),

  workspaceListFiles: (workspace: string, dirPath: string) =>
    json<{ path: string; entries: FileEntry[] }>(
      `/api/workspaces/${encodeURIComponent(workspace)}/files?path=${encodeURIComponent(dirPath)}`
    ),
  workspaceReadFile: (workspace: string, filePath: string) =>
    json<FileContent>(
      `/api/workspaces/${encodeURIComponent(workspace)}/file?path=${encodeURIComponent(filePath)}`
    ),
  saveFile: (workspace: string, filePath: string, content: string) =>
    json<{ ok: true; size: number; mtime: number }>(
      `/api/workspaces/${encodeURIComponent(workspace)}/file?path=${encodeURIComponent(filePath)}`,
      { method: "PUT", body: JSON.stringify({ content }) }
    ),
  deleteFile: (workspace: string, filePath: string) =>
    json<{ ok: true }>(
      `/api/workspaces/${encodeURIComponent(workspace)}/file?path=${encodeURIComponent(filePath)}`,
      { method: "DELETE" }
    ),
  fileDownloadUrl: (workspace: string, filePath: string) =>
    `/api/workspaces/${encodeURIComponent(workspace)}/file?path=${encodeURIComponent(filePath)}&download=1`,
  archiveDownloadUrl: (workspace: string) =>
    `/api/workspaces/${encodeURIComponent(workspace)}/archive`,
};

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number };
}

export interface PiState {
  model: PiModel;
  thinkingLevel: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
}

/** A portal model server (local llama or remote) for the picker's "your servers". */
export interface ModelServerChoice {
  name: string;
  host: string;
  port: number;
  model: string;
  alias: string;
  ctx: number;
  enabled: boolean;
  status: {
    remote: boolean;
    running: boolean;
    healthy: boolean;
    state: ServerState;
    host: string;
    port: number;
  };
}

export interface PiConfig {
  /** False when pi is not running: model and effort are the stored ones. */
  live: boolean;
  state: PiState;
  thinking: { levels: string[] };
  models: { models: PiModel[] };
  /** The portal's own model servers, so the picker can show which are running. */
  servers?: ModelServerChoice[];
  stats: null | {
    tokens: { input: number; output: number; total: number };
    cost: number;
    contextUsage: { tokens: number; contextWindow: number; percent: number };
    toolCalls: number;
    totalMessages: number;
  };
}

export interface ConfigPatch {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  autoCompaction?: boolean;
  autoRetry?: boolean;
}


export interface ChannelField {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ChannelKind {
  id: string;
  label: string;
  blurb: string;
  fields: ChannelField[];
  /** The package providing it — builtins ship with the portal. */
  packageName: string;
  version?: string;
  builtin: boolean;
  /** False if the package has no usable start(), so it can never run. */
  runnable: boolean;
}

/** A package that failed to load, reported rather than silently skipped. */
export interface BrokenChannelPackage {
  packageName: string;
  dir: string;
  builtin: boolean;
  error: string;
}

export interface Channel {
  id: string;
  /** Stable key the agent's conversations hang off. Survives delete + recreate. */
  slug: string;
  kind: string;
  name: string;
  enabled: boolean;
  /** Non-secret values only — secrets never leave the server. */
  config: Record<string, string>;
  /** Which secret fields have a value stored. */
  secretsSet: string[];
  /** Appended to the agent's system prompt for messages arriving here. */
  instructions: string;
  /** Relay what the agent says between tool calls, not just the final answer. */
  relayProgress: boolean;
  /** Relay the name of each tool as it runs. */
  relayTools: boolean;
  /** Conversations keyed to this channel's slug. */
  sessionCount: number;
  /** What the supervisor is doing with it right now. */
  state: "running" | "stopped" | "starting" | "error";
  error?: string;
  since?: string;
  log: { at: string; text: string }[];
  created_at: string;
  updated_at: string;
}

/** One setting an extension reads, recovered from its source by the server. */
export interface DetectedSetting {
  key: string;
  value: unknown;
  configured: boolean;
}

export interface ExtensionInfo {
  spec: string;
  name: string;
  path?: string;
  scope?: string;
  description?: string;
  homepage?: string;
  version?: string;
  settings: DetectedSetting[];
}

export interface GlobalSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
}

export interface PiCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill" | string;
  /** Builtins only: "client" commands are handled here, not sent to pi. */
  where?: "server" | "client";
  sourceInfo?: { path?: string; scope?: string; origin?: string };
}

/** One MCP server as pi-mcp-adapter reads it. Unlisted keys are kept verbatim. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  socket?: string;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  includeTools?: string[];
  excludeTools?: string[];
  debug?: boolean;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface McpServerView {
  name: string;
  entry: McpServerEntry;
  transport: "stdio" | "http" | "socket" | "unknown";
  disabled: boolean;
}

export interface McpConfigView {
  path: string;
  exists: boolean;
  /** Without the adapter installed, nothing here is read by anything. */
  adapterInstalled: boolean;
  adapterSpec: string;
  servers: McpServerView[];
  settings: Record<string, unknown>;
  raw: string;
  parseError: string | null;
}

/** A conversation a routine can report into. */
export interface ReportTarget {
  channel: string;
  target: string;
  label: string;
}

export interface ReportTo {
  channel: string;
  target: string;
}

/** Descending capability. "unknown" never reaches the agent at all. */
export type Role = "primary" | "colleague" | "guest" | "unknown";

export interface Person {
  key: string;
  name: string;
  role: Role;
  notes: string;
  first_seen: string;
  last_seen: string | null;
  announced_at: string | null;
}

/** An exception to what a non-primary role may run. */
export interface ToolRule {
  id: string;
  role: string;
  tool: string;
  pattern: string;
  /** Set when the rule is for one person rather than a whole role. */
  person_key: string | null;
  person_name: string | null;
  note: string;
  created_at: string;
}
