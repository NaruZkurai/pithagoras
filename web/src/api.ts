export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface Session {
  id: string;
  title: string;
  project: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  live?: boolean;
}

export interface Project {
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
  projects: () => json<{ root: string; projects: Project[] }>("/api/projects"),
  sessions: () => json<{ sessions: Session[]; executor: string }>("/api/sessions"),
  createSession: (title: string, project: string) =>
    json<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ title, project }) }),
  renameSession: (id: string, title: string) =>
    json<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => json<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  prompt: (id: string, message: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  abort: (id: string) => json<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),
};
