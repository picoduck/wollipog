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
  bucketStart,
  bucketStepMs,
  coverageMessages,
  coverageNeedsRates,
  coverageSentence,
  dailyBudgetReached,
  DRIVER_ORDER,
  DRIVER_PRESENTATION,
  driverRows,
  formatCompactTokens,
  formatMoney,
  formatShare,
  niceScale,
  OTHER_AGENTS_LABEL,
  periodLabel,
  processedTokens,
  ratesRefreshProblem,
  subscriptionPlanLabel,
  todaySpendUsd,
  usageDriverLabels,
  usageIsEmpty,
  usageRestingSummary,
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

const DAY = 86_400_000;
/** A daily axis whose exclusive end is a midnight, so a 30-day range is exactly 30 buckets. */
const dailyAxis = (through: number, rangeDays = 30, coverageStartedAt = 0) => ({
  granularity: "day" as const, since: Math.max(through - rangeDays * DAY, Math.floor(coverageStartedAt / DAY) * DAY),
  through, coverageStartedAt, rangeDays,
});

test("Claude Code takes the blue slot, Codex the orange and ACP the purple, stacked in an explicit order", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DRIVER_PRESENTATION).map(([driver, { slot }]) => [driver, slot])),
    { "claude-code": 2, "codex-app-server": 1, acp: 4, codex: 3, pi: 5 },
  );
  assert.deepEqual(DRIVER_ORDER, ["claude-code", "codex-app-server", "pi", "acp", "codex"]);
  assert.deepEqual(new Set(DRIVER_ORDER), new Set(Object.keys(DRIVER_PRESENTATION)), "every driver stacks exactly once");
});

test("columns stack drivers in DRIVER_ORDER, ascend in time, and fall back to bucket totals without a split", () => {
  const through = Date.UTC(2026, 8, 4);
  const [d1, d2, d3] = [through - 3 * DAY, through - 2 * DAY, through - DAY];
  const series: UsageTimeBucket[] = [
    { bucketTs: d2, ...amount({ costUsd: 5 }) },
    { bucketTs: d1, ...amount({ costUsd: 3 }) },
    { bucketTs: d3, ...amount({ costUsd: 7 }) },
  ];
  const split: UsageDriverTimeBucket[] = [
    { bucketTs: d2, driver: "acp", ...amount({ costUsd: 1 }) },
    { bucketTs: d2, driver: "claude-code", ...amount({ costUsd: 4 }) },
    { bucketTs: d1, driver: "claude-code", ...amount({ costUsd: 3 }) },
  ];
  const axis = dailyAxis(through, 3);
  const columns = buildColumns(series, split, ["claude-code", "acp"], "cost", axis);
  assert.deepEqual(columns.map((column) => column.bucketTs), [d1, d2, d3]);
  assert.deepEqual(columns[1]!.bands, [
    { driver: "claude-code", value: 4, from: 0, to: 4 },
    { driver: "acp", value: 1, from: 4, to: 5 },
  ]);
  assert.equal(columns[1]!.total, 5);
  assert.deepEqual(columns[0]!.bands.map((band) => band.value), [3, 0], "a missing driver inside a split is a zero band");
  assert.equal(columns[2]!.total, 7, "a bucket with no per-driver split keeps its total height");
  assert.deepEqual(columns[2]!.bands, [], "and presents no per-driver values, because none are known");
  assert.equal(buildColumns(series, [], ["claude-code"], "cost", axis).every((column) => column.bands.length === 0), true);
  assert.deepEqual(buildColumns([], [], ["claude-code"], "cost", axis), [], "a window with no usage has nothing to draw");
});

