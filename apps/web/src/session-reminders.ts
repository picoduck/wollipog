import {
  sessionAttentionStatus,
  type BackgroundDeliveryWatchdogState,
  type SessionAttentionStatus,
  type SessionReminderView,
  type SessionView,
} from "@wollipog/protocol";
import { formatReminderInstant } from "./reminder-schedule.js";

export type ReminderInboxMode = "ordinary" | "snoozed";

export type SnoozedAttentionReason =
  | { kind: "session_attention"; label: string; description: string; attention: SessionAttentionStatus }
  | { kind: "failed"; label: "Failed"; description: string }
  | { kind: "orphaned_background_work"; label: "Background Work Orphaned"; description: string }
  | {
    kind: "background_delivery_watchdog";
    label: string;
    description: string;
    watchdogState: BackgroundDeliveryWatchdogState;
  };

const WATCHDOG_ATTENTION_LABELS: Record<BackgroundDeliveryWatchdogState, string> = {
  terminal_without_continuation: "Continuation Required",
  accepted_without_result: "Background Result Missing",
  result_not_projected: "Transcript Update Missing",
  dashboard_observation_pending: "Dashboard Check Pending",
};

/** One canonical explanation for every exception that keeps a pending reminder in Active. */
export function snoozedSessionAttentionReason(session: SessionView): SnoozedAttentionReason | null {
  // Older or partial snapshots may omit pendingApproval even though current SessionView requires
  // null. `undefined !== null` used to retain an otherwise-idle snoozed session with no reason.
  const attention = sessionAttentionStatus({
    status: session.status,
    pendingApproval: session.pendingApproval ?? null,
  });
  if (attention) {
    return {
      kind: "session_attention",
      label: attention.label,
      description: attention.description,
      attention,
    };
  }
  if (session.status === "failed") {
    return {
      kind: "failed",
      label: "Failed",
      description: "The session failed and requires attention.",
    };
  }
  if (session.backgroundWorkState === "orphaned") {
    return {
      kind: "orphaned_background_work",
      label: "Background Work Orphaned",
      description: "Managed background work became orphaned and requires attention.",
    };
  }
  const watchdogState = session.backgroundDeliveries?.find((delivery) => delivery.watchdogState)?.watchdogState;
  if (watchdogState) {
    const label = WATCHDOG_ATTENTION_LABELS[watchdogState];
    return {
      kind: "background_delivery_watchdog",
      label,
      description: `${label}. Background delivery requires attention before this session can leave Active.`,
      watchdogState,
    };
  }
  return null;
}

/** Safety and authentication work remains discoverable in the ordinary Inbox even while a
 * reminder is pending. Snooze still stays lifecycle-independent and remains visible in its view. */
export function sessionNeedsAttentionWhileSnoozed(session: SessionView): boolean {
  return snoozedSessionAttentionReason(session) !== null;
}

export function sessionVisibleForReminderMode(
  session: SessionView,
  reminder: SessionReminderView | undefined,
  mode: ReminderInboxMode,
): boolean {
  if (session.archived) return false;
  const pending = reminder?.state === "pending";
  if (mode === "snoozed") return pending;
  return !pending || sessionNeedsAttentionWhileSnoozed(session);
}

/** Fired reminders precede every normal inbox item exactly once; their existing activity order is
 * preserved after that stable rank. Pending reminders in the Snoozed view sort by wake time. */
export function sortSessionsForReminders(
  sessions: readonly SessionView[],
  reminders: ReadonlyMap<string, SessionReminderView>,
  mode: ReminderInboxMode,
): SessionView[] {
  return [...sessions].sort((left, right) => {
    const leftReminder = reminders.get(left.id);
    const rightReminder = reminders.get(right.id);
    if (mode === "snoozed") {
      const leftScheduledFor = leftReminder?.scheduledFor;
      const rightScheduledFor = rightReminder?.scheduledFor;
      if (leftScheduledFor === undefined || rightScheduledFor === undefined) return 0;
      return leftScheduledFor - rightScheduledFor;
    }
    const leftFired = leftReminder?.state === "fired";
    const rightFired = rightReminder?.state === "fired";
    if (leftFired !== rightFired) return leftFired ? -1 : 1;
    if (leftFired && rightFired) return (rightReminder?.firedAt ?? 0) - (leftReminder?.firedAt ?? 0);
    return 0;
  });
}

export function reminderBadgeLabel(reminder: SessionReminderView): string {
  if (reminder.state === "pending") return "Snoozed";
  if (reminder.wakeReason !== "scheduled") return "Activity Reminder";
  return "Returned from Snooze";
}

export function reminderBadgeDescription(reminder: SessionReminderView): string {
  const instant = formatReminderInstant(reminder.scheduledFor, reminder.timeZone);
  if (reminder.state === "pending") return `Snoozed until ${instant}.`;
  if (reminder.wakeReason === "scheduled") return `Returned from snooze. Snooze ended ${instant}.`;
  return `Activity reminder scheduled for ${instant}.`;
}

export function reminderMenuActionLabel(reminder?: SessionReminderView): string {
  if (!reminder) return "Snooze Session…";
  return reminder.state === "fired" ? "Snooze Again…" : "Edit Reminder…";
}
