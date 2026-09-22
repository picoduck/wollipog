import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SubscriptionUsageResponse, UsageAggregationGranularity, UsageAggregationResponse } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { bucketLabel } from "../usage-view-model.js";
import { UsageView } from "./UsageView.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// `UsageView` starts a 30s `setInterval` that only its effect teardown clears, so an assertion that
// throws before this file's trailing `root.unmount()` would leave the timer rescheduling and the
// process unable to exit — a plain failure reading as a hung suite (#690, #899).
installDomTestCleanup(domWindow);

const response = (
  series: UsageAggregationResponse["series"],
  granularity: UsageAggregationResponse["granularity"] = "day",
): UsageAggregationResponse => ({
  granularity,
  since: 0,
  through: Date.UTC(2026, 0, 2),
  retention: { hourlyDays: 30, dailyDays: 365, coverageStartedAt: 0 },
  canManageRetention: false,
  privacy: "Content-free usage accounting.",
  totals: {
    inputTokens: 6, outputTokens: 0, costUsd: 0.06, uncachedInputTokens: 6, cachedInputTokens: 0,
    cacheCreationTokens: 0, reasoningTokens: 0, cacheSavingsUsd: 0, costSource: "providerReported", unpricedRecords: 0,
    processedTokens: 6,
  },
  series,
  seriesByDriver: series.map((bucket) => ({ ...bucket, driver: "claude-code" as const })),
  byDriver: [],
  byAgent: [],
  byRunner: [],
  byModel: [],
});

const bucket = (bucketTs: number, inputTokens: number, costUsd: number): UsageAggregationResponse["series"][number] => ({
  bucketTs, inputTokens, outputTokens: 0, costUsd, uncachedInputTokens: inputTokens, cachedInputTokens: 0,
  cacheCreationTokens: 0, reasoningTokens: 0, cacheSavingsUsd: 0, costSource: "providerReported", unpricedRecords: 0,
  processedTokens: inputTokens,
});

const settleLoad = () => new Promise((resolve) => setTimeout(resolve, 250));

test("UsageView keeps the control-plane newest-first order after a refresh", async () => {
  const olderDay = Date.UTC(2025, 11, 30);
  const newerDay = Date.UTC(2025, 11, 31);
  const newestDay = Date.UTC(2026, 0, 1);
  const dailySeries = [
    bucket(newestDay, 3, 0.03),
    bucket(newerDay, 2, 0.02),
    bucket(olderDay, 1, 0.01),
  ];
  const responses: UsageAggregationResponse[] = [
    response([
      bucket(newerDay, 2, 0.02),
      bucket(olderDay, 1, 0.01),
    ], "day"),
    response(dailySeries, "day"),
    response(dailySeries, "day"),
    response(dailySeries, "day"),
    response(dailySeries, "day"),
  ];
  let calls = 0;
  const requestedRanges: number[] = [];
  const requestedGranularities: UsageAggregationGranularity[] = [];
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { days: number; granularity?: UsageAggregationGranularity }) => {
      requestedRanges.push(query.days);
      requestedGranularities.push(query.granularity!);
      return responses[calls++]!;
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);

  await act(async () => {
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });
  const rowLabels = () => [...container.querySelectorAll("tbody th")].map((cell) => cell.textContent ?? "");
  assert.deepEqual(rowLabels(), [bucketLabel(newerDay, "day"), bucketLabel(olderDay, "day")]);

  const selectedRange = [...container.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").trim() === "30d") as HTMLButtonElement;
  await act(async () => {
    selectedRange.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(rowLabels(), dailySeries.map((bucket) => bucketLabel(bucket.bucketTs, "day")));

  for (const label of ["7d", "90d", "365d"]) {
    const range = [...container.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === label) as HTMLButtonElement;
    await act(async () => {
      range.click();
    });
    await act(async () => {
      await settleLoad();
      await Promise.resolve();
    });
    assert.deepEqual(
      rowLabels(),
      dailySeries.map((bucket) => bucketLabel(bucket.bucketTs, "day")),
      `${label} keeps every bucket newest-first`,
    );
  }
  assert.deepEqual(requestedRanges, [30, 30, 7, 90, 365]);
  assert.deepEqual(requestedGranularities, ["day", "day", "day", "day", "day"]);
  assert.equal(calls, 5, "refresh and each period selector load exactly once");

  await act(async () => root.unmount());
  container.remove();
});

test("chart and time breakdown share Hour, Day, and Week while retention explains unavailable hours", async () => {
  const calls: Array<{ days: number; granularity: UsageAggregationGranularity }> = [];
  const at = Date.UTC(2026, 8, 21);
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { days: number; granularity?: UsageAggregationGranularity }) => {
      const requested = query.granularity ?? "day";
      calls.push({ days: query.days, granularity: requested });
      return { ...response([bucket(at, 6, 0.06)], requested), hourlyDataAvailable: query.days !== 30 };
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });

  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;

  assert.equal(option("Usage Aggregation", "Hour").getAttribute("aria-disabled"), "true");
  assert.match(container.querySelector(".usage-granularity-note")?.textContent ?? "", /retained as daily buckets/);

  await act(async () => { option("Usage Breakdown", "Week").click(); });
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assert.deepEqual(calls.at(-1), { days: 30, granularity: "week" });
  assert.equal(option("Usage Aggregation", "Week").getAttribute("aria-checked"), "true");
  assert.match(container.querySelector(".usage-chart-section h3")?.textContent ?? "", /Weekly Cost/);
  assert.equal(container.querySelector("#usage-table-caption")?.textContent, "Weekly Usage in UTC");
  assert.match(container.querySelector(".usage-table tbody th")?.textContent ?? "", /Sep 21, 2026 00:00–Sep 27, 2026 23:59 UTC/);

  await act(async () => { option("Usage Aggregation", "Day").click(); });
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assert.equal(option("Usage Breakdown", "Day").getAttribute("aria-checked"), "true");
  assert.equal(container.querySelector("#usage-table-caption")?.textContent, "Daily Usage in UTC");

  await act(async () => { option("Usage Range", "90d").click(); });
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assert.equal(option("Usage Aggregation", "Hour").getAttribute("aria-disabled"), "true");
  assert.equal(option("Usage Breakdown", "Hour").getAttribute("aria-disabled"), "true");
  assert.match(container.querySelector(".usage-granularity-note")?.textContent ?? "", /retained for 30 days.*30 days or less/);

  await act(async () => root.unmount());
  container.remove();
});

