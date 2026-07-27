import { useEffect, useState } from "react";
import { LuCheck, LuTerminal, LuX } from "react-icons/lu";
import { api } from "../api";

export interface UiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
}

/**
 * The browser standing in for the TUI when an extension asks the user
 * something. Without this, pi hands the extension a default straight away and
 * commands that open a menu appear to do nothing.
 */
export function ExtensionDialog({
  sessionId,
  request,
  onDone,
}: {
  sessionId: string;
  request: UiRequest;
  onDone: () => void;
}) {
  const [value, setValue] = useState(request.defaultValue ?? "");
  const [busy, setBusy] = useState(false);

  const respond = async (payload: { value?: unknown; cancelled?: boolean }) => {
    setBusy(true);
    try {
      await api.respondUi(sessionId, request.id, payload);
    } finally {
      setBusy(false);
      onDone();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && respond({ cancelled: true });
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request.id]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && respond({ cancelled: true })}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl">
        <header className="flex items-start gap-3 border-b border-white/10 px-4 py-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-300">
            <LuTerminal className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-zinc-100">{request.title || "Extension"}</h2>
            {request.message && (
              <p className="mt-0.5 text-xs text-zinc-400">{request.message}</p>
            )}
          </div>
          <button
            onClick={() => respond({ cancelled: true })}
            className="rounded-lg p-1 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
          >
            <LuX className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[55vh] overflow-y-auto p-3">
          {request.method === "select" && (
            <ul className="space-y-1">
              {(request.options ?? []).map((opt) => (
                <li key={opt}>
                  <button
                    disabled={busy}
                    onClick={() => respond({ value: opt })}
                    className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/10 disabled:opacity-40"
                  >
                    {opt}
                  </button>
                </li>
              ))}
              {(request.options ?? []).length === 0 && (
                <p className="px-3 py-2 text-sm text-zinc-500">No options offered.</p>
              )}
            </ul>
          )}

          {(request.method === "input" || request.method === "editor") && (
            <>
              {request.method === "editor" ? (
                <textarea
                  autoFocus
                  rows={10}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500/60"
                />
              ) : (
                <input
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && respond({ value })}
                  placeholder={request.placeholder}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/60"
                />
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => respond({ cancelled: true })}
                  className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  disabled={busy}
                  onClick={() => respond({ value })}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-1.5 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
                >
                  <LuCheck className="h-3.5 w-3.5" /> Submit
                </button>
              </div>
            </>
          )}

          {request.method === "confirm" && (
            <div className="flex justify-end gap-2">
              <button
                disabled={busy}
                onClick={() => respond({ value: false })}
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/10"
              >
                No
              </button>
              <button
                disabled={busy}
                onClick={() => respond({ value: true })}
                className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-sm text-cyan-200 ring-1 ring-inset ring-cyan-400/30 hover:bg-cyan-500/25"
              >
                Yes
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
