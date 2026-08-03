import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { LuMessagesSquare, LuSend, LuX } from "react-icons/lu";
import { api, type Thread } from "../api";

/**
 * A message thread — a side-chat attached to one message, like Discord.
 *
 * The thread agent's whole context is the parent message (pinned at the top)
 * and this thread. It does not see the rest of the conversation, and its only
 * memory across threads is the confirmation database.
 */
export function ThreadsPanel({
  thread,
  onClose,
}: {
  thread: Thread;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<Thread>(thread);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrent(thread);
    setError(null);
  }, [thread.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [current.messages.length, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    setError(null);
    try {
      const updated = await api.sendThreadMessage(current.id, text);
      setCurrent(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <LuMessagesSquare className="h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg">Thread</div>
          <div className="truncate font-mono text-[10px] text-fg-faint">
            isolated agent · {current.messages.length} message
            {current.messages.length === 1 ? "" : "s"}
          </div>
        </div>
        <button
          onClick={onClose}
          title="Close thread"
          className="rounded-md p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg-muted"
        >
          <LuX className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Pinned parent message — the thread's only view of the conversation. */}
      <div className="border-b border-line bg-accent/5 px-3 py-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-accent/80">
          {current.parentRole === "user" ? "Your message" : "Agent message"}
        </div>
        <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
          {current.parentText}
        </p>
      </div>

      {/* Thread conversation */}
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {current.messages.length === 0 && !sending && (
          <div className="pt-8 text-center">
            <p className="text-sm text-fg-muted">Ask about this message.</p>
            <p className="mx-auto mt-1 max-w-[220px] text-[11px] leading-relaxed text-fg-faint">
              The thread agent sees only this message and this thread — not the rest of the
              conversation.
            </p>
          </div>
        )}
        {current.messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/10 px-3 py-1.5 text-xs text-fg ring-1 ring-inset ring-accent/15">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="max-w-[92%]">
              <div className="md text-xs leading-relaxed text-fg">
                <ReactMarkdown>{m.content}</ReactMarkdown>
              </div>
            </div>
          )
        )}
        {sending && (
          <div className="flex items-center gap-1.5 py-1 text-[11px] text-fg-subtle">
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
            thread agent working…
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-line px-3 py-2.5"
      >
        <div className="flex items-end gap-2">
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
            placeholder="Ask about this message…"
            className="w-full resize-none rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-xs outline-none placeholder:text-fg-faint focus:border-accent"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            title="Send to the thread agent"
            className="rounded-lg bg-accent/12 p-2 text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
          >
            <LuSend className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </aside>
  );
}