test("usage on 3 of 30 days draws 30 columns spanning the whole range, 27 of them at zero", () => {
  const through = Date.UTC(2026, 8, 4);
  const used = [through - 30 * DAY + 4 * DAY, through - 12 * DAY, through - DAY];
  const series = used.map((bucketTs, index) => ({ bucketTs, ...amount({ costUsd: index + 1, inputTokens: 10 }) }));
  const split = series.map((bucket) => ({ ...bucket, driver: "claude-code" as const }));
  const columns = buildColumns(series, split, ["claude-code", "codex-app-server"], "cost", dailyAxis(through));
  assert.equal(columns.length, 30);
  assert.equal(columns[0]!.bucketTs, through - 30 * DAY, "the axis starts where the range does");
  assert.equal(columns.at(-1)!.bucketTs, through - DAY, "and ends on the window's last day");
  assert.ok(columns.every((column, index) => index === 0 || column.bucketTs - columns[index - 1]!.bucketTs === DAY), "one column per day");
  assert.equal(columns.filter((column) => column.total === 0).length, 27);
  assert.ok(columns.every((column) => column.recorded));
  const quiet = columns.find((column) => column.total === 0)!;
  assert.deepEqual(quiet.bands.map((band) => [band.driver, band.value]), [["claude-code", 0], ["codex-app-server", 0]],
    "a quiet day still lists each driver at zero");
  // A plane that never splits by driver claims no per-driver zeros for a quiet day either.
  assert.ok(buildColumns(series, [], ["claude-code"], "cost", dailyAxis(through)).every((column) => column.bands.length === 0));
});

test("buckets before recording started are unrecorded, and the axis still spans the chosen range", () => {
  const through = Date.UTC(2026, 8, 4);
  const coverageStartedAt = through - 10 * DAY;
  const series = [{ bucketTs: through - 2 * DAY, ...amount({ costUsd: 2 }) }];
  // The plane clamps `since` to the start of recording; the chosen range still reaches 30 days back.
  const columns = buildColumns(series, [], [], "cost", dailyAxis(through, 30, coverageStartedAt));
  assert.equal(columns.length, 30);
  assert.deepEqual(columns.map((column) => column.recorded), [...Array(20).fill(false), ...Array(10).fill(true)]);
  // Recording that started part way through a day records that whole day's bucket.
  const midDay = buildColumns(series, [], [], "cost", dailyAxis(through, 30, coverageStartedAt + 15 * 3_600_000));
  assert.equal(midDay.filter((column) => !column.recorded).length, 20);
  // Without the range the axis starts at the clamped window, so nothing is unrecorded.
  const { rangeDays: _range, ...unranged } = dailyAxis(through, 30, coverageStartedAt);
  assert.equal(buildColumns(series, [], [], "cost", unranged).length, 10);
});

test("hourly and weekly axes step by their bucket, and weeks start on the plane's Monday", () => {
  const through = Date.UTC(2026, 8, 3, 14, 30);
  const hourly = buildColumns(
    [{ bucketTs: Date.UTC(2026, 8, 3, 9), ...amount({ costUsd: 1 }) }], [], [], "cost",
    { granularity: "hour", since: Date.UTC(2026, 8, 2, 14), through, coverageStartedAt: 0, rangeDays: 1 },
  );
  assert.equal(hourly.length, 25, "a 24-hour range ending part way through an hour holds 25 hour buckets");
  assert.equal(hourly[0]!.bucketTs, Date.UTC(2026, 8, 2, 14));
  assert.equal(hourly.at(-1)!.bucketTs, Date.UTC(2026, 8, 3, 14));
  assert.equal(bucketStart(Date.UTC(2026, 8, 3, 14, 30), "week"), Date.UTC(2026, 7, 31), "Sep 3, 2026 is in the week of Monday Aug 31");
  assert.equal(bucketStart(Date.UTC(2026, 7, 31), "week"), Date.UTC(2026, 7, 31));
  assert.equal(bucketStart(Date.UTC(1970, 0, 1), "week"), Date.UTC(1969, 11, 29), "day zero, a Thursday, is in the week of Monday Dec 29");
  const weekly = buildColumns(
    [{ bucketTs: Date.UTC(2026, 7, 24), ...amount({ costUsd: 1 }) }], [], [], "cost",
    { granularity: "week", since: Date.UTC(2026, 7, 5), through, coverageStartedAt: 0, rangeDays: 30 },
  );
  assert.deepEqual(weekly.map((column) => column.bucketTs),
    [Date.UTC(2026, 7, 3), Date.UTC(2026, 7, 10), Date.UTC(2026, 7, 17), Date.UTC(2026, 7, 24), Date.UTC(2026, 7, 31)],
    "partial edge weeks are columns too");
  assert.equal(bucketStepMs("week"), 7 * DAY);
});

