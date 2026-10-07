import {
  sessionAttentionStatus,
  type BackgroundDeliveryWatchdogState,
  type SessionAttentionStatus,
  type SessionReminderView,
  type SessionView,
} from "@wollipog/protocol";
import { formatReminderInstant, reminderDisplayZone } from "./reminder-schedule.js";
import { sortInboxSessions } from "./inbox.js";
import { sessionFollowUp } from "./session-follow-up.js";
import {
  BACKGROUND_DELIVERY_STATUS,
  backgroundDeliveryAccessibleName,
  backgroundDeliveryAttentionDescription,
  shownWatchdogDelivery,
  type BackgroundDeliverySeverity,
} from "./background-delivery-status.js";

export type ReminderInboxMode = "ordinary" | "snoozed";

export type SnoozedAttentionReason =
  | { kind: "session_attention"; label: string; description: string; attention: SessionAttentionStatus }
  | { kind: "failed"; label: "Failed"; description: string }
  | { kind: "orphaned_background_work"; label: "Background Work Lost"; description: string }
  | {
    kind: "background_delivery_watchdog";
    label: string;
    description: string;
    accessibleName: string;
    severity: BackgroundDeliverySeverity;
    watchdogState: BackgroundDeliveryWatchdogState;
  };

/** One canonical explanation for attention that remains visible with a snoozed session. */
export function snoozedSessionAttentionReason(session: SessionView): SnoozedAttentionReason | null {
  // Older or partial snapshots may omit pendingApproval even though current SessionView requires
  // null. `undefined !== null` used to retain an otherwise-idle snoozed session with no reason.
  const attention = sessionAttentionStatus({
    status: session.status,
    pendingApproval: session.pendingApproval ?? null,
    pendingRequestOwners: session.pendingRequestOwners,
    orchestratorCampaign: session.orchestratorCampaign,
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
      label: "Background Work Lost",
      description: "Managed background work was lost and requires attention.",
    };
  }
  const watchdogState = shownWatchdogDelivery(session.backgroundDeliveries)?.watchdogState;
  if (watchdogState) {
    const status = BACKGROUND_DELIVERY_STATUS[watchdogState];
    return {
      kind: "background_delivery_watchdog",
      label: status.label,
      description: backgroundDeliveryAttentionDescription(watchdogState),
      accessibleName: backgroundDeliveryAccessibleName(watchdogState),
      severity: status.severity,
      watchdogState,
    };
  }
  return null;
}

export function sessionVisibleForReminderMode(
  session: SessionView,
  reminder: SessionReminderView | undefined,
  mode: ReminderInboxMode,
): boolean {
  if (session.archived) return false;
  const pending = reminder?.state === "pending";
  if (mode === "snoozed") return pending;
  return !pending;
}

/** Fired reminders precede every normal inbox item exactly once; their existing activity order is
 * preserved after that stable rank. Pending reminders in the Snoozed view sort by wake time. */
export function sortSessionsForReminders(
  sessions: readonly SessionView[],
  reminders: ReadonlyMap<string, SessionReminderView>,
  mode: ReminderInboxMode,
  pins: ReadonlySet<string> = new Set(),
): SessionView[] {
  if (mode === "ordinary") {
    const original = new Map(sessions.map((session) => [session.id, session]));
    const withDueFollowUp = sessions.map((session) => {
      const reminder = reminders.get(session.id);
      return reminder?.state === "fired" && sessionFollowUp(session).priority < 2
        ? { ...session, attention: { version: 1 as const, humanActions: session.attention?.humanActions ?? [],
            meaningfulAt: session.attention?.meaningfulAt ?? session.createdAt,
            result: { revision: "reminder", at: reminder.firedAt ?? session.createdAt, owner: "human" as const },
            acknowledgedRevision: null } } : session;
    });
    return sortInboxSessions(withDueFollowUp, pins).map((session) => original.get(session.id)!);
  }
  return [...sessions].sort((left, right) => {
    const leftReminder = reminders.get(left.id);
    const rightReminder = reminders.get(right.id);
    const leftSomeday = leftReminder?.scheduleKind === "someday";
    const rightSomeday = rightReminder?.scheduleKind === "someday";
    if (leftSomeday !== rightSomeday) return leftSomeday ? 1 : -1;
    const leftScheduledFor = leftReminder?.scheduledFor;
    const rightScheduledFor = rightReminder?.scheduledFor;
    if (leftScheduledFor === undefined || rightScheduledFor === undefined) return 0;
    return leftScheduledFor - rightScheduledFor;
  });
}

export function reminderBadgeLabel(reminder: SessionReminderView): string {
  if (reminder.state === "pending") return reminder.scheduleKind === "someday" ? "Someday" : "Snoozed";
  if (reminder.wakeReason !== "scheduled") return "Activity Reminder";
  return "Returned from Snooze";
}

export function reminderBadgeDescription(reminder: SessionReminderView): string {
  if (reminder.scheduleKind === "someday") {
    if (reminder.state === "pending") return "Snoozed Someday with no automatic return time.";
    return "Activity returned this session from a Someday snooze.";
  }
  const instant = formatReminderInstant(reminder.scheduledFor, reminderDisplayZone());
  if (reminder.state === "pending") return `Snoozed until ${instant}.`;
  if (reminder.wakeReason === "scheduled") return `Returned from snooze. Snooze ended ${instant}.`;
  return `Activity reminder scheduled for ${instant}.`;
}

export function reminderMenuActionLabel(reminder?: SessionReminderView): string {
  if (!reminder) return "Snooze…";
  return reminder.state === "fired" ? "Snooze Again…" : "Change Reminder…";
}
