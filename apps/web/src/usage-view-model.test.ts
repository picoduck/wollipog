import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageAmount, UsageDriverTimeBucket, UsageTimeBucket } from "@wollipog/protocol";
import {
  activeDrivers,
  axisLabel,
  axisLabelIndexes,
  buildColumns,
  coverageMessages,
  driverRows,
  formatCompactTokens,
  formatMoney,
  formatShare,
  niceScale,
  processedTokens,
  windowDays,
} from "./usage-view-model.js";

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

test("the headline window comes from the response, not the last clicked range", () => {
  assert.equal(windowDays({ since: 0, through: 30 * 86_400_000 }), 30);
  assert.equal(windowDays({ since: 0, through: 7 * 86_400_000 + 3_600_000 }), 7);
  assert.equal(windowDays({ since: 5, through: 5 }), 1);
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
  assert.equal(axisLabel(Date.UTC(2026, 8, 3, 14), "hour"), "14:00");
  assert.equal(axisLabel(Date.UTC(2026, 8, 3), "day"), "Sep 3");
});

test("coverage messages name offline machines, unpriced records, and rate-table state", () => {
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: { status: "fresh", source: "x", fetchedAt: 1, knownModels: 2 } }), []);
  const messages = coverageMessages({
    offlineMachines: ["Build Box"], unpricedRecords: 3,
    pricing: { status: "cached", source: "x", fetchedAt: 1, knownModels: 2 },
  });
  assert.equal(messages.length, 3);
  assert.match(messages[0]!, /Build Box is offline/);
  assert.match(messages[1]!, /3 records have tokens but no price/);
  assert.match(messages[2]!, /could not be refreshed/);
  assert.match(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: { status: "unavailable", source: "disabled", fetchedAt: null, knownModels: 0 } })[0]!, /No model rate table/);
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: undefined }), [], "a pre-v103 plane sends no pricing block");
});