test("a malformed window is bounded, and a bucket off the axis grid is still drawn", () => {
  const through = Date.UTC(2026, 8, 4);
  const offGrid = through - DAY + 3_600_000;
  const columns = buildColumns([{ bucketTs: offGrid, ...amount({ costUsd: 1 }) }], [], [], "cost",
    { granularity: "day", since: 0, through, coverageStartedAt: 0 });
  assert.ok(columns.length <= 4_001, "an axis from 1970 is cut to a bounded number of buckets");
  assert.equal(columns.find((column) => column.bucketTs === offGrid)?.total, 1, "filling never drops a bucket the plane sent");
  assert.ok(columns.every((column, index) => index === 0 || column.bucketTs > columns[index - 1]!.bucketTs), "still in time order");
});

test("the resting readout gives the recorded average and the peak with its date", () => {
  const through = Date.UTC(2026, 8, 4);
  const coverageStartedAt = through - 4 * DAY;
  const series = [
    { bucketTs: through - 3 * DAY, ...amount({ costUsd: 4, inputTokens: 4_000 }) },
    { bucketTs: through - DAY, ...amount({ costUsd: 12, inputTokens: 1_000 }) },
  ];
  const columns = buildColumns(series, [], [], "cost", dailyAxis(through, 30, coverageStartedAt));
  // Four recorded days, $16 in all: the 26 Not Recorded days are not zero usage.
  assert.deepEqual(usageRestingSummary(columns, "cost", "day"), { average: "Daily average $4.00", peak: "Peak $12.00 on Sep 3" });
  const tokens = buildColumns(series, [], [], "tokens", dailyAxis(through, 30, coverageStartedAt));
  assert.deepEqual(usageRestingSummary(tokens, "tokens", "day"), { average: "Daily average 1.25K", peak: "Peak 4K on Sep 1" });
  const hour = [{ bucketTs: Date.UTC(2026, 8, 3, 14), total: 2, bands: [], recorded: true }];
  assert.equal(usageRestingSummary(hour, "cost", "hour").peak, "Peak $2.00 on Sep 3 at 14:00");
  assert.equal(usageRestingSummary(hour, "cost", "hour").average, "Hourly average $2.00");
  const week = [{ bucketTs: Date.UTC(2026, 7, 31), total: 2, bands: [], recorded: true }];
  assert.deepEqual(usageRestingSummary(week, "cost", "week"), { average: "Weekly average $2.00", peak: "Peak $2.00 in the week of Aug 31" });
  assert.equal(usageRestingSummary([{ ...week[0]!, total: 0 }], "cost", "week").peak, null, "no usage has no peak");
});

