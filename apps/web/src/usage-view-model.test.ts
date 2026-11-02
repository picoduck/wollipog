import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageAmount, UsageDriverTimeBucket, UsageTimeBucket } from "@wollipog/protocol";
import {
  activeDrivers,
  agentBreakdown,
  axisLabel,
  axisLabelIndexes,
  breakdownRows,
  buildColumns,
  bucketLabel,
  coverageMessages,
  dailyBudgetReached,
  driverRows,
  formatCompactTokens,
  formatMoney,
  formatShare,
  niceScale,
  periodLabel,
  processedTokens,
  subscriptionPlanLabel,
  todaySpendUsd,
  usageWindowCaption,
} from "./usage-view-model.js";

test("subscription plans normalize known branding and preserve unknown provider labels", () => {
  assert.equal(subscriptionPlanLabel("pro"), "Pro");
  assert.equal(subscriptionPlanLabel("PRO"), "Pro");
  assert.equal(subscriptionPlanLabel("max"), "Max");
  assert.equal(subscriptionPlanLabel("Future_Tier"), "Future_Tier");
});

function amount(over: Partial<UsageAmount> = {}): UsageAmount {
  return {
    inputTokens: 0, outputTokens: 0, costUsd: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0,
    reasoningTokens: 0, cacheSavingsUsd: 0, costSource: "providerReported", unpricedRecords: 0,
    processedTokens: (over.inputTokens ?? 0) + (over.outputTokens ?? 0), ...over,
  };
}

test("processed tokens trust the plane's additive figure and fall back conservatively without it", () => {
  assert.equal(processedTokens(amount({ inputTokens: 100, cachedInputTokens: 900, outputTokens: 10, processedTokens: 1060 })), 1060, "the server-derived figure wins");
  const legacyPlane = { ...amount({ inputTokens: 1200, uncachedInputTokens: 400, cachedInputTokens: 600, cacheCreationTokens: 50, outputTokens: 30 }) } as Record<string, unknown>;
  delete legacyPlane.processedTokens;
  assert.equal(processedTokens(legacyPlane as unknown as UsageAmount), 1230, "without the field only reported input plus output is claimed");
  assert.equal(processedTokens(amount({ inputTokens: 40, outputTokens: 2, processedTokens: Number.NaN })), 42, "a malformed figure falls back too");
});

test("formatting compacts tokens to three significant figures and money to whole cents", () => {
  assert.equal(formatCompactTokens(0), "0");
  assert.equal(formatCompactTokens(842), "842");
  assert.equal(formatCompactTokens(1234), "1.23K");
  assert.equal(formatCompactTokens(12_400), "12.4K");
  assert.equal(formatCompactTokens(804_000), "804K");
  assert.equal(formatCompactTokens(76_700_000), "76.7M");
  assert.equal(formatCompactTokens(1_000_000), "1M");
  assert.equal(formatCompactTokens(19_900_000_000), "19.9B");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(0.004), "<$0.01");
  assert.equal(formatMoney(0.005), "$0.01");
  assert.equal(formatMoney(1234.5), "$1,234.50");
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(0.0123), "1.2%");
  assert.equal(formatShare(0.5), "50%");
});

test("driver rows keep slot order, skip Other, and share the active metric", () => {
  const byDriver = [
    { key: "Other", ...amount({ costUsd: 1 }) },
    { key: "acp", ...amount({ costUsd: 1, inputTokens: 10 }) },
    { key: "claude-code", ...amount({ costUsd: 3, inputTokens: 90 }) },
    { key: "codex", ...amount() },
  ];
  assert.deepEqual(activeDrivers(byDriver), ["claude-code", "acp"]);
  const totals = amount({ costUsd: 5, inputTokens: 100 });
  assert.deepEqual(driverRows({ byDriver, totals }, "cost").map((row) => [row.driver, row.share]), [["claude-code", 0.6], ["acp", 0.2]]);
  assert.deepEqual(driverRows({ byDriver, totals }, "tokens").map((row) => [row.driver, row.share]), [["claude-code", 0.9], ["acp", 0.1]]);
});

