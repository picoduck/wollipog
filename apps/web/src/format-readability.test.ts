import assert from "node:assert/strict";
import { test } from "node:test";
import { formatClock, formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp } from "./format.js";

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
