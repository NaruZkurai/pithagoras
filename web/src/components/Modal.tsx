import { useEffect, type ReactNode } from "react";
import { LuX } from "react-icons/lu";

/**
 * Centered dialog with a dimmed backdrop. Escape and backdrop clicks close it.
 *
 * With a `rail` it becomes a two-pane settings dialog: navigation down the left
 * edge, content on the right. The rail collapses above the content on narrow
 * screens rather than squeezing both into an unusable width.
 */
export function Modal({
  title,
  subtitle,
  rail,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  rail?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* The rail layout gets a floor as well as a ceiling: its panels fetch
          before they render anything, so without one the dialog opened as a
          bare title bar and snapped to full height a moment later. */}
      <div
        className={`flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl ${
          wide ? "max-w-3xl" : "max-w-2xl"
        } ${rail ? "min-h-[min(34rem,88vh)]" : ""}`}
      >
        <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
            {subtitle && <p className="truncate text-xs text-zinc-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
            aria-label="Close"
          >
            <LuX className="h-4 w-4" />
          </button>
        </header>

        {rail ? (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav className="shrink-0 overflow-y-auto border-b border-white/10 bg-zinc-950/40 p-2 sm:w-52 sm:border-b-0 sm:border-r">
              {rail}
            </nav>
            <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        )}

        {footer && <footer className="border-t border-white/10 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