test("columns stack drivers in slot order, ascend in time, and fall back to bucket totals without a split", () => {
  const series: UsageTimeBucket[] = [
    { bucketTs: 2, ...amount({ costUsd: 5 }) },
    { bucketTs: 1, ...amount({ costUsd: 3 }) },
    { bucketTs: 3, ...amount({ costUsd: 7 }) },
  ];
  const split: UsageDriverTimeBucket[] = [
    { bucketTs: 2, driver: "acp", ...amount({ costUsd: 1 }) },
    { bucketTs: 2, driver: "claude-code", ...amount({ costUsd: 4 }) },
    { bucketTs: 1, driver: "claude-code", ...amount({ costUsd: 3 }) },
  ];
  const columns = buildColumns(series, split, ["claude-code", "acp"], "cost");
  assert.deepEqual(columns.map((column) => column.bucketTs), [1, 2, 3]);
  assert.deepEqual(columns[1]!.bands, [
    { driver: "claude-code", value: 4, from: 0, to: 4 },
    { driver: "acp", value: 1, from: 4, to: 5 },
  ]);
  assert.equal(columns[1]!.total, 5);
  assert.deepEqual(columns[0]!.bands.map((band) => band.value), [3, 0], "a missing driver inside a split is a zero band");
  assert.equal(columns[2]!.total, 7, "a bucket with no per-driver split keeps its total height");
  assert.deepEqual(columns[2]!.bands, [], "and presents no per-driver values, because none are known");
  assert.equal(buildColumns(series, [], ["claude-code"], "cost").every((column) => column.bands.length === 0), true);
});

test("the headline caption names the response's real dates, not the last clicked range", () => {
  const retention = { hourlyDays: 30, dailyDays: 365, coverageStartedAt: Date.UTC(2026, 0, 1) };
  // A full 30-day daily window ends at an exclusive midnight, so its last day is the day before.
  const full = { since: Date.UTC(2026, 7, 5), through: Date.UTC(2026, 8, 4), retention };
  assert.equal(usageWindowCaption("cost", full), "Estimated API cost, Aug 5 – Sep 3");
  assert.equal(usageWindowCaption("tokens", full), "Processed tokens, Aug 5 – Sep 3");
  // A live window ends now, part way through today.
  assert.equal(
    usageWindowCaption("cost", { since: Date.UTC(2026, 7, 5), through: Date.UTC(2026, 8, 3, 14, 30), retention }),
    "Estimated API cost, Aug 5 – Sep 3",
  );
  // An hourly window starts on the hour, not at midnight; the dates are still UTC days.
  assert.equal(
    usageWindowCaption("cost", { since: Date.UTC(2026, 7, 27, 14), through: Date.UTC(2026, 8, 3, 14, 30), retention }),
    "Estimated API cost, Aug 27 – Sep 3",
  );
  // A window that crosses a year names the year on both dates.
  assert.equal(
    usageWindowCaption("tokens", { since: Date.UTC(2025, 11, 20), through: Date.UTC(2026, 0, 19), retention: { ...retention, coverageStartedAt: 0 } }),
    "Processed tokens, Dec 20, 2025 – Jan 18, 2026",
  );
});

