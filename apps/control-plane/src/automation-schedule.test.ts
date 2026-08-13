import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCronFire, parseCron, validateTimeZone } from "./automation-schedule.js";

test("strict cron parsing supports lists, ranges, steps, and Sunday alias", () => {
  const parsed = parseCron("*/15 8-10 1,15 * 1-5");
  assert.deepEqual(parsed.minute.values, [0, 15, 30, 45]);
  assert.deepEqual(parsed.hour.values, [8, 9, 10]);
  assert.deepEqual(parsed.dayOfMonth.values, [1, 15]);
  assert.deepEqual(parseCron("0 0 * * 7").dayOfWeek.values, [0]);
  assert.deepEqual(parseCron("0 0 * * 5-7").dayOfWeek.values, [0, 5, 6]);
  assert.throws(() => parseCron("0 0 * *"), /exactly five/);
  assert.throws(() => parseCron("60 0 * * *"), /between 0 and 59/);
  assert.throws(() => parseCron("0 0 9-2 * *"), /ascending/);
  assert.throws(() => parseCron("0 0 * * MON"), /invalid cron value/);
});

test("nextCronFire uses exclusive minute precision and POSIX day-of-month/day-of-week OR semantics", () => {
  const after = Date.UTC(2026, 6, 12, 12, 0);
  assert.equal(nextCronFire("*/15 * * * *", "UTC", after), Date.UTC(2026, 6, 12, 12, 15));
  // July 13 2026 is Monday; either day 13 OR Monday matches when both fields are restricted.
  assert.equal(nextCronFire("30 9 13 * 1", "UTC", after), Date.UTC(2026, 6, 13, 9, 30));
  assert.equal(
    nextCronFire("0 9 */1 * 1", "UTC", Date.UTC(2026, 6, 13, 12, 0)),
    Date.UTC(2026, 6, 20, 9, 0),
    "a step expression selecting the entire day-of-month domain remains semantically unrestricted",
  );
});

test("nextCronFire interprets IANA timezones and skips nonexistent spring-DST wall time", () => {
  assert.equal(
    nextCronFire("0 9 * * *", "America/Chicago", Date.UTC(2026, 6, 12, 13, 59)),
    Date.UTC(2026, 6, 12, 14, 0),
  );
  assert.equal(
    nextCronFire("30 2 * * *", "America/New_York", Date.UTC(2024, 2, 9, 8, 0)),
    Date.UTC(2024, 2, 11, 6, 30),
    "02:30 does not exist on the spring-forward day",
  );
  const repeatedWallTime = nextCronFire("30 1 * * *", "America/Chicago", Date.UTC(2026, 10, 1, 5, 0));
  assert.equal(repeatedWallTime, Date.UTC(2026, 10, 1, 6, 30));
  assert.equal(
    nextCronFire("30 1 * * *", "America/Chicago", repeatedWallTime),
    Date.UTC(2026, 10, 2, 7, 30),
    "a repeated fall-back wall time fires only once",
  );
  assert.equal(
    nextCronFire("0 0 29 2 *", "UTC", Date.UTC(2025, 0, 1)),
    Date.UTC(2028, 1, 29),
    "sparse valid schedules remain searchable within the documented five-year horizon",
  );
});

test("timezone and cursor validation fail closed", () => {
  assert.equal(validateTimeZone(" America/Chicago "), "America/Chicago");
  assert.throws(() => validateTimeZone("Mars/Olympus"), /unknown IANA timezone/);
  assert.throws(() => nextCronFire("0 0 * * *", "UTC", Number.NaN), /non-negative epoch/);
});
