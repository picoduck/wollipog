import React, { type MouseEventHandler, type ReactNode } from "react";
import type { StatusMeta, StatusTone } from "../status-meta.js";

export interface StatusBadgeProps {
  /** Label, tone and pulse, normally from `statusMeta(domain, value)`. */
  meta?: Pick<StatusMeta, "label" | "tone"> & Partial<Pick<StatusMeta, "pulse" | "hollow">>;
  /** A computed label (a count, a provider-supplied attention label) replacing `meta.label`. */
  label?: ReactNode;
  tone?: StatusTone;
  pulse?: boolean;
  hollow?: boolean;
  size?: "sm" | "md";
  /** Dot plus label with no pill, for dense rows and tables. */
  inline?: boolean;
  /** A flag badge ("Required", "Built-In"): a fact beside a status, not a state, so no dot. */
  noDot?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  ariaControls?: string;
  role?: "status";
  hidden?: boolean;
  /** Groups badges for a surface that measures them (the Session header's background-work tier). */
  dataGroup?: string;
  /** Renders the badge as a button that opens the place where the status can be acted on. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
}

/**
 * The one status badge (docs/design-system.md §11.1): a tinted pill with a dot in the tone's full
 * colour and a Title Case label. It is the only coloured chip in the app. Tone classes are literal
 * so the stylesheet guard can see every one rendered.
 */
export function StatusBadge({
  meta,
  label,
  tone = meta?.tone ?? "neutral",
  pulse = meta?.pulse ?? false,
  hollow = meta?.hollow ?? false,
  size = "sm",
  inline = false,
  noDot = false,
  className,
  title,
  ariaLabel,
  ariaControls,
  role,
  hidden,
  dataGroup,
  onClick,
  children,
}: StatusBadgeProps) {
  // One element either way; a badge that opens its source is a button. The cast keeps one JSX body
  // (and one literal class expression, which is what the stylesheet guard reads) for both tags.
  const Tag = (onClick ? "button" : "span") as "button";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={[
        "status",
        size === "md" ? "md" : "sm",
        tone === "info" ? "t-info"
          : tone === "success" ? "t-success"
            : tone === "warning" ? "t-warning"
              : tone === "danger" ? "t-danger"
                : "t-neutral",
        inline ? "inline" : "",
        noDot ? "no-dot" : pulse ? "pulse" : hollow ? "hollow" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      title={title}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      role={onClick ? undefined : role}
      hidden={hidden}
      data-group={dataGroup}
      onClick={onClick}
    >
      {label ?? meta?.label}{children}
    </Tag>
  );
}

/**
 * A tone's class, for a status dot drawn outside the badge (the instance tile and card). Written out
 * in full so the stylesheet guard can see every tone class rendered.
 */
export function statusToneClass(tone: StatusTone): string {
  return tone === "info" ? "t-info"
    : tone === "success" ? "t-success"
      : tone === "warning" ? "t-warning"
        : tone === "danger" ? "t-danger"
          : "t-neutral";
}

/** A count inside a status badge ("Answer Required 2"). The badge's accessible name says it in words. */
export function StatusCount({ children }: { children: ReactNode }) {
  return <span className="status-count" aria-hidden="true">{children}</span>;
}
