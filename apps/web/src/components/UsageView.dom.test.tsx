import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SubscriptionUsageResponse, UsageAggregationResponse } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { bucketLabel, UsageView } from "./UsageView.js";

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

const response = (
  series: UsageAggregationResponse["series"],
  granularity: UsageAggregationResponse["granularity"] = "hour",
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
});

const settleLoad = () => new Promise((resolve) => setTimeout(resolve, 250));

test("UsageView keeps the control-plane newest-first order after a refresh", async () => {
  const older = Date.UTC(2026, 0, 1, 10);
  const newer = Date.UTC(2026, 0, 1, 11);
  const newest = Date.UTC(2026, 0, 1, 12);
  const olderDay = Date.UTC(2025, 11, 30);
  const newerDay = Date.UTC(2025, 11, 31);
  const newestDay = Date.UTC(2026, 0, 1);
  const hourlySeries = [
    bucket(newest, 3, 0.03),
    bucket(newer, 2, 0.02),
    bucket(older, 1, 0.01),
  ];
  const dailySeries = [
    bucket(newestDay, 3, 0.03),
    bucket(newerDay, 2, 0.02),
    bucket(olderDay, 1, 0.01),
  ];
  const responses: UsageAggregationResponse[] = [
    response([
      bucket(newer, 2, 0.02),
      bucket(older, 1, 0.01),
    ]),
    response(hourlySeries),
    response(hourlySeries),
    response(dailySeries, "day"),
    response(dailySeries, "day"),
  ];
  let calls = 0;
  const requestedRanges: number[] = [];
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usage: async (query: { days: number }) => {
      requestedRanges.push(query.days);
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
  assert.deepEqual(rowLabels(), [bucketLabel(newer, "hour"), bucketLabel(older, "hour")]);

  const selectedRange = [...container.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").trim() === "30d") as HTMLButtonElement;
  await act(async () => {
    selectedRange.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(rowLabels(), hourlySeries.map((bucket) => bucketLabel(bucket.bucketTs, "hour")));

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
    const granularity = label === "7d" ? "hour" : "day";
    const expectedSeries = granularity === "hour" ? hourlySeries : dailySeries;
    assert.deepEqual(
      rowLabels(),
      expectedSeries.map((bucket) => bucketLabel(bucket.bucketTs, granularity)),
      `${label} keeps every bucket newest-first`,
    );
  }
  assert.deepEqual(requestedRanges, [30, 30, 7, 90, 365]);
  assert.equal(calls, 5, "refresh and each period selector load exactly once");

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
    }],
  });
  let refreshes = 0;
  const client = {
    ...api,
    usage: async () => response([]),
    subscriptionUsage: async () => subscription("warning", 15),
    refreshSubscriptionUsage: async () => {
      refreshes++;
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
  assert.match(pageText(), /0% Remaining/);
  assert.match(pageText(), /⛔ Exhausted/);
  assert.match(pageText(), /Subscription usage refreshed/);
  await act(async () => root.unmount());
  container.remove();
});
