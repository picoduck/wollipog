import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "./identity.js";

function fixture(): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.raw().prepare(
    "INSERT INTO runners (runner_id,hostname,os,version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("runner-1", "host", "linux", "test", "online", 1, 1);
  db.createSession({
    id: "session-1",
    runnerId: "runner-1",
    workspaceId: null,
    agentId: "agent-1",
    title: "Reminder Test",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 1,
    scope: {
      organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "user", userId: LOCAL_OWNER_USER_ID },
    },
  });
  return db;
}

const schedule = {
  sessionId: "session-1",
  userId: LOCAL_OWNER_USER_ID,
  scheduledFor: 100_000,
  timeZone: "America/Chicago",
  originalExpression: "in 1 hour",
  wakePolicy: "until_activity" as const,
  now: 10,
};

test("reminder create, edit, and remove use optimistic revisions", () => {
  const db = fixture();
  const created = db.setSessionReminder({ ...schedule, expectedRevision: 0 });
  assert.equal(created.kind, "updated");
  assert.equal(db.setSessionReminder({ ...schedule, scheduledFor: 200_000, expectedRevision: 0 }).kind, "conflict");
  assert.equal(db.setSessionReminder({ ...schedule, scheduledFor: 200_000, expectedRevision: 99 }).kind, "conflict");
  assert.equal(db.removeSessionReminder("session-1", LOCAL_OWNER_USER_ID, 99).kind, "conflict");
  assert.equal(db.removeSessionReminder("session-1", LOCAL_OWNER_USER_ID, 1).kind, "removed");
  db.close();
});

test("reminder identity rejects stale edits and removals after recreation at the same revision", () => {
  const db = fixture();
  const created = db.setSessionReminder({ ...schedule, expectedRevision: 0 });
  assert.equal(created.kind, "updated");
  if (created.kind !== "updated") throw new Error("reminder was not created");
  assert.equal(db.removeSessionReminder(
    "session-1",
    LOCAL_OWNER_USER_ID,
    created.reminder.revision,
    created.reminder.reminderId,
  ).kind, "removed");

  const recreated = db.setSessionReminder({ ...schedule, expectedRevision: 0, now: 20 });
  assert.equal(recreated.kind, "updated");
  if (recreated.kind !== "updated") throw new Error("reminder was not recreated");
  assert.equal(recreated.reminder.revision, created.reminder.revision);
  assert.notEqual(recreated.reminder.reminderId, created.reminder.reminderId);

  assert.equal(db.setSessionReminder({
    ...schedule,
    scheduledFor: 200_000,
    expectedRevision: created.reminder.revision,
    expectedReminderId: created.reminder.reminderId,
  }).kind, "conflict");
  assert.equal(db.removeSessionReminder(
    "session-1",
    LOCAL_OWNER_USER_ID,
    created.reminder.revision,
    created.reminder.reminderId,
  ).kind, "conflict");
  assert.equal(db.getSessionReminder("session-1", LOCAL_OWNER_USER_ID)?.reminderId, recreated.reminder.reminderId);
  db.close();
});

test("duplicate and reconnect-replayed activity evidence fires once after the baseline", () => {
  const db = fixture();
  db.appendEvent("session-1", { kind: "agent_message", text: "one" }, 1);
  db.appendEvent("session-1", { kind: "agent_message", text: "two" }, 2);
  db.raw().prepare("UPDATE sessions SET hydrated_seq=999 WHERE id=?").run("session-1");
  assert.equal(db.setSessionReminder({ ...schedule, expectedRevision: 0 }).kind, "updated");
  const stored = db.raw().prepare(
    "SELECT baseline_event_seq FROM session_reminders WHERE session_id=? AND user_id=?",
  ).get("session-1", LOCAL_OWNER_USER_ID) as unknown as { baseline_event_seq: number };
  assert.equal(stored.baseline_event_seq, 2);
  assert.equal(db.fireSessionRemindersForActivity("session-1", 2, "agent_response", 20).length, 0);
  const third = db.appendEvent("session-1", { kind: "agent_message", text: "three" }, 3);
  assert.equal(third.seq, 3);
  assert.equal(db.fireSessionRemindersForActivity("session-1", third.seq, "agent_response", 20).length, 1);
  assert.equal(db.fireSessionRemindersForActivity("session-1", third.seq, "agent_response", 20).length, 0);
  assert.equal(db.fireSessionRemindersForActivity("session-1", third.seq + 1, "agent_response", 21).length, 0);
  db.close();
});

test("overdue reminders fire exactly once after a delayed sweep", () => {
  const db = fixture();
  assert.equal(db.setSessionReminder({ ...schedule, wakePolicy: "regardless", expectedRevision: 0 }).kind, "updated");
  assert.equal(db.fireDueSessionReminders(schedule.scheduledFor - 1).length, 0);
  const fired = db.fireDueSessionReminders(schedule.scheduledFor + 60_000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.reminder.state, "fired");
  assert.equal(fired[0]?.reminder.wakeReason, "scheduled");
  assert.equal(fired[0]?.reminder.firedAt, schedule.scheduledFor + 60_000);
  assert.equal(db.fireDueSessionReminders(schedule.scheduledFor + 120_000).length, 0);
  db.close();
});

test("archived reminders stay pending until the session is restored", () => {
  const db = fixture();
  assert.equal(db.setSessionReminder({ ...schedule, expectedRevision: 0 }).kind, "updated");
  db.setSessionArchived("session-1", true, schedule.scheduledFor - 1);
  assert.equal(db.fireDueSessionReminders(schedule.scheduledFor + 1).length, 0);
  assert.equal(db.getSessionReminder("session-1", LOCAL_OWNER_USER_ID)?.state, "pending");
  assert.equal(db.fireSessionRemindersForActivity("session-1", 1, "agent_response", schedule.scheduledFor + 2).length, 0);

  db.setSessionArchived("session-1", false, schedule.scheduledFor + 3);
  const fired = db.fireDueSessionReminders(schedule.scheduledFor + 4);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.reminder.state, "fired");
  db.close();
});

test("deleting a session cascades its per-user reminder", () => {
  const db = fixture();
  assert.equal(db.setSessionReminder({ ...schedule, expectedRevision: 0 }).kind, "updated");
  assert.equal(db.listSessionReminders(LOCAL_OWNER_USER_ID).length, 1);
  db.deleteSession("session-1");
  assert.equal(db.listSessionReminders(LOCAL_OWNER_USER_ID).length, 0);
  db.close();
});