test("a window clamped to the start of recording says when recording started, never a day count", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 8, 26, 9);
  // Recording started yesterday at 15:20 UTC; a 30-day range is clamped to that day's bucket.
  const coverageStartedAt = Date.UTC(2026, 8, 25, 15, 20);
  const retention = { hourlyDays: 30, dailyDays: 365, coverageStartedAt };
  const daily = { since: Math.floor(coverageStartedAt / DAY) * DAY, through: now, retention };
  assert.equal(usageWindowCaption("cost", daily), "Estimated API cost since Sep 25, when recording started");
  assert.equal(usageWindowCaption("tokens", daily), "Processed tokens since Sep 25, when recording started");
  const hourly = { since: Date.UTC(2026, 8, 25, 15), through: now, retention };
  assert.equal(usageWindowCaption("cost", hourly), "Estimated API cost since Sep 25, when recording started");
  // Recording that started on the very first day of an unclamped window still reads as the start.
  assert.equal(
    usageWindowCaption("cost", { since: Date.UTC(2026, 7, 27), through: now, retention: { ...retention, coverageStartedAt: Date.UTC(2026, 7, 27) } }),
    "Estimated API cost since Aug 27, when recording started",
  );
  // A start of recording in the previous year names both years.
  assert.equal(
    usageWindowCaption("cost", { since: Date.UTC(2025, 11, 31), through: Date.UTC(2026, 0, 2, 3), retention: { ...retention, coverageStartedAt: Date.UTC(2025, 11, 31, 8) } }),
    "Estimated API cost since Dec 31, 2025, when recording started",
  );
  // A window shorter than a day that has not reached coverage names its one date.
  assert.equal(
    usageWindowCaption("cost", { since: Date.UTC(2026, 8, 26), through: now, retention: { ...retention, coverageStartedAt: Date.UTC(2026, 0, 1) } }),
    "Estimated API cost, Sep 26",
  );
});

test("axis helpers produce clean ticks and bounded, end-anchored labels", () => {
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(niceScale(7.3, 4), { max: 8, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(niceScale(1234, 4), { max: 1500, ticks: [0, 500, 1000, 1500] });
  assert.deepEqual(niceScale(0.037, 4), { max: 0.04, ticks: [0, 0.01, 0.02, 0.03, 0.04] });
  assert.deepEqual(axisLabelIndexes(3), [0, 1, 2]);
  const thirty = axisLabelIndexes(30, 8);
  assert.equal(thirty[0], 0);
  assert.equal(thirty.at(-1), 29);
  assert.ok(thirty.length <= 8);
  assert.equal(axisLabel(Date.UTC(2026, 8, 3, 14), "hour"), "Sep 3 · 14:00");
  assert.equal(axisLabel(Date.UTC(2026, 8, 3), "day"), "Sep 3");
  assert.equal(axisLabel(Date.UTC(2026, 8, 14), "week"), "Sep 14–20");
  assert.equal(axisLabel(Date.UTC(2026, 8, 28), "week"), "Sep 28–Oct 4");
  assert.equal(bucketLabel(Date.UTC(2026, 8, 3, 14), "hour"), "Sep 3, 2026 · 14:00–14:59 UTC");
  assert.equal(bucketLabel(Date.UTC(2026, 8, 3), "day"), "Sep 3, 2026 · 00:00–23:59 UTC");
  assert.equal(bucketLabel(Date.UTC(2026, 8, 14), "week"), "Sep 14, 2026 00:00–Sep 20, 2026 23:59 UTC");
  assert.equal(
    bucketLabel(Date.UTC(2026, 8, 14), "week", {
      since: Date.UTC(2026, 8, 17),
      through: Date.UTC(2026, 8, 21),
    }),
    "Sep 14, 2026 00:00–Sep 20, 2026 23:59 UTC (Partial)",
  );
});

test("coverage messages name offline machines, unpriced records, and rate-table state", () => {
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: { status: "fresh", source: "x", fetchedAt: 1, knownModels: 2 } }), []);
  const messages = coverageMessages({
    offlineMachines: ["Build Box"], unpricedRecords: 3,
    pricing: { status: "cached", source: "x", fetchedAt: 1, knownModels: 2 },
  });
  assert.equal(messages.length, 3);
  assert.match(messages[0]!, /Build Box is offline/);
  assert.match(messages[1]!, /3 usage records could not be fully priced/);
  assert.match(messages[2]!, /could not be refreshed/);
  assert.match(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: { status: "unavailable", source: "disabled", fetchedAt: null, knownModels: 0 } })[0]!, /No model rate table/);
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: undefined }), [], "a pre-v103 plane sends no pricing block");
});

test("historical Claude records disclose possible duplicate spending without relabeling new estimates", () => {
  const messages = coverageMessages({ offlineMachines: [], unpricedRecords: 0, legacyClaudeCostRecords: 2 });
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Resumed spending may be counted more than once/);
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, legacyClaudeCostRecords: 0 }), []);
});

