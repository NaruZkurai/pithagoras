import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  LuBookOpen,
  LuFolderOpen,
  LuGitBranch,
  LuMessagesSquare,
  LuPencil,
  LuRotateCcw,
  LuSquare,
} from "react-icons/lu";
import { api, type PiCommand, type PortalEvent, type Session, type Thread } from "../api";
import { buildTranscript, type Item } from "../transcript";
import { ComposerBar } from "./ComposerBar";
import { FileExplorer } from "./FileExplorer";
import { ChatSkillsPanel } from "./ChatSkillsPanel";
import { ThreadsPanel } from "./ThreadsPanel";
import { Tooltip } from "./Tooltip";

/**
 * Context the portal attaches to a message, and what to call it.
 *
 * The agent needs to be told who is speaking and what it said while nobody was
 * talking to it. A person reading the transcript does not — they wrote the
 * message, so seeing their own words buried under three framing blocks is
 * noise. Folded away rather than dropped: it is still what the model saw, and
 * when a reply looks strange this is usually why.
 */
/** Keep in step with what the server attaches — see channels/supervisor.ts. */
const CONTEXT_BLOCKS: { tag: string; label: string }[] = [
  { tag: "speaker", label: "Speaker" },
  { tag: "sent-since-you-last-spoke", label: "Sent while idle" },
  { tag: "answer-from-primary", label: "Answer" },
  { tag: "channel-instructions", label: "Channel instructions" },
  { tag: "routine", label: "Routine" },
];

function splitContext(raw: string): { text: string; blocks: { label: string; body: string }[] } {
  let text = raw;
  const blocks: { label: string; body: string }[] = [];
  for (const { tag, label } of CONTEXT_BLOCKS) {
    // The opening tag may carry attributes, as <routine name="..."> does.
    const re = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g");
    text = text.replace(re, (match) => {
      const body = match
        .replace(new RegExp(`^<${tag}(\\s[^>]*)?>`), "")
        .replace(new RegExp(`</${tag}>$`), "")
        .trim();
      if (body) blocks.push({ label, body });
      return "";
    });
  }
  return { text: text.trim(), blocks };
}

