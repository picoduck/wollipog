import React from "react";

export interface CountBadgeProps {
  /** How many things need the user. Zero or less renders nothing: zero is never shown in colour. */
  count: number;
  /** Amber by default; danger for counts that are failing rather than waiting (stalled, errored). */
  tone?: "warning" | "danger";
  /** Places the badge on an icon's top-right shoulder. The icon's wrapper is the positioned box. */
  onIcon?: boolean;
  className?: string;
}

/**
 * The one count badge (docs/design-system.md §11.4): a 16px solid pill for a count that needs the
 * user. It is `aria-hidden`, so the control that shows it states the count in its own accessible
 * name or description. Classes are literal so the stylesheet guard can see every one rendered.
 */
export function CountBadge({ count, tone = "warning", onIcon = false, className }: CountBadgeProps) {
  if (!(count > 0)) return null;
  return (
    <span
      className={[
        "count-badge",
        tone === "danger" ? "danger" : "",
        onIcon ? "on-icon" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      {count}
    </span>
  );
}