test("one ACP agent names the ACP series; anything less certain reads Other Agents, never ACP", () => {
  const acp = amount({ costUsd: 2, inputTokens: 200 });
  const data = (byAgent: Array<{ key: string } & UsageAmount>) => ({
    byDriver: [{ key: "claude-code", ...amount({ costUsd: 5, inputTokens: 500 }) }, { key: "acp", ...acp }],
    byAgent: [{ key: "claude", ...amount({ costUsd: 5, inputTokens: 500 }) }, ...byAgent],
  });
  const agents = [
    { id: "claude", driver: "claude-code" as const, name: "Claude Code" },
    { id: "gemini", name: "Gemini CLI" },
    { id: "goose", driver: "acp" as const, name: "Goose" },
  ];
  const labels = usageDriverLabels(data([{ key: "gemini / gemini-3-pro", ...acp }]), agents);
  assert.equal(labels.acp, "Gemini CLI", "the plane's `<agent id> / <model>` key resolves to its agent, and no driver is ACP");
  assert.equal(labels["claude-code"], "Claude Code");
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...acp }]), agents).acp, "Gemini CLI", "a row with no model is keyed by the id alone");
  // One agent across two models is still one agent; its rows add up to the ACP total.
  const [pro, flash] = [amount({ costUsd: 1.5, inputTokens: 150 }), amount({ costUsd: 0.5, inputTokens: 50 })];
  assert.equal(usageDriverLabels(data([{ key: "gemini / gemini-3-pro", ...pro }, { key: "gemini / gemini-3-flash", ...flash }]), agents).acp,
    "Gemini CLI");
  // A row two advertised ids could both claim is attributed to neither, so the named agent no
  // longer accounts for the whole ACP total.
  assert.equal(
    usageDriverLabels(data([{ key: "gemini / gemini-3-pro", ...pro }, { key: "gemini / nightly / x", ...flash }]),
      [...agents, { id: "gemini / nightly", name: "Gemini Nightly" }]).acp,
    OTHER_AGENTS_LABEL,
  );
  assert.equal(usageDriverLabels(data([{ key: "gemini / gemini-3-pro", ...pro }, { key: "unassigned", ...flash }]), agents).acp,
    OTHER_AGENTS_LABEL, "usage with no agent may be ACP usage");
  // The same agent on a second machine under the same name is still one agent.
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...acp }]), [...agents, { id: "gemini", name: "Gemini CLI" }]).acp, "Gemini CLI");
  const half = amount({ costUsd: 1, inputTokens: 100 });
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...half }, { key: "goose", ...half }]), agents).acp, OTHER_AGENTS_LABEL);
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...half }, { key: "Other", ...half }]), agents).acp, OTHER_AGENTS_LABEL,
    "ACP usage folded into the remainder may be another agent's");
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...half }, { key: "retired", ...half }]), agents).acp, OTHER_AGENTS_LABEL,
    "ACP usage by an agent no runner advertises may be another agent's");
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...acp }]), [...agents, { id: "gemini", name: "Gemini (Nightly)" }]).acp,
    OTHER_AGENTS_LABEL, "an id two machines name differently has no one name");
  assert.equal(usageDriverLabels(data([{ key: "gemini", ...acp }]), []).acp, OTHER_AGENTS_LABEL, "with no runners, no agent is known");
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
  // 33 columns at a 5-label limit step by 8: 0, 8, 16, 24 and the last, 32, a whole step from 24.
  // With 30 columns the 24 would sit 5 from the last, inside one step, so it is skipped.
  assert.deepEqual(axisLabelIndexes(33, 5), [0, 8, 16, 24, 32]);
  assert.deepEqual(axisLabelIndexes(29, 5), [0, 7, 14, 21, 28]);
  assert.deepEqual(axisLabelIndexes(30, 5), [0, 8, 16, 29], "a step label within one step of the last is skipped");
  assert.deepEqual(axisLabelIndexes(30, 5, 14), [0, 8, 29], "a wider end-anchored label clears more columns");
  assert.deepEqual(axisLabelIndexes(2, 8, 3), [1], "two columns too close for two labels keep only the last");
  assert.deepEqual(axisLabelIndexes(1), [0]);
  assert.deepEqual(axisLabelIndexes(0), []);
  for (let count = 1; count <= 400; count += 1) {
    for (const limit of [2, 3, 5, 8, 13]) {
      for (const lastClearance of [1, 2, 5]) {
        const indexes = axisLabelIndexes(count, limit, lastClearance);
        const step = count <= limit ? 1 : Math.ceil((count - 1) / (limit - 1));
        const where = `count ${count}, limit ${limit}, clearance ${lastClearance}`;
        assert.equal(indexes.at(-1), count - 1, `${where}: the last column is always labelled`);
        assert.ok(indexes.length <= Math.max(limit, 1), `${where}: at most the limit`);
        for (let index = 1; index < indexes.length; index += 1) {
          assert.ok(indexes[index]! - indexes[index - 1]! >= step, `${where}: two labels closer than a step`);
        }
        if (indexes.length > 1) {
          assert.ok(indexes.at(-1)! - indexes.at(-2)! >= lastClearance, `${where}: a label inside the last one's clearance`);
        }
      }
    }
  }
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

