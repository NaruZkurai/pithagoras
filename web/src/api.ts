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
  live?: boolean;
}

export interface Workspace {
  name: string;
  path: string;
  isGit: boolean;
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
  authStatus: () => json<{ authRequired: boolean; authed: boolean }>("/api/auth/status"),
  login: (password: string) =>
    json<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
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
  prompt: (id: string, message: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  respondUi: (sessionId: string, id: string, payload: { value?: unknown; cancelled?: boolean }) =>
    json<{ ok: boolean }>(`/api/sessions/${sessionId}/ui-response`, {
      method: "POST",
      body: JSON.stringify({ id, ...payload }),
    }),

  abort: (id: string) => json<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),

  config: (id: string) => json<PiConfig>(`/api/sessions/${id}/config`),
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
    json<{ settings: GlobalSettings; executor: string; workspaceRoot: string }>("/api/settings"),
  saveSettings: (patch: Partial<GlobalSettings>) =>
    json<{ settings: GlobalSettings; note: string }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
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

export interface PiConfig {
  state: PiState;
  thinking: { levels: string[] };
  models: { models: PiModel[] };
  stats: {
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
