import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "./identity.js";

function fixture(location = ":memory:"): ControlPlaneDb {
  const db = ControlPlaneDb.open(location);
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

test("rescheduling atomically replaces the exact fired state with one pending reminder", () => {
  const db = fixture();
  const created = db.setSessionReminder({ ...schedule, expectedRevision: 0 });
  assert.equal(created.kind, "updated");
  const [fired] = db.fireDueSessionReminders(schedule.scheduledFor + 1);
  assert.ok(fired);

  const stale = db.setSessionReminder({
    ...schedule,
    scheduledFor: 200_000,
    expectedRevision: fired.reminder.revision - 1,
    expectedReminderId: fired.reminder.reminderId,
    rescheduleFired: true,
    now: schedule.scheduledFor + 2,
  });
  assert.equal(stale.kind, "conflict");
  assert.deepEqual(db.getSessionReminder("session-1", LOCAL_OWNER_USER_ID), fired.reminder,
    "a failed replacement leaves the fired reminder intact");

  const replaced = db.setSessionReminder({
    ...schedule,
    scheduledFor: 200_000,
    originalExpression: "in one day",
    expectedRevision: fired.reminder.revision,
    expectedReminderId: fired.reminder.reminderId,
    rescheduleFired: true,
    now: schedule.scheduledFor + 2,
  });
  assert.equal(replaced.kind, "updated");
  if (replaced.kind !== "updated") throw new Error("fired reminder was not replaced");
  assert.equal(replaced.reminder.state, "pending");
  assert.equal(replaced.reminder.reminderId, fired.reminder.reminderId);
  assert.equal(replaced.reminder.firedAt, undefined);
  assert.equal(replaced.reminder.wakeReason, undefined);
  assert.equal(db.listSessionReminders(LOCAL_OWNER_USER_ID).length, 1);
  db.close();
});

test("explicit rescheduling resets an activity-fired reminder at the same instant and rejects pending state", () => {
  const db = fixture();
  const futureSchedule = { ...schedule, scheduledFor: 200_000 };
  assert.equal(db.setSessionReminder({ ...futureSchedule, expectedRevision: 0 }).kind, "updated");
  const [fired] = db.fireSessionRemindersForActivity("session-1", 1, "agent_response", 20);
  assert.ok(fired);
  assert.equal(fired.reminder.state, "fired");

  const replaced = db.setSessionReminder({
    ...futureSchedule,
    expectedRevision: fired.reminder.revision,
    expectedReminderId: fired.reminder.reminderId,
    rescheduleFired: true,
    now: 30,
  });
  assert.equal(replaced.kind, "updated");
  if (replaced.kind !== "updated") throw new Error("activity-fired reminder was not replaced");
  assert.equal(replaced.reminder.state, "pending",
    "explicit intent must reset fired state even when the selected instant is unchanged");

  const pendingReplacement = db.setSessionReminder({
    ...futureSchedule,
    scheduledFor: 300_000,
    expectedRevision: replaced.reminder.revision,
    expectedReminderId: replaced.reminder.reminderId,
    rescheduleFired: true,
    now: 40,
  });
  assert.equal(pendingReplacement.kind, "conflict");
  assert.deepEqual(db.getSessionReminder("session-1", LOCAL_OWNER_USER_ID), replaced.reminder,
    "a matching pending reminder is still not a valid Snooze Again target");
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

test("Someday persists without a timer and can be rescheduled atomically", () => {
  const db = fixture();
  const created = db.setSessionReminder({
    sessionId: "session-1",
    userId: LOCAL_OWNER_USER_ID,
    scheduleKind: "someday",
    originalExpression: "Someday",
    wakePolicy: "regardless",
    expectedRevision: 0,
    now: 10,
  });
  assert.equal(created.kind, "updated");
  if (created.kind !== "updated") throw new Error("Someday reminder was not created");
  assert.equal(created.reminder.scheduleKind, "someday");
  assert.equal("scheduledFor" in created.reminder, false);
  assert.equal("timeZone" in created.reminder, false);
  assert.deepEqual(
    { ...db.raw().prepare(
      "SELECT schedule_kind,scheduled_for,time_zone FROM session_reminders WHERE session_id=? AND user_id=?",
    ).get("session-1", LOCAL_OWNER_USER_ID) },
    { schedule_kind: "someday", scheduled_for: null, time_zone: null },
  );
  assert.equal(db.fireDueSessionReminders(Number.MAX_SAFE_INTEGER).length, 0,
    "an indefinite reminder never enters the timer sweep");

  const rescheduled = db.setSessionReminder({
    ...schedule,
    scheduledFor: 200_000,
    expectedRevision: created.reminder.revision,
    expectedReminderId: created.reminder.reminderId,
    now: 20,
  });
  assert.equal(rescheduled.kind, "updated");
  if (rescheduled.kind !== "updated") throw new Error("Someday reminder was not rescheduled");
  assert.equal(rescheduled.reminder.scheduleKind, "timed");
  assert.equal(rescheduled.reminder.scheduledFor, 200_000);
  assert.equal(rescheduled.reminder.reminderId, created.reminder.reminderId);
  db.close();
});

test("Someday follows the existing activity wake policy without gaining a timer", () => {
  const db = fixture();
  const input = {
    sessionId: "session-1",
    userId: LOCAL_OWNER_USER_ID,
    scheduleKind: "someday" as const,
    originalExpression: "Someday",
    wakePolicy: "until_activity" as const,
    expectedRevision: 0,
    now: 10,
  };
  assert.equal(db.setSessionReminder(input).kind, "updated");
  const [fired] = db.fireSessionRemindersForActivity("session-1", 1, "agent_response", 20);
  assert.equal(fired?.reminder.scheduleKind, "someday");
  assert.equal(fired?.reminder.wakeReason, "agent_response");
  assert.equal(db.fireDueSessionReminders(Number.MAX_SAFE_INTEGER).length, 0);
  db.close();
});

test("Someday survives restart and file-level backup restore", () => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-someday-reminder-"));
  const database = join(directory, "control-plane.sqlite");
  const backup = join(directory, "restored.sqlite");
  try {
    const db = fixture(database);
    assert.equal(db.setSessionReminder({
      sessionId: "session-1",
      userId: LOCAL_OWNER_USER_ID,
      scheduleKind: "someday",
      originalExpression: "Someday",
      wakePolicy: "regardless",
      expectedRevision: 0,
      now: 10,
    }).kind, "updated");
    db.close();

    copyFileSync(database, backup);
    const restored = ControlPlaneDb.open(backup);
    assert.equal(restored.getSessionReminder("session-1", LOCAL_OWNER_USER_ID)?.scheduleKind, "someday");
    assert.equal(restored.fireDueSessionReminders(Number.MAX_SAFE_INTEGER).length, 0);
    restored.deleteSession("session-1");
    assert.equal(restored.getSessionReminder("session-1", LOCAL_OWNER_USER_ID), null,
      "restored databases retain reminder cascade cleanup");
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opening a pre-v173 database migrates timed reminders without changing their identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-reminder-migration-"));
  const database = join(directory, "control-plane.sqlite");
  try {
    const db = fixture(database);
    const created = db.setSessionReminder({ ...schedule, expectedRevision: 0 });
    assert.equal(created.kind, "updated");
    if (created.kind !== "updated") throw new Error("timed reminder was not created");
    db.raw().exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP INDEX idx_session_reminders_due;
      CREATE TABLE session_reminders_legacy (
        reminder_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        original_expression TEXT NOT NULL,
        wake_policy TEXT NOT NULL CHECK (wake_policy IN ('until_activity','regardless')),
        state TEXT NOT NULL CHECK (state IN ('pending','fired')),
        revision INTEGER NOT NULL,
        baseline_event_seq INTEGER NOT NULL DEFAULT 0,
        wake_reason TEXT,
        fired_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE
      );
      INSERT INTO session_reminders_legacy
        (reminder_id,session_id,user_id,scheduled_for,time_zone,original_expression,
         wake_policy,state,revision,baseline_event_seq,wake_reason,fired_at,created_at,updated_at)
        SELECT reminder_id,session_id,user_id,scheduled_for,time_zone,original_expression,
               wake_policy,state,revision,baseline_event_seq,wake_reason,fired_at,created_at,updated_at
        FROM session_reminders;
      DROP TABLE session_reminders;
      ALTER TABLE session_reminders_legacy RENAME TO session_reminders;
      CREATE INDEX idx_session_reminders_due
        ON session_reminders(state, scheduled_for, session_id, user_id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    db.close();

    const migrated = ControlPlaneDb.open(database);
    const reminder = migrated.getSessionReminder("session-1", LOCAL_OWNER_USER_ID);
    assert.equal(reminder?.scheduleKind, "timed");
    assert.equal(reminder?.reminderId, created.reminder.reminderId);
    assert.equal(reminder?.scheduledFor, schedule.scheduledFor);
    assert.equal(reminder?.timeZone, schedule.timeZone);
    assert.equal(
      migrated.raw().prepare("PRAGMA table_info(session_reminders)").all()
        .some((column) => (column as { name: string }).name === "schedule_kind"),
      true,
    );
    assert.deepEqual(migrated.raw().prepare("PRAGMA foreign_key_check").all(), []);
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
