import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import {
  reminderBadgeLabel,
  sessionVisibleForReminderMode,
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
  assert.equal(reminderBadgeLabel(fired, 2_030), "Reminder Due");
  assert.equal(reminderBadgeLabel({ ...fired, wakeReason: "agent_response" }), "Activity Reminder");
});
