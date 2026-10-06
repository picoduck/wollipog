import React, { useEffect, useRef, useState, type ReactNode } from "react";
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
  type SessionAttentionGroup,
  type SessionReminderView,
  sessionAttentionBreakdown,
} from "@wollipog/protocol";
import { BACKGROUND_DELIVERY_STATUS, backgroundDeliveryAccessibleName } from "../background-delivery-status.js";
import {
  childRequestsLabel,
  quarantinedStatusMeta,
  queueReasonLabel,
  sessionLifecycleMeta,
  statusMeta,
  type StatusMeta,
} from "../status-meta.js";

export { quarantinedStatusMeta, sessionLifecycleMeta };
import { reminderBadgeDescription, reminderBadgeLabel, type SnoozedAttentionReason } from "../session-reminders.js";
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

export function SessionStatusBadge({ status, archiveStatus, archiveOperation, stopOperation, historyQuarantine, runnerOnline, ariaLabel }: {
  status: SessionStatus;
  archiveStatus?: ArchiveStatus;
  archiveOperation?: ArchiveOperationView;
  stopOperation?: StopOperationView;
  historyQuarantine?: SessionView["historyQuarantine"];
  runnerOnline?: boolean;
  ariaLabel?: string;
}) {
  const meta = sessionLifecycleMeta(status, { archiveStatus, archiveOperation, stopOperation, historyQuarantine, runnerOnline });
  const operation = stopOperation ?? archiveOperation;
  return <StatusBadge meta={meta} title={operation?.failure?.message} ariaLabel={ariaLabel} />;
}

/** One status badge per entity (docs/design-system.md §11.1): attention outranks lifecycle, so when
 * an attention badge already says the session needs the user, "Awaiting Input" is not said again. */
export function lifecycleRepeatsAttention(lifecycle: StatusMeta, attention: unknown): boolean {
  return Boolean(attention) && lifecycle.label === statusMeta("session", "input_required").label;
}

export function AttentionBadge({ session, ariaLabel, onOpen }: {
  session: Pick<SessionView, "status" | "pendingApproval"> &
    Partial<Pick<SessionView, "orchestratorCampaign" | "pendingRequestOwners">>;
  ariaLabel?: string;
  onOpen?: () => void;
}) {
  const attention = sessionAttentionStatus(session);
  if (!attention) return null;
  return (
    <StatusBadge meta={statusMeta("attention", attention.kind)} label={attention.label}
      title={attention.description} ariaLabel={ariaLabel ?? attention.label} onClick={onOpen} />
  );
}

/**
 * Whether the session's attention is only its campaign's: no request of its own needs the person,
 * so the protocol's "Needs Your Input" stands for the human-owned child requests, which the one
 * "N Child Requests" status says instead (#2206).
 */
function attentionIsChildRequestsOnly(session: Parameters<typeof sessionAttentionBreakdown>[0]): boolean {
  return (session.orchestratorCampaign?.pendingRequests?.human ?? 0) > 0 &&
    sessionAttentionBreakdown(session).every((group) => group.count === 0);
}

/** One child's dot on a parent's family chip (#896). Literal class names, so the stylesheet guard can
 * see every state rendered; the state itself comes off the wire. */
export function ThreadDot({ state, title }: { state: "blocked" | "stalled" | "running" | "done" | "idle"; title: string }) {
  return <i
    className={state === "blocked"
      ? "inbox-thread-dot blocked"
      : state === "stalled"
        ? "inbox-thread-dot stalled"
        : state === "running"
          ? "inbox-thread-dot running"
          : state === "done" ? "inbox-thread-dot done" : "inbox-thread-dot"}
    title={title}
  />;
}

/**
 * Attention as one pill PER KIND, each carrying its count, in priority order: "Answer Required 2 ·
 * Approval Required" where the rolled-up badge says "3 Actions Required" (#896). A single request
 * keeps the rolled-up label so a child-owned request still names its owner; the tooltip lists each
 * request's owner and title, bounded so a runaway provider cannot grow a card's title attribute.
 */
