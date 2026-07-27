import { useEffect, type ReactNode } from "react";

/** Centered dialog with a dimmed backdrop. Escape and backdrop clicks close it. */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <div className="min-w-0 flex-1">{title}</div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-zinc-800 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
