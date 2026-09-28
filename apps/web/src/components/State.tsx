import React, { type ReactNode } from "react";
import { useOptionalStoreSelector } from "../store.js";
import { Notice } from "./Notice.js";
import { Spinner } from "./common.js";

export type StateVariant = "offline" | "loading" | "error" | "empty" | "no-results";

/**
 * The one state a collection shows instead of its content (docs/design-system.md §12). The states
 * are mutually exclusive in this priority order — offline, then loading, then error, then empty,
 * then no results — so a list never says "No … Yet" while it is still loading or disconnected.
 * Returns null when the content itself should render.
 */
export function stateVariant(conditions: {
  offline?: boolean;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  noResults?: boolean;
}): StateVariant | null {
  if (conditions.offline) return "offline";
  if (conditions.loading) return "loading";
  if (conditions.error) return "error";
  if (conditions.empty) return "empty";
  if (conditions.noResults) return "no-results";
  return null;
}

/**
 * Whether the live snapshot can vouch for an empty collection. Before the first snapshot a list is
 * loading; while the socket is down it is offline, even after a snapshot has loaded, because the
 * last-known content may no longer be true. The store retries a dropped socket, so a loaded
 * snapshot with a connection that is only "connecting" is still offline: the retry has not
 * delivered anything new yet. A surface rendered without a store (a harness page or a unit test)
 * has no connection to report and is treated as current.
 */
export function useSnapshotState(): { offline: boolean; loading: boolean } {
  const conn = useOptionalStoreSelector((state) => state.conn);
  const loaded = useOptionalStoreSelector((state) => state.snapshotLoaded);
  if (conn === undefined) return { offline: false, loading: false };
  return {
    offline: conn === "offline" || conn === "unauthorized" || (loaded === true && conn === "connecting"),
    loading: !loaded,
  };
}

export interface StateProps {
  variant?: StateVariant;
  /** A 24px icon, shown on a 40px tile for an empty state. */
  icon?: ReactNode;
  /** Title Case. Loading and offline states are one sentence and take no title. */
  title?: string;
  /** One or two sentences in sentence case. */
  children?: ReactNode;
  /** The next step: at least one action for an empty state (§1.4.5). */
  actions?: ReactNode;
  /** 24px from the top instead of 48px, for states inside panels (§21.4). */
  compact?: boolean;
  /** Render the title as a heading at this level, for a state that replaced a real heading. */
  headingLevel?: 2 | 3 | 4;
  /** False when an ancestor is already the live region, so the message is announced once. */
  live?: boolean;
  className?: string;
}

/**
 * Empty, no results, loading, error and offline, in one component (docs/design-system.md §12).
 * Top-aligned and left-aligned with the content's edge: no bordered card and no success glyph.
 */
export function State({
  variant = "empty",
  icon,
  title,
  children,
  actions,
  compact = false,
  headingLevel,
  live: announce = true,
  className,
}: StateProps) {
  if (variant === "error") {
    // §12.4: an error is a danger notice in place of the content, with its recovery as the action.
    return (
      <Notice tone="danger" role="alert" title={title} actions={actions}
        className={["state-error", compact ? "compact-state" : "", className ?? ""].filter(Boolean).join(" ")}>
        {children}
      </Notice>
    );
  }
  const Title = (headingLevel ? `h${headingLevel}` : "p") as "p" | "h2" | "h3" | "h4";
  const live = variant === "loading" || variant === "offline";
  return (
    <div
      className={[
        "state",
        variant === "loading" ? "loading"
          : variant === "offline" ? "offline"
            : variant === "no-results" ? "no-results"
              : "",
        compact ? "compact" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      role={announce && (live || variant === "no-results") ? "status" : undefined}
      aria-live={announce && live ? "polite" : undefined}
    >
      {variant === "loading" && <Spinner decorative />}
      {icon && variant !== "loading" && <span className="state-icon" aria-hidden="true">{icon}</span>}
      {title && <Title className="state-title">{title}</Title>}
      {children != null && children !== false && <div className="state-body">{children}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
