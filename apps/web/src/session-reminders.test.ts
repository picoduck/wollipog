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

test("pending reminders hide ordinary active work but never hide required attention", () => {
  const pending = reminder("running");
  assert.equal(sessionVisibleForReminderMode(session("running", "running"), pending, "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode(session("running", "running"), pending, "snoozed"), true);
  assert.equal(sessionVisibleForReminderMode(session("blocked", "input_required"), reminder("blocked"), "ordinary"), true);
  assert.equal(sessionVisibleForReminderMode(session("failed", "failed"), reminder("failed"), "ordinary"), true);
});

test("only explicit attention reasons retain a snoozed session in Active", () => {
  const cases: Array<[string, SessionView, string]> = [
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
    ["delivery watchdog", session("watchdog", "idle", {
      backgroundDeliveries: [{
        deliveryId: "delivery",
        continuationId: "continuation",
        watchdogState: "terminal_without_continuation",
      } as never],
    }), "Continuation Required"],
  ];

  for (const [name, candidate, label] of cases) {
    assert.equal(sessionVisibleForReminderMode(candidate, reminder(candidate.id), "ordinary"), true, name);
    assert.equal(snoozedSessionAttentionReason(candidate)?.label, label, name);
  }

  const omittedApproval = session("omitted-approval", "idle", { pendingApproval: undefined as never });
  assert.equal(snoozedSessionAttentionReason(omittedApproval), null);
  assert.equal(sessionVisibleForReminderMode(omittedApproval, reminder(omittedApproval.id), "ordinary"), false,
    "a legacy omitted pendingApproval is absence, not an attention condition");
});

test("clearing the final attention condition removes a still-snoozed session from Active", () => {
  const pending = reminder("transition");
  const retained = session("transition", "idle", { backgroundWorkState: "orphaned" });
  assert.equal(sessionVisibleForReminderMode(retained, pending, "ordinary"), true);
  assert.equal(sessionVisibleForReminderMode({ ...retained, backgroundWorkState: "resumed" }, pending, "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode({ ...retained, backgroundWorkState: undefined }, pending, "ordinary"), false);
});

test("archived sessions do not appear in either reminder view", () => {
  const archived = session("archived", "idle", { archived: true });
  assert.equal(sessionVisibleForReminderMode(archived, reminder("archived"), "ordinary"), false);
  assert.equal(sessionVisibleForReminderMode(archived, reminder("archived"), "snoozed"), false);
});

test("fired reminders return to the top with a text-backed reason until dismissed", () => {
  const normal = session("normal");
  const due = session("due");
  const fired = reminder("due", { state: "fired", wakeReason: "scheduled", firedAt: 2_000 });
  const reminders = new Map([["due", fired]]);
  assert.deepEqual(sortSessionsForReminders([normal, due], reminders, "ordinary").map(({ id }) => id), ["due", "normal"]);
  assert.equal(reminderBadgeLabel(fired), "Returned from Snooze");
  assert.match(reminderBadgeDescription(fired), /Returned from snooze\. Snooze ended/);
  assert.equal(reminderBadgeLabel({ ...fired, wakeReason: "agent_response" }), "Activity Reminder");
  assert.equal(reminderMenuActionLabel(), "Snooze Session…");
  assert.equal(reminderMenuActionLabel(reminder("pending")), "Edit Reminder…");
  assert.equal(reminderMenuActionLabel(fired), "Snooze Again…");
});