test("an Hour request that discovers rolled data switches to Day and disables Hour", async () => {
  const calls: Array<{ days: number; granularity: UsageAggregationGranularity }> = [];
  const at = Date.UTC(2026, 8, 21);
  let rejectUnavailableHour: ((reason?: unknown) => void) | undefined;
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { days: number; granularity?: UsageAggregationGranularity }) => {
      const granularity = query.granularity ?? "day";
      calls.push({ days: query.days, granularity });
      if (query.days === 90 && granularity === "hour") {
        return await new Promise<UsageAggregationResponse>((_resolve, reject) => {
          rejectUnavailableHour = reject;
        });
      }
      return {
        ...response([bucket(at, 6, 0.06)], granularity),
        retention: { hourlyDays: 90, dailyDays: 365, coverageStartedAt: 0 },
        hourlyDataAvailable: query.days !== 90,
      };
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });

  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;
  await act(async () => { option("Usage Aggregation", "Hour").click(); await settleLoad(); });
  await act(async () => { option("Usage Range", "90d").click(); await settleLoad(); });
  assert.ok(rejectUnavailableHour, "the unavailable Hour request is in flight");
  await act(async () => {
    rejectUnavailableHour!(new ApiError(
      "hour granularity is unavailable because part of this range has been retained as daily buckets; choose day or week",
      400,
      "USAGE_HOURLY_DATA_UNAVAILABLE",
    ));
    await Promise.resolve();
  });
  assert.ok(container.querySelector(".usage-chart-section"), "the prior Hour chart remains visible during the handoff");
  assert.equal(container.querySelector("[aria-busy]")?.getAttribute("aria-busy"), "true",
    "the handoff stays busy until Day data arrives");
  await act(async () => { await settleLoad(); });

  assert.deepEqual(calls.slice(-2), [
    { days: 90, granularity: "hour" },
    { days: 90, granularity: "day" },
  ]);
  assert.equal(option("Usage Aggregation", "Day").getAttribute("aria-checked"), "true");
  assert.equal(option("Usage Breakdown", "Day").getAttribute("aria-checked"), "true");
  assert.equal(option("Usage Aggregation", "Hour").getAttribute("aria-disabled"), "true");
  assert.match(container.querySelector(".usage-granularity-note")?.textContent ?? "", /retained as daily buckets/);
  assert.equal(container.querySelector('[role="alert"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test("an older plane's implicit Day fallback disables Hour without showing an error", async () => {
  const at = Date.UTC(2026, 8, 21);
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => response(
      [bucket(at, 6, 0.06)],
      query.granularity === "hour" ? "day" : query.granularity ?? "day",
    ),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
  await act(async () => { await settleLoad(); });
  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;

  await act(async () => { option("Usage Aggregation", "Hour").click(); await settleLoad(); });
  assert.equal(option("Usage Aggregation", "Day").getAttribute("aria-checked"), "true");
  assert.equal(option("Usage Aggregation", "Hour").getAttribute("aria-disabled"), "true");
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.match(container.querySelector(".usage-granularity-note")?.textContent ?? "", /retained as daily buckets/);

  await act(async () => root.unmount());
  container.remove();
});

