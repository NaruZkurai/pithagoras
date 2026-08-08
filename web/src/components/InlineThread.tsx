import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { LuMessagesSquare } from "react-icons/lu";
import type { Thread } from "../api";

/** How many thread messages show before collapsing into a "show more". */
const SHOW = 8;

/**
 * A thread's conversation rendered inline under its parent message, with a
 * composer to keep replying — "reply to a specific message" in the main chat,
 * continuing from that point.
 */
export function InlineThread({
  thread,
  busy,
  onSend,
}: {
  thread: Thread;
  busy: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);

  const messages = thread.messages;
  const hidden = messages.length - SHOW;
  const shown = expanded ? messages : messages.slice(Math.max(0, hidden));

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    try {
      await onSend(t);
    } catch {
      setText(t); // restore on failure so nothing is lost
    }
  };

  return (
    <div className="ml-8 mt-2 rounded-xl border border-line bg-surface/70 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <LuMessagesSquare className="h-3 w-3 text-accent" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          Thread · {messages.length} message{messages.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="space-y-2">
        {hidden > 0 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-fg-faint hover:text-fg"
          >
            Show {hidden} earlier message{hidden === 1 ? "" : "s"}…
          </button>
        )}
        {shown.map((m) =>
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
        {busy && (
          <div className="flex items-center gap-1.5 py-1 text-[11px] text-fg-subtle">
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
            thread agent working…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="mt-2 flex gap-1.5"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={busy ? "Working…" : "Reply in thread…"}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-lg bg-accent px-2.5 py-1 text-xs text-white disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