function ContextChip({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full px-2 py-0.5 text-[11px] transition ${
          open
            ? "bg-accent/20 text-accent"
            : "bg-fg/5 text-fg-faint hover:bg-fg/10 hover:text-fg-muted"
        }`}
        title="Context the portal attached to this message"
      >
        {label}
      </button>
      {open && (
        <pre className="mt-1 w-full whitespace-pre-wrap rounded-lg bg-fg/5 p-2 text-left text-[11px] leading-relaxed text-fg-muted">
          {body}
        </pre>
      )}
    </>
  );
}

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
  // A dedicated "Threads" side drawer: every message-thread on this session.
  // Distinct from Branches (which are stash forks) even though both are backed
  // by the same thread machinery.
  const [showThreads, setShowThreads] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [stashError, setStashError] = useState<string | null>(null);
  // Inline replies to specific messages — threads rendered under their parent.
  const [inlineThreads, setInlineThreads] = useState<Record<number, Thread>>({});
  const [replySeq, setReplySeq] = useState<number | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  // Edit an existing user message in place, then resend it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // Branch overview (Obsidian-style branching of messages -> stash threads).
  const [showBranches, setShowBranches] = useState(false);
  // When branching a message, anything at or after this seq is hidden, so the
  // conversation reads as a focused fork ending at the branch point.
  const [cutoff, setCutoff] = useState<number | null>(null);
  // When set, the composer is in "branch continue" mode: the next message goes
  // into the branch message's thread (not the main session), so it genuinely
  // continues from that timeline instead of appending to the folded future.
  const [branchSeq, setBranchSeq] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildTranscript(events), [events]);

  // After a branch, only show messages up to and including the branch point
  // (the "stash all future" behaviour) unless the user continues past it.
  // Branching on a user message keeps that message's reply visible too — it
  // reads as the end of the exchange, not a cut-off mid-turn.
  const visibleItems = useMemo(() => {
    if (cutoff === null) return items;
    let i = items.findIndex((it) => it.id === `a${cutoff}` || it.id === `u${cutoff}`);
    if (i < 0) return items;
    if (items[i].kind === "user") {
      // Include the tool calls and the assistant's reply that answer this user
      // message, so the fold lands at the end of the exchange.
      while (
        i + 1 < items.length &&
        (items[i + 1].kind === "assistant" || items[i + 1].kind === "tool")
      ) {
        i += 1;
      }
    }
    return items.slice(0, i + 1);
  }, [items, cutoff]);

  const running = session.status === "running";

  /** User messages with no assistant response after them (e.g. a run died). */
  const unanswered = useMemo(() => {
    const ids = new Set<string>();
    let responseAfter = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "assistant" && it.text) responseAfter = true;
      if (it.kind === "user" && !responseAfter) ids.add(it.id);
    }
    return ids;
  }, [items]);

  /**
   * A safe, non-empty label for a message used as a stash/thread parent.
   * Some messages have no surface text (a thinking-only assistant turn, a bare
   * tool round-trip), and the server rejects an empty parent with
   * "A message needs text to stash on" — so never send it an empty string.
   */
  const messageText = (item: Extract<Item, { kind: "user" | "assistant" }>): string => {
    const direct = item.text?.trim();
    if (direct) return direct;
    if (item.kind === "assistant" && item.thinking?.trim()) {
      return item.thinking.trim().slice(0, 120) + "…";
    }
    return "This message";
  };

  /** Open (or reopen) the thread on a message. The thread agent sees only it. */
  const openThread = async (item: Item) => {
    if (item.kind === "tool" || item.kind === "notice") return;
    setShowFiles(false);
    setThreadError(null);
    try {
      const t = await api.createThread(session.id, {
        seq: Number(item.id.slice(1)),
        role: item.kind === "user" ? "user" : "assistant",
        text: messageText(item),
      });
      setThread(t);
    } catch (e) {
      setThreadError((e as Error).message);
    }
  };

  /**
   * Branch: stash the conversation at this message and fold the timeline here
   * — everything below this point is hidden (it becomes the branch's future),
   * and the composer switches to continue the branch from this message.
   */
  const stashMessage = async (item: Item) => {
    if (item.kind === "tool" || item.kind === "notice") return;
    setShowFiles(false);
    setStashError(null);
    const seq = seqOf(item);
    try {
      await api.stashSession(session.id, {
        seq,
        role: item.kind === "user" ? "user" : "assistant",
        text: messageText(item),
      });
      // Fold the timeline to the branch point and make the next message
      // continue this branch (through its thread) rather than the old future.
      // Deliberately do NOT open the thread side panel — branching is a
      // timeline action, not "open this message's thread".
      setCutoff(seq);
      setBranchSeq(seq);
    } catch (e) {
      setStashError((e as Error).message);
    }
  };

  /** Show the full original timeline again, abandoning the branch fold. */
  const showFullTimeline = () => {
    setCutoff(null);
    setBranchSeq(null);
    setShowBranches(false);
  };

  /** Enter "continue this branch" mode at a message and focus the composer. */
  const beginBranchContinue = (seq: number) => {
    setBranchSeq(seq);
    setShowBranches(false);
    setReplyError(null);
    const el = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="Describe"], textarea[placeholder^="Continuing"]'
    );
    el?.focus();
  };

  /** Focused fork continuation is handled by `send()`, which routes into the
   *  branch message's thread when `branchSeq` is set. */

  /** The numeric id a message's thread is keyed on (its event seq). */
  const seqOf = (it: Item) =>
    it.kind === "tool" || it.kind === "notice" ? -1 : Number(it.id.slice(1));

  /**
   * Reply to a specific message — continue from that point. Uses a thread on
   * the message (one per message), and shows the exchange inline underneath it.
   */
  const sendReply = async (seq: number, text: string) => {
    const t = text.trim();
    if (!t || (replySeq === seq && replyBusy)) return;
    setReplySeq(seq);
    setReplyError(null);
    try {
      const parent = items.find(
        (it) =>
          (it.kind === "user" || it.kind === "assistant") &&
          Number(it.id.slice(1)) === seq
      ) as Extract<Item, { kind: "user" | "assistant" }> | undefined;
      const role = parent?.kind === "user" ? "user" : "assistant";
      const parentText = parent ? messageText(parent) : "This message";
      let thread = inlineThreads[seq];
      if (!thread) {
        thread = await api.createThread(session.id, { seq, role, text: parentText });
      }
      const updated = await api.sendThreadMessage(thread.id, t);
      setInlineThreads((m) => ({ ...m, [seq]: updated }));
    } catch (e) {
      setReplyError((e as Error).message);
    } finally {
      setReplySeq(null);
    }
  };

  // Load every thread on this session so replies render inline under their
  // parent message (a thread is keyed on the parent message's event seq).
  useEffect(() => {
    let cancelled = false;
    api
      .threads(session.id)
      .then(async ({ threads }) => {
        const map: Record<number, Thread> = {};
        await Promise.all(
          threads.map(async (t) => {
            if (cancelled) return;
            try {
              map[t.parentSeq] = await api.getThread(t.id);
            } catch {
              // skip an unreadable thread rather than dropping the page
            }
          })
        );
        if (!cancelled) setInlineThreads(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.id]);

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

  /** True while a reply to a specific message is being processed. */
  const replyBusy = replySeq !== null;

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
      // In a branch fold, the next message continues that branch through its
      // thread (isolated context rooted at the branch message), so it really
      // continues from that timeline instead of appending to the folded future.
      if (branchSeq !== null) {
        await sendReply(branchSeq, msg);
      } else {
        await onSend(msg);
      }
    } finally {
      setSending(false);
    }
  };

  /** Re-issue a prompt that never got an answer. */
  const resend = (item: Extract<Item, { kind: "user" }>) => {
    if (sending || running) return;
    void onSend(item.text);
  };

  /** Start editing a message in place; saving re-issues it so the agent
   *  responds again (in the branch when one is active). Works for both user
   *  and assistant messages. */
  const startEdit = (item: Extract<Item, { kind: "user" | "assistant" }>) => {
    if (sending || running) return;
    setEditingId(item.id);
    // Strip framing blocks for user messages so you edit just what you wrote;
    // assistant messages are already the model's own words.
    setEditingText(item.kind === "user" ? splitContext(item.text).text : item.text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };

  /** Save an edited message and re-issue it so the agent responds again.  */
  const applyEdit = () => {
    const msg = editingText.trim();
    if (!msg || sending || running) return;
    setEditingId(null);
    setEditingText("");
    // In a branch, editing re-runs the agent inside the branch (same tools and
    // context); otherwise it resumes the session with the edited prompt.
    if (branchSeq !== null) {
      void sendReply(branchSeq, msg);
    } else {
      void onSend(msg);
    }
  };

  // Map message ids -> their stash/reply thread (a "branch"), for the overview.
  const branches = useMemo(() => {
    const out: { seq: number; role: "user" | "assistant"; parent: string; messages: Thread["messages"] }[] = [];
    const all = items.filter((it) => it.kind === "user" || it.kind === "assistant");
    const seqs = Object.keys(inlineThreads).map(Number);
    for (const seq of seqs) {
      const t = inlineThreads[seq];
      if (!t || t.messages.length === 0) continue;
      const parent = all.find((it) => Number(it.id.slice(1)) === seq);
      out.push({
        seq,
        role: parent?.kind === "user" ? "user" : "assistant",
        parent: (parent as Extract<Item, { kind: "user" | "assistant" }>)?.text?.trim() || t.parentText,
        messages: t.messages,
      });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }, [items, inlineThreads]);

  // Every thread on this session, for the dedicated "Threads" side drawer.
  const threadsList = useMemo(() => {
    const all = items.filter((it) => it.kind === "user" || it.kind === "assistant");
    return Object.entries(inlineThreads)
      .map(([seqStr, t]) => {
        const seq = Number(seqStr);
        const parent = all.find((it) => Number(it.id.slice(1)) === seq);
        return {
          seq,
          role: parent?.kind === "user" ? "user" : "assistant",
          parent: (parent as Extract<Item, { kind: "user" | "assistant" }>)?.text?.trim() || t.parentText,
          thread: t,
        };
      })
      .sort((a, b) => a.seq - b.seq);
  }, [items, inlineThreads]);

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
          <button
            onClick={() => {
              setShowThreads((v) => !v);
              setShowFiles(false);
              setShowBranches(false);
            }}
            title="Threads — open a message's thread in the side panel"
            className={`flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs transition hover:bg-fg/5 ${
              showThreads ? "text-accent" : "text-fg-muted hover:text-fg"
            }`}
          >
            <LuMessagesSquare className="h-3.5 w-3.5" />
            Threads
            {threadsList.length > 0 && (
              <span className="rounded-full bg-fg/10 px-1.5 text-[10px] text-fg-faint">
                {threadsList.length}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              setShowBranches((v) => !v);
              setShowFiles(false);
              setShowThreads(false);
            }}
            title="Branches — every stashed/threaded sub-conversation on this chat"
            className={`flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs transition hover:bg-fg/5 ${
              showBranches ? "text-accent" : "text-fg-muted hover:text-fg"
            }`}
          >
            <LuGitBranch className="h-3.5 w-3.5" />
            Branches
            {branches.length > 0 && (
              <span className="rounded-full bg-fg/10 px-1.5 text-[10px] text-fg-faint">
                {branches.length}
              </span>
            )}
          </button>
          {session.status === "interrupted" && (
            <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              interrupted — send a message to resume
            </span>
          )}
          <button
            onClick={onAbort}
            disabled={!running}
            title={running ? "Stop the agent mid-task" : "Agent is idle"}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <LuSquare className="h-3 w-3" />
            Stop agent
          </button>
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

        {cutoff !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-accent/30 bg-accent/5 px-3 py-2 text-xs text-fg-subtle">
            <LuGitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              Branching from this message — new replies continue this branch;
              the old future is folded.
            </span>
            <button
              onClick={showFullTimeline}
              title="Unfold the full original conversation"
              className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/25"
            >
              Show full timeline
            </button>
          </div>
        )}

        {visibleItems.map((item) => {
          if (item.kind === "user") {
            const noResponse = !running && unanswered.has(item.id);
            const { text, blocks } = splitContext(item.text);
            // Nothing but framing: the portal spoke, not a person. Drawing it as
            // a message bubble with no message in it reads as something broken.
            if (!text) {
              return (
                <div key={item.id} className="flex flex-wrap justify-end gap-1">
                  {blocks.map((b, i) => (
                    <ContextChip key={i} label={b.label} body={b.body} />
                  ))}
                </div>
              );
            }
            return (
              <div key={item.id} className="group">
                <div className="flex justify-end gap-2">
                  <Tooltip label="Edit this message and resend it" side="top">
                    <button
                      onClick={() => startEdit(item)}
                      className="self-center rounded-md p-1.5 text-fg-faint opacity-0 transition hover:bg-fg/5 hover:text-accent group-hover:opacity-100"
                    >
                      <LuPencil className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Branch — stash the conversation here as a thread and push it to memory" side="top">
                    <button
                      onClick={() => stashMessage(item)}
                      className="self-center rounded-md p-1.5 text-fg-faint opacity-0 transition hover:bg-fg/5 hover:text-accent group-hover:opacity-100"
                    >
                      <LuGitBranch className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  {noResponse && (
                    <Tooltip label="Resend this message (it got no reply)" side="top">
                      <button
                        onClick={() => resend(item)}
                        className="self-center rounded-md p-1.5 text-fg-muted opacity-70 transition hover:bg-fg/5 hover:text-accent hover:opacity-100"
                      >
                        <LuRotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  )}
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/15">
                    {editingId === item.id ? (
                      <div className="space-y-1.5">
                        <textarea
                          autoFocus
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) applyEdit();
                            if (e.key === "Escape") cancelEdit();
                          }}
                          rows={Math.max(2, Math.min(8, editingText.split("\n").length + 1))}
                          className="w-full resize-y rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
                        />
                        <div className="flex justify-end gap-1.5 text-[11px]">
                          <button
                            onClick={applyEdit}
                            title="Save and ask the agent to respond again (Ctrl+Enter)"
                            className="rounded-md bg-accent px-2 py-1 text-white"
                          >
                            Save & re-respond
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="rounded-md px-2 py-1 text-fg-muted hover:text-fg"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{text}</div>
                    )}
                    {editingId !== item.id && blocks.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                        {blocks.map((b, i) => (
                          <ContextChip key={i} label={b.label} body={b.body} />
                        ))}
                      </div>
                    )}
                  </div>
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
                {editingId === item.id ? (
                  <div className="space-y-1.5">
                    <textarea
                      autoFocus
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) applyEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      rows={Math.max(2, Math.min(10, editingText.split("\n").length + 1))}
                      className="w-full resize-y rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
                    />
                    <div className="flex justify-end gap-1.5 text-[11px]">
                      <button
                        onClick={applyEdit}
                        title="Save and ask the agent to respond again (Ctrl+Enter)"
                        className="rounded-md bg-accent px-2 py-1 text-white"
                      >
                        Save & re-respond
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="rounded-md px-2 py-1 text-fg-muted hover:text-fg"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  item.text && (
                    <div className="md text-sm leading-relaxed text-fg">
                      {/* A reasoning model sometimes closes a thought inside the
                          answer; the stray tag is noise to whoever is reading. */}
                      <ReactMarkdown>{item.text.replace(/<\/?think(ing)?>/gi, "")}</ReactMarkdown>
                    </div>
                  )
                )}
                <div className="mt-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <Tooltip label="Edit this message and ask the agent to respond again" side="top">
                    <button
                      onClick={() => startEdit(item)}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg-faint transition hover:bg-fg/5 hover:text-accent"
                    >
                      <LuPencil className="h-3 w-3" /> Edit
                    </button>
                  </Tooltip>
                  <Tooltip label="Branch — stash the conversation here as a thread and push it to memory" side="top">
                    <button
                      onClick={() => stashMessage(item)}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg-faint transition hover:bg-fg/5 hover:text-accent"
                    >
                      <LuGitBranch className="h-3 w-3" /> Branch
                    </button>
                  </Tooltip>
                </div>
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
              <div key={item.id} className="py-0.5">
                <div className="flex items-center gap-2 font-mono text-[11px] text-fg-faint">
                  <span className={`shrink-0 ${tone}`}>
                    {item.status === "running" ? "◇" : item.status === "error" ? "✕" : "◆"}
                  </span>
                  <span className="shrink-0 text-fg-subtle">{item.name}</span>
                  {item.detail && <span className="truncate opacity-60">{item.detail}</span>}
                  {item.output && (
                    <span className="ml-auto shrink-0 text-[10px] text-fg-faint/60">
                      {item.status === "running" ? "running…" : item.status === "error" ? "error" : "✓"}
                    </span>
                  )}
                </div>
                {item.output && (
                  <details className="group/tool ml-5 mt-1">
                    <summary
                      className="cursor-pointer select-none font-mono text-[10px] text-fg-faint hover:text-fg-muted"
                    >
                      output
                    </summary>
                    <pre
                      className={`mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-fg/5 p-2 font-mono text-[11px] leading-relaxed ${
                        item.status === "error" ? "text-danger" : "text-fg-muted"
                      }`}
                    >
                      {item.output}
                    </pre>
                  </details>
                )}
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

          {cutoff !== null && (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => beginBranchContinue(cutoff)}
                title="Continue the conversation from this branch point — replies go into this message's branch"
                className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20"
              >
                <LuGitBranch className="h-3.5 w-3.5" /> Continue from here
              </button>
            </div>
          )}

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
          placeholder={
            branchSeq !== null
              ? "Continuing this branch — reply goes under this message…"
              : running
                ? "pi is working — send to queue a follow-up…"
                : "Describe the task…"
          }
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

      {showThreads && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <LuMessagesSquare className="h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-fg">Threads</div>
              <div className="text-[10px] text-fg-faint">
                message threads on this chat
              </div>
            </div>
            <button
              onClick={() => setShowThreads(false)}
              title="Close threads"
              className="rounded-md p-1 text-fg-faint hover:bg-fg/5 hover:text-fg-muted"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {threadsList.length === 0 && (
              <p className="pt-6 text-center text-xs leading-relaxed text-fg-faint">
                No threads yet. Reply to a message or branch one to start a thread.
              </p>
            )}
            {threadsList.map((b) => (
              <div key={b.seq} className="rounded-xl border border-line bg-raised/40 p-2.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                      b.role === "user" ? "bg-accent/15 text-accent" : "bg-ok/15 text-ok"
                    }`}
                  >
                    {b.role === "user" ? "you" : "agent"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-faint">
                    message {b.seq}
                  </span>
                  <span className="shrink-0 rounded-full bg-fg/10 px-1.5 text-[10px] text-fg-faint">
                    {b.thread.messages.length}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-subtle">
                  {b.parent}
                </p>
                <button
                  onClick={() => {
                    setThread(b.thread);
                    setShowThreads(false);
                  }}
                  title="Open this thread in the side panel"
                  className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg-faint hover:bg-fg/5 hover:text-accent"
                >
                  Open thread →
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      {showBranches && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <LuGitBranch className="h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-fg">Branches</div>
              <div className="text-[10px] text-fg-faint">
                stashed / threaded sub-conversations on this chat
              </div>
            </div>
            <button
              onClick={() => setShowBranches(false)}
              title="Close branches"
              className="rounded-md p-1 text-fg-faint hover:bg-fg/5 hover:text-fg-muted"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {branches.length === 0 && (
              <p className="pt-6 text-center text-xs leading-relaxed text-fg-faint">
                No branches yet. Hover any message and use the{" "}
                <LuGitBranch className="inline h-3 w-3" /> breadcrumb to stash the
                conversation there and branch from it.
              </p>
            )}
            {branches.map((b) => (
              <div key={b.seq} className="rounded-xl border border-line bg-raised/40 p-2.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                      b.role === "user" ? "bg-accent/15 text-accent" : "bg-ok/15 text-ok"
                    }`}
                  >
                    {b.role === "user" ? "you" : "agent"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-faint">
                    message {b.seq}
                  </span>
                  <span className="shrink-0 rounded-full bg-fg/10 px-1.5 text-[10px] text-fg-faint">
                    {b.messages.length}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-subtle">
                  {b.parent}
                </p>
                <button
                  onClick={() =>
                    api
                      .getThread(inlineThreads[b.seq].id)
                      .then((t) => {
                        setThread(t);
                        setShowBranches(false);
                      })
                      .catch(() => {})
                  }
                  title="Open this branch as a thread"
                  className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg-faint hover:bg-fg/5 hover:text-accent"
                >
                  Open branch →
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      {threadError && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger ring-1 ring-inset ring-danger/20">
          Couldn't open thread: {threadError}{" "}
          <button onClick={() => setThreadError(null)} className="ml-1 opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {stashError && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger ring-1 ring-inset ring-danger/20">
          Couldn't stash: {stashError}{" "}
          <button onClick={() => setStashError(null)} className="ml-1 opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {replyError && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger ring-1 ring-inset ring-danger/20">
          Couldn't reply: {replyError}{" "}
          <button onClick={() => setReplyError(null)} className="ml-1 opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {thread && (
        <ThreadsPanel thread={thread} onClose={() => setThread(null)} />
      )}
    </div>
  );
}