test("coverage items name offline machines, unpriced turns and rate-table state, in that order (#3016)", () => {
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: { status: "fresh", source: "x", fetchedAt: 1, knownModels: 2 } }), []);
  const items = coverageMessages({
    offlineMachines: ["Build Box"], unpricedRecords: 12, legacyClaudeCostRecords: 2,
    pricing: { status: "cached", source: "x", fetchedAt: 1, knownModels: 2 },
  });
  assert.deepEqual(items, [
    { kind: "offline-machines", machines: ["Build Box"] },
    { kind: "unpriced", records: 12 },
    { kind: "legacy-claude", records: 2 },
    { kind: "rates-cached" },
  ]);
  assert.deepEqual(items.map(coverageSentence), [
    "Build Box is offline, so usage it hasn't reported yet isn't counted.",
    "12 turns have no price because no rate is known for their model.",
    "Some older Claude Code costs were recorded in a way that can count a resumed session's spending more than once.",
    "Rates couldn't be updated, so costs use the last rates Wollipog loaded.",
  ]);
  assert.equal(coverageNeedsRates(items), true);
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: { status: "unavailable", source: "disabled", fetchedAt: null, knownModels: 0 } }),
    [{ kind: "rates-unavailable" }]);
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, pricing: undefined }), [], "a pre-v103 plane sends no pricing block");
  assert.deepEqual(coverageMessages({ offlineMachines: [], unpricedRecords: 0, legacyClaudeCostRecords: 0 }), []);
});

test("coverage sentences agree with their count, and only pricing gaps offer new rates (#3016)", () => {
  assert.equal(coverageSentence({ kind: "offline-machines", machines: ["Build Box", "Studio Mac"] }),
    "Build Box and Studio Mac are offline, so usage they haven't reported yet isn't counted.");
  assert.equal(coverageSentence({ kind: "unpriced", records: 1 }), "1 turn has no price because no rate is known for its model.");
  assert.equal(coverageSentence({ kind: "unpriced", records: 1200 }), "1,200 turns have no price because no rate is known for their model.");
  assert.equal(coverageNeedsRates([{ kind: "offline-machines", machines: ["Build Box"] }, { kind: "legacy-claude", records: 1 }]), false);
  assert.equal(coverageNeedsRates([{ kind: "rates-unavailable" }]), true);
});

test("a window is empty only with no processed tokens and no cost (#3016)", () => {
  assert.equal(usageIsEmpty(amount()), true);
  assert.equal(usageIsEmpty(amount({ inputTokens: 1 })), false);
  assert.equal(usageIsEmpty(amount({ costUsd: 0.01 })), false);
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

test("a Refresh Rates answer that isn't fresh names why, a skipped one says when to retry, and an older plane keeps its wording (#4056)", () => {
  const source = "https://rates.example/table.json";
  assert.equal(ratesRefreshProblem({ status: "fresh", source, fetchedAt: 1, knownModels: 1 }), null);
  assert.deepEqual(ratesRefreshProblem({ status: "fresh", source, fetchedAt: 1, knownModels: 1, refreshSkipped: { nextAttemptAt: 2, retryAfterMs: 20_000 } }), {
    summary: "This refresh was skipped because one ran less than a minute ago.",
    details: [
      "Wollipog tries the rate source at most once a minute. Try again in 20 seconds.",
      "The last attempt succeeded, so the rates are current.",
    ],
  }, "a skip is said even when the rates are fresh");
  assert.deepEqual(ratesRefreshProblem({ status: "unavailable", source: "disabled", fetchedAt: null, knownModels: 0 })?.details,
    ["Rate fetching is turned off on this control plane."]);
  assert.deepEqual(ratesRefreshProblem({ status: "cached", source, fetchedAt: 1, knownModels: 1, lastRefreshError: { message: "already a sentence.", at: 1 } })?.details,
    [`${source} couldn't be fetched: already a sentence.`, "The rates are still cached."]);
  assert.deepEqual(ratesRefreshProblem({ status: "cached", source, fetchedAt: 1, knownModels: 1, refreshSkipped: { nextAttemptAt: 2, retryAfterMs: 300 } }), {
    summary: "This refresh was skipped because one ran less than a minute ago.",
    details: ["Wollipog tries the rate source at most once a minute. Try again in 1 second."],
  });
  assert.match(ratesRefreshProblem({ status: "cached", source, fetchedAt: 1, knownModels: 1 })?.details[0] ?? "",
    /didn't return a usable rate table, so the rates are still cached\. .*the control plane's log has the cause\.$/);
});
