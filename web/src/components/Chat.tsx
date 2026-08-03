import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { LuBookOpen, LuFolderOpen, LuMessagesSquare } from "react-icons/lu";
import { api, type PiCommand, type PortalEvent, type Session, type Thread } from "../api";
import { buildTranscript, type Item } from "../transcript";
import { ComposerBar } from "./ComposerBar";
import { FileExplorer } from "./FileExplorer";
import { ChatSkillsPanel } from "./ChatSkillsPanel";
import { ThreadsPanel } from "./ThreadsPanel";

export function Chat({
  session,
  events,
  onSend,
  onAbort,
  onClientCommand,
}: {
  session: Session;
  events: PortalEvent[];
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
  /** Builtins the portal itself services — /settings, /new, /name. */
  onClientCommand: (name: string, args: string) => void | Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [panelRequest, setPanelRequest] = useState<"model" | "effort" | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildTranscript(events), [events]);
  const running = session.status === "running";

  /** Open (or reopen) the thread on a message. The thread agent sees only it. */
  const openThread = async (item: Item) => {
    if (item.kind === "tool" || item.kind === "notice") return;
    setShowFiles(false);
    setThreadError(null);
    try {
      const t = await api.createThread(session.id, {
        seq: Number(item.id.slice(1)),
        role: item.kind === "user" ? "user" : "assistant",
        text: item.text,
      });
      setThread(t);
    } catch (e) {
      setThreadError((e as Error).message);
    }
  };

  // A task just finished: open a thread on the final assistant message so the
  // follow-up can happen in an isolated context. Fires on the running→idle
  // transition, once per finished run.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    const was = wasRunningRef.current;
    wasRunningRef.current = running;
    if (was && !running) {
      const last = [...items].reverse().find((i) => i.kind === "assistant" && i.done && i.text);
      if (last) void openThread(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Commands come from pi at runtime, so anything a newly installed package
  // registers shows up here without the portal knowing about it in advance.
  const [commands, setCommands] = useState<PiCommand[]>([]);
  useEffect(() => {
    api
      .commands(session.id)
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]));
    // Refetch when a run ends: installing an extension mid-session should make
    // its commands show up without a reload.
  }, [session.id, running]);

  // Show the palette while the composer holds a bare "/name" prefix.
  const slashQuery = /^\/([\w:-]*)$/.exec(input.trimStart());
  const matches = slashQuery
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery[1].toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length, events.length]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || sending) return;

    // Some builtins are UI, not prompts: /model opens the picker the pill uses,
    // /settings opens the modal. Sending them to pi would just be a chat line.
    const parsed = /^\/([\w-]+)\s*(.*)$/.exec(msg);
    const client = parsed
      ? commands.find((c) => c.name === parsed[1] && c.where === "client")
      : undefined;
    if (client && parsed) {
      setInput("");
      if (client.name === "model") setPanelRequest("model");
      else await onClientCommand(client.name, parsed[2]);
      return;
    }

    setSending(true);
    setInput("");
    try {
      await onSend(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-fg">{session.title}</h2>
          <p className="truncate font-mono text-[11px] text-fg-faint">{session.workspace}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => {
              setShowFiles((v) => !v);
              setThread(null);
            }}
            title="Workspace file explorer — see what the agent has written so far"
            className={`flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs transition hover:bg-fg/5 ${
              showFiles ? "text-accent" : "text-fg-muted hover:text-fg"
            }`}
          >
            <LuFolderOpen className="h-3.5 w-3.5" />
            Files
          </button>
          <button
            onClick={() => setShowSkills((v) => !v)}
            title="Skills this chat used — read them from the library"
            className={`flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs transition hover:bg-fg/5 ${
              showSkills ? "text-accent" : "text-fg-muted hover:text-fg"
            }`}
          >
            <LuBookOpen className="h-3.5 w-3.5" />
            Skills
          </button>
          {session.status === "interrupted" && (
            <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              interrupted — send a message to resume
            </span>
          )}
          {running && (
            <button
              onClick={onAbort}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg"
            >
              Stop
            </button>
          )}
        </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-3">
        {items.length === 0 && (
          <div className="pt-14 text-center">
            <p className="text-sm text-fg-muted">Give pi a task.</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-fg-faint">
              Type a task in the box below — pi works on it on its own and replies here.
              Runs are owned by the server, so you can close this tab and read what it did
              when you come back. Every event is logged and replays, so nothing is missed.
            </p>
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} className="group flex justify-end gap-2">
                <button
                  onClick={() => openThread(item)}
                  title="Thread on this message — an isolated agent that sees only it"
                  className="self-center rounded-md p-1.5 text-fg-faint opacity-0 transition hover:bg-fg/5 hover:text-accent group-hover:opacity-100"
                >
                  <LuMessagesSquare className="h-3.5 w-3.5" />
                </button>
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/15">
                  {item.text}
                </div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="group max-w-[90%]">
                {item.thinking && (
                  <details className="mb-1 text-xs text-fg-subtle">
                    <summary className="cursor-pointer hover:text-fg-muted">thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap border-l border-line pl-2">
                      {item.thinking}
                    </div>
                  </details>
                )}
                {item.text && (
                  <div className="md text-sm leading-relaxed text-fg">
                    <ReactMarkdown>{item.text}</ReactMarkdown>
                  </div>
                )}
                <button
                  onClick={() => openThread(item)}
                  title="Thread on this message — an isolated agent that sees only it"
                  className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg-faint opacity-0 transition hover:bg-fg/5 hover:text-accent group-hover:opacity-100"
                >
                  <LuMessagesSquare className="h-3 w-3" /> Thread
                </button>
              </div>
            );
          }
          if (item.kind === "tool") {
            const tone =
              item.status === "error"
                ? "text-danger"
                : item.status === "running"
                  ? "text-accent"
                  : "text-fg-faint";
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-fg-faint"
              >
                <span className={`shrink-0 ${tone}`}>
                  {item.status === "running" ? "◇" : item.status === "error" ? "✕" : "◆"}
                </span>
                <span className="shrink-0 text-fg-subtle">{item.name}</span>
                {item.detail && <span className="truncate opacity-60">{item.detail}</span>}
              </div>
            );
          }
          return (
            <div
              key={item.id}
              className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${
                item.tone === "error"
                  ? "bg-danger/10 text-danger"
                  : "bg-raised/60 text-fg-muted"
              }`}
            >
              {item.text}
            </div>
          );
        })}

          {running && (
            <div className="flex items-center gap-1.5 py-1 text-xs text-fg-subtle">
              <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
              working…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-line px-4 py-3"
      >
        <div className="relative mx-auto w-full max-w-3xl">
        {matches.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            {matches.map((c) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(`/${c.name} `);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <span className="font-mono text-xs text-accent">/{c.name}</span>
                <span className="truncate text-xs text-fg-subtle">{c.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{c.source}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={running ? "pi is working — send to queue a follow-up…" : "Describe the task…"}
          title="Describe the task. pi works on it server-side — closing this tab doesn't stop it."
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
          <ComposerBar
            sessionId={session.id}
            session={session}
            running={running}
            panelRequest={panelRequest}
            onPanelConsumed={() => setPanelRequest(null)}
          />
        </div>
      </form>
      </div>

      {showFiles && (
        <FileExplorer
          sessionId={session.id}
          workspace={session.workspace}
          onClose={() => setShowFiles(false)}
        />
      )}

      {showSkills && (
        <ChatSkillsPanel sessionId={session.id} onClose={() => setShowSkills(false)} />
      )}

      {threadError && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger ring-1 ring-inset ring-danger/20">
          Couldn't open thread: {threadError}{" "}
          <button onClick={() => setThreadError(null)} className="ml-1 opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {thread && (
        <ThreadsPanel thread={thread} onClose={() => setThread(null)} />
      )}
    </div>
  );
}