test("a time table row names only its period; the column header says UTC (#3013)", () => {
  assert.equal(periodLabel(Date.UTC(2026, 8, 3, 14), "hour"), "Sep 3, 2026 · 14:00");
  assert.equal(periodLabel(Date.UTC(2026, 8, 3), "day"), "Sep 3, 2026");
  assert.equal(periodLabel(Date.UTC(2026, 8, 14), "week"), "Sep 14–20, 2026");
  assert.equal(periodLabel(Date.UTC(2026, 8, 28), "week"), "Sep 28–Oct 4, 2026");
  assert.equal(periodLabel(Date.UTC(2025, 11, 29), "week"), "Dec 29, 2025–Jan 4, 2026");
  assert.equal(periodLabel(Date.UTC(2026, 8, 14), "week", { since: Date.UTC(2026, 8, 17), through: Date.UTC(2026, 8, 21) }),
    "Sep 14–20, 2026 (Partial)");
});

test("By Agent cuts each key at its first ' / ' and sums an agent's models (#3013)", () => {
  const rows = agentBreakdown([
    { key: "claude / claude-fable-5-1", ...amount({ inputTokens: 10, costUsd: 1 }) },
    { key: "codex / gpt-5.5 / preview", ...amount({ inputTokens: 5, costUsd: 0.5 }) },
    { key: "claude / claude-sonnet-5-5", ...amount({ inputTokens: 20, costUsd: 2, costSource: "unpriced", unpricedRecords: 1 }) },
    { key: "unassigned", ...amount({ inputTokens: 1 }) },
    { key: "Other", ...amount({ inputTokens: 2 }) },
  ]);
  assert.deepEqual(rows.map((row) => [row.key, row.inputTokens, row.costUsd, row.costSource]), [
    ["claude", 30, 3, "unpriced"],
    ["codex", 5, 0.5, "providerReported"],
    ["unassigned", 1, 0, "providerReported"],
    ["Other", 2, 0, "providerReported"],
  ]);
});

test("breakdown rows are named, ranked by the active metric, and keep Other last (#3013)", () => {
  const totals = amount({ inputTokens: 100, costUsd: 10 });
  const input = [
    { key: "Other", ...amount({ inputTokens: 60, costUsd: 6 }) },
    { key: "a", ...amount({ inputTokens: 10, costUsd: 3 }) },
    { key: "b", ...amount({ inputTokens: 30, costUsd: 1 }) },
  ];
  const byCost = breakdownRows(input, (key) => key.toUpperCase(), "cost", totals);
  assert.deepEqual(byCost.map((row) => [row.name, row.share]), [["A", 0.3], ["B", 0.1], ["Other", 0.6]]);
  const byTokens = breakdownRows(input, (key) => key.toUpperCase(), "tokens", totals);
  assert.deepEqual(byTokens.map((row) => [row.name, row.share]), [["B", 0.3], ["A", 0.1], ["Other", 0.6]]);
});

test("the daily budget is reached at settled spend plus running-turn estimates, as the gate counts it (#3013)", () => {
  const person = { todayUsd: 24, dailyBudgetUsd: 25 };
  assert.equal(dailyBudgetReached(person), false);
  assert.equal(dailyBudgetReached({ ...person, todayEstimateUsd: 0.75 }), false);
  assert.equal(dailyBudgetReached({ ...person, todayEstimateUsd: 1 }), true, "at the budget is reached");
  assert.equal(dailyBudgetReached({ todayUsd: 0.1, todayEstimateUsd: 0.2, dailyBudgetUsd: 0.3 }), true,
    "compared in whole micro-dollars, so float sums never fall a hair short");
  assert.equal(todaySpendUsd({ todayUsd: 0.1, todayEstimateUsd: 0.2 }), 0.3);
  assert.equal(dailyBudgetReached({ todayUsd: 100, dailyBudgetUsd: null }), false, "no budget, nothing to reach");
});
