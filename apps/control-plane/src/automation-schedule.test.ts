import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextCronFire,
  parseCron,
  resetTimezoneCachesForTests,
  timezoneCacheStateForTests,
  validateTimeZone,
} from "./automation-schedule.js";

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

test("nextCronFire does bounded timezone work for permissive schedules", () => {
  const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) {
    calls += 1;
    return originalFormatToParts.apply(this, args);
  };
  try {
    const after = Date.UTC(2026, 6, 12, 12, 0);
    nextCronFire("0 13 * * *", "UTC", after);
    const fixedTimeCalls = calls;
    calls = 0;
    nextCronFire("* * * * *", "UTC", after);
    assert.ok(
      calls <= 8,
      `per-minute schedule used ${calls} timezone conversions after a ${fixedTimeCalls}-call warmup`,
    );
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
  }
});

test("a one-day per-minute catch-up has bounded timezone conversions", () => {
  const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) {
    calls += 1;
    return originalFormatToParts.apply(this, args);
  };
  try {
    const now = Date.UTC(2026, 8, 11, 12, 0);
    let cursor = now - 1440 * 60_000;
    let occurrences = 0;
    while (occurrences < 10_000) {
      const next = nextCronFire("* * * * *", "America/Chicago", cursor);
      occurrences += 1;
      if (next > now) break;
      cursor = next;
    }
    assert.equal(occurrences, 1441);
    assert.ok(calls < 2_500, `one-day catch-up used ${calls} timezone conversions`);
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
  }
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
    nextCronFire("* * * * *", "America/Chicago", Date.UTC(2026, 10, 1, 6, 59)),
    Date.UTC(2026, 10, 1, 8, 0),
    "per-minute schedules skip the repeated fall-back hour after its wall times have fired",
  );
  assert.equal(
    nextCronFire("30 1 * * *", "Australia/Lord_Howe", Date.UTC(2025, 3, 5, 0, 0)),
    Date.UTC(2025, 3, 5, 15, 0),
    "half-hour fall-back retains the existing zone-specific repeated-time resolution",
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

test("timezone case variants share validation and cron formatter work", () => {
  resetTimezoneCachesForTests();
  const originalDescriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat")!;
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructions = 0;
  Object.defineProperty(Intl, "DateTimeFormat", {
    ...originalDescriptor,
    value: function CountingDateTimeFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): Intl.DateTimeFormat {
      constructions += 1;
      return new OriginalDateTimeFormat(locales, options);
    },
  });
  try {
    assert.equal(validateTimeZone(" america/chicago "), "America/Chicago");
    assert.equal(validateTimeZone("AMERICA/CHICAGO"), "America/Chicago");
    assert.equal(constructions, 1, "a case variant should reuse successful validation");

    const after = Date.UTC(2026, 6, 12, 13, 59);
    const expected = Date.UTC(2026, 6, 12, 14, 0);
    assert.equal(nextCronFire("0 9 * * *", "America/Chicago", after), expected);
    assert.equal(nextCronFire("0 9 * * *", "aMeRiCa/cHiCaGo", after), expected);
    assert.equal(constructions, 2, "case variants should reuse one scheduling formatter");
    assert.deepEqual(timezoneCacheStateForTests(), {
      validationEntries: 1,
      formatterEntries: 1,
      maxValidationEntries: 128,
      maxFormatterEntries: 128,
    });
  } finally {
    Object.defineProperty(Intl, "DateTimeFormat", originalDescriptor);
    resetTimezoneCachesForTests();
  }
});

test("timezone validation and formatter LRUs stay bounded across eviction", () => {
  resetTimezoneCachesForTests();
  try {
    const limits = timezoneCacheStateForTests();
    const requiredZones = Math.max(limits.maxValidationEntries, limits.maxFormatterEntries) + 1;
    const zones = Intl.supportedValuesOf("timeZone").slice(0, requiredZones);
    assert.equal(zones.length, requiredZones, "the test runtime must expose enough IANA timezones");

    for (const zone of zones) validateTimeZone(zone);
    assert.equal(timezoneCacheStateForTests().validationEntries, limits.maxValidationEntries);
    assert.throws(() => validateTimeZone("Mars/Olympus"), /unknown IANA timezone/);
    assert.equal(
      timezoneCacheStateForTests().validationEntries,
      limits.maxValidationEntries,
      "invalid timezones must not enter the bounded validation cache",
    );
    assert.equal(validateTimeZone(zones[0]!), zones[0], "an evicted valid timezone remains accepted");

    const after = Date.UTC(2026, 0, 1);
    for (const zone of zones) nextCronFire("0 0 * * *", zone, after);
    assert.equal(timezoneCacheStateForTests().formatterEntries, limits.maxFormatterEntries);
    assert.ok(
      nextCronFire("0 0 * * *", zones[0]!, after) > after,
      "scheduling remains valid after validation and formatter eviction",
    );
    assert.equal(timezoneCacheStateForTests().formatterEntries, limits.maxFormatterEntries);
  } finally {
    resetTimezoneCachesForTests();
  }
});
