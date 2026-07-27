import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { PortalEvent, Session } from "../api";
import { buildTranscript } from "../transcript";

export function Chat({
  session,
  events,
  onSend,
  onAbort,
}: {
  session: Session;
  events: PortalEvent[];
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildTranscript(events), [events]);
  const running = session.status === "running";

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
          <p className="truncate font-mono text-[11px] text-zinc-500">{session.project}</p>
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
        className="border-t border-zinc-800 p-3"
      >
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
      </form>
    </div>
  );
}
