import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView } from "@wollipog/protocol";
import {
  formatReminderReturn,
  formatReminderReturnDay,
  formatReminderTileTime,
  parseReminderExpression,
  reminderExpressionError,
  storedReminderSchedule,
  suggestReminderExpressions,
  timeZoneDisplayName,
} from "./reminder-schedule.js";

test("a snoozed row's return time is the time today, the weekday this week, and the date after (#2209)", () => {
  // Tuesday 6 October 2026, 10:00 in New York.
  const now = Date.UTC(2026, 9, 6, 14, 0);
  const timeZone = "America/New_York";
  // The host's locale writes the words; the test checks which form each instant gets.
  const format = (instant: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(instant));
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const today = Date.UTC(2026, 9, 6, 19, 0);
  const thursday = Date.UTC(2026, 9, 8, 13, 0);
  const later = Date.UTC(2026, 9, 20, 13, 0);
  assert.equal(formatReminderReturn(today, timeZone, now), format(today, time));
  assert.equal(formatReminderReturn(thursday, timeZone, now), format(thursday, { weekday: "short", ...time }));
  assert.equal(formatReminderReturn(later, timeZone, now), format(later, { month: "short", day: "numeric" }));
  // The day is the reminder's own: 23:30 in New York on the 6th is already the 7th in UTC.
  const lateToday = Date.UTC(2026, 9, 7, 3, 30);
  assert.equal(formatReminderReturn(lateToday, timeZone, now), format(lateToday, time));
  if (new Intl.DateTimeFormat().resolvedOptions().locale === "en-US") {
    assert.equal(formatReminderReturn(thursday, timeZone, now).replace(/ /g, " "), "Thu 9:00 AM");
  }
});

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

test("ISO dates resolve, past ones and numeric dates are refused (#2181)", () => {
  withTimeZone("America/New_York", () => {
    const now = new Date(2026, 7, 21, 10, 0);
    assert.equal(parseReminderExpression("2026-08-20T09:00", now), null);
    assert.equal(reminderExpressionError("2026-08-20T09:00", now), "That time has passed. Choose a later one.");
    const stored = parseReminderExpression("2099-05-06T21:45", now);
    assert.equal(stored?.scheduleKind === "timed" && stored.scheduledFor, new Date(2099, 4, 6, 21, 45).getTime());
    const dateOnly = parseReminderExpression("2026-12-10", now);
    assert.equal(dateOnly?.scheduleKind === "timed" && dateOnly.scheduledFor, new Date(2026, 11, 10, 9, 0).getTime());
    assert.equal(parseReminderExpression("08/22/2026", now), null);
  });
});

test("named dates take a day, an optional year, and a clock or daypart (#2181)", () => {
  withTimeZone("America/New_York", () => {
    // Tuesday 6 October 2026, 10:00.
    const now = new Date(2026, 9, 6, 10, 0);
    const at = (expression: string) => {
      const parsed = parseReminderExpression(expression, now);
      return parsed?.scheduleKind === "timed" ? new Date(parsed.scheduledFor) : null;
    };
    assert.deepEqual(at("dec 10 9am"), new Date(2026, 11, 10, 9, 0));
    assert.deepEqual(at("Dec 10, 2026 9:30 pm"), new Date(2026, 11, 10, 21, 30));
    assert.deepEqual(at("December 10th at 15:00"), new Date(2026, 11, 10, 15, 0));
    assert.deepEqual(at("10 dec"), new Date(2026, 11, 10, 9, 0), "a day-first name, at 9 AM by default");
    assert.deepEqual(at("sept 3 afternoon"), new Date(2027, 8, 3, 13, 0), "a day already past this year is next year's");
    assert.deepEqual(at("oct 6 9am"), new Date(2027, 9, 6, 9, 0), "an hour already past today is next year's");
    assert.deepEqual(at("feb 29"), new Date(2028, 1, 29, 9, 0), "the next leap day");
    assert.equal(at("feb 30"), null);
    assert.equal(at("dec 10 25pm"), null);
    assert.equal(at("jan 5 2020"), null);

    const decTenth = parseReminderExpression("dec 10 9am", now);
    assert.ok(decTenth?.scheduleKind === "timed");
    if (new Intl.DateTimeFormat().resolvedOptions().locale === "en-US" && decTenth?.scheduleKind === "timed") {
      assert.equal(`Returns ${formatReminderReturnDay(decTenth.scheduledFor, decTenth.timeZone, now.getTime())}.`
        .replace(/ /g, " "), "Returns Thursday, Dec 10 at 9:00 AM.");
    }
  });
});

