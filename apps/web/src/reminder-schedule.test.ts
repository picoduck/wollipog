import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView } from "@wollipog/protocol";
import {
  exactReminderSchedule,
  parseReminderExpression,
  storedReminderSchedule,
  suggestReminderExpressions,
} from "./reminder-schedule.js";

function withTimeZone<T>(timeZone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

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

test("weekday names, abbreviations, dayparts, and clocks resolve to the next future occurrence", () => {
  withTimeZone("America/Chicago", () => {
    const beforeWednesdayMorning = new Date("2026-08-19T13:30:00.000Z");
    assert.equal(
      parseReminderExpression("Wednesday", beforeWednesdayMorning)?.scheduledFor,
      Date.parse("2026-08-19T14:00:00.000Z"),
    );
    assert.equal(
      parseReminderExpression("wEd", new Date("2026-08-19T15:00:00.000Z"))?.scheduledFor,
      Date.parse("2026-08-26T14:00:00.000Z"),
      "a same-day default time that passed rolls to the following week",
    );
    assert.equal(
      parseReminderExpression("Fri Afternoon", beforeWednesdayMorning)?.scheduledFor,
      Date.parse("2026-08-21T18:00:00.000Z"),
    );
    assert.equal(
      parseReminderExpression("monday evening", beforeWednesdayMorning)?.scheduledFor,
      Date.parse("2026-08-24T23:00:00.000Z"),
    );
    assert.equal(
      parseReminderExpression("THU at 3:30 PM", beforeWednesdayMorning)?.scheduledFor,
      Date.parse("2026-08-20T20:30:00.000Z"),
    );
    assert.equal(
      parseReminderExpression("Thursday 15:30", beforeWednesdayMorning)?.scheduledFor,
      Date.parse("2026-08-20T20:30:00.000Z"),
    );
  });
});

test("calendar-relative expressions use local calendar boundaries", () => {
  withTimeZone("America/New_York", () => {
    const fridayBeforeDst = new Date("2026-03-06T15:00:00.000Z");
    assert.equal(
      parseReminderExpression("This Weekend", fridayBeforeDst)?.scheduledFor,
      Date.parse("2026-03-07T14:00:00.000Z"),
    );
    assert.equal(
      parseReminderExpression("Next Week", fridayBeforeDst)?.scheduledFor,
      Date.parse("2026-03-09T13:00:00.000Z"),
      "next Monday remains 9 AM after the DST boundary rather than adding fixed hours",
    );
    assert.equal(
      parseReminderExpression("Next Month", new Date("2027-12-31T17:00:00.000Z"))?.scheduledFor,
      Date.parse("2028-01-01T14:00:00.000Z"),
    );
    assert.equal(
      parseReminderExpression("Next Month", new Date("2028-02-29T17:00:00.000Z"))?.scheduledFor,
      Date.parse("2028-03-01T14:00:00.000Z"),
      "leap day advances to the first day of March",
    );
  });
});

test("weekday clocks skip nonexistent DST times and select a still-future repeated time", () => {
  withTimeZone("America/New_York", () => {
    assert.equal(
      parseReminderExpression("Sunday at 2:30 AM", new Date("2026-03-07T17:00:00.000Z"))?.scheduledFor,
      Date.parse("2026-03-15T06:30:00.000Z"),
      "the spring-forward Sunday has no 2:30 AM occurrence",
    );
    assert.equal(
      parseReminderExpression("Sunday at 1:30 AM", new Date("2026-11-01T05:45:00.000Z"))?.scheduledFor,
      Date.parse("2026-11-01T06:30:00.000Z"),
      "the second fall-back occurrence remains available after the first has passed",
    );
  });
});

test("existing natural-language expressions retain their behavior", () => {
  const now = new Date(2026, 7, 21, 10, 0, 0, 0);
  assert.equal(parseReminderExpression("In 2 Hours", now)?.scheduledFor, now.getTime() + 2 * 3_600_000);
  assert.equal(new Date(parseReminderExpression("Tomorrow Morning", now)!.scheduledFor).getHours(), 9);
  assert.ok(parseReminderExpression("Later Today", now));
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
    scheduleKind: "timed",
    scheduledFor: reminder.scheduledFor,
    timeZone: "America/New_York",
    originalExpression: "2026-11-01T01:30",
  });
});

test("Someday parses and reloads without inventing a scheduled instant", () => {
  const parsed = parseReminderExpression("  sOmEdAy  ");
  assert.deepEqual(parsed, {
    scheduleKind: "someday",
    originalExpression: "sOmEdAy",
  });
  assert.deepEqual(suggestReminderExpressions("some").map((suggestion) => suggestion.originalExpression), ["Someday"]);

  const reminder = {
    reminderId: "rem-someday",
    sessionId: "session-someday",
    scheduleKind: "someday",
    originalExpression: "Someday",
    wakePolicy: "regardless",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  } satisfies SessionReminderView;
  assert.deepEqual(storedReminderSchedule(reminder), {
    scheduleKind: "someday",
    originalExpression: "Someday",
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

  const weekdays = suggestReminderExpressions("wed", now);
  assert.deepEqual(weekdays.map((suggestion) => suggestion.originalExpression), [
    "Wednesday",
    "Wednesday Morning",
    "Wednesday Afternoon",
    "Wednesday Evening",
    "Wednesday at 9 AM",
    "Wednesday at 3:30 PM",
  ]);
  assert.deepEqual(
    suggestReminderExpressions("fri aft", now).map((suggestion) => suggestion.originalExpression),
    ["Friday Afternoon"],
  );
  assert.deepEqual(
    suggestReminderExpressions("next m", now).map((suggestion) => suggestion.originalExpression),
    ["Next Month"],
  );

  for (const suggestion of [
    ...relative,
    ...clock,
    ...weekdays,
    ...suggestReminderExpressions("wed at 3:30", now),
    ...suggestReminderExpressions("tom", now),
  ]) {
    assert.ok(parseReminderExpression(suggestion.originalExpression, now),
      `${suggestion.originalExpression} must remain inside the authoritative grammar`);
  }
  assert.deepEqual(suggestReminderExpressions("In 2 Hours", now), [],
    "a complete valid expression should release Enter back to form submission");
  assert.deepEqual(suggestReminderExpressions("", now), []);
});
