import type { ReactNode } from "react";

type Side = "top" | "bottom" | "right" | "left";

const SIDE: Record<Side, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
};

/**
 * A CSS-only hover tooltip — no state, no portal, no JS.
 *
 * Uses a named group (`group/tt`) so it coexists with other `group` classes on
 * the same element, and shows on hover or keyboard focus.
 */
export function Tooltip({
  label,
  children,
  side = "top",
  className = "",
}: {
  label?: ReactNode;
  children: ReactNode;
  side?: Side;
  className?: string;
}) {
  if (!label) return <>{children}</>;
  return (
    <span className={`group/tt relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 hidden w-max max-w-[280px] rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-normal leading-snug text-fg-subtle shadow-pop group-hover/tt:block group-focus-within/tt:block ${SIDE[side]}`}
      >
        {label}
      </span>
    </span>
  );
}