export function AttentionPills({ session, compact = false }: {
  session: Pick<SessionView, "status" | "pendingApproval" | "attentionOwners"> &
    Partial<Pick<SessionView, "orchestratorCampaign" | "pendingRequestOwners">>;
  /** A phone card has one line for the sender AND the signals: show the top-priority kind with a
   * "+N" for the rest instead of one pill per kind, so three kinds cannot push the sender off the card. */
  compact?: boolean;
}) {
  const groups = sessionAttentionBreakdown(session);
  if (groups.length === 0) return null;
  if (groups.length === 1 && groups[0]!.count <= 1) {
    const attention = sessionAttentionStatus(session);
    return attention
      ? <StatusBadge meta={statusMeta("attention", attention.kind)} label={attention.label}
        title={attention.description} ariaLabel={"Attention: " + attention.label} />
      : null;
  }
  const describe = (group: SessionAttentionGroup) =>
    group.requests.slice(0, 10).map((request, index) => `${group.owners[index]}: ${request.title}`);
  if (compact) {
    const top = groups[0]!;
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    const listed = groups.flatMap(describe).slice(0, 10);
    const more = total - listed.length;
    return <StatusBadge meta={statusMeta("attention", top.kind)} label={top.label}
      title={[...listed, ...(more > 0 ? [`${more} more`] : [])].join("\n")}
      ariaLabel={`Attention: ${top.label}, ${total} Requests`}>
      <StatusCount>+{total - 1}</StatusCount>
    </StatusBadge>;
  }
  return <>{groups.map((group) => {
    const listed = describe(group);
    const more = group.count - listed.length;
    const title = [...listed, ...(more > 0 ? [`${more} more`] : [])].join("\n");
    return <StatusBadge key={group.label} meta={statusMeta("attention", group.kind)} label={group.label} title={title}
      ariaLabel={`Attention: ${group.label}${group.count > 1 ? `, ${group.count} Requests` : ""}`}>
      {group.count > 1 && <StatusCount>{group.count}</StatusCount>}
    </StatusBadge>;
  })}</>;
}

export function SessionStatusIndicators({
  session,
  disconnected = false,
  onOpenAttention,
  onOpenChildRequests,
  attention = "badge",
}: {
  session: Pick<SessionView, "status" | "pendingApproval" | "archiveStatus" | "archiveOperation" |
    "stopOperation" | "historyQuarantine" | "attentionOwners" | "capacityWait" | "queueHold" | "holds" |
    "orchestratorCampaign" | "pendingRequestOwners"> & Partial<Pick<SessionView, "runnerId">>;
  /** The session's runner is not connected (offline, or not known to this client). */
  disconnected?: boolean;
  onOpenAttention?: () => void;
  /** Opens the Requests panel's list of child requests; the attention target by default. */
  onOpenChildRequests?: () => void;
  /** Board cards show the per-kind pills; headers keep the single badge that opens the panel. */
  attention?: "badge" | "pills";
}) {
  // A Stop waits for its runner only when the runner is known to be offline. A runner this client
  // has no record of is unknown, not offline, so the Stop keeps its delivery wording (the Inbox row
  // reads it the same way). Without a store, the caller's `disconnected` is the only evidence.
  const storedRunnerStatus = useOptionalStoreSelector((state) =>
    session.runnerId === undefined ? undefined : state.runners.get(session.runnerId)?.status ?? "unknown");
  const runnerOnline = storedRunnerStatus === undefined ? !disconnected : storedRunnerStatus !== "offline";
  const lifecycle = sessionLifecycleMeta(session.status, {
    archiveStatus: session.archiveStatus,
    archiveOperation: session.archiveOperation,
    stopOperation: session.stopOperation,
    historyQuarantine: session.historyQuarantine,
    runnerOnline,
  });
  // Child requests are one status, "N Child Requests", whatever else the session needs (#2206). The
  // Orchestrator's own share is counted only inside the Requests panel.
  const childRequests = session.orchestratorCampaign?.pendingRequests?.human ?? 0;
  const attentionStatus = attentionIsChildRequestsOnly(session) ? null : sessionAttentionStatus(session);
  const queueHoldReason = session.status === "queued" && !session.capacityWait && session.queueHold
    ? session.holds?.find((hold) => hold.holdId === session.queueHold?.holdId)?.reason
    : undefined;
  return (
    <span className="session-status-indicators" role="group" aria-label="Session Status">
      {!lifecycleRepeatsAttention(lifecycle, attentionStatus) && <SessionStatusBadge
        status={session.status}
        archiveStatus={session.archiveStatus}
        archiveOperation={session.archiveOperation}
        stopOperation={session.stopOperation}
        historyQuarantine={session.historyQuarantine}
        runnerOnline={runnerOnline}
        ariaLabel={`Activity: ${lifecycle.label}`}
      />}
      {session.status === "queued" && session.capacityWait && (
        <StatusBadge tone="neutral" label={queueReasonLabel(session.capacityWait.kind)}
          title={session.capacityWait.description}
          ariaLabel={`Queue Reason: ${session.capacityWait.description}`} />
      )}
      {session.status === "queued" && !session.capacityWait && session.queueHold && (
        <StatusBadge tone="neutral"
          label={session.queueHold.kind === "worktree_rebind" ? "Worktree Handoff" : "Account Handoff"}
          title={queueHoldReason}
          ariaLabel={`Queue Reason: ${queueHoldReason ?? "A handoff is waiting on background work."}`} />
      )}
      {attentionStatus && (attention === "pills"
        ? <AttentionPills session={session} />
        : <AttentionBadge session={session} ariaLabel={`Attention: ${attentionStatus.label}`} onOpen={onOpenAttention} />)}
      {childRequests > 0 && (
        <StatusBadge tone="warning" label={childRequestsLabel(childRequests)}
          title={`${childRequests} ${childRequests === 1 ? "request from a child session needs" : "requests from child sessions need"} your input.`}
          ariaLabel={childRequestsLabel(childRequests)}
          onClick={onOpenChildRequests ?? onOpenAttention} />
      )}
      {disconnected && (
        <StatusBadge tone="danger" label="Disconnected" title="The session runner is disconnected."
          ariaLabel="Health: Disconnected" />
      )}
    </span>
  );
}

