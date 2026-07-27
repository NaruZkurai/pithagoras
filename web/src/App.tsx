import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PortalEvent, type Session, type Workspace } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { ConfigPanel } from "./components/ConfigPanel";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [executor, setExecutor] = useState("host");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api.authStatus().then((s) => setAuthed(s.authed)).catch(() => setAuthed(false));
  }, []);

  const refreshSessions = useCallback(async () => {
    const { sessions, executor } = await api.sessions();
    setSessions(sessions);
    setExecutor(executor);
    return sessions;
  }, []);

  useEffect(() => {
    if (!authed) return;
    refreshSessions()
      .then((list) => setActiveId((cur) => cur ?? list[0]?.id ?? null))
      .catch((e) => setError(String(e)));
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch(() => {});
    // Session list carries live status; poll so the sidebar reflects runs
    // started from another tab or device.
    const t = setInterval(() => refreshSessions().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [authed, refreshSessions]);

  // Subscribe to the active session's stream, replaying anything missed first.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    if (!activeId || !authed) return;

    let cancelled = false;
    let seq = 0;
    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/sessions/${activeId}/events?since=${seq}`);
      esRef.current = es;
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        seq = ev.seq;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "portal_status") refreshSessions().catch(() => {});
      };
      es.onerror = () => {
        es.close();
        // Reconnect and resume from the last seq we actually saw.
        setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [activeId, authed, refreshSessions]);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const onCreate = async (workspacePath: string) => {
    // Title is omitted on purpose: the server names the session after the
    // workspace folder.
    const s = await api.createSession(workspacePath);
    await refreshSessions();
    setActiveId(s.id);
  };

  const onDelete = async (id: string) => {
    await api.deleteSession(id);
    const list = await refreshSessions();
    if (activeId === id) setActiveId(list[0]?.id ?? null);
  };

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center text-zinc-500">Loading…</div>;
  }
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return (
    <div className="flex h-screen">
      <Sidebar
        sessions={sessions}
        workspaces={workspaces}
        executor={executor}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={onCreate}
        onDelete={onDelete}
        onRename={async (id, title) => {
          await api.renameSession(id, title);
          refreshSessions();
        }}
        onCreateWorkspace={async (name) => {
          const created = await api.createWorkspace(name);
          const list = await api.workspaces();
          setWorkspaces(list.workspaces);
          return created;
        }}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {error && <div className="bg-red-950/60 px-4 py-2 text-sm text-red-300">{error}</div>}
        {active ? (
          <Chat
            session={active}
            events={events}
            onSend={async (msg) => {
              await api.prompt(active.id, msg);
              refreshSessions();
            }}
            onAbort={async () => {
              await api.abort(active.id);
              refreshSessions();
            }}
            onToggleConfig={() => setConfigOpen((v) => !v)}
            configOpen={configOpen}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-zinc-600">
            <p>Create a task on the left to get started.</p>
          </div>
        )}
      </main>
      {active && configOpen && (
        <ConfigPanel sessionId={active.id} onClose={() => setConfigOpen(false)} />
      )}
    </div>
  );
}
