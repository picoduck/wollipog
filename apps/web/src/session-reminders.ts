import type { SessionReminderView, SessionView } from "@wollipog/protocol";

export type ReminderInboxMode = "ordinary" | "snoozed";

/** Safety and authentication work remains discoverable in the ordinary Inbox even while a
 * reminder is pending. Snooze still stays lifecycle-independent and remains visible in its view. */
export function sessionNeedsAttentionWhileSnoozed(session: SessionView): boolean {
  return ["input_required", "failed"].includes(session.status) ||
    session.pendingApproval !== null || session.backgroundWorkState === "orphaned" ||
    Boolean(session.backgroundDeliveries?.some((delivery) => delivery.watchdogState));
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
      return (leftReminder?.scheduledFor ?? Number.POSITIVE_INFINITY) -
        (rightReminder?.scheduledFor ?? Number.POSITIVE_INFINITY);
    }
    const leftFired = leftReminder?.state === "fired";
    const rightFired = rightReminder?.state === "fired";
    if (leftFired !== rightFired) return leftFired ? -1 : 1;
    if (leftFired && rightFired) return (rightReminder?.firedAt ?? 0) - (leftReminder?.firedAt ?? 0);
    return 0;
  });
}

export function reminderBadgeLabel(reminder: SessionReminderView, now = Date.now()): string {
  if (reminder.state === "pending") return "Snoozed";
  if (reminder.wakeReason !== "scheduled") return "Activity Reminder";
  return now - reminder.scheduledFor >= 60_000 ? "Overdue" : "Reminder Due";
}