test("a retention save preserves aggregation changes made while the request is in flight", async () => {
  const at = Date.UTC(2026, 8, 21);
  let finishRetention: (() => void) | undefined;
  const retained = { hourlyDays: 30, dailyDays: 365, coverageStartedAt: 0 };
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => ({
      ...response([bucket(at, 6, 0.06)], query.granularity ?? "day"),
      canManageRetention: true,
    }),
    updateUsageRetention: async () => await new Promise<{ retention: typeof retained }>((resolve) => {
      finishRetention = () => resolve({ retention: retained });
    }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
  await act(async () => { await settleLoad(); });
  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;
  const save = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Save Retention") as HTMLButtonElement;

  await act(async () => { save.click(); await Promise.resolve(); });
  assert.ok(finishRetention, "the retention write is in flight");
  await act(async () => { option("Usage Aggregation", "Week").click(); await settleLoad(); });
  await act(async () => { finishRetention!(); await settleLoad(); });
  assert.equal(option("Usage Aggregation", "Week").getAttribute("aria-checked"), "true");
  assert.equal(option("Usage Breakdown", "Week").getAttribute("aria-checked"), "true");

  await act(async () => root.unmount());
  container.remove();
});

test("aggregation switches ignore stale responses and show request failures without mislabeled old data", async () => {
  const at = Date.UTC(2026, 8, 21);
  let holdWeek = true;
  let failWeek = false;
  let releaseWeek: ((value: UsageAggregationResponse) => void) | undefined;
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      const requested = query.granularity ?? "day";
      if (requested === "week" && holdWeek) {
        return await new Promise<UsageAggregationResponse>((resolve) => { releaseWeek = resolve; });
      }
      if (requested === "week" && failWeek) throw new Error("Weekly usage is temporarily unavailable");
      return response([bucket(at, 6, 0.06)], requested);
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  const aggregation = () => container.querySelector('[role="radiogroup"][aria-label="Usage Aggregation"]')!;
  const option = (label: string) => [...aggregation().querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === label) as HTMLButtonElement;

  await act(async () => { option("Week").click(); await new Promise((resolve) => setTimeout(resolve, 150)); });
  assert.ok(releaseWeek, "the weekly request is in flight");
  await act(async () => { option("Day").click(); await settleLoad(); await Promise.resolve(); });
  assert.match(container.querySelector(".usage-chart-section h3")?.textContent ?? "", /Daily Cost/);
  await act(async () => { releaseWeek!(response([bucket(at, 6, 0.06)], "week")); await Promise.resolve(); });
  assert.match(container.querySelector(".usage-chart-section h3")?.textContent ?? "", /Daily Cost/,
    "the late weekly response cannot replace the newer daily request");

  holdWeek = false;
  failWeek = true;
  await act(async () => { option("Week").click(); await settleLoad(); await Promise.resolve(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Weekly usage is temporarily unavailable/);
  assert.equal(container.querySelector(".usage-chart-section"), null,
    "a failed aggregation request never leaves the previous chart under the new selected label");

  await act(async () => root.unmount());
  container.remove();
});

test("Subscription Usage shows remaining allowance, local and relative resets, stale state, and text warnings", async () => {
  const now = Date.now();
  const subscription = (status: "warning" | "exhausted", remainingPercent: number): SubscriptionUsageResponse => ({
    staleAfterMs: 600_000,
    generatedAt: now,
    sources: [{
      sourceId: "a".repeat(32),
      runnerId: "runner-1",
      agentId: "codex",
      provider: "codex",
      providerAccountId: "work",
      accountLabel: "Work",
      state: "available",
      fetchedAt: now - 700_000,
      freshness: "stale",
      runnerStatus: "offline",
      runnerName: "Build Machine",
      agentName: "Codex",
      plan: "plus",
      buckets: [{
        id: "future_lane",
        label: "Future Lane",
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: now + 90 * 60_000,
        status,
      }],
      spendControls: [{ id: "monthly", label: "Monthly Limit", limit: "$100" }],
    }, {
      sourceId: "b".repeat(32),
      runnerId: "runner-1",
      agentId: "claude",
      provider: "claude",
      providerAccountId: "personal",
      accountLabel: "Personal",
      state: "unavailable",
      detail: "Usage appears after a provider response.",
      fetchedAt: now,
      freshness: "fresh",
      runnerStatus: "online",
      runnerName: "Build Machine",
      agentName: "Claude",
      buckets: [],
      spendControls: [],
    }],
  });
  let refreshes = 0;
  const refreshTargets: Array<{ runnerId: string; providerAccountId: string } | undefined> = [];
  const client = {
    ...api,
    usage: async () => response([]),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    subscriptionUsage: async () => subscription("warning", 15),
    refreshSubscriptionUsage: async (target?: { runnerId: string; providerAccountId: string }) => {
      refreshes++;
      refreshTargets.push(target);
      return subscription("exhausted", 0);
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });
  const pageText = () => container.textContent ?? "";
  assert.match(pageText(), /Subscription Usage/);
  assert.match(pageText(), /15% Remaining/);
  assert.match(pageText(), /⚠ Approaching Limit/);
  assert.match(pageText(), /Last Known — Stale/);
  assert.match(pageText(), /Resets in 2 hours/);
  assert.ok(pageText().includes(new Date(now + 90 * 60_000).toLocaleString()), "the exact reset uses the viewer's local time");
  assert.match(pageText(), /Machine Offline/);
  assert.match(pageText(), /Monthly Limit: Usage Reported of \$100/);

  const refresh = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Refresh") as HTMLButtonElement;
  await act(async () => {
    refresh.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(refreshes, 1);
  assert.equal(refreshTargets[0], undefined);
  assert.match(pageText(), /0% Remaining/);
  assert.match(pageText(), /⛔ Exhausted/);
  assert.match(pageText(), /Subscription usage refreshed/);
  const refreshAccount = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Refresh Account") as HTMLButtonElement;
  assert.equal(
    [...container.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === "Refresh Account").length,
    1,
    "only a Codex account exposes an active refresh probe",
  );
  await act(async () => {
    refreshAccount.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(refreshes, 2);
  assert.deepEqual(refreshTargets[1], { runnerId: "runner-1", providerAccountId: "work" });
  await act(async () => root.unmount());
  container.remove();
});

test("a window the provider never measured is marked absent, not shown as a value", async () => {
  const now = Date.now();
  const bucket = (id: string, measured: boolean) => ({
    id,
    label: id === "five_hour" ? "Five-Hour Window" : "Weekly — All Models",
    ...(measured ? { usedPercent: 40, remainingPercent: 60 } : {}),
    resetsAt: now + 90 * 60_000,
    status: "available" as const,
  });
  const subscription: SubscriptionUsageResponse = {
    staleAfterMs: 600_000,
    generatedAt: now,
    sources: [{
      sourceId: "b".repeat(32),
      runnerId: "runner-1",
      agentId: "claude",
      provider: "claude",
      state: "available",
      fetchedAt: now,
      freshness: "fresh",
      runnerStatus: "online",
      runnerName: "Build Machine",
      agentName: "Claude Code",
      buckets: [bucket("five_hour", false), bucket("seven_day", true)],
    }],
  };
  const client = {
    ...api,
    usage: async () => response([]),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    subscriptionUsage: async () => subscription,
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });

  const buckets = [...container.querySelectorAll(".subscription-bucket")];
  assert.equal(buckets.length, 2);
  const [unmeasured, measured] = buckets as HTMLElement[];
  assert.ok(unmeasured?.className.includes("unmeasured"), "the unmeasured window is distinguishable");
  assert.ok(!measured?.className.includes("unmeasured"));

  // The old bold "Allowance Reported" put a non-value where every sibling shows a percentage.
  assert.doesNotMatch(container.textContent ?? "", /Allowance Reported/);
  // The dash is decorative; the meaning reaches assistive technology as text, not as visual weight.
  assert.equal(unmeasured?.querySelector("[aria-hidden=\"true\"]")?.textContent, "—");
  assert.equal(unmeasured?.querySelector(".sr-only")?.textContent, "Utilization Not Reported");
  // The reset time is what that window does have to say, so it takes the prominent slot.
  assert.match(unmeasured?.querySelector("dd strong")?.textContent ?? "", /Resets in 2 hours/);
  // A measured window is untouched: the percentage keeps the prominent slot.
  assert.equal(measured?.querySelector("dd strong")?.textContent, "60% Remaining");
  assert.equal(measured?.querySelector(".sr-only"), null);

  await act(async () => root.unmount());
  container.remove();
});

test("an unsplit response from an older plane is shown honestly and the window comes from the response", async () => {
  const day = Date.UTC(2026, 0, 2);
  const unsplit: UsageAggregationResponse = {
    ...response([bucket(day, 4, 0.04), bucket(day - 86_400_000, 2, 0.02)], "day"),
    since: day - 6 * 86_400_000,
    through: day + 86_400_000,
    seriesByDriver: [],
    byDriver: [
      { key: "claude-code", ...bucket(0, 4, 0.04) },
      { key: "codex-app-server", ...bucket(0, 2, 0.02) },
    ].map(({ bucketTs: _ignored, ...row }) => row),
  };
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: 20, updatedAt: 1 } }),
    usageUsers: async () => ({ users: [{ userId: "u1", userName: "Ada", todayUsd: 21.5, last7DaysUsd: 40, last30DaysUsd: 90, dailyBudgetUsd: 20 }] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => ({
      ...unsplit,
      granularity: query.granularity ?? "day",
    }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });

  // The headline names the response's 7-day window although the default range control says 30d.
  assert.match(container.querySelector(".usage-headline-note")?.textContent ?? "", /last 7 days/);
  const codexCoverage = [...container.querySelectorAll(".usage-coverage")]
    .find((node) => node.textContent?.includes("Codex App Server"));
  assert.match(
    codexCoverage?.textContent ?? "",
    /before protocol v127 include only the final model response and are incomplete.*v127\+ records complete turn usage/s,
  );
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /not split by driver/);
  assert.equal(container.querySelector(".usage-legend"), null, "no legend claims a split that does not exist");
  const dayTable = container.querySelector(".usage-breakdown-section table")!;
  const driverCells = [...dayTable.querySelectorAll("tbody tr")].flatMap((row) => [...row.querySelectorAll("td.usage-cell-dim")].slice(0, 2));
  assert.ok(driverCells.length >= 4);
  assert.ok(driverCells.every((cell) => cell.textContent === "—"), "unknown per-driver values read as dashes, not $0.00");

  const hit = container.querySelector(".usage-chart-hit") as SVGRectElement;
  await act(async () => {
    hit.dispatchEvent(new domWindow.FocusEvent("focus", { bubbles: false }) as never);
    hit.dispatchEvent(new domWindow.Event("focusin", { bubbles: true }) as never);
    await Promise.resolve();
  });
  const readout = container.querySelector(".usage-chart-readout")?.textContent ?? "";
  assert.match(readout, /Not split by this control plane/);
  assert.match(readout, /Total/);

  const usersText = container.querySelector(".usage-users-section")?.textContent ?? "";
  assert.match(usersText, /Ada · paused by daily budget/);
  assert.match(usersText, /\$21\.50 of \$20\.00/);
  assert.match(usersText, /Each user may spend \$20\.00 per UTC day/);

  await act(async () => root.unmount());
  container.remove();
});

test("a pre-v103 response without seriesByDriver still renders", async () => {
  const day = Date.UTC(2026, 0, 2);
  const legacy = {
    ...response([bucket(day, 4, 0.04)], "day"),
    since: day,
    through: day + 86_400_000,
  };
  legacy.byDriver = [{
    key: "claude-code",
    ...bucket(0, 4, 0.04),
  }].map(({ bucketTs: _ignored, ...row }) => row);
  delete (legacy as Partial<UsageAggregationResponse>).seriesByDriver;
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => ({
      ...legacy,
      granularity: query.granularity ?? "day",
    }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });

  assert.match(container.querySelector(".usage-headline-note")?.textContent ?? "", /last 1 day/);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(container.textContent ?? "", /Codex App Server records/);
  await act(async () => root.unmount());
  container.remove();
});
