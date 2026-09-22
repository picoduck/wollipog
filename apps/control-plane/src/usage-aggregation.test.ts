import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parseUsageAggregationQuery, parseUsageRetentionInput, startOfUtcWeek } from "./usage-aggregation.js";

const retention = { hourlyDays: 30, dailyDays: 365, coverageStartedAt: 1_000 };

test("usage query windows choose retained granularity and clamp to explicit coverage", () => {
  assert.deepEqual(parseUsageAggregationQuery({ days: "7" }, retention, 10 * 86_400_000), {
    since: 3 * 86_400_000,
    through: 10 * 86_400_000,
    granularity: "hour",
  });
  assert.equal(parseUsageAggregationQuery({ days: "90" }, retention, 100 * 86_400_000).granularity, "day");
  assert.deepEqual(parseUsageAggregationQuery({ days: "90", granularity: "week" }, retention, 100 * 86_400_000), {
    since: 10 * 86_400_000,
    through: 100 * 86_400_000,
    granularity: "week",
  });
  assert.equal(parseUsageAggregationQuery({ days: "7" }, { ...retention, coverageStartedAt: 9 * 86_400_000 }, 10 * 86_400_000).since, 9 * 86_400_000);
});

test("usage query rejects unretained, malformed, and unbounded dimensions", () => {
  assert.throws(() => parseUsageAggregationQuery({ days: 31, granularity: "hour" }, retention), /retained/);
  assert.throws(() => parseUsageAggregationQuery({ days: 366 }, retention), /between/);
  assert.throws(() => parseUsageAggregationQuery({ days: 7.5 }, retention), /whole/);
  assert.throws(() => parseUsageAggregationQuery({ granularity: "month" }, retention), /hour, day, or week/);
  assert.throws(() => parseUsageAggregationQuery({ driver: "made-up" }, retention), /driver/);
  assert.throws(() => parseUsageAggregationQuery({ runnerId: "x".repeat(257) }, retention), /256/);
});

test("UTC week starts are Monday midnights, idempotent, and contain every generated instant", () => {
  fc.assert(fc.property(
    fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 11, 31, 23, 59, 59, 999) }),
    (timestamp) => {
      const start = startOfUtcWeek(timestamp);
      const date = new Date(start);
      assert.equal(date.getUTCDay(), 1);
      assert.equal(date.getUTCHours(), 0);
      assert.equal(date.getUTCMinutes(), 0);
      assert.ok(start <= timestamp && timestamp < start + 7 * 86_400_000);
      assert.equal(startOfUtcWeek(start), start);
    },
  ), { numRuns: 500 });

  // US daylight-saving transitions do not move UTC accounting boundaries.
  assert.equal(startOfUtcWeek(Date.UTC(2026, 2, 8, 7)), Date.UTC(2026, 2, 2));
  assert.equal(startOfUtcWeek(Date.UTC(2026, 10, 1, 6)), Date.UTC(2026, 9, 26));
});

test("usage retention validation is integer, bounded, and keeps at least 30 daily days", () => {
  assert.deepEqual(parseUsageRetentionInput({ hourlyDays: 7, dailyDays: 90 }), { hourlyDays: 7, dailyDays: 90 });
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: 0, dailyDays: 90 }), /hourlyDays/);
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: 7.5, dailyDays: 90 }), /hourlyDays/);
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: 7, dailyDays: 29 }), /dailyDays/);
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: 60, dailyDays: 30 }), /dailyDays/);
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: "7", dailyDays: 90 }), /hourlyDays/);
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: true, dailyDays: 90 }), /hourlyDays/);
  assert.throws(() => parseUsageRetentionInput({ hourlyDays: [7], dailyDays: 90 }), /hourlyDays/);
});
