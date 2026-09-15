import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView } from "@wollipog/protocol";
import {
  exactReminderSchedule,
  parseReminderExpression,
  storedReminderSchedule,
  suggestReminderExpressions,
} from "./reminder-schedule.js";

test("natural reminder expressions reject an explicitly past Today time", () => {
  const now = new Date(2026, 7, 21, 15, 0, 0, 0);
  assert.equal(parseReminderExpression("today at 2 pm", now), null);
  assert.ok(parseReminderExpression("tomorrow at 2 pm", now));
});

test("relative days are exact elapsed 24-hour periods", () => {
  const now = new Date("2026-03-08T07:30:00.000Z");
  const parsed = parseReminderExpression("in 1 day", now);
  assert.equal(parsed?.scheduledFor - now.getTime(), 86_400_000);
});

test("exact inputs reject past instants and ambiguous free-form dates", () => {
  assert.equal(exactReminderSchedule("2026-08-20T09:00", Date.UTC(2026, 7, 21)), null);
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

test("reminder suggestions complete common partials and are all accepted by the parser", () => {
  const now = new Date(2026, 7, 21, 10, 0, 0, 0);
  const relative = suggestReminderExpressions("in 23", now);
  assert.deepEqual(relative.map((suggestion) => suggestion.originalExpression), [
    "In 23 Minutes",
    "In 23 Hours",
    "In 23 Days",
  ]);

  const clock = suggestReminderExpressions("tomorrow at 3:30", now);
  assert.deepEqual(clock.map((suggestion) => suggestion.originalExpression), [
    "Tomorrow at 3:30 PM",
    "Tomorrow at 3:30 AM",
  ]);

  for (const suggestion of [...relative, ...clock, ...suggestReminderExpressions("tom", now)]) {
    assert.ok(parseReminderExpression(suggestion.originalExpression, now),
      `${suggestion.originalExpression} must remain inside the authoritative grammar`);
  }
  assert.deepEqual(suggestReminderExpressions("In 2 Hours", now), [],
    "a complete valid expression should release Enter back to form submission");
  assert.deepEqual(suggestReminderExpressions("", now), []);
});
