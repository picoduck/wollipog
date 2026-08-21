import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView } from "@wollipog/protocol";
import { exactReminderSchedule, parseReminderExpression, storedReminderSchedule } from "./reminder-schedule.js";

test("natural reminder expressions reject an explicitly past Today time", () => {
  const now = new Date(2026, 7, 21, 15, 0, 0, 0);
  assert.equal(parseReminderExpression("today at 2 pm", now, "America/Chicago"), null);
  assert.ok(parseReminderExpression("tomorrow at 2 pm", now, "America/Chicago"));
});

test("relative days are exact elapsed 24-hour periods", () => {
  const now = new Date("2026-03-08T07:30:00.000Z");
  const parsed = parseReminderExpression("in 1 day", now, "America/Chicago");
  assert.equal(parsed?.scheduledFor - now.getTime(), 86_400_000);
});

test("exact inputs reject past instants and ambiguous free-form dates", () => {
  assert.equal(exactReminderSchedule("2026-08-20T09:00", "UTC", Date.UTC(2026, 7, 21)), null);
  assert.equal(parseReminderExpression("08/22/2026", new Date(2026, 7, 21)), null);
});

test("editing preserves the authoritative stored instant and time zone", () => {
  const reminder = {
    scheduledFor: Date.UTC(2026, 10, 1, 6, 30),
    timeZone: "America/New_York",
    originalExpression: "2026-11-01T01:30",
  } as SessionReminderView;
  assert.deepEqual(storedReminderSchedule(reminder), {
    scheduledFor: reminder.scheduledFor,
    timeZone: "America/New_York",
    originalExpression: "2026-11-01T01:30",
  });
});
