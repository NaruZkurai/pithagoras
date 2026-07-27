import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type PortalEvent, type Session, type Workspace } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { ConfigModal } from "./components/ConfigModal";

type Tab = "session" | "global" | "extensions";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setAuthed(s.authed))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-zinc-500">Loading…</div>
    );
  }
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  // Every meaningful view has a URL: a session, and its settings tabs. Deep
  // links and the back button work, and the server's SPA fallback serves them.
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/s/:sessionId" element={<Shell />} />
      <Route path="/s/:sessionId/settings" element={<Shell settings />} />
      <Route path="/s/:sessionId/settings/:tab" element={<Shell settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Shell({ settings = false }: { settings?: boolean }) {
  const { sessionId, tab } = useParams<{ sessionId?: string; tab?: string }>();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [executor, setExecutor] = useState("host");
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const refreshSessions = useCallback(async () => {
    const r = await api.sessions();
    setSessions(r.sessions);
    setExecutor(r.executor);
    return r.sessions;
  }, []);

  useEffect(() => {
    refreshSessions()
      .then((list) => {
        // Landing on "/" opens the most recent session.
        if (!sessionId && list[0]) navigate(`/s/${list[0].id}`, { replace: true });
      })
      .catch((e) => setError(String(e)));
    api
      .workspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => {});
    const t = setInterval(() => refreshSessions().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [refreshSessions, sessionId, navigate]);

  // Replay-then-tail for whichever session is in the URL.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    if (!sessionId) return;

    let cancelled = false;
    let seq = 0;
    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/sessions/${sessionId}/events?since=${seq}`);
      esRef.current = es;
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        seq = ev.seq;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "portal_status") refreshSessions().catch(() => {});
      };
      es.onerror = () => {
        es.close();
        setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [sessionId, refreshSessions]);

  const active = sessions.find((s) => s.id === sessionId) ?? null;

  return (
    <div className="flex h-screen bg-zinc-950">
      <Sidebar
        sessions={sessions}
        workspaces={workspaces}
        executor={executor}
        activeId={sessionId ?? null}
        onSelect={(id) => navigate(`/s/${id}`)}
        onCreate={async (workspacePath) => {
          const s = await api.createSession(workspacePath);
          await refreshSessions();
          navigate(`/s/${s.id}`);
        }}
        onDelete={async (id) => {
          await api.deleteSession(id);
          const list = await refreshSessions();
          if (sessionId === id) navigate(list[0] ? `/s/${list[0].id}` : "/", { replace: true });
        }}
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
            onOpenSettings={(t: Tab = "session") => navigate(`/s/${active.id}/settings/${t}`)}
            settingsOpen={settings}
          />
        ) : (
          <EmptyState hasSessions={sessions.length > 0} />
        )}
      </main>

      {settings && active && (
        <ConfigModal
          sessionId={active.id}
          initialTab={(tab as Tab) || "session"}
          onClose={() => navigate(`/s/${active.id}`)}
        />
      )}
    </div>
  );
}

function EmptyState({ hasSessions }: { hasSessions: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-zinc-900 text-xl text-zinc-600">
        π
      </div>
      <p className="text-sm text-zinc-400">
        {hasSessions ? "Pick a session on the left." : "Start a session to get going."}
      </p>
      <p className="max-w-xs text-xs text-zinc-600">
        Give it a task and close the tab — it keeps working, and picks up where it left off when you
        come back.
      </p>
    </div>
  );
}