/** The accessible name of a background-work badge: "Background Work:" and the state, as every other
 * background-work status is announced, so lost work is "Background Work: Lost". It always names
 * background work, because the short visible forms ("Job", "Lost") do not. */
export function backgroundWorkAccessibleName(state: Exclude<BackgroundWorkState, "resumed">): string {
  const label = state === "orphaned" ? statusMeta("job", "lost").label : statusMeta("background_work", state).label;
  return `Background Work: ${label}`;
}

export function BackgroundWorkBadge({ state, compact = false, announce = true, onOpen }: {
  state: BackgroundWorkState;
  compact?: boolean;
  announce?: boolean;
  onOpen?: () => void;
}) {
  // Rolling deployments may briefly receive the retired terminal sentinel from an older control
  // plane. Completion remains available in the durable Background Work inventory, never here.
  if (state === "resumed") return null;
  const meta = statusMeta("background_work", state);
  const label = backgroundWorkAccessibleName(state);
  const visible = compact ? (
    <>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{meta.label}</span>
    </>
  ) : label;
  if (onOpen) {
    return (
      <>
        <StatusBadge meta={meta} label={visible} dataGroup="background-work" ariaLabel={label}
          ariaControls="right-panel" title={`Open ${label}`} onClick={onOpen} />
        {announce && <span className="sr-only" role="status" aria-label={label}>{label}</span>}
      </>
    );
  }
  return (
    <StatusBadge meta={meta} label={visible} dataGroup="background-work" role={announce ? "status" : undefined}
      ariaLabel={label} title={compact ? label : undefined} />
  );
}

/** The attention a snoozed session keeps showing beside its reminder: lost background work, or a
 * background result that has not come back. */
export function SnoozedAttentionBadge({ reason }: {
  reason: Extract<SnoozedAttentionReason, { kind: "orphaned_background_work" | "background_delivery_watchdog" }>;
}) {
  return (
    <StatusBadge
      tone={reason.kind === "orphaned_background_work" ? "danger" : reason.severity === "pending" ? "info" : "warning"}
      label={reason.label}
      title={reason.description}
      ariaLabel={reason.kind === "background_delivery_watchdog" ? reason.accessibleName : `Attention: ${reason.label}`}
    />
  );
}

export function ReminderBadge({ reminder }: { reminder: SessionReminderView }) {
  return (
    <StatusBadge meta={statusMeta("session", "snoozed")} label={reminderBadgeLabel(reminder)}
      title={reminderBadgeDescription(reminder)}
      ariaLabel={`Reminder: ${reminder.state === "fired" ? reminderBadgeDescription(reminder) : reminderBadgeLabel(reminder)}`} />
  );
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