test("every refused expression has one sentence saying what is wrong and how to fix it (#2181)", () => {
  withTimeZone("America/New_York", () => {
    const now = new Date(2026, 9, 6, 22, 30);
    assert.equal(reminderExpressionError("12/10/26", now),
      "“12/10/26” could be December 10 or October 12. Write the month, like “Dec 10”.");
    assert.equal(reminderExpressionError("25/12/26", now),
      "“25/12/26” is a date in numbers only. Write the month, like “Dec 25”.");
    assert.equal(reminderExpressionError("5/5", now), "“5/5” is a date in numbers only. Write the month, like “May 5”.");
    assert.equal(reminderExpressionError("  ", now), "Enter when it returns, like “tomorrow 3pm”.");
    assert.equal(reminderExpressionError("later today", now), "Later Today has passed for today. Choose another time.");
    assert.equal(reminderExpressionError("in 0 minutes", now), "Choose a time in the future, like “in 2 hours”.");
    assert.equal(reminderExpressionError("today at 9 pm", now), "That time has passed. Choose a later one.");
    assert.equal(reminderExpressionError("fri at 13 pm", now), "Enter a real time of day, like “3:30pm”.");
    assert.equal(reminderExpressionError("feb 30", now), "“feb 30” isn't a date on the calendar. Check the day and the month.");
    assert.equal(reminderExpressionError("soon-ish", now),
      "Wollipog can't read “soon-ish” as a time. Try “in 2 hours”, “tomorrow 3pm” or “dec 10 9am”.");
    assert.equal(reminderExpressionError("someday", now, false), "Someday needs a newer version of Wollipog. Enter a time instead.");
    assert.equal(reminderExpressionError("someday", now, true), null);
    assert.equal(reminderExpressionError("dec 10 9am", now), null);
  });
});

test("a preset tile's time is today's clock, the weekday within the week, and the date beyond (#2181)", () => {
  // Friday 25 September 2026, 14:00 in New York.
  const now = Date.UTC(2026, 8, 25, 18, 0);
  const timeZone = "America/New_York";
  const timed = (scheduledFor: number) => ({ scheduleKind: "timed" as const, scheduledFor, timeZone, originalExpression: "" });
  const tile = (scheduledFor: number) => formatReminderTileTime(timed(scheduledFor), now).replace(/ /g, " ");
  assert.equal(formatReminderTileTime({ scheduleKind: "someday", originalExpression: "someday" }, now), "No set time");
  if (new Intl.DateTimeFormat().resolvedOptions().locale !== "en-US") return;
  assert.equal(tile(Date.UTC(2026, 8, 25, 21, 0)), "Today, 5:00 PM");
  assert.equal(tile(Date.UTC(2026, 8, 26, 13, 0)), "Sat, 9:00 AM");
  assert.equal(tile(Date.UTC(2026, 9, 1, 13, 0)), "Thu, 9:00 AM");
  assert.equal(tile(Date.UTC(2026, 9, 2, 13, 0)), "Oct 2, 9:00 AM");
});

test("the summary's day names the year only when it is not this one, and a foreign zone (#2181)", () => {
  withTimeZone("America/New_York", () => {
    if (new Intl.DateTimeFormat().resolvedOptions().locale !== "en-US") return;
    const now = Date.UTC(2026, 8, 25, 18, 0);
    const day = (scheduledFor: number, timeZone = "America/New_York") =>
      formatReminderReturnDay(scheduledFor, timeZone, now).replace(/ /g, " ");
    assert.equal(day(Date.UTC(2026, 8, 26, 13, 0)), "Saturday, Sep 26 at 9:00 AM");
    assert.equal(day(Date.UTC(2027, 0, 4, 14, 0)), "Monday, Jan 4, 2027 at 9:00 AM");
    assert.equal(day(Date.UTC(2026, 8, 26, 0, 0), "Asia/Tokyo"), "Saturday, Sep 26 at 9:00 AM GMT+9");
    assert.equal(timeZoneDisplayName("America/New_York", now), "Eastern Time");
    assert.equal(timeZoneDisplayName("UTC", now), "UTC");
  });
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
  assert.deepEqual(
    suggestReminderExpressions("dec 10", now).map((suggestion) => suggestion.originalExpression),
    ["December 10 at 9 AM", "December 10 at 1 PM"],
  );
  assert.deepEqual(
    suggestReminderExpressions("december 10 3", now).map((suggestion) => suggestion.originalExpression),
    ["December 10 at 3 AM", "December 10 at 3 PM"],
  );

  for (const suggestion of [
    ...relative,
    ...clock,
    ...weekdays,
    ...suggestReminderExpressions("wed at 3:30", now),
    ...suggestReminderExpressions("tom", now),
    ...suggestReminderExpressions("dec 10 3", now),
  ]) {
    assert.ok(parseReminderExpression(suggestion.originalExpression, now),
      `${suggestion.originalExpression} must remain inside the authoritative grammar`);
  }
  assert.deepEqual(suggestReminderExpressions("In 2 Hours", now), [],
    "a complete valid expression should release Enter back to form submission");
  assert.deepEqual(suggestReminderExpressions("", now), []);
});
