import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTimestampFormatterCache, formatClock, formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp, timestampFormatterCacheSize } from "./format.js";

test("duration formatting carries rounded seconds across minute and hour boundaries", () => {
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(1_250), "1.3s");
  assert.equal(formatDuration(59_600), "1m 0s");
  assert.equal(formatDuration(59 * 60_000 + 59_600), "1h 0m");
  assert.equal(formatDuration(61_400), "1m 1s");
  assert.equal(formatDuration(Number.NaN), "");
});

test("recorded timestamps expose machine-readable and neutral runner-recorded copy", () => {
  const formatted = formatRecordedTimestamp(Date.UTC(2026, 6, 13, 18, 5, 4), "en-US", "UTC");
  assert.equal(formatted?.dateTime, "2026-07-13T18:05:04.000Z");
  assert.match(formatted?.label ?? "", /6:05:04 PM/);
  assert.match(formatted?.title ?? "", /^Recorded /);
  assert.equal(formatRecordedTimestamp(Number.NaN), null);
});

test("recorded relative timestamps are deterministic, compact, and sentence case", () => {
  const now = 10 * 86_400_000;
  assert.equal(formatRecordedRelativeTime(now - 1_000, now), "just now");
  assert.equal(formatRecordedRelativeTime(now - 31_000, now), "31s ago");
  assert.equal(formatRecordedRelativeTime(now - 3 * 60_000, now), "3m ago");
  assert.equal(formatRecordedRelativeTime(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(formatRecordedRelativeTime(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(formatRecordedRelativeTime(now - 36 * 3_600_000, now), "1d ago");
  assert.equal(formatRecordedRelativeTime(now - 47 * 3_600_000, now), "1d ago");
  assert.equal(formatRecordedRelativeTime(now - 59_600, now), "59s ago");
  assert.equal(formatRecordedRelativeTime(now - (59 * 60_000 + 59_600), now), "59m ago");
  assert.equal(formatRecordedRelativeTime(now - (23 * 3_600_000 + 59 * 60_000 + 59_600), now), "23h ago");
  assert.equal(formatRecordedRelativeTime(now + 1_000, now), "just now");
  assert.equal(formatRecordedRelativeTime(Number.NaN, now), "");
});

test("clock times drop seconds so one turn reads as one minute", () => {
  assert.equal(formatClock(Date.UTC(2026, 6, 13, 0, 26, 4), "en-US", "UTC"), "12:26 AM");
  assert.equal(formatClock(Date.UTC(2026, 6, 13, 18, 5, 59), "en-US", "UTC"), "6:05 PM");
  assert.equal(formatClock(Number.NaN), "");
  assert.equal(formatClock(undefined), "");
});

test("timestamp formatter reuse separates styles, locales and time zones and preserves DST output", () => {
  clearTimestampFormatterCache();
  for (const locale of ["en-US", "de-DE", "ja-JP"]) for (const timeZone of ["UTC", "America/New_York", "Europe/Berlin"]) {
    for (const instant of ["2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:01:00Z"]) {
      const date = new Date(instant);
      assert.equal(formatClock(date.getTime(), locale, timeZone), new Intl.DateTimeFormat(locale, {
        hour: "numeric", minute: "2-digit", timeZone,
      }).format(date));
      assert.deepEqual(formatRecordedTimestamp(date.getTime(), locale, timeZone), {
        dateTime: date.toISOString(),
        label: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone }).format(date),
        title: `Recorded ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", timeZone }).format(date)}`,
      });
    }
  }
  assert.equal(timestampFormatterCacheSize(), 27);
  for (const timeZone of Intl.supportedValuesOf("timeZone").slice(0, 40)) formatClock(0, "en-US", timeZone);
  assert.equal(timestampFormatterCacheSize(), 32, "distinct environments cannot grow the cache without bound");
  assert.throws(() => formatClock(0, "en-US", "Invalid/Zone"), RangeError);
  assert.throws(() => formatClock(0, "invalid_locale", "UTC"), RangeError);
  assert.equal(formatRecordedTimestamp(8.65e15), null);
  clearTimestampFormatterCache();
});

test("repeated timestamp formatting reuses instances instead of constructing Intl per row", () => {
  clearTimestampFormatterCache();
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = new Proxy(original, {
    construct(target, args) { constructions++; return Reflect.construct(target, args); },
  });
  try {
    for (let index = 0; index < 100; index++) {
      formatClock(index * 1000, "en-US", "UTC");
      formatRecordedTimestamp(index * 1000, "en-US", "UTC");
    }
    assert.equal(constructions, 3, "one formatter per style, independent of the timestamp");
  } finally { Intl.DateTimeFormat = original; clearTimestampFormatterCache(); }
});

test("implicit time-zone changes refresh without freezing the earlier environment", () => {
  const previousZone = process.env.TZ;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  clearTimestampFormatterCache();
  try {
    process.env.TZ = "UTC";
    assert.equal(formatClock(0, "en-US"), "12:00 AM");
    process.env.TZ = "America/New_York";
    assert.equal(formatClock(0, "en-US"), "7:00 PM", "changed UTC offset refreshes immediately");
    // Phoenix and Denver can share today's offset but differ on dates across DST. Even a change
    // with no observable current offset is refreshed within one second of active formatting.
    process.env.TZ = "America/Phoenix";
    now += 1_000;
    const summer = Date.UTC(2026, 6, 13, 18);
    formatClock(summer, "en-US");
    process.env.TZ = "America/Denver";
    now += 1_000;
    const expected = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(summer));
    assert.equal(formatClock(summer, "en-US"), expected);
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
    Date.now = originalNow;
    clearTimestampFormatterCache();
  }
});

test("implicit locale changes invalidate cached styles on the next environment refresh", () => {
  const original = Intl.DateTimeFormat;
  const originalNow = Date.now;
  let now = originalNow();
  let defaultLocale = "en-US";
  Date.now = () => now;
  Intl.DateTimeFormat = new Proxy(original, {
    construct(target, args) {
      if (args[0] === undefined) args[0] = defaultLocale;
      return Reflect.construct(target, args);
    },
  });
  clearTimestampFormatterCache();
  try {
    const timestamp = Date.UTC(2026, 6, 13, 18);
    assert.equal(formatClock(timestamp, undefined, "UTC"), "6:00 PM");
    defaultLocale = "de-DE";
    now += 1_000;
    assert.equal(formatClock(timestamp, undefined, "UTC"), "18:00");
  } finally {
    Intl.DateTimeFormat = original;
    Date.now = originalNow;
    clearTimestampFormatterCache();
  }
});
