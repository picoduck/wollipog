import { sessionCampaignRequests } from "@wollipog/protocol";
import React, { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type BackgroundDeliveryWatchdogState,
  type BackgroundNotificationReceiptState,
  type SessionView,
} from "@wollipog/protocol";
import { BACKGROUND_DELIVERY_STATUS, backgroundDeliveryAccessibleName } from "../background-delivery-status.js";
import {
  childRequestsLabel,
  quarantinedStatusMeta,
  sessionStatusSummary,
  sessionLifecycleMeta,
  statusMeta,
  type StatusMeta,
} from "../status-meta.js";

export { quarantinedStatusMeta, sessionLifecycleMeta };
import { useOptionalStoreSelector } from "../store.js";
import { CheckIcon, CopyIcon, ErrorIcon, PinIcon } from "./Icons.js";
import { StatusBadge, StatusCount } from "./StatusBadge.js";

export { Modal, type ModalSize } from "./Modal.js";

/** A compact, non-colour-only pin signal shared by List rows and Board cards. */
export function SessionPinIndicator({ contains = false }: { contains?: boolean }) {
  const label = contains ? "Contains Pinned Session" : "Pinned Session";
  return (
    <span
      className={`inbox-pin-indicator${contains ? " contains-pinned" : ""}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <PinIcon size={14} />
      {contains && <span className="inbox-pin-contained-mark" />}
    </span>
  );
}

export function copyResultIsCurrent(input: {
  mounted: boolean;
  request: number;
  currentRequest: number;
  copiedText: string;
  currentText: string;
}): boolean {
  return input.mounted && input.request === input.currentRequest && input.copiedText === input.currentText;
}

/** How long a copy result stays on the button before it returns to its label. */
export const COPY_RESULT_MS = 2000;

/**
 * Copy-to-clipboard button. For about two seconds after a copy, its leading icon becomes a check and
 * its label "Copied" (or an error icon and "Copy Failed"), announced politely as well.
 *
 * The labeled form stacks all three labels in one grid cell and shows one, so the button is always as
 * wide as its longest label and does not change width when the result appears. Only the shown label is
 * text; the other two are hidden generated content (`data-sizer-*`, styles.css), so the button's text
 * is never the three run together.
 */
export function CopyButton({
  text,
  format,
  label = "Copy",
  onResult,
  className = "copy-btn",
  describedBy,
  ariaLabel,
  role,
  iconOnly = false,
  tooltip = true,
}: {
  text: string;
  /** Turns `text` into what is copied, run only when the button is pressed (Copy Response's plain text). */
  format?: (text: string) => string;
  label?: string;
  onResult?: (copied: boolean) => void;
  className?: string;
  describedBy?: string;
  ariaLabel?: string;
  role?: "menuitem";
  /** Keep compact utility surfaces visual while retaining a descriptive accessible name. */
  iconOnly?: boolean;
  /** False where a surface keeps every control's name out of the title attribute (the sign-in
   * Request Card, #2198); the accessible name still says what the button does. */
  tooltip?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const clearResetTimer = () => {
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  };
  useEffect(() => {
    requestRef.current += 1;
    clearResetTimer();
    setStatus("idle");
  }, [text]);
  useEffect(() => {
    // StrictMode runs setup → cleanup → setup in development. Re-arm on every setup so the
    // simulated cleanup cannot permanently discard every later clipboard completion.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      clearResetTimer();
    };
  }, []);
  const copy = async () => {
    const copiedText = text;
    const value = format ? format(copiedText) : copiedText;
    const request = ++requestRef.current;
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      if (!copyResultIsCurrent({
        mounted: mountedRef.current,
        request,
        currentRequest: requestRef.current,
        copiedText,
        currentText: textRef.current,
      })) return;
      const fallback = document.createElement("textarea");
      fallback.value = value;
      fallback.readOnly = true;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      } finally {
        fallback.remove();
        // select() moved focus into the temporary control. Restore the invoking menu/button so
        // plain-HTTP dashboards without Clipboard API do not lose keyboard position.
        buttonRef.current?.focus();
      }
    }
    if (!copyResultIsCurrent({
      mounted: mountedRef.current,
      request,
      currentRequest: requestRef.current,
      copiedText,
      currentText: textRef.current,
    })) return;
    setStatus(ok ? "copied" : "failed");
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => {
      setStatus("idle");
      resetTimerRef.current = null;
    }, COPY_RESULT_MS);
    onResult?.(ok);
  };
  // A menu row draws its icon in the menu's 16px icon slot, so its label lines up with its neighbours'.
  const menuRow = role === "menuitem";
  const iconSize = iconOnly || menuRow ? 16 : 14;
  const glyph = status === "copied" ? <CheckIcon size={iconSize} className="copy-status-icon-copied" />
    : status === "failed" ? <ErrorIcon size={iconSize} className="copy-status-icon-failed" />
      : <CopyIcon size={iconSize} />;
  const icon = menuRow ? <span className="menu-icon" aria-hidden="true">{glyph}</span> : glyph;
  const labels = { idle: label, copied: "Copied", failed: "Copy Failed" } as const;
  const [sizerA, sizerB] = (["idle", "copied", "failed"] as const).filter((each) => each !== status).map((each) => labels[each]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${className}${iconOnly ? "" : " copy-btn-labeled"}${status !== "idle" ? ` copy-status-${status}` : ""}`}
        onClick={copy}
        title={tooltip ? ariaLabel ?? "Copy to Clipboard" : undefined}
        aria-label={ariaLabel ?? label}
        aria-describedby={describedBy}
        role={role}
      >
        {icon}
        {!iconOnly && (
          <span className="copy-btn-labels" data-sizer-a={sizerA} data-sizer-b={sizerB}>
            <span>{labels[status]}</span>
          </span>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {status === "copied" ? "Copied to clipboard" : status === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}

/** One child's dot on a parent's family chip (#896). Literal class names, so the stylesheet guard can
 * see every state rendered; the state itself comes off the wire. */
export function ThreadDot({ state, title }: { state: "blocked" | "running" | "done" | "idle"; title: string }) {
  return <i
    className={state === "blocked"
      ? "inbox-thread-dot blocked"
      : state === "running"
        ? "inbox-thread-dot running"
        : state === "done" ? "inbox-thread-dot done" : "inbox-thread-dot"}
    title={title}
  />;
}

export function SessionStatusIndicators({
  session,
  disconnected = false,
  onOpenAttention,
  onOpenChildRequests,
}: {
  session: Pick<SessionView, "status" | "pendingApproval" | "archiveStatus" | "archiveOperation" |
    "stopOperation" | "historyQuarantine" | "attentionOwners" | "capacityWait" | "queueHold" | "holds" |
    "orchestratorCampaign" | "campaignRequests" | "pendingRequestOwners"> & Partial<Pick<SessionView, "runnerId">>;
  /** The session's runner is not connected (offline, or not known to this client). */
  disconnected?: boolean;
  onOpenAttention?: () => void;
  /** Opens the Requests panel's list of child requests; the attention target by default. */
  onOpenChildRequests?: () => void;
}) {
  // A Stop waits for its runner only when the runner is known to be offline. A runner this client
  // has no record of is unknown, not offline, so the Stop keeps its delivery wording (the Inbox row
  // reads it the same way). Without a store, the caller's `disconnected` is the only evidence.
  const storedRunnerStatus = useOptionalStoreSelector((state) =>
    session.runnerId === undefined ? undefined : state.runners.get(session.runnerId)?.status ?? "unknown");
  const runnerOnline = storedRunnerStatus === undefined ? !disconnected : storedRunnerStatus !== "offline";
  const summary = sessionStatusSummary(session, { runnerOnline, disconnected: disconnected || !runnerOnline });
  const extras = summary.conditions.filter((condition) => condition.needsYou && condition !== summary.secondary);
  const extraNames = extras.map((condition) => condition.meta.label).join("; ");
  const openExtras = extras.some((condition) => condition.kind === "child_requests")
    ? onOpenChildRequests ?? onOpenAttention : onOpenAttention;
  return <span className="session-status-indicators" role="group" aria-label="Session Status">
    {[summary.primary, ...(summary.secondary ? [summary.secondary] : [])].map((condition, index) =>
      <StatusBadge key={index} meta={condition.meta} title={condition.description}
        ariaLabel={condition.kind === "lifecycle" ? "Activity: " + condition.meta.label :
          condition.kind === "attention" ? "Attention: " + condition.meta.label + (condition.count ? `, ${condition.count} Requests` : "") :
          condition.kind === "disconnected" ? "Health: Disconnected" :
          condition.kind === "queue_reason" ? "Queue Reason: " + condition.description : condition.meta.label}
        onClick={condition.kind === "child_requests" ? onOpenChildRequests ?? onOpenAttention : condition.needsYou ? onOpenAttention : undefined}>
        {condition.count !== undefined && <StatusCount>{condition.count}</StatusCount>}
      </StatusBadge>)}
    {summary.more > 0 && (openExtras
      ? <button type="button" className="btn sm ghost" title={extraNames}
        aria-label={`${summary.more} More: ${extraNames}`} onClick={openExtras}>+{summary.more}</button>
      : <span title={extraNames} aria-label={`${summary.more} More: ${extraNames}`}>+{summary.more}</span>)}
  </span>;
}

export function BackgroundDeliveryBadge({ state, onOpen }: { state: BackgroundDeliveryWatchdogState; onOpen?: () => void }) {
  const status = BACKGROUND_DELIVERY_STATUS[state];
  // Only a state that progresses on its own reads as working; a blocked or missing result asks
  // for a step, so it takes the needs-you tone.
  return (
    <StatusBadge tone={status.severity === "pending" ? "info" : "warning"} label={status.label}
      dataGroup="background-work" ariaLabel={backgroundDeliveryAccessibleName(state)}
      ariaControls={onOpen ? "right-panel" : undefined} title={status.description} onClick={onOpen} />
  );
}

export function BackgroundNotificationBadge({ state, onOpen }: {
  state: BackgroundNotificationReceiptState;
  onOpen?: () => void;
}) {
  const meta = statusMeta("notification", state);
  return (
    <StatusBadge meta={meta} dataGroup="background-work" ariaLabel={meta.label}
      ariaControls={onOpen ? "right-panel" : undefined}
      title={onOpen ? `Open Background Work: ${meta.label}` : undefined} onClick={onOpen} />
  );
}

export function Spinner({ decorative = false }: { decorative?: boolean } = {}) {
  // Decorative where an adjacent label ALREADY says what is happening. Two accessible names on one
  // control announce as "Loading Checking…", which is duplication carrying no extra information.
  return decorative
    ? <span className="spinner" aria-hidden="true" />
    : <span className="spinner" aria-label="Loading" />;
}

/**
 * A placeholder shaped like the content that is coming.
 *
 * "Loading Projects…" tells you the app is not broken and nothing else — the layout jumps when the
 * real content lands, and a slow load reads as a blank screen with an apology on it. Rows of the
 * right size hold the layout still and make the wait legible as progress.
 *
 * `aria-hidden` with a single live region outside: a screen reader should hear "Loading projects"
 * once, not read eight empty rows. The prop is `announce`, not `label`, because that is what it is —
 * a status message in sentence case, not a UI label in Title Case, and naming it `label` put it
 * under the wrong copy convention.
 */
/**
 * A master-detail pane's placeholder (§12.3): a skeleton title over two section blocks. Silent
 * unless given `announce`, because while the whole collection loads the list's Skeleton beside it
 * already says so.
 */
export function DetailSkeleton({ announce }: { announce?: string } = {}) {
  return (
    <div className="skeleton detail-skeleton" role={announce ? "status" : undefined} aria-live={announce ? "polite" : undefined}>
      {announce && <span className="sr-only">{announce}</span>}
      <div aria-hidden="true" className="skeleton-row skeleton-title" />
      <div aria-hidden="true" className="skeleton-row skeleton-block" />
      <div aria-hidden="true" className="skeleton-row skeleton-block" />
    </div>
  );
}

export function Skeleton({ rows = 3, announce }: { rows?: number; announce: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{announce}</span>
      <div aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index} />)}
      </div>
    </div>
  );
}
