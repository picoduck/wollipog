import React, { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  sessionAttentionStatus,
  type ArchiveStatus,
  type ArchiveOperationView,
  type StopOperationView,
  type BackgroundDeliveryWatchdogState,
  type BackgroundNotificationReceiptState,
  type BackgroundWorkState,
  type SessionStatus,
  type SessionView,
} from "@wollipog/protocol";
import { statusMeta } from "../format.js";
import type { SessionChangeStatus } from "../session-status.js";
import { CheckIcon, CloseIcon, CopyIcon, WarningIcon } from "./Icons.js";

let nextModalLayerId = 1;
const modalLayerStack: number[] = [];

export function copyResultIsCurrent(input: {
  mounted: boolean;
  request: number;
  currentRequest: number;
  copiedText: string;
  currentText: string;
}): boolean {
  return input.mounted && input.request === input.currentRequest && input.copiedText === input.currentText;
}

/** Copy-to-clipboard button with brief "Copied!" feedback. */
export function CopyButton({
  text,
  label = "Copy",
  onResult,
  className = "copy-btn",
  describedBy,
  ariaLabel,
  role,
  iconOnly = false,
}: {
  text: string;
  label?: string;
  onResult?: (copied: boolean) => void;
  className?: string;
  describedBy?: string;
  ariaLabel?: string;
  role?: "menuitem";
  /** Keep compact utility surfaces visual while retaining a descriptive accessible name. */
  iconOnly?: boolean;
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
    const request = ++requestRef.current;
    let ok = false;
    try {
      await navigator.clipboard.writeText(copiedText);
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
      fallback.value = copiedText;
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
    }, 1500);
    onResult?.(ok);
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${className}${iconOnly && status !== "idle" ? ` copy-status-${status}` : ""}`}
        onClick={copy}
        title={ariaLabel ?? "Copy to Clipboard"}
        aria-label={ariaLabel ?? label}
        aria-describedby={describedBy}
        role={role}
      >
        {iconOnly ? (
          status === "copied" ? <CheckIcon className="copy-status-icon-copied" />
            : status === "failed" ? <WarningIcon className="copy-status-icon-failed" />
              : <CopyIcon />
        ) : status === "copied" ? "✓ Copied" : status === "failed" ? "Copy failed" : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {status === "copied" ? "Copied to clipboard" : status === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}

export function StatusBadge({ status, archiveStatus, archiveOperation, stopOperation, ariaLabel }: {
  status: SessionStatus;
  archiveStatus?: ArchiveStatus;
  archiveOperation?: ArchiveOperationView;
  stopOperation?: StopOperationView;
  ariaLabel?: string;
}) {
  const m = sessionStatusBadgeMeta(status, archiveStatus, archiveOperation, stopOperation);
  const operation = stopOperation ?? archiveOperation;
  return (
    <span className={"status-badge " + m.className} title={operation?.failure?.message} aria-label={ariaLabel}>
      <span className={"status-dot2 " + (m.busy ? "pulse" : "")} />
      {m.label}
    </span>
  );
}

function sessionStatusBadgeMeta(
  status: SessionStatus,
  archiveStatus?: ArchiveStatus,
  archiveOperation?: ArchiveOperationView,
  stopOperation?: StopOperationView,
) {
  const operation = stopOperation ?? archiveOperation;
  const operationStatus = operation?.status ?? archiveStatus;
  return operationStatus === "stop_pending"
    ? { label: "Stopping", className: "st-running", busy: true }
    : operationStatus === "stop_failed"
      ? { label: "Stop Failed", className: "st-failed", busy: false }
      : statusMeta(status);
}

export function AttentionBadge({ session, ariaLabel }: {
  session: Pick<SessionView, "status" | "pendingApproval">;
  ariaLabel?: string;
}) {
  const attention = sessionAttentionStatus(session);
  if (!attention) return null;
  return (
    <span className="status-badge st-input" title={attention.description} aria-label={ariaLabel ?? attention.label}>
      <span className="status-dot2" aria-hidden="true" />
      {attention.label}
    </span>
  );
}

export function SessionStatusIndicators({ session, disconnected = false }: {
  session: Pick<SessionView, "status" | "pendingApproval" | "archiveStatus" | "archiveOperation" | "stopOperation">;
  disconnected?: boolean;
}) {
  const lifecycle = sessionStatusBadgeMeta(
    session.status,
    session.archiveStatus,
    session.archiveOperation,
    session.stopOperation,
  );
  const attention = sessionAttentionStatus(session);
  return (
    <span className="session-status-indicators" role="group" aria-label="Session Status">
      <StatusBadge
        status={session.status}
        archiveStatus={session.archiveStatus}
        archiveOperation={session.archiveOperation}
        stopOperation={session.stopOperation}
        ariaLabel={`Activity: ${lifecycle.label}`}
      />
      <AttentionBadge session={session} ariaLabel={attention ? `Attention: ${attention.label}` : undefined} />
      {disconnected && (
        <span className="status-badge st-failed" title="The session runner is disconnected." aria-label="Health: Disconnected">
          <span className="status-dot2" aria-hidden="true" />
          Disconnected
        </span>
      )}
    </span>
  );
}

export function ChangeStatusBadge({ change }: { change: SessionChangeStatus | null }) {
  if (!change) return null;
  const indicators = change.kind === "ready_for_review" && change.supplement
    ? [change, change.supplement]
    : [change];
  return (
    <span className="change-status-indicators" role="group" aria-label="Change Status">
      {indicators.map((indicator) => {
        const className = indicator.kind === "ready_for_review"
          ? "st-done"
          : indicator.kind === "no_changes" ? "st-stopped" : "st-idle";
        return (
          <span key={indicator.kind} className={"status-badge " + className}
            title={indicator.description} aria-label={`Changes: ${indicator.label}`}>
            <span className="status-dot2" aria-hidden="true" />
            {indicator.label}
          </span>
        );
      })}
    </span>
  );
}

const BACKGROUND_WORK_LABELS: Record<BackgroundWorkState, string> = {
  running: "Waiting on External Job",
  continuation_pending: "Continuation Pending",
  orphaned: "Orphaned",
  resumed: "Resumed",
};

const COMPACT_BACKGROUND_WORK_LABELS: Record<BackgroundWorkState, string> = {
  running: "Background Work Active",
  continuation_pending: "Continuation Pending",
  orphaned: "Background Work Orphaned",
  resumed: "Background Work Resumed",
};

export function BackgroundWorkBadge({ state }: { state: BackgroundWorkState }) {
  const label = `Background Work: ${BACKGROUND_WORK_LABELS[state]}`;
  return (
    <span
      className={`background-work-badge ${state === "running" || state === "continuation_pending"
        ? "background-work-running"
        : state === "orphaned"
          ? "background-work-orphaned"
          : "background-work-resumed"}`}
      role="status"
      aria-label={label}
    >
      <span className="background-work-dot" aria-hidden="true" />
      <span className="background-work-label-full">{label}</span>
      <span className="background-work-label-compact" aria-hidden="true">
        {COMPACT_BACKGROUND_WORK_LABELS[state]}
      </span>
    </span>
  );
}

export function UntrackedBackgroundWorkBadge() {
  return (
    <span
      className="background-work-badge background-work-untracked"
      role="status"
      aria-label="Detached Work: Untracked"
      title="This provider does not expose a durable detached-work lifecycle. Wollipog cannot promise automatic completion, cancellation, or recovery."
    >
      <span className="background-work-dot" aria-hidden="true" />
      Detached Work: Untracked
    </span>
  );
}

export function ActiveSubagentsBadge({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count < 1) return null;
  const label = count === 1 ? "1 Subagent Active" : `${count} Subagents Active`;
  const visibleLabel = count === 1 ? "1 Subagent" : `${count} Subagents`;
  return (
    <button
      type="button"
      className="background-work-badge background-work-running"
      onClick={onOpen}
      aria-label={label}
      title={label}
    >
      <span className="background-work-dot" aria-hidden="true" />
      <span className="background-work-label-full">{label}</span>
      <span className="background-work-label-compact" aria-hidden="true">{visibleLabel}</span>
    </button>
  );
}

const BACKGROUND_DELIVERY_LABELS: Record<BackgroundDeliveryWatchdogState, string> = {
  terminal_without_continuation: "Terminal Result Awaiting Continuation",
  accepted_without_result: "Accepted Continuation Awaiting Result",
  result_not_projected: "Result Awaiting Transcript Projection",
  dashboard_observation_pending: "Notification Awaiting Dashboard",
};

export function BackgroundDeliveryBadge({ state }: { state: BackgroundDeliveryWatchdogState }) {
  const label = `Background Delivery: ${BACKGROUND_DELIVERY_LABELS[state]}`;
  return (
    <span className="background-work-badge background-work-orphaned" aria-label={label}>
      <span className="background-work-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

const BACKGROUND_NOTIFICATION_LABELS: Record<BackgroundNotificationReceiptState, string> = {
  pending: "Push Pending",
  retry: "Push Retry Pending",
  service_accepted: "Push Service Accepted",
  shown: "Notification Displayed",
  clicked: "Notification Clicked",
  permanent_failure: "Push Failed",
  expired: "Push Expired",
};

export function BackgroundNotificationBadge({ state }: { state: BackgroundNotificationReceiptState }) {
  const label = BACKGROUND_NOTIFICATION_LABELS[state];
  const attention = state === "pending" || state === "retry" || state === "permanent_failure" || state === "expired";
  return (
    <span
      className={`background-work-badge ${attention ? "background-work-orphaned" : "background-work-resumed"}`}
      aria-label={label}
    >
      <span className="background-work-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  describedBy,
  className,
  returnFocusRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  describedBy?: string;
  className?: string;
  /** Durable element to restore focus to on close. Without it the dialog restores to whatever
   * was focused at open — which fails when the opener was a menu item removed in the same
   * commit that opened the dialog (the menu closes as the dialog mounts). */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const openerFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const explicitReturnFocusRef = useRef(returnFocusRef);
  explicitReturnFocusRef.current = returnFocusRef;
  const layerIdRef = useRef<number>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  if (layerIdRef.current == null) layerIdRef.current = nextModalLayerId++;

  useEffect(() => {
    const layerId = layerIdRef.current!;
    modalLayerStack.push(layerId);
    const onKey = (e: KeyboardEvent) => {
      // Nested UI (e.g. the directory browser) claims Escape for itself via preventDefault —
      // don't tear the whole dialog down over it.
      if (e.key === "Escape" && !e.defaultPrevented && modalLayerStack.at(-1) === layerId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const index = modalLayerStack.lastIndexOf(layerId);
      if (index !== -1) modalLayerStack.splice(index, 1);
      const explicit = explicitReturnFocusRef.current?.current;
      const target = explicit?.isConnected ? explicit : openerFocusRef.current;
      window.setTimeout(() => {
        // A queued dialog can replace this one in the same commit. Do not steal focus back to
        // the page from that newer modal; nested dialogs may still restore into their owning
        // dialog — but only the TOPMOST one, so a dying layer can never pull focus out from
        // under a newer dialog stacked above its opener (regression coverage).
        const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
        const topmost = dialogs[dialogs.length - 1] ?? null;
        if (target?.isConnected &&
            (modalLayerStack.length === 0 || (topmost !== null && target.closest('[role="dialog"]') === topmost))) {
          target.focus();
          // A connected target can still refuse focus — e.g. it became disabled while the
          // dialog's action ran. Fall through so keyboard position never lands on <body>.
          if (document.activeElement === target) return;
        }
        // The opener is gone or unfocusable — a breakpoint crossing unmounted the layout that
        // held it, or a busy state disabled it. Focus was live inside the dialog the whole
        // time, so no layout rescue fired and none will. Without this the close drops focus on
        // <body> and the next Tab restarts at the top of the document.
        if (modalLayerStack.length === 0) {
          document.getElementById("page-title")?.focus();
          return;
        }
        // Restoration failed while other dialogs remain open: keep keyboard position inside
        // the modal system and its Tab trap rather than on <body>.
        if (document.activeElement === document.body || document.activeElement === null) {
          topmost?.focus();
        }
      }, 0);
    };
  }, []);

  // Move focus into the dialog on open so Escape/Tab work immediately — unless a field
  // inside already claimed it (autoFocus).
  useEffect(() => {
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) card.focus();
  }, []);

  // Keep Tab cycling inside the dialog instead of escaping to the page behind it.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const card = cardRef.current;
    if (!card) return;
    const focusables = card.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className={`modal ${wide ? "modal-wide" : ""} ${className ?? ""}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
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

/**
 * An empty state: icon, title, hint, and the action that ends it.
 *
 * §F8 called the previous version a 2015 pattern, and the shape was the problem rather than the
 * styling — a dashed box with 54px of padding and no way in. An empty screen is the one moment the
 * app knows exactly what the user should do next, and it was spending that moment on a border.
 *
 * `icon` and `action` are OPTIONAL and every existing caller omits both, so this is additive: the
 * screens that pass nothing render what they rendered before, minus the dashes. The alternative —
 * requiring an action — would have meant inventing one for eight screens in a styling PR.
 *
 * `hint` stays a div rather than a <p> so callers can pass block content without producing invalid
 * <div>-in-<p> nesting.
 */
export function Empty({ title, hint, icon, action, headingLevel }: {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  /**
   * Render the title as a heading at this level, for a caller that replaced a real one.
   *
   * A screen that used to expose "No Automations Yet" as an `h3` lost it when it moved to this
   * component: heading navigation is how a screen-reader user finds a section, and a paragraph is
   * not in that list. Not the default, because most callers sit inside a section that already has
   * its heading, and an extra one there is noise rather than structure.
   */
  headingLevel?: 2 | 3 | 4;
}) {
  const Title = (headingLevel ? `h${headingLevel}` : "p") as "p" | "h2" | "h3" | "h4";
  return (
    <div className="empty">
      {icon && <span className="empty-icon" aria-hidden="true">{icon}</span>}
      <Title className="empty-title">{title}</Title>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
