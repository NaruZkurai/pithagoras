import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api, type PiCommand, type PortalEvent, type Session } from "../api";
import { buildTranscript } from "../transcript";
import { ComposerBar } from "./ComposerBar";

export function Chat({
  session,
  events,
  onSend,
  onAbort,
  onOpenSettings,
  settingsOpen,
}: {
  session: Session;
  events: PortalEvent[];
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onOpenSettings: (tab?: "session" | "global" | "extensions") => void;
  settingsOpen: boolean;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildTranscript(events), [events]);
  const running = session.status === "running";

  // Commands come from pi at runtime, so anything a newly installed package
  // registers shows up here without the portal knowing about it in advance.
  const [commands, setCommands] = useState<PiCommand[]>([]);
  useEffect(() => {
    api
      .commands(session.id)
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]));
  }, [session.id]);

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
    setSending(true);
    setInput("");
    try {
      await onSend(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-200">{session.title}</h2>
          <p className="truncate font-mono text-[11px] text-zinc-500">{session.workspace}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session.status === "interrupted" && (
            <span className="rounded bg-amber-950/60 px-2 py-0.5 text-[11px] text-amber-300">
              interrupted — send a message to resume
            </span>
          )}
          {running && (
            <button
              onClick={onAbort}
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {items.length === 0 && (
          <p className="pt-10 text-center text-sm text-zinc-600">
            Give pi a task. You can close this tab — it keeps working.
          </p>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-xl bg-cyan-900/40 px-3 py-2 text-sm">
                  {item.text}
                </div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="max-w-[90%]">
                {item.thinking && (
                  <details className="mb-1 text-xs text-zinc-500">
                    <summary className="cursor-pointer hover:text-zinc-400">thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap border-l border-zinc-800 pl-2">
                      {item.thinking}
                    </div>
                  </details>
                )}
                {item.text && (
                  <div className="md rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
                    <ReactMarkdown>{item.text}</ReactMarkdown>
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === "tool") {
            const color =
              item.status === "error"
                ? "border-red-900/60 bg-red-950/30 text-red-300"
                : item.status === "running"
                  ? "border-cyan-900/60 bg-cyan-950/30 text-cyan-300"
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-400";
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1 font-mono text-xs ${color}`}
              >
                <span>{item.status === "running" ? "…" : item.status === "error" ? "✗" : "✓"}</span>
                <span className="font-semibold">{item.name}</span>
                {item.detail && <span className="truncate opacity-70">{item.detail}</span>}
              </div>
            );
          }
          return (
            <div
              key={item.id}
              className={`rounded-lg px-3 py-2 text-xs ${
                item.tone === "error"
                  ? "bg-red-950/40 text-red-300"
                  : "bg-zinc-900 text-zinc-400"
              }`}
            >
              {item.text}
            </div>
          );
        })}

        {running && <div className="animate-pulse text-xs text-zinc-500">pi is working…</div>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="relative border-t border-zinc-800 p-3"
      >
        {matches.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
            {matches.map((c) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(`/${c.name} `);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
              >
                <span className="font-mono text-xs text-cyan-300">/{c.name}</span>
                <span className="truncate text-xs text-zinc-500">{c.description}</span>
                <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">
                  {c.source}
                </span>
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
          className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-600"
        />
        <ComposerBar
          sessionId={session.id}
          running={running}
          onOpenSettings={onOpenSettings}
          settingsOpen={settingsOpen}
        />
      </form>
    </div>
  );
}
