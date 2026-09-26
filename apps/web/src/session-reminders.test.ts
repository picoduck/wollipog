import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import {
  reminderBadgeDescription,
  reminderBadgeLabel,
  reminderMenuActionLabel,
  sessionVisibleForReminderMode,
  snoozedSessionAttentionReason,
  sortSessionsForReminders,
} from "./session-reminders.js";

function session(id: string, status: SessionView["status"] = "idle", overrides: Partial<SessionView> = {}): SessionView {
  return { id, status, archived: false, pendingApproval: null, ...overrides } as SessionView;
}

function reminder(sessionId: string, overrides: Partial<SessionReminderView> = {}): SessionReminderView {
  return {
    reminderId: `rem-${sessionId}`,
    sessionId,
    scheduledFor: 2_000,
    timeZone: "UTC",
    originalExpression: "in 1 hour",
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function somedayReminder(sessionId: string, overrides: Partial<SessionReminderView> = {}): SessionReminderView {
  return {
    reminderId: `rem-${sessionId}`,
    sessionId,
    scheduleKind: "someday",
    originalExpression: "Someday",
    wakePolicy: "regardless",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionReminderView;
}

test("pending reminders make Active and Snoozed mutually exclusive across every attention condition", () => {
  const cases: Array<[string, SessionView, string]> = [
    ["running", session("running", "running"), ""],
    ["legacy input", session("input", "input_required"), "Input Required"],
    ["failure", session("failed", "failed"), "Failed"],
    ["approval", session("approval", "idle", {
      pendingApproval: { requestId: "approval", title: "Run tests?", options: [] },
    }), "Approval Required"],
    ["question", session("question", "idle", {
      pendingApproval: { requestId: "question", title: "Which database?", options: [], kind: "question" },
    }), "Answer Required"],
    ["orphaned background work", session("orphaned", "idle", {
      backgroundWorkState: "orphaned",
    }), "Background Work Orphaned"],
    ["pending result", session("pending-result", "idle", {
      backgroundDeliveries: [{
        parentTurnId: "parent",
        jobCount: 1,
        terminalCount: 1,
        watchdogState: "terminal_without_continuation",
      }],
    }), "Result Pending"],
    ["missing result", session("missing-result", "idle", {
      backgroundDeliveries: [{
        parentTurnId: "parent",
        jobCount: 1,
        terminalCount: 1,
        watchdogState: "accepted_without_result",
      }],
    }), "Result Missing"],
    ["delayed transcript", session("delayed-transcript", "idle", {
      backgroundDeliveries: [{
        parentTurnId: "parent",
        jobCount: 1,
        terminalCount: 1,
        watchdogState: "result_not_projected",
      }],
    }), "Transcript Delayed"],
    ["pending notification", session("pending-notification", "idle", {
      backgroundDeliveries: [{
        parentTurnId: "parent",
        jobCount: 1,
        terminalCount: 1,
        watchdogState: "dashboard_observation_pending",
      }],
    }), "Notification Pending"],
  ];

  for (const wakePolicy of ["until_activity", "regardless"] as const) {
    for (const [name, candidate, label] of cases) {
      const pending = reminder(candidate.id, { wakePolicy });
      assert.equal(sessionVisibleForReminderMode(candidate, pending, "ordinary"), false,
        `${wakePolicy}: ${name} must leave Active`);
      assert.equal(sessionVisibleForReminderMode(candidate, pending, "snoozed"), true,
        `${wakePolicy}: ${name} must remain in Snoozed`);
      assert.equal(snoozedSessionAttentionReason(candidate)?.label ?? "", label,
        `${wakePolicy}: ${name} must preserve its attention reason`);
    }
  }

  const omittedApproval = session("omitted-approval", "idle", { pendingApproval: undefined as never });
  assert.equal(snoozedSessionAttentionReason(omittedApproval), null);
  assert.equal(sessionVisibleForReminderMode(omittedApproval, reminder(omittedApproval.id), "ordinary"), false,
    "a legacy omitted pendingApproval is absence, not an attention condition");
  assert.equal(sessionVisibleForReminderMode(omittedApproval, reminder(omittedApproval.id), "snoozed"), true);
});

test("snoozed attention uses the shared delivery-watchdog presentation", () => {
  const cases = [
    ["terminal_without_continuation", "Result Pending", "pending", /returning the result automatically.*No action is needed/s],
    ["continuation_blocked", "Result Blocked", "blocked", /ends that job itself only when a queued handoff has waited on it past its bound.*stop the unfinished job/s],
    ["accepted_without_result", "Result Missing", "missing", /will not repeat.*Acknowledge the missing result/s],
    ["result_not_projected", "Transcript Delayed", "pending", /updating the transcript automatically.*No action is needed/s],
    ["dashboard_observation_pending", "Notification Pending", "pending", /waiting for the dashboard confirmation.*No action is needed/s],
  ] as const;
  for (const [watchdogState, label, severity, description] of cases) {
    const reason = snoozedSessionAttentionReason(session(watchdogState, "idle", {
      backgroundDeliveries: [{
        parentTurnId: "parent",
        jobCount: 1,
        terminalCount: 1,
        watchdogState,
      }],
    }));
    assert.equal(reason?.label, label);
    assert.equal(reason?.severity, severity);
    assert.match(reason?.accessibleName ?? "", new RegExp(`^Background Work: ${label}\\.`));
    assert.match(reason?.description ?? "", description);
  }
});

test("attention changes never reintroduce a pending snooze into Active", () => {
  const pending = reminder("transition");
  const retained = session("transition", "idle", { backgroundWorkState: "orphaned" });
  assert.equal(sessionVisibleForReminderMode(retained, pending, "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode({ ...retained, backgroundWorkState: "resumed" }, pending, "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode({ ...retained, backgroundWorkState: undefined }, pending, "ordinary"), false);

  const missing = session("transition", "idle", {
    backgroundDeliveries: [{
      continuationId: "bgcont-missing",
      parentTurnId: "turn-1",
      jobCount: 1,
      terminalCount: 1,
      acceptedAt: 10,
      missingResultAt: 20,
      watchdogState: "accepted_without_result",
    }],
  });
  assert.equal(sessionVisibleForReminderMode(missing, pending, "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode(missing, pending, "snoozed"), true);
  const acknowledged = {
    ...missing,
    backgroundDeliveries: missing.backgroundDeliveries?.map(({ watchdogState: _watchdog, ...delivery }) => ({
      ...delivery,
      missingResultAcknowledgedAt: 30,
    })),
  };
  assert.equal(sessionVisibleForReminderMode(acknowledged, pending, "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode(acknowledged, pending, "snoozed"), true);
});

test("archived sessions do not appear in either reminder view", () => {
  const archived = session("archived", "idle", { archived: true });
  assert.equal(sessionVisibleForReminderMode(archived, reminder("archived"), "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode(archived, reminder("archived"), "snoozed"), false);
});

test("Someday stays in Snoozed with a no-timer label and sorts after timed reminders", () => {
  const timedEarly = session("timed-early");
  const someday = session("someday", "input_required");
  const timedLate = session("timed-late");
  const reminders = new Map<string, SessionReminderView>([
    [timedEarly.id, reminder(timedEarly.id, { scheduledFor: 1_000 })],
    [someday.id, somedayReminder(someday.id)],
    [timedLate.id, reminder(timedLate.id, { scheduledFor: 3_000 })],
  ]);

  assert.equal(sessionVisibleForReminderMode(someday, reminders.get(someday.id), "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode(someday, reminders.get(someday.id), "snoozed"), true);
  assert.equal(reminderBadgeLabel(reminders.get(someday.id)!), "Someday");
  assert.equal(reminderBadgeDescription(reminders.get(someday.id)!), "Snoozed Someday with no automatic return time.");
  assert.doesNotMatch(reminderBadgeDescription(reminders.get(someday.id)!), /1970|scheduled for|until/i);
  assert.deepEqual(
    sortSessionsForReminders([someday, timedLate, timedEarly], reminders, "snoozed").map(({ id }) => id),
    ["timed-early", "timed-late", "someday"],
  );
});

test("fired reminders return to the top with a text-backed reason until dismissed", () => {
  const normal = session("normal");
  const due = session("due", "input_required");
  const fired = reminder("due", { state: "fired", wakeReason: "scheduled", firedAt: 2_000 });
  const reminders = new Map([["due", fired]]);
  assert.equal(sessionVisibleForReminderMode(due, fired, "ordinary"), true);
  assert.equal(sessionVisibleForReminderMode(due, fired, "snoozed"), false);
  assert.equal(snoozedSessionAttentionReason(due)?.label, "Input Required",
    "firing a reminder must not clear unresolved state");
  const activityFired = { ...fired, wakePolicy: "until_activity", wakeReason: "agent_response" } as const;
  assert.equal(sessionVisibleForReminderMode(due, activityFired, "ordinary"), true);
  assert.equal(sessionVisibleForReminderMode(due, activityFired, "snoozed"), false);
  assert.deepEqual(sortSessionsForReminders([normal, due], reminders, "ordinary").map(({ id }) => id), ["due", "normal"]);
  assert.equal(reminderBadgeLabel(fired), "Returned from Snooze");
  assert.match(reminderBadgeDescription(fired), /Returned from snooze\. Snooze ended/);
  assert.equal(reminderBadgeLabel({ ...fired, wakeReason: "agent_response" }), "Activity Reminder");
  assert.equal(reminderMenuActionLabel(), "Snooze Session…");
  assert.equal(reminderMenuActionLabel(reminder("pending")), "Edit Reminder…");
  assert.equal(reminderMenuActionLabel(fired), "Snooze Again…");
});
