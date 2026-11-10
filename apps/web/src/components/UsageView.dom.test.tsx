import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  RunnerView,
  UiSnapshotMessage,
  UsageAggregationGranularity,
  UsageAggregationResponse,
  UsageAmount,
  UsagePricingStatus,
  UserCostWindows,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { periodLabel } from "../usage-view-model.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { USAGE_SKELETON_DELAY_MS, UsageView } from "./UsageView.js";

const domWindow = new Window({ url: "http://localhost/" });
domWindow.localStorage.setItem("wollipog.hide-account-emails", "true");
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// `UsageView` debounces each aggregation request by 120ms through `window.setTimeout`, and React
// schedules that timer only when it commits the change, after a test has already started any real
// sleep. A 150ms sleep therefore left 30ms minus the render time, and a slow render under load lost
// the race (#1914). happy-dom binds its timers to Node's at import, so `node:test` mock timers never
// reach them. The window's timeout pair is replaced instead: a timeout fires only when a test
// advances this clock, and every request it starts settles before the advance returns.
const USAGE_DEBOUNCE_MS = 120;
const pendingTimeouts = new Map<number, { at: number; run: () => void }>();
let clockNow = 0;
let nextTimeoutId = 1;
Object.assign(domWindow, {
  setTimeout: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = nextTimeoutId++;
    pendingTimeouts.set(id, { at: clockNow + Math.max(0, Number(delay) || 0), run: () => callback(...args) });
    return id;
  },
  clearTimeout: (id: number) => { pendingTimeouts.delete(id); },
});

// Node's real `setImmediate` runs only once every queued microtask has, so a mocked request, the
// state updates it resolves into, and the commit that schedules the next debounce all land first.
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

const advanceTimeouts = async (ms: number) => {
  await drain();
  const until = clockNow + ms;
  for (;;) {
    const [next] = [...pendingTimeouts]
      .filter(([, timeout]) => timeout.at <= until)
      .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId);
    if (!next) break;
    const [id, timeout] = next;
    pendingTimeouts.delete(id);
    clockNow = timeout.at;
    timeout.run();
    await drain();
  }
  clockNow = until;
  await drain();
};

// `UsageView` starts a 30s `setInterval` that only its effect teardown clears, so an assertion that
// throws before this file's trailing `root.unmount()` would leave the timer rescheduling and the
// process unable to exit — a plain failure reading as a hung suite (#690, #899). The reset drops a
// debounce such a test left pending, so it cannot fire into the next test's first advance.
installDomTestCleanup(domWindow, { reset: () => pendingTimeouts.clear() });

const response = (
  series: UsageAggregationResponse["series"],
  granularity: UsageAggregationResponse["granularity"] = "day",
): UsageAggregationResponse => ({
  granularity,
  supportedGranularities: ["hour", "day", "week"],
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

const settleLoad = () => advanceTimeouts(USAGE_DEBOUNCE_MS);

/** The toolbar's Range menu, portalled to <body> while open. */
const rangeMenu = () => domWindow.document.body.querySelector('[role="menu"][aria-label="Range"]') as unknown as HTMLElement | null;
const menuText = (item: Element) => item.querySelector(".menu-text")?.textContent ?? "";
const openRangeMenu = async (container: HTMLElement) => {
  if (!rangeMenu()) {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Range: "]');
    assert.ok(trigger, "the toolbar has a Range menu button");
    await act(async () => { trigger!.click(); await Promise.resolve(); });
  }
  assert.ok(rangeMenu(), "the Range menu opens");
  return rangeMenu()!;
};
/** Each Range item's label and second line, in order. */
const rangeItems = async (container: HTMLElement) => [...(await openRangeMenu(container)).querySelectorAll('[role="menuitemradio"]')]
  .map((item) => ({ label: menuText(item), description: item.querySelector(".menu-desc")?.textContent ?? null }));
/** Chooses "Last {days} Days" from the Range menu, which closes it. */
const chooseRange = async (container: HTMLElement, days: number) => {
  const item = [...(await openRangeMenu(container)).querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    .find((candidate) => menuText(candidate) === `Last ${days} Days`);
  assert.ok(item, `the Range menu offers Last ${days} Days`);
  await act(async () => { item!.click(); await Promise.resolve(); await Promise.resolve(); });
};
/** The visible options of a segmented control, by label. */
const optionLabels = (container: HTMLElement, group: string) =>
  [...container.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)].map((node) => node.textContent?.trim() ?? "");
/** The Breakdown's tab row (#3013). */
const breakdownTabs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Breakdown"] [role="tab"]')];
const breakdownTabLabels = (container: HTMLElement) => breakdownTabs(container).map((tab) => tab.textContent?.trim() ?? "");
const selectedBreakdownTab = (container: HTMLElement) =>
  breakdownTabs(container).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent?.trim();
const chooseBreakdown = async (container: HTMLElement, label: string) => {
  const tab = breakdownTabs(container).find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(tab, `the Breakdown has a ${label} tab`);
  await act(async () => { tab!.click(); await Promise.resolve(); });
};
/** The time table's row names, without the figure folded under them in the compact tier. */
const periodLabels = (container: HTMLElement) => [...container.querySelectorAll(".usage-period")].map((node) => node.textContent ?? "");

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
    root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });
  assertNoDomNode(container.querySelector("#usage-subscriptions-panel"), "subscription allowances wait in their own tab");
  const rowLabels = () => periodLabels(container);
  assert.deepEqual(rowLabels(), [periodLabel(newerDay, "day"), periodLabel(olderDay, "day")]);

  // Choosing the current range again is a refresh.
  await chooseRange(container, 30);
  assert.deepEqual(rowLabels(), dailySeries.map((bucket) => periodLabel(bucket.bucketTs, "day")));

  for (const days of [7, 90, 365]) {
    const label = `Last ${days} Days`;
    await chooseRange(container, days);
    assert.equal(container.querySelector('button[aria-label^="Range: "]')?.textContent, label);
    await act(async () => {
      await settleLoad();
      await Promise.resolve();
    });
    assert.deepEqual(
      rowLabels(),
      dailySeries.map((bucket) => periodLabel(bucket.bucketTs, "day")),
      `${label} keeps every bucket newest-first`,
    );
  }
  assert.deepEqual(requestedRanges, [30, 30, 7, 90, 365]);
  assert.deepEqual(requestedGranularities, ["day", "day", "day", "day", "day"]);
  assert.equal(calls, 5, "refresh and each period selector load exactly once");

  await act(async () => root.unmount());
  container.remove();
});

test("with 14 days of hourly retention, Group By omits Hour past 14 days and the Range menu says where it is", async () => {
  const at = Date.UTC(2026, 8, 21);
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { days: number; granularity?: UsageAggregationGranularity }) => ({
      ...response([bucket(at, 6, 0.06)], query.granularity ?? "day"),
      retention: { hourlyDays: 14, dailyDays: 365, coverageStartedAt: 0 },
      hourlyDataAvailable: query.days <= 14,
    }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  // No Hour option is ever drawn disabled: it is there or it is not.
  const disabledHour = () => [...container.querySelectorAll('[role="radio"][aria-disabled="true"]')]
    .filter((node) => node.textContent?.trim() === "Hour");

  assert.deepEqual(optionLabels(container, "Group By"), ["Day", "Week"]);
  assert.deepEqual(breakdownTabLabels(container), ["By Day", "By Model", "By Agent", "By Machine", "By Person"]);
  assert.equal(disabledHour().length, 0);
  assert.deepEqual(await rangeItems(container), [
    { label: "Last 7 Days", description: "Hour grouping is available for ranges up to 14 days." },
    { label: "Last 30 Days", description: null },
    { label: "Last 90 Days", description: null },
    { label: "Last 365 Days", description: null },
  ]);
  assert.equal(rangeMenu()!.querySelector('[aria-checked="true"]') && menuText(rangeMenu()!.querySelector('[aria-checked="true"]')!), "Last 30 Days");

  await chooseRange(container, 7);
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assertNoDomNode(rangeMenu(), "a choice closes the Range menu");
  assert.deepEqual(optionLabels(container, "Group By"), ["Hour", "Day", "Week"]);
  assert.equal(disabledHour().length, 0);
  // Nothing about Hour or retention is left on the page while the menu is closed.
  assert.doesNotMatch(container.textContent ?? "", /Hour grouping|retained/);

  await act(async () => root.unmount());
  container.remove();
});

test("a plane without weekly support has no Week, and the Range menu ends with why", async () => {
  const at = Date.UTC(2026, 8, 21);
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => ({
      ...response([bucket(at, 6, 0.06)], query.granularity ?? "day"),
      supportedGranularities: ["hour", "day"],
      hourlyDataAvailable: true,
    }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });

  assert.deepEqual(optionLabels(container, "Group By"), ["Hour", "Day"]);
  const menu = await openRangeMenu(container);
  const last = menu.lastElementChild;
  assert.ok(last?.classList.contains("menu-note"), "the Range menu ends with a note");
  assert.equal(last?.textContent, "Week grouping needs a newer version of Wollipog.");
  assertNoDomNode(container.querySelector(".menu-note"), "the note lives only in the menu");

  await act(async () => root.unmount());
  container.remove();
});

test("About These Numbers holds the caveats: estimate, rate source, coverage date without a time, privacy", async () => {
  const at = Date.UTC(2026, 8, 21);
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => ({
      ...response([bucket(at, 6, 0.06)], query.granularity ?? "day"),
      retention: { hourlyDays: 30, dailyDays: 365, coverageStartedAt: Date.UTC(2026, 6, 1, 14, 30) },
      pricing: { status: "fresh", source: "https://example.com/rates.json", fetchedAt: at, knownModels: 10 },
    }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assert.doesNotMatch(container.textContent ?? "", /published API rates|Recording started|Only totals/,
    "no caveat is on screen until About These Numbers opens");

  const about = container.querySelector<HTMLButtonElement>('.usage-toolbar > button[aria-haspopup="dialog"]');
  assert.equal(about?.textContent, "About These Numbers", "a visible label on desktop");
  await act(async () => { about!.click(); await Promise.resolve(); });
  const dialog = domWindow.document.body.querySelector('[role="dialog"][aria-label="About These Numbers"]');
  assert.ok(dialog, "the popover opens");
  const text = dialog!.textContent ?? "";
  assert.match(text, /These are estimates at published API rates, not a bill\. Subscription plans are not billed this way\./);
  assert.match(text, /Recording started Jul 1, 2026\. Earlier usage isn't in these charts\./);
  assert.doesNotMatch(text, /14:30|2:30/, "the coverage date has no time of day");
  assert.match(text, /Only totals are stored: no prompts, file paths, tool inputs or session content\./);
  assert.doesNotMatch(text, /Codex App Server/, "the Codex sentence waits for Codex usage");
  const link = dialog!.querySelector("a");
  assert.equal(link?.getAttribute("href"), "https://example.com/rates.json");
  assert.equal(dialog!.querySelector("dt")?.textContent, "Rate Source");

  await act(async () => root.unmount());
  container.remove();
});

test("Group By is the one aggregation control: it renames the time tab, and a Breakdown tab never re-aggregates", async () => {
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });

  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;

  // This range's hours were already rolled into days.
  assert.deepEqual(optionLabels(container, "Group By"), ["Day", "Week"]);

  assertNoDomNode(container.querySelector('[role="radiogroup"][aria-label="Usage Breakdown"]'), "the Breakdown has no aggregation control of its own");
  assert.equal(selectedBreakdownTab(container), "By Day");
  assert.equal(container.querySelector(".usage-table thead th")?.textContent, "Day (UTC)");

  await act(async () => { option("Group By", "Week").click(); });
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assert.deepEqual(calls.at(-1), { days: 30, granularity: "week" });
  assert.equal(option("Group By", "Week").getAttribute("aria-checked"), "true");
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /^Weekly cost/);
  assert.deepEqual(breakdownTabLabels(container), ["By Week", "By Model", "By Agent", "By Machine", "By Person"]);
  assert.equal(container.querySelector(".usage-table thead th")?.textContent, "Week (UTC)");
  assert.deepEqual(periodLabels(container), [periodLabel(at, "week", { since: 0, through: Date.UTC(2026, 0, 2) })]);
  assert.match(periodLabels(container)[0]!, /^Sep 21–27, 2026/);

  // Every other tab changes the dimension only: no request, and the chart keeps its aggregation.
  const requests = calls.length;
  for (const label of ["By Model", "By Agent", "By Machine", "By Person", "By Week"]) {
    await chooseBreakdown(container, label);
    await act(async () => { await settleLoad(); await Promise.resolve(); });
    assert.equal(selectedBreakdownTab(container), label);
    assert.equal(calls.length, requests, `${label} does not re-aggregate`);
    assert.equal(option("Group By", "Week").getAttribute("aria-checked"), "true");
    assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /^Weekly cost/);
  }

  await chooseBreakdown(container, "By Model");
  await act(async () => { option("Group By", "Day").click(); });
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  assert.equal(selectedBreakdownTab(container), "By Model", "Group By leaves the chosen tab alone");
  assert.equal(breakdownTabLabels(container)[0], "By Day");
  await chooseBreakdown(container, "By Day");
  assert.deepEqual(periodLabels(container), [periodLabel(at, "day")]);

  await chooseRange(container, 90);
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  // Past hourly retention Hour is omitted from both, never drawn disabled.
  assert.deepEqual(optionLabels(container, "Group By"), ["Day", "Week"]);
  assert.deepEqual((await rangeItems(container)).map((item) => item.description), [
    "Hour grouping is available for ranges up to 30 days.",
    "Hour grouping is available for ranges up to 30 days.",
    null,
    null,
  ]);

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
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });

  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;
  await act(async () => { option("Group By", "Hour").click(); await settleLoad(); });
  await chooseRange(container, 90);
  await act(async () => { await settleLoad(); });
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
  assert.equal(option("Group By", "Day").getAttribute("aria-checked"), "true");
  assert.equal(breakdownTabLabels(container)[0], "By Day");
  assert.deepEqual(optionLabels(container, "Group By"), ["Day", "Week"], "Hour is omitted, not disabled");
  assertNoDomNode(container.querySelector('[role="alert"]'));

  await act(async () => root.unmount());
  container.remove();
});

test("an older plane's implicit Day fallback disables Hour without showing an error", async () => {
  const at = Date.UTC(2026, 8, 21);
  const legacyResponse = (granularity: UsageAggregationGranularity) => {
    const current = response([bucket(at, 6, 0.06)], granularity);
    delete current.supportedGranularities;
    return current;
  };
  const calls: UsageAggregationGranularity[] = [];
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      const requested = query.granularity ?? "day";
      calls.push(requested);
      return legacyResponse(requested === "hour" ? "day" : requested);
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); });
  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;

  // An older plane cannot aggregate by week, so Week is not offered at all and the Range menu says why.
  assert.deepEqual(optionLabels(container, "Group By"), ["Hour", "Day"]);
  const note = (await openRangeMenu(container)).lastElementChild?.textContent ?? "";
  assert.equal(note, "Week grouping needs a newer version of Wollipog.");
  assert.doesNotMatch(note, /control plane/i, "docs/design-system.md §17.2 retires the term");
  await act(async () => { rangeMenu()!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never); });

  const callCount = calls.length;
  await act(async () => { option("Group By", "Hour").click(); await settleLoad(); });
  await act(async () => { await settleLoad(); });
  assert.ok(calls.length > callCount, "Hour was requested");
  assert.ok(!calls.includes("week"), "an older plane never receives an unsupported Week request");
  assert.equal(option("Group By", "Day").getAttribute("aria-checked"), "true");
  assert.deepEqual(optionLabels(container, "Group By"), ["Day"], "the implicit Day fallback omits Hour");
  assertNoDomNode(container.querySelector('[role="alert"]'));

  await act(async () => root.unmount());
  container.remove();
});

test("Week names Wollipog while its availability is still being checked", async () => {
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    // The first usage response is what reports the supported granularities, so it never arrives here.
    usage: () => new Promise(() => {}),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); });

  const week = [...container.querySelectorAll('[role="radiogroup"][aria-label="Group By"] [role="radio"]')]
    .find((node) => node.textContent?.trim() === "Week") as HTMLButtonElement;
  assert.equal(week.getAttribute("aria-disabled"), "true");
  const descriptionId = week.getAttribute("aria-describedby");
  assert.ok(descriptionId);
  assert.equal(domWindow.document.getElementById(descriptionId!)?.textContent ?? "",
    "Checking whether this version of Wollipog supports weekly aggregation.");

  await act(async () => root.unmount());
  container.remove();
});

test("an initial usage failure gives unavailable Week an actionable retry explanation", async () => {
  let calls = 0;
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async () => {
      calls += 1;
      throw new Error("Usage is temporarily unavailable");
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });

  const week = [...container.querySelectorAll('[role="radiogroup"][aria-label="Group By"] [role="radio"]')]
    .find((node) => node.textContent?.trim() === "Week") as HTMLButtonElement;
  assert.equal(week.getAttribute("aria-disabled"), "true");
  const descriptionId = week.getAttribute("aria-describedby");
  assert.ok(descriptionId);
  assert.match(domWindow.document.getElementById(descriptionId!)?.textContent ?? "", /could not be checked\. Retry by choosing a range/);
  assert.equal(week.getAttribute("title"), "Weekly availability could not be checked. Retry by choosing a range.");
  const callCount = calls;
  await act(async () => { week.click(); await settleLoad(); });
  assert.equal(calls, callCount, "failed capability discovery still cannot submit a Week request");

  await act(async () => root.unmount());
  container.remove();
});

test("an unavailable Hour response cannot replace a newer Week selection during debounce", async () => {
  const at = Date.UTC(2026, 8, 21);
  let rejectHour: ((reason?: unknown) => void) | undefined;
  const calls: UsageAggregationGranularity[] = [];
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      const granularity = query.granularity ?? "day";
      calls.push(granularity);
      if (granularity === "hour") {
        return await new Promise<UsageAggregationResponse>((_resolve, reject) => { rejectHour = reject; });
      }
      return { ...response([bucket(at, 6, 0.06)], granularity), hourlyDataAvailable: true };
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); });
  const group = (label: string) => container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
  const option = (label: string, value: string) => [...group(label).querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === value) as HTMLButtonElement;

  await act(async () => { option("Group By", "Hour").click(); await settleLoad(); });
  assert.ok(rejectHour, "the Hour request is in flight");
  await act(async () => {
    option("Group By", "Week").click();
    rejectHour!(new ApiError("rolled", 400, "USAGE_HOURLY_DATA_UNAVAILABLE"));
    await Promise.resolve();
  });
  await act(async () => { await settleLoad(); });

  assert.equal(option("Group By", "Week").getAttribute("aria-checked"), "true");
  assert.equal(breakdownTabLabels(container)[0], "By Week");
  assert.equal(calls.at(-1), "week");
  assertNoDomNode(container.querySelector('[role="alert"]'));

  await act(async () => root.unmount());
  container.remove();
});

/** A Usage page over `usage`, with the budget and retention writes the dialog makes recorded. */
const renderBudgetHistory = async ({
  canManage = true,
  usersFail = false,
  perUserUsd = 25 as number | null,
  updateUsageDailyBudget = async (value: number | null) => ({ dailyBudget: { perUserUsd: value, updatedAt: 1 } }),
  updateUsageRetention = async (input: { hourlyDays: number; dailyDays: number }) => ({ retention: { ...input, coverageStartedAt: 0 } }),
}: {
  canManage?: boolean;
  usersFail?: boolean;
  perUserUsd?: number | null;
  updateUsageDailyBudget?: (value: number | null) => Promise<{ dailyBudget: { perUserUsd: number | null; updatedAt: number } }>;
  updateUsageRetention?: (input: { hourlyDays: number; dailyDays: number }) => Promise<{ retention: { hourlyDays: number; dailyDays: number; coverageStartedAt: number } }>;
} = {}) => {
  const at = Date.UTC(2026, 8, 21);
  const writes: Array<["budget", number | null] | ["retention", { hourlyDays: number; dailyDays: number }]> = [];
  let budget = perUserUsd;
  const usageQueries: string[] = [];
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: budget, updatedAt: null } }),
    usageUsers: async () => {
      if (usersFail) throw new Error("Unable to list people");
      return { users: [] };
    },
    usage: async (query: { days?: number; granularity?: UsageAggregationGranularity }) => {
      usageQueries.push(`${query.days}:${query.granularity}`);
      return { ...response([bucket(at, 6, 0.06)], query.granularity ?? "day"), canManageRetention: canManage };
    },
    updateUsageDailyBudget: async (value: number | null) => {
      writes.push(["budget", value]);
      const result = await updateUsageDailyBudget(value);
      budget = result.dailyBudget.perUserUsd;
      return result;
    },
    updateUsageRetention: async (input: { hourlyDays: number; dailyDays: number }) => {
      writes.push(["retention", input]);
      return await updateUsageRetention(input);
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><FeedbackProvider><UsageView tab="api" /></FeedbackProvider></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  const body = domWindow.document.body as unknown as HTMLElement;
  const dialogs = () => [...body.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const dialog = (title: string) => dialogs().find((candidate) => candidate.querySelector(".modal-title")?.textContent === title) ?? null;
  const button = (scope: ParentNode, name: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name);
    assert.ok(found, `expected a ${name} button`);
    return found!;
  };
  const field = (label: string) => {
    const owner = dialog("Budget and History")!;
    const labelNode = [...owner.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
    assert.ok(labelNode, `expected a ${label} field`);
    return domWindow.document.getElementById(labelNode!.htmlFor) as unknown as HTMLInputElement;
  };
  const type = async (label: string, value: string) => {
    await act(async () => { fireDomEvent.change(field(label), { target: { value } }); });
  };
  const leave = async (label: string) => {
    await act(async () => { field(label).dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event); });
  };
  const open = async () => {
    await act(async () => { button(container, "Budget and History…").click(); await Promise.resolve(); });
    assert.ok(dialog("Budget and History"), "Budget and History opens");
  };
  const save = async () => {
    await act(async () => { button(dialog("Budget and History")!, "Save Changes").click(); await drain(); await drain(); });
  };
  const toast = () => body.querySelector(".toast");
  return {
    container, body, writes, usageQueries, dialog, button, field, type, leave, open, save, toast,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
};

test("an owner opens Budget and History from the header and By Person; a member sees the sentence only (#3015)", async () => {
  for (const canManage of [true, false]) {
    const page = await renderBudgetHistory({ canManage });
    try {
      const header = page.container.querySelector(".page-header")!;
      const headerAction = [...header.querySelectorAll("button")].find((candidate) => candidate.textContent === "Budget and History…");
      assert.equal(Boolean(headerAction), canManage, `the header's Budget and History… (canManage ${canManage})`);
      await chooseBreakdown(page.container, "By Person");
      const head = page.container.querySelector(".usage-person-head")!;
      assert.match(head.textContent ?? "", /Each person can spend \$25\.00 per UTC day\./);
      const change = [...head.querySelectorAll("button")].find((candidate) => candidate.textContent === "Change Budget…");
      assert.equal(Boolean(change), canManage, `By Person's Change Budget… (canManage ${canManage})`);
      if (change) assert.equal(change.className, "btn sm");
      // The page holds no form and no field of its own, and no primary button outside the dialog.
      assertNoDomNode(page.container.querySelector("form, input"));
      assertNoDomNode(page.container.querySelector(".btn.primary"));
      assert.doesNotMatch(page.container.textContent ?? "", /Retention|Save Daily Budget/);
    } finally {
      await page.unmount();
    }
  }
});

test("Budget and History's fields, and Change Budget… opening it in the budget field (#3015)", async () => {
  const page = await renderBudgetHistory();
  try {
    await page.open();
    const dialog = page.dialog("Budget and History")!;
    assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Applies to everyone who uses this Wollipog.");
    assert.deepEqual([...dialog.querySelectorAll("h3")].map((heading) => heading.textContent), ["Daily Budget", "History Kept"]);
    const budget = page.field("Daily Budget per Person (Optional)");
    assert.equal(budget.value, "25");
    assert.equal(budget.closest(".input-affix")?.querySelector(".input-affix-text")?.textContent, "$");
    assert.equal(page.field("Hourly Detail").value, "30");
    assert.equal(page.field("Daily Totals").value, "365");
    for (const label of ["Daily Budget per Person (Optional)", "Hourly Detail", "Daily Totals"]) {
      const input = page.field(label);
      assert.equal(input.hasAttribute("min") || input.hasAttribute("max"), false, `${label} has no min or max`);
      assert.ok(input.classList.contains("w-xs") || input.closest(".w-xs"), `${label} is a 96px field`);
    }
    assert.equal(dialog.querySelector("form")?.noValidate, true);
    const helpers = [...dialog.querySelectorAll(".field-helper")].map((helper) => helper.textContent);
    assert.deepEqual(helpers, [
      "New turns pause for the rest of the UTC day once a person reaches it. Leave empty for no limit.",
      "1 to 90 days.",
      "30 to 3,650 days.",
    ]);
    assert.match(dialog.textContent ?? "", /Only usage charts use this history\. Transcripts and audit logs are kept separately\./);
    assert.equal(page.button(dialog, "Save Changes").className.includes("primary"), true);
    await act(async () => { page.button(dialog, "Cancel").click(); await drain(); });
    assertNoDomNode(page.dialog("Budget and History"));

    await chooseBreakdown(page.container, "By Person");
    await act(async () => { page.button(page.container, "Change Budget…").click(); await drain(); });
    assert.equal(domWindow.document.activeElement, page.field("Daily Budget per Person (Optional)") as never);
  } finally {
    await page.unmount();
  }
});

test("-5 and 500 show both inline errors on Save Changes, send nothing and say Fix 2 fields to save (#3015)", async () => {
  const page = await renderBudgetHistory();
  try {
    await page.open();
    await page.type("Daily Budget per Person (Optional)", "-5");
    await page.type("Hourly Detail", "500");
    // Nothing shows while typing; an edited field shows its error once it is left.
    assertNoDomNode(page.dialog("Budget and History")!.querySelector(".field-error"));
    await page.save();
    const dialog = page.dialog("Budget and History")!;
    assert.deepEqual(page.writes, [], "nothing is sent");
    const budget = page.field("Daily Budget per Person (Optional)");
    const hourly = page.field("Hourly Detail");
    for (const [input, message] of [
      [budget, "Enter an amount of at least $0.01, or leave it empty for no limit."],
      [hourly, "Enter 1 to 90 days."],
    ] as const) {
      assert.equal(input.getAttribute("aria-invalid"), "true");
      const error = domWindow.document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!);
      assert.ok(error?.classList.contains("field-error"), "aria-describedby names the error");
      assert.equal(error?.textContent, message);
    }
    // The error replaces the helper.
    assert.equal([...dialog.querySelectorAll(".field-helper")].some((helper) => helper.textContent === "1 to 90 days."), false);
    assert.equal(page.field("Daily Totals").getAttribute("aria-invalid"), null);
    assert.equal(dialog.querySelector(".modal-foot .budget-history-reason")?.textContent, "Fix 2 fields to save.");
    assert.equal(domWindow.document.activeElement, budget as never, "focus moves to the first invalid field");

    // A valid value clears its error as it is typed, and the count follows.
    await page.type("Hourly Detail", "14");
    assert.equal(page.field("Hourly Detail").getAttribute("aria-invalid"), null);
    assert.equal(dialog.querySelector(".budget-history-reason")?.textContent, "Fix 1 field to save.");
    await page.type("Daily Budget per Person (Optional)", "");
    assertNoDomNode(dialog.querySelector(".budget-history-reason"));

    // Daily Totals' range follows Hourly Detail, and its error shows on leaving it after an edit.
    await page.type("Hourly Detail", "60");
    await page.type("Daily Totals", "45");
    await page.leave("Daily Totals");
    assert.equal(dialog.querySelector(".field-error")?.textContent, "Enter 60 to 3,650 days.");
  } finally {
    await page.unmount();
  }
});

test("a shorter period warns, then asks Shorten Usage History; Cancel keeps every value and returns to Save Changes (#3015)", async () => {
  const page = await renderBudgetHistory();
  try {
    await page.open();
    await page.type("Daily Budget per Person (Optional)", "30");
    await page.type("Hourly Detail", "14");
    const dialog = page.dialog("Budget and History")!;
    const warning = dialog.querySelector(".field-warn");
    assert.equal(warning?.textContent, "Shorter than now (30 days). Older hourly detail will be deleted.");
    assert.ok(page.field("Hourly Detail").getAttribute("aria-describedby")!.includes(warning!.querySelector("span")!.id));

    await page.save();
    const confirmation = page.dialog("Shorten Usage History");
    assert.ok(confirmation, "the confirmation opens over the dialog");
    assert.ok(page.dialog("Budget and History"), "the dialog stays open under it");
    assert.match(confirmation!.textContent ?? "",
      /Hourly detail older than 14 days is deleted now, so hourly charts will start at [A-Z][a-z]{2} \d{1,2}(, \d{4})?\. Daily totals are not affected\. This can't be undone\./);
    assert.equal(page.button(confirmation!, "Shorten History").className, "btn danger");
    assert.deepEqual(page.writes, [], "nothing is sent before the confirmation");

    await act(async () => { page.button(confirmation!, "Cancel").click(); await advanceTimeouts(0); });
    assertNoDomNode(page.dialog("Shorten Usage History"));
    assert.equal(page.field("Daily Budget per Person (Optional)").value, "30");
    assert.equal(page.field("Hourly Detail").value, "14");
    assert.equal(domWindow.document.activeElement, page.button(page.dialog("Budget and History")!, "Save Changes") as never);
    assert.deepEqual(page.writes, []);

    await page.save();
    await act(async () => { page.button(page.dialog("Shorten Usage History")!, "Shorten History").click(); await drain(); await drain(); });
    assert.deepEqual(page.writes, [["budget", 30], ["retention", { hourlyDays: 14, dailyDays: 365 }]], "the budget, then the retention");
    assertNoDomNode(page.dialog("Budget and History"));
    assert.equal(page.toast()?.querySelector(".toast-message")?.textContent, "Budget and history saved.");
    assert.equal(page.toast()?.querySelector(".toast-detail")?.textContent,
      "Daily budget $30.00 per person. Hourly detail 14 days, daily totals 365 days.");
  } finally {
    await page.unmount();
  }
});

test("when the retention fails after the budget saved, the notice says so and a retry sends only the retention (#3015)", async () => {
  let failRetention = true;
  const page = await renderBudgetHistory({
    updateUsageRetention: async (input) => {
      if (failRetention) throw new ApiError("dailyDays must be between max(hourlyDays, 30) and 3650", 400, "BAD_REQUEST");
      return { retention: { ...input, coverageStartedAt: 0 } };
    },
  });
  try {
    await page.open();
    await page.type("Daily Budget per Person (Optional)", "40");
    await page.type("Daily Totals", "400");
    await page.save();
    const dialog = page.dialog("Budget and History")!;
    assert.ok(dialog, "the dialog stays open");
    const notice = dialog.querySelector('.notice.t-danger[role="alert"]')!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Save Changes");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "The daily budget was saved. History wasn't changed.");
    assert.doesNotMatch(notice.textContent ?? "", /dailyDays must be/, "the server's words wait behind Show Details");
    await act(async () => { page.button(notice, "Show Details").click(); });
    assert.match(notice.textContent ?? "", /dailyDays must be between/);
    // The notice sits at the body's end, directly above the footer (§7.3).
    assert.equal(dialog.querySelector(".modal-body form")?.lastElementChild, notice as never);

    // By Person already shows the budget that saved.
    await act(async () => { page.button(dialog, "Cancel").click(); await drain(); });
    await chooseBreakdown(page.container, "By Person");
    assert.match(page.container.querySelector(".usage-person-head")?.textContent ?? "", /\$40\.00 per UTC day/);

    failRetention = false;
    await page.open();
    await page.type("Daily Totals", "400");
    await page.save();
    assert.deepEqual(page.writes, [
      ["budget", 40],
      ["retention", { hourlyDays: 30, dailyDays: 400 }],
      ["retention", { hourlyDays: 30, dailyDays: 400 }],
    ]);
    assertNoDomNode(page.dialog("Budget and History"));
  } finally {
    await page.unmount();
  }
});

test("a budget failure saves nothing else and says the budget wasn't saved (#3015)", async () => {
  const page = await renderBudgetHistory({
    updateUsageDailyBudget: async () => { throw new ApiError("Daily cost budgets cannot be enabled while a user-owned Agent TUI is running", 409, "CONFLICT"); },
  });
  try {
    await page.open();
    await page.type("Daily Budget per Person (Optional)", "40");
    await page.save();
    const notice = page.dialog("Budget and History")!.querySelector(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent, "The daily budget wasn't saved.");
    await page.type("Daily Totals", "400");
    assertNoDomNode(page.dialog("Budget and History")!.querySelector(".notice"), "an edit clears the failure");
    await page.save();
    assert.equal(page.dialog("Budget and History")!.querySelector(".notice-body")?.textContent, "Nothing was changed.");
    assert.deepEqual(page.writes.map(([kind]) => kind), ["budget", "budget"], "history is never sent after the budget failed");
  } finally {
    await page.unmount();
  }
});

test("a people list that fails to load still leaves Budget and History open to change history (#3015)", async () => {
  const page = await renderBudgetHistory({ usersFail: true });
  try {
    await chooseBreakdown(page.container, "By Person");
    assert.equal(page.container.querySelector('.notice.t-danger[role="alert"] .notice-body')?.textContent, "Unable to list people");
    assert.match(page.container.querySelector(".usage-person-head")?.textContent ?? "", /\$25\.00 per UTC day/);
    assert.ok(page.button(page.container, "Change Budget…"));
    await page.open();
    await page.type("Daily Totals", "400");
    await page.save();
    assert.deepEqual(page.writes, [["retention", { hourlyDays: 30, dailyDays: 400 }]]);
    assertNoDomNode(page.dialog("Budget and History"));
  } finally {
    await page.unmount();
  }
});

test("saved history narrows Group By to what is still kept, and an emptied budget removes the limit (#3015)", async () => {
  const page = await renderBudgetHistory();
  try {
    const group = page.container.querySelector('[role="radiogroup"][aria-label="Group By"]')!;
    const option = (value: string) => [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")]
      .find((node) => node.textContent?.trim() === value);
    await act(async () => { option("Hour")!.click(); await settleLoad(); });
    assert.equal(option("Hour")!.getAttribute("aria-checked"), "true");
    await page.open();
    await page.type("Daily Budget per Person (Optional)", "");
    await page.type("Hourly Detail", "14");
    await page.save();
    await act(async () => { page.button(page.dialog("Shorten Usage History")!, "Shorten History").click(); await drain(); await settleLoad(); });
    assert.deepEqual(page.writes, [["budget", null], ["retention", { hourlyDays: 14, dailyDays: 365 }]]);
    assert.equal(page.toast()?.querySelector(".toast-detail")?.textContent, "No daily budget. Hourly detail 14 days, daily totals 365 days.");
    assert.equal(option("Hour"), undefined, "Hour is omitted past 14 days of hourly detail");
    assert.equal(option("Day")!.getAttribute("aria-checked"), "true");
    await act(async () => { await settleLoad(); });
    assert.equal(page.usageQueries.at(-1), "30:day");
    await chooseBreakdown(page.container, "By Person");
    assert.match(page.container.querySelector(".usage-person-head")?.textContent ?? "", /No daily budget is set\./);
  } finally {
    await page.unmount();
  }
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  const aggregation = () => container.querySelector('[role="radiogroup"][aria-label="Group By"]')!;
  const option = (label: string) => [...aggregation().querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === label) as HTMLButtonElement;

  await act(async () => { option("Week").click(); await settleLoad(); });
  assert.ok(releaseWeek, "the weekly request is in flight");
  await act(async () => { option("Day").click(); await settleLoad(); await Promise.resolve(); });
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /^Daily cost/);
  await act(async () => { releaseWeek!(response([bucket(at, 6, 0.06)], "week")); await Promise.resolve(); });
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /^Daily cost/,
    "the late weekly response cannot replace the newer daily request");

  holdWeek = false;
  failWeek = true;
  await act(async () => { option("Week").click(); await settleLoad(); await Promise.resolve(); });
  const alert = () => container.querySelector('[role="alert"]');
  assert.match(alert()?.textContent ?? "", /Couldn't Load Usage/);
  assert.doesNotMatch(alert()?.textContent ?? "", /Weekly usage is temporarily unavailable/, "the raw message waits behind Show Details");
  const showDetails = [...alert()!.querySelectorAll("button")].find((node) => node.textContent === "Show Details") as HTMLButtonElement;
  await act(async () => { showDetails.click(); await Promise.resolve(); });
  assert.match(alert()?.textContent ?? "", /Weekly usage is temporarily unavailable/);
  assertNoDomNode(container.querySelector(".usage-chart-section"),
    "a failed aggregation request never leaves the previous chart under the new selected label");

  await act(async () => root.unmount());
  container.remove();
});

test("a late failed request cannot overwrite the newer selection's loading state or data", async () => {
  const initialDay = Date.UTC(2026, 8, 20);
  const newerDay = Date.UTC(2026, 8, 21);
  const pending: Array<{
    granularity: UsageAggregationGranularity;
    resolve: (value: UsageAggregationResponse) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  let initialLoaded = false;
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      const granularity = query.granularity ?? "day";
      if (!initialLoaded) {
        initialLoaded = true;
        return response([bucket(initialDay, 6, 0.06)], granularity);
      }
      return await new Promise<UsageAggregationResponse>((resolve, reject) => {
        pending.push({ granularity, resolve, reject });
      });
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); });
  const aggregation = () => container.querySelector('[role="radiogroup"][aria-label="Group By"]')!;
  const option = (label: string) => [...aggregation().querySelectorAll("[role=radio]")]
    .find((node) => node.textContent?.trim() === label) as HTMLButtonElement;
  // Compare text, not nodes: a failing `assert.equal` on a happy-dom node inspects its whole graph.
  const alertText = () => container.querySelector('[role="alert"]')?.textContent;
  const loadingShown = () => [...container.querySelectorAll('[role="status"]')]
    .some((node) => node.textContent === "Loading usage…");

  await act(async () => { option("Week").click(); await settleLoad(); });
  await act(async () => { option("Day").click(); await settleLoad(); });
  // Nothing to keep on screen, so the skeleton and its status line follow after 300ms (§12.3).
  await act(async () => { await advanceTimeouts(USAGE_SKELETON_DELAY_MS); });
  assert.deepEqual(pending.map((request) => request.granularity), ["week", "day"],
    "the Week request is still in flight when the newer Day request starts");
  const [weekly, daily] = pending;

  await act(async () => { weekly!.reject(new Error("Weekly usage is temporarily unavailable")); await drain(); });
  assert.equal(alertText(), undefined, "the late Week failure does not surface as an error for the Day selection");
  assert.equal(loadingShown(), true, "the Day request is still loading after the Week request fails");

  await act(async () => { daily!.resolve(response([bucket(newerDay, 7, 0.07)], "day")); await drain(); });
  assert.equal(alertText(), undefined);
  assert.equal(loadingShown(), false, "loading ends when the Day request resolves");
  assert.equal(container.querySelector("[aria-busy]")?.getAttribute("aria-busy"), "false");
  assert.equal(option("Day").getAttribute("aria-checked"), "true");
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /^Daily cost/);
  assert.equal(breakdownTabLabels(container)[0], "By Day");
  assert.deepEqual(periodLabels(container), [periodLabel(newerDay, "day")]);

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
    root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });

  // The headline names the response's 7-day window although the default range control says 30d,
  // with the year on both dates because the window crosses one.
  assert.equal(container.querySelector(".usage-headline-note")?.textContent, "Estimated API cost, Dec 27, 2025 – Jan 2, 2026");
  // The Codex caveat waits in About These Numbers, which says it once Codex has usage.
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.usage-toolbar > button[aria-haspopup="dialog"]')!.click();
    await Promise.resolve();
  });
  const codexCoverage = [...domWindow.document.body.querySelectorAll('[aria-label="About These Numbers"] p')]
    .find((node) => node.textContent?.includes("Codex App Server"));
  assert.equal(
    codexCoverage?.textContent,
    "Codex App Server usage recorded before a machine's Wollipog update includes only the final response of each turn, so it is incomplete. Usage recorded since then counts every response.",
  );
  assert.doesNotMatch(codexCoverage?.textContent ?? "", /protocol|v\d/i);
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /not split by driver/);
  assertNoDomNode(container.querySelector(".usage-legend"), "no legend claims a split that does not exist");
  const dayTable = container.querySelector(".usage-tables-section table")!;
  const driverCells = [...dayTable.querySelectorAll("tbody tr")].flatMap((row) => [...row.querySelectorAll("td[data-driver]")].slice(0, 2));
  assert.ok(driverCells.length >= 4);
  // The value, without the cell's own label (shown only in the narrow two-line layout).
  const value = (cell: Element) => (cell.textContent ?? "").slice(cell.querySelector(".cell-label")?.textContent?.length ?? 0);
  assert.ok(driverCells.every((cell) => value(cell) === "—"), "unknown per-driver values read as dashes, not $0.00");

  const hit = container.querySelector(".usage-chart-hit") as SVGRectElement;
  await act(async () => {
    hit.dispatchEvent(new domWindow.FocusEvent("focus", { bubbles: false }) as never);
    hit.dispatchEvent(new domWindow.Event("focusin", { bubbles: true }) as never);
    await Promise.resolve();
  });
  const readout = container.querySelector(".usage-chart-readout")?.textContent ?? "";
  assert.match(readout, /Not split by this control plane/);
  assert.match(readout, /Total/);

  await chooseBreakdown(container, "By Person");
  const panel = container.querySelector("#usage-breakdown-panel")!;
  assert.match(panel.textContent ?? "", /Each person can spend \$20\.00 per UTC day\. When they reach it, their new turns pause until midnight UTC\./);
  const ada = [...panel.querySelectorAll("tbody tr")].find((row) => row.querySelector("th")?.textContent?.includes("Ada"))!;
  assert.deepEqual([...ada.querySelectorAll(".status")].map((badge) => badge.textContent), ["Budget Reached"]);
  assert.match(ada.textContent ?? "", /\$21\.50 of \$20\.00/);
  assert.ok(ada.querySelector(".meter.t-warning"), "a reached budget's meter takes the warning tone");
  assert.doesNotMatch(panel.textContent ?? "", /paused by daily budget/);

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
    root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });

  assert.equal(container.querySelector(".usage-headline-note")?.textContent, "Estimated API cost, Jan 2");
  assertNoDomNode(container.querySelector('[role="alert"]'));
  assert.doesNotMatch(container.textContent ?? "", /Codex App Server records/);
  await act(async () => root.unmount());
  container.remove();
});

// ---- The Breakdown's tabs (#3013) ----

const amountOf = (inputTokens: number, costUsd: number, over: Partial<UsageAmount> = {}): UsageAmount => {
  const { bucketTs: _ignored, ...row } = bucket(0, inputTokens, costUsd);
  return { ...row, ...over };
};

/** The fleet a store would hold: two named machines, their agents and the models they offer. */
const fleet: RunnerView[] = [
  {
    runnerId: "runner-build", hostname: "build-01", displayName: "Build Box", os: "linux", version: "1", status: "online",
    workspaces: [], connectedAt: 1, lastSeen: 1,
    agents: [{
      id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true,
      capabilities: { models: [{ id: "claude-fable-5-1", displayName: "Fable 5.1" }], effortLevels: [] },
    }],
  },
  {
    runnerId: "runner-studio", hostname: "studio", displayName: "Studio Mac", os: "macos", version: "1", status: "online",
    workspaces: [], connectedAt: 1, lastSeen: 1,
    agents: [{
      id: "codex", name: "Codex App Server", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true,
      capabilities: { models: [{ id: "gpt-5.5-codex", displayName: "GPT-5.5-Codex" }], effortLevels: [] },
    }],
  },
] as unknown as RunnerView[];

class FleetSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

let fleetSequence = 0;
/** UsageView under a store that knows `runners`, as it renders in the shell. */
async function renderWithFleet(client: ApiClient, runners: readonly RunnerView[]) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FleetSocket();
  fleetSequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `usage-fleet-${fleetSequence}`,
    runtimeKey: `usage-fleet-${fleetSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const pushed: View[] = [];
  const navigation: ViewNavigation = { current: () => ({ name: "usage" }), push: (view) => { pushed.push(view); }, listen: () => () => {} };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}><UsageView tab="api" /></StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
      runners, boxes: [], sessions: [], runs: [], pods: [],
    } as unknown as UiSnapshotMessage);
  });
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  return {
    container,
    socket,
    pushed,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

const usageClient = (usage: UsageAggregationResponse, users: UserCostWindows[] = [], perUserUsd: number | null = null) => ({
  ...api,
  subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
  refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
  usageDailyBudget: async () => ({ dailyBudget: { perUserUsd, updatedAt: null } }),
  usageUsers: async () => ({ users }),
  usage: async (query: { granularity?: UsageAggregationGranularity }) => ({ ...usage, granularity: query.granularity ?? "day" }),
} as unknown as ApiClient);

/** Each body row of the open Breakdown table, as its cells' text. */
const breakdownCells = (container: HTMLElement) => [...container.querySelectorAll("#usage-breakdown-panel tbody tr")]
  .map((row) => [...row.children].map((cell) => cell.textContent ?? ""));

test("By Agent and By Machine name what they count, and By Model uses the catalog's names (#3013)", async () => {
  const usage: UsageAggregationResponse = {
    ...response([bucket(Date.UTC(2026, 0, 1), 100, 1)], "day"),
    totals: amountOf(100, 10),
    // Claude ran two models; the plane keys each "agent / model".
    byAgent: [
      { key: "claude / claude-fable-5-1", ...amountOf(40, 4) },
      { key: "codex / gpt-5.5-codex", ...amountOf(30, 3) },
      { key: "claude / claude-sonnet-5-5", ...amountOf(20, 2) },
      { key: "Other", ...amountOf(5, 0.5) },
      { key: "aider / gpt-5.5", ...amountOf(5, 0.5) },
    ],
    byRunner: [
      { key: "runner-studio", ...amountOf(30, 3) },
      { key: "runner-build", ...amountOf(60, 6) },
      { key: "runner-gone", ...amountOf(10, 1) },
    ],
    byModel: [
      { key: "claude-fable-5-1", ...amountOf(40, 4) },
      { key: "gpt-5.5-codex", ...amountOf(30, 3) },
      { key: "local-llama", ...amountOf(30, 0, { costSource: "unpriced", unpricedRecords: 3 }) },
    ],
  };
  const view = await renderWithFleet(usageClient(usage), fleet);
  try {
    await chooseBreakdown(view.container, "By Agent");
    const agents = breakdownCells(view.container);
    assert.deepEqual(agents.map((row) => row[0]), ["Claude Code", "Codex App Server", "aider", "Other"],
      "an agent's models sum into one row, an unlisted agent keeps its id, and Other stays last");
    // The cell label and the unit are drawn only on a phone's line 2; the text holds them throughout.
    assert.deepEqual(agents[0]!.slice(1, 4), ["Share: 60%", "60 tokens", "$6.00"]);
    assert.ok(agents.flat().every((cell) => !cell.includes(" / ")), "no cell joins an agent id and a model");
    assert.equal(view.container.querySelector("#usage-breakdown-panel table")?.getAttribute("aria-labelledby"), "usage-breakdown-agent-tab");
    assert.deepEqual([...view.container.querySelectorAll("#usage-breakdown-panel thead th")].map((cell) => cell.textContent),
      ["Agent", "Share", "Tokens", "Cost"]);

    await chooseBreakdown(view.container, "By Machine");
    const machines = breakdownCells(view.container);
    assert.deepEqual(machines.map((row) => row[0]), ["Build Box", "Studio Mac", "runner-gone"],
      "a machine the store knows is named; one it does not keeps its id");
    assert.ok(machines.flat().every((cell) => !/runner-(build|studio)/.test(cell)));

    await chooseBreakdown(view.container, "By Model");
    const models = breakdownCells(view.container);
    assert.deepEqual(models.map((row) => row[0]), ["Fable 5.1", "GPT-5.5-Codex", "local-llama"]);
    assert.equal(models[2]![3], "Unpriced", "an unpriced row says so in its Cost cell, not after its name");
  } finally {
    await view.unmount();
  }
});

test("the time table shows the newest 7 periods and Show All, which shows the rest without an inner scroll (#3013)", async () => {
  const end = Date.UTC(2026, 8, 30);
  const series = Array.from({ length: 30 }, (_, index) => bucket(end - index * 86_400_000, 10 + index, 0.1 + index / 100));
  const client = usageClient({
    ...response(series, "day"),
    since: end - 29 * 86_400_000,
    through: end + 86_400_000,
    byDriver: [{ key: "claude-code", ...amountOf(1000, 10) }],
  });
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
    await act(async () => { await settleLoad(); await Promise.resolve(); });
    assert.deepEqual(periodLabels(container), series.slice(0, 7).map((row) => periodLabel(row.bucketTs, "day")));
    assertNoDomNode(container.querySelector('#usage-breakdown-panel [role="region"]'), "the table is not a scroll region");
    const showAll = [...container.querySelectorAll<HTMLButtonElement>(".list-foot button")];
    assert.deepEqual(showAll.map((button) => button.textContent), ["Show All 30 Days"]);
    assert.ok(showAll[0]!.classList.contains("ghost"));

    await act(async () => { showAll[0]!.click(); await Promise.resolve(); });
    assert.equal(periodLabels(container).length, 30);
    assertNoDomNode(container.querySelector(".list-foot"), "everything is shown");
    assert.equal(domWindow.document.activeElement?.textContent?.startsWith(periodLabel(series[7]!.bucketTs, "day")), true,
      "focus lands on the first row Show All revealed");

    // Tokens: the figures are tokens and the trailing column is Cost.
    const tokens = [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Metric"] [role="radio"]')]
      .find((node) => node.textContent?.trim() === "Tokens")!;
    await act(async () => { tokens.click(); await Promise.resolve(); });
    assert.deepEqual([...container.querySelectorAll(".usage-table thead th")].map((cell) => cell.textContent),
      ["Day (UTC)", "Claude Code", "Total", "Cost"]);
    const first = container.querySelector(".usage-table tbody tr")!;
    assert.equal(first.querySelector(".cell-status")?.textContent, "10");
    assert.equal(first.querySelector(".usage-period-trailing")?.textContent, "$0.10 estimated");
    assert.equal(first.querySelector(".usage-period-meta")?.textContent, "$0.10 estimated");

    // A new range starts at the newest 7 again.
    await chooseRange(container, 90);
    await act(async () => { await settleLoad(); await Promise.resolve(); });
    assert.equal(periodLabels(container).length, 7);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a person at the daily budget, settled plus running turns, shows one Budget Reached badge and a warning meter (#3013)", async () => {
  const people: UserCostWindows[] = [
    { userId: "u-ada", userName: "Ada", todayUsd: 26.4, last7DaysUsd: 112.2, last30DaysUsd: 401.7, dailyBudgetUsd: 25 },
    // Under the budget on settled spend alone; the gate counts her running turn too.
    { userId: "u-grace", userName: "Grace", todayUsd: 24, todayEstimateUsd: 1.25, last7DaysUsd: 61.3, last30DaysUsd: 240.1, dailyBudgetUsd: 25 },
    { userId: "u-linus", userName: "Linus", todayUsd: 9.8, last7DaysUsd: 4.5, last30DaysUsd: 38.9, dailyBudgetUsd: 25 },
  ];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={usageClient(response([]), people, 25)}><UsageView tab="api" /></ApiProvider>));
    await act(async () => { await settleLoad(); await Promise.resolve(); });
    await chooseBreakdown(container, "By Person");
    const panel = container.querySelector("#usage-breakdown-panel")!;
    assert.match(panel.textContent ?? "",
      /Each person can spend \$25\.00 per UTC day\. When they reach it, their new turns pause until midnight UTC\./);
    assert.deepEqual([...panel.querySelectorAll("thead th")].map((cell) => cell.textContent), ["Person", "Today", "Last 7 Days", "Last 30 Days"]);
    const row = (name: string) => [...panel.querySelectorAll("tbody tr")].find((candidate) => candidate.querySelector("th")?.textContent?.includes(name))!;
    for (const name of ["Ada", "Grace"]) {
      assert.deepEqual([...row(name).querySelectorAll(".status")].map((badge) => badge.textContent), ["Budget Reached"], name);
      assert.ok(row(name).querySelector(".status.t-warning") || row(name).querySelector(".status")?.className.includes("warning"),
        `${name}'s badge is the warning tone`);
      const meter = row(name).querySelector('.meter[role="progressbar"]')!;
      assert.ok(meter.classList.contains("t-warning"), `${name}'s meter takes the warning tone`);
    }
    assert.match(row("Ada").textContent ?? "", /\$26\.40 of \$25\.00/);
    assert.match(row("Grace").textContent ?? "", /\$25\.25 of \$25\.00/);
    assert.equal(row("Grace").querySelector(".usage-person-today")?.getAttribute("title"), "Includes an estimate for running turns.");
    assert.match(panel.textContent ?? "", /Today includes an estimate for running turns\./);
    assert.equal(row("Linus").querySelectorAll(".status").length, 0);
    const linusMeter = row("Linus").querySelector('.meter[role="progressbar"]')!;
    assert.equal(linusMeter.classList.contains("t-warning"), false);
    assert.equal(linusMeter.getAttribute("aria-valuetext"), "$9.80 of $25.00");
    assert.doesNotMatch(panel.textContent ?? "", /paused by daily budget/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("without a daily budget By Person says so and draws no meter or badge (#3013)", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    const people: UserCostWindows[] = [
      { userId: "u-ada", userName: "Ada", todayUsd: 26.4, last7DaysUsd: 112.2, last30DaysUsd: 401.7, dailyBudgetUsd: null },
    ];
    await act(async () => root.render(<ApiProvider client={usageClient(response([]), people)}><UsageView tab="api" /></ApiProvider>));
    await act(async () => { await settleLoad(); await Promise.resolve(); });
    await chooseBreakdown(container, "By Person");
    const panel = container.querySelector("#usage-breakdown-panel")!;
    assert.match(panel.textContent ?? "", /No daily budget is set\./);
    assertNoDomNode(panel.querySelector(".meter"));
    assertNoDomNode(panel.querySelector(".status"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** Renders the API Usage tab over one fixed aggregation response and waits for it to load. */
const renderOverview = async (data: UsageAggregationResponse) => {
  const client = {
    ...api,
    subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => ({ ...data, granularity: query.granularity ?? data.granularity }),
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, cleanup };
};

/** A two-driver window, split per day, so the chart has a real legend to draw. */
const splitWindow = (since: number, through: number, coverageStartedAt: number): UsageAggregationResponse => {
  const day = Math.floor((through - 1) / 86_400_000) * 86_400_000;
  const claude = bucket(day, 4_000, 4);
  const codex = bucket(day, 1_000, 1);
  return {
    ...response([bucket(day, 5_000, 5)], "day"),
    since,
    through,
    retention: { hourlyDays: 30, dailyDays: 365, coverageStartedAt },
    totals: { ...bucket(day, 5_000, 5), cachedInputTokens: 2_000, outputTokens: 300, cacheSavingsUsd: 0.25 },
    seriesByDriver: [{ ...claude, driver: "claude-code" }, { ...codex, driver: "codex-app-server" }],
    byDriver: [
      { key: "claude-code", ...claude },
      { key: "codex-app-server", ...codex },
    ].map(({ bucketTs: _ignored, ...row }) => row),
  };
};

const chooseMetric = async (container: HTMLElement, name: "Cost" | "Tokens") => {
  const radio = [...container.querySelectorAll('[role="radiogroup"][aria-label="Metric"] [role="radio"]')]
    .find((candidate) => candidate.textContent === name) as HTMLButtonElement | undefined;
  assert.ok(radio, `the Metric control offers ${name}`);
  await act(async () => {
    radio.click();
    await Promise.resolve();
  });
};

const facts = (container: HTMLElement) => [...container.querySelectorAll("dl.facts.strip > div")]
  .map((pair) => [pair.querySelector("dt")?.textContent, pair.querySelector("dd")?.textContent]);

test("a 30-day range clamped to yesterday's start of recording says so, never a count of one day", async () => {
  const DAY = 86_400_000;
  const through = Date.UTC(2026, 8, 26, 9, 30);
  const coverageStartedAt = Date.UTC(2026, 8, 25, 15, 20);
  const { container, cleanup } = await renderOverview(splitWindow(Math.floor(coverageStartedAt / DAY) * DAY, through, coverageStartedAt));

  assert.equal(container.querySelector(".usage-headline-note")?.textContent, "Estimated API cost since Sep 25, when recording started");
  await chooseMetric(container, "Tokens");
  assert.equal(container.querySelector(".usage-headline-note")?.textContent, "Processed tokens since Sep 25, when recording started");
  // No caption anywhere on the page counts a single day, in either form.
  assert.doesNotMatch(container.textContent ?? "", /\b1 days?\b/);
  await cleanup();
});

test("a full 30-day window names both of its end dates", async () => {
  const { container, cleanup } = await renderOverview(splitWindow(Date.UTC(2026, 7, 5), Date.UTC(2026, 8, 3, 18), Date.UTC(2026, 0, 1)));

  assert.equal(container.querySelector(".usage-headline-note")?.textContent, "Estimated API cost, Aug 5 – Sep 3");
  await chooseMetric(container, "Tokens");
  assert.equal(container.querySelector(".usage-headline-note")?.textContent, "Processed tokens, Aug 5 – Sep 3");
  await cleanup();
});

test("the driver list is the chart's only legend, and the chart has no heading of its own", async () => {
  const { container, cleanup } = await renderOverview(splitWindow(Date.UTC(2026, 7, 5), Date.UTC(2026, 8, 3, 18), Date.UTC(2026, 0, 1)));

  const list = container.querySelector('.usage-overview ul[aria-label="By Driver"]');
  assert.ok(list, "the driver list is in the overview");
  assert.deepEqual(
    [...list.querySelectorAll(".usage-driver-row")].map((row) => [
      row.querySelector(".usage-series-swatch")?.getAttribute("class"),
      row.querySelector(".usage-driver-name")?.textContent,
      row.querySelector(".usage-driver-share")?.textContent,
      row.querySelector("strong")?.textContent,
    ]),
    [
      ["usage-series-swatch usage-series-2", "Claude Code", "80%", "$4.00"],
      ["usage-series-swatch usage-series-1", "Codex", "20%", "$1.00"],
    ],
  );
  assert.equal(container.querySelectorAll("ul").length, 1, "the page lists the driver series once");
  assertNoDomNode(container.querySelector(".usage-legend"), "the chart draws no legend of its own");
  assertNoDomNode(container.querySelector(".usage-chart-section h3"), "the chart has no heading of its own");
  // Its accessible name still says what it plots.
  assert.match(container.querySelector(".usage-chart-svg title")?.textContent ?? "", /^Daily cost by driver; /);

  // The readout keys each driver with the same swatch, never a line key.
  const hit = container.querySelector(".usage-chart-hit") as SVGRectElement;
  await act(async () => {
    hit.dispatchEvent(new domWindow.FocusEvent("focus", { bubbles: false }) as never);
    hit.dispatchEvent(new domWindow.Event("focusin", { bubbles: true }) as never);
    await Promise.resolve();
  });
  assert.equal(container.querySelectorAll(".usage-chart-readout dt .usage-series-swatch").length, 2);
  assertNoDomNode(container.querySelector(".usage-series-key"), "the readout has no line keys");
  await cleanup();
});

test("the facts strip has no heading, and in Tokens mode it keeps the Cost headline's dollar figure", async () => {
  const { container, cleanup } = await renderOverview(splitWindow(Date.UTC(2026, 7, 5), Date.UTC(2026, 8, 3, 18), Date.UTC(2026, 0, 1)));

  assert.equal(container.querySelectorAll("dl.facts.strip").length, 1);
  assert.doesNotMatch(container.textContent ?? "", /Totals/);
  const costHeadline = container.querySelector(".usage-headline-value")?.textContent;
  assert.equal(costHeadline, "$5.00");
  assert.deepEqual(facts(container).map(([label]) => label), ["Processed Tokens", "Cached Input", "Uncached Input", "Output", "Cache Savings"]);

  await chooseMetric(container, "Tokens");
  assert.notEqual(container.querySelector(".usage-headline-value")?.textContent, costHeadline);
  assert.deepEqual(facts(container).map(([label]) => label), [
    "Processed Tokens", "Cached Input", "Uncached Input", "Output", "Cache Savings", "Estimated Cost",
  ]);
  assert.equal(facts(container).at(-1)![1], costHeadline, "Estimated Cost reads exactly as the Cost headline did");
  await cleanup();
});

// ---- One state at a time, each with an action that helps (#3016) ----

/** A window with nothing in it: no buckets, no tokens and no cost. */
const emptyWindow = (granularity: UsageAggregationGranularity = "day"): UsageAggregationResponse => ({
  ...response([], granularity),
  totals: amountOf(0, 0),
});

/** UsageView without a store, over `client`, with its first aggregation settled. */
const renderStandalone = async (client: ApiClient) => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><UsageView tab="api" /></ApiProvider>));
  await act(async () => { await settleLoad(); await Promise.resolve(); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
};

const apiPanel = (container: HTMLElement) => container.querySelector("#usage-api-panel") as HTMLElement;
const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === name) as HTMLButtonElement | undefined;

test("an empty window is said once, in one empty state with the toolbar above it, and Show Last 365 Days loads that range (#3016)", async () => {
  const requested: number[] = [];
  const client = {
    ...usageClient(emptyWindow()),
    usage: async (query: { days: number; granularity?: UsageAggregationGranularity }) => {
      requested.push(query.days);
      return emptyWindow(query.granularity ?? "day");
    },
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const panel = apiPanel(container);

  assert.equal(panel.querySelectorAll(".state").length, 1, "exactly one state");
  assert.equal(panel.querySelector(".state-title")?.textContent, "No Usage in the Last 30 Days");
  assert.equal(panel.querySelector(".state-body")?.textContent,
    "Usage is recorded each time an agent finishes a turn on a connected machine. Try a longer range, or start a session.");
  assert.ok(panel.querySelector(".state .state-icon svg"), "the state carries the Usage icon");
  assert.ok(panel.querySelector(".usage-toolbar"), "the toolbar stays");
  assert.doesNotMatch(panel.textContent ?? "", /\$0\.00/, "no zero headline");
  assertNoDomNode(panel.querySelector(".usage-overview"), "no overview");
  assertNoDomNode(panel.querySelector(".usage-chart-svg"), "no chart");
  assertNoDomNode(panel.querySelector("dl.facts"), "no facts");
  assertNoDomNode(panel.querySelector("table"), "no breakdown table");
  assertNoDomNode(panel.querySelector('[role="alert"]'), "no error beside the empty state");
  assertNoDomNode(buttonNamed(panel, "Go to Sessions") ?? null, "without a store there is nowhere to go");

  await act(async () => { buttonNamed(panel, "Show Last 365 Days")!.click(); await settleLoad(); await Promise.resolve(); });
  assert.equal(requested.at(-1), 365, "Show Last 365 Days loads the longest range");
  assert.equal(panel.querySelector(".state-title")?.textContent, "No Usage in the Last 365 Days");
  assert.equal(buttonNamed(panel, "Show Last 365 Days"), undefined, "the longest range offers no longer one");
  assert.match(panel.querySelector(".state-body")?.textContent ?? "", /Start a session to record some\.$/);
  assert.ok(panel.querySelector('button[aria-label="Range: Last 365 Days"]'), "the Range menu shows the new range");
  await unmount();
});

test("under a store the empty state's Go to Sessions opens Sessions (#3016)", async () => {
  const view = await renderWithFleet(usageClient(emptyWindow()), fleet);
  await act(async () => { buttonNamed(apiPanel(view.container), "Go to Sessions")!.click(); await Promise.resolve(); });
  assert.deepEqual(view.pushed.at(-1), { name: "inbox" });
  await view.unmount();
});

test("a failed load shows Couldn't Load Usage with Retry, the raw message only behind Show Details, and never the empty state (#3016)", async () => {
  let fail = false;
  let calls = 0;
  const client = {
    ...usageClient(emptyWindow()),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      calls += 1;
      if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:4317");
      return emptyWindow(query.granularity ?? "day");
    },
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const panel = apiPanel(container);
  assert.equal(panel.querySelector(".state-title")?.textContent, "No Usage in the Last 30 Days");

  // A refresh of the same range that fails replaces the empty state rather than joining it.
  fail = true;
  await chooseRange(container, 30);
  await act(async () => { await drain(); });
  const alert = () => panel.querySelector('[role="alert"]');
  assert.equal(alert()?.querySelector(".notice-title")?.textContent, "Couldn't Load Usage");
  assert.equal(alert()?.querySelector(".notice-body")?.textContent, "Wollipog didn't answer. Recording continues, and nothing is lost.");
  assert.doesNotMatch(panel.textContent ?? "", /ECONNREFUSED/, "the raw message waits behind Show Details");
  assert.equal(panel.querySelectorAll(".state").length, 0, "the empty state never shows with the error");
  await act(async () => { buttonNamed(alert()!, "Show Details")!.click(); await Promise.resolve(); });
  assert.match(alert()?.textContent ?? "", /connect ECONNREFUSED 127\.0\.0\.1:4317/);

  fail = false;
  const before = calls;
  await act(async () => { buttonNamed(alert()!, "Retry")!.click(); await drain(); });
  assert.equal(calls, before + 1, "Retry asks again at once");
  assertNoDomNode(alert(), "a successful retry clears the error");
  assert.equal(panel.querySelector(".state-title")?.textContent, "No Usage in the Last 30 Days");
  await unmount();
});

test("an offline machine and 12 unpriced turns are one warning notice with View Machines and Refresh Rates (#3016)", async () => {
  let usageCalls = 0;
  let pricingCalls = 0;
  const usage: UsageAggregationResponse = {
    ...response([bucket(Date.UTC(2026, 0, 1), 100, 1)], "day"),
    totals: amountOf(100, 1, { costSource: "unpriced", unpricedRecords: 12 }),
    pricing: { status: "fresh", source: "https://rates.example/table.json", fetchedAt: 1, knownModels: 10 },
  };
  const client = {
    ...usageClient(usage),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      usageCalls += 1;
      return { ...usage, granularity: query.granularity ?? "day" };
    },
    refreshUsagePricing: async () => {
      pricingCalls += 1;
      return { pricing: usage.pricing };
    },
  } as unknown as ApiClient;
  const offlineFleet = [{ ...fleet[0]!, status: "offline" }, fleet[1]!] as RunnerView[];
  const view = await renderWithFleet(client, offlineFleet);
  const panel = apiPanel(view.container);

  const notices = [...panel.querySelectorAll(".notice")];
  assert.equal(notices.length, 1, "one notice");
  const notice = notices[0]!;
  assert.ok(notice.classList.contains("t-warning"), "a warning");
  assert.equal(notice.querySelector(".notice-title")?.textContent, "Some Usage Is Missing");
  assert.deepEqual([...notice.querySelectorAll(".notice-body > p")].map((node) => node.textContent), [
    "Build Box is offline, so usage it hasn't reported yet isn't counted.",
    "12 turns have no price because no rate is known for their model.",
  ]);
  assert.doesNotMatch(notice.textContent ?? "", /build-01/, "the machine is named by its display name, never its hostname");
  assert.equal(notice.compareDocumentPosition(panel.querySelector(".usage-overview")! as never) & 4, 4,
    "the notice sits above the overview");

  const usageBefore = usageCalls;
  await act(async () => { buttonNamed(notice, "Refresh Rates")!.click(); await drain(); await drain(); });
  assert.equal(pricingCalls, 1, "Refresh Rates asks for new rates once");
  assert.equal(usageCalls, usageBefore + 1, "and reloads the window");

  await act(async () => { buttonNamed(notice, "View Machines")!.click(); await Promise.resolve(); });
  assert.deepEqual(view.pushed.at(-1), { name: "runners", section: "machines" });
  await view.unmount();
});

test("a Refresh Rates failure says so and keeps its reason behind Show Details (#3016)", async () => {
  const usage: UsageAggregationResponse = {
    ...response([bucket(Date.UTC(2026, 0, 1), 100, 1)], "day"),
    totals: amountOf(100, 1, { costSource: "unpriced", unpricedRecords: 3 }),
  };
  const client = {
    ...usageClient(usage),
    refreshUsagePricing: async () => { throw new Error("usage pricing is unavailable"); },
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const notice = () => apiPanel(container).querySelector(".notice")!;
  assertNoDomNode(buttonNamed(notice(), "View Machines") ?? null, "no machine is offline");
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); });
  assert.match(notice().querySelector(".notice-body")?.textContent ?? "", /Rates couldn't be refreshed\.$/);
  assert.doesNotMatch(notice().textContent ?? "", /usage pricing is unavailable/);
  await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
  assert.match(notice().textContent ?? "", /usage pricing is unavailable/);
  await unmount();
});

// The answers below carry neither `lastRefreshError` nor `refreshSkipped`: a plane from before #4056.
for (const status of ["cached", "unavailable"] as const) {
  test(`a refresh an older plane answers with ${status} rates is a failure too, keeps today's wording, and still reloads (#3016, #4056)`, async () => {
    let usageCalls = 0;
    const usage: UsageAggregationResponse = {
      ...response([bucket(Date.UTC(2026, 0, 1), 100, 1)], "day"),
      totals: amountOf(100, 1, { costSource: "unpriced", unpricedRecords: 3 }),
    };
    const client = {
      ...usageClient(usage),
      usage: async (query: { granularity?: UsageAggregationGranularity }) => {
        usageCalls += 1;
        return { ...usage, granularity: query.granularity ?? "day" };
      },
      // An upstream timeout: HTTP 200 with whatever rates the plane still has.
      refreshUsagePricing: async () => ({
        pricing: { status, source: "https://rates.example/table.json", fetchedAt: status === "cached" ? 1 : null, knownModels: 0 },
      }),
    } as unknown as ApiClient;
    const { container, unmount } = await renderStandalone(client);
    const notice = () => apiPanel(container).querySelector(".notice")!;
    const before = usageCalls;
    await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
    assert.equal(usageCalls, before + 1, "the window reloads either way");
    assert.match(notice().querySelector(".notice-body")?.textContent ?? "", /Rates couldn't be refreshed\.$/);
    await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
    assert.match(notice().textContent ?? "",
      new RegExp(`https://rates\\.example/table\\.json didn't return a usable rate table, so the rates are still ${status}\\.`));
    await unmount();
  });
}

test("Refresh Rates against a plane with rate fetching turned off says so (#3016)", async () => {
  const usage: UsageAggregationResponse = {
    ...response([bucket(Date.UTC(2026, 0, 1), 100, 1)], "day"),
    totals: amountOf(100, 1, { costSource: "unpriced", unpricedRecords: 3 }),
  };
  const client = {
    ...usageClient(usage),
    refreshUsagePricing: async () => ({ pricing: { status: "unavailable", source: "disabled", fetchedAt: null, knownModels: 0 } }),
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const notice = () => apiPanel(container).querySelector(".notice")!;
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
  assert.match(notice().textContent ?? "", /Rate fetching is turned off on this control plane\./);
  await unmount();
});

function unpricedUsage(): UsageAggregationResponse {
  return {
    ...response([bucket(Date.UTC(2026, 0, 1), 100, 1)], "day"),
    totals: amountOf(100, 1, { costSource: "unpriced", unpricedRecords: 3 }),
  };
}

const RATE_SOURCE = "https://rates.example/table.json";

test("a timed-out refresh shows the plane's reason behind Show Details, and a later successful one clears it (#4056)", async () => {
  const answers: UsagePricingStatus[] = [
    { status: "cached", source: RATE_SOURCE, fetchedAt: 1, knownModels: 9,
      lastRefreshError: { message: "the rate source didn't answer within 30 seconds", at: 2 } },
    { status: "fresh", source: RATE_SOURCE, fetchedAt: 3, knownModels: 10 },
  ];
  const client = {
    ...usageClient(unpricedUsage()),
    refreshUsagePricing: async () => ({ pricing: answers.shift()! }),
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const notice = () => apiPanel(container).querySelector(".notice")!;
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  assert.match(notice().querySelector(".notice-body")?.textContent ?? "", /Rates couldn't be refreshed\.$/);
  assert.doesNotMatch(notice().textContent ?? "", /didn't answer/, "the reason waits behind Show Details");
  await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
  assert.deepEqual([...notice().querySelectorAll(".notice-details-body > p")].map((node) => node.textContent), [
    "https://rates.example/table.json couldn't be fetched: the rate source didn't answer within 30 seconds.",
    "The rates are still cached.",
  ]);
  assert.doesNotMatch(notice().textContent ?? "", /control plane's log/, "a plane that sends the reason isn't sent to its log");

  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  assert.doesNotMatch(notice().textContent ?? "", /couldn't be refreshed|didn't answer/, "a fresh table clears the failure");
  assertNoDomNode(buttonNamed(notice(), "Show Details") ?? null, "nothing is left to show");
  await unmount();
});

test("an invalid rate document shows its reason behind Show Details (#4056)", async () => {
  const client = {
    ...usageClient(unpricedUsage()),
    refreshUsagePricing: async () => ({ pricing: {
      status: "unavailable", source: RATE_SOURCE, fetchedAt: null, knownModels: 0,
      lastRefreshError: { message: "rate table document isn't valid JSON", at: 2 },
    } satisfies UsagePricingStatus }),
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const notice = () => apiPanel(container).querySelector(".notice")!;
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
  assert.match(notice().textContent ?? "", /couldn't be fetched: rate table document isn't valid JSON\.The rates are still unavailable\./);
  await unmount();
});

test("a second Refresh Rates inside the refresh floor says it was skipped and when it can run, not a new failure (#4056)", async () => {
  const lastRefreshError = { message: "rate table returned HTTP 503", at: 2 };
  const answers: UsagePricingStatus[] = [
    { status: "cached", source: RATE_SOURCE, fetchedAt: 1, knownModels: 9, lastRefreshError },
    { status: "cached", source: RATE_SOURCE, fetchedAt: 1, knownModels: 9, lastRefreshError,
      refreshSkipped: { nextAttemptAt: 60_002, retryAfterMs: 41_200 } },
  ];
  const client = {
    ...usageClient(unpricedUsage()),
    refreshUsagePricing: async () => ({ pricing: answers.shift()! }),
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const notice = () => apiPanel(container).querySelector(".notice")!;
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  const body = notice().querySelector(".notice-body")?.textContent ?? "";
  assert.match(body, /This refresh was skipped because one ran less than a minute ago\.$/);
  assert.doesNotMatch(body, /couldn't be refreshed/, "a skipped refresh isn't reported as a new failure");
  await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
  assert.deepEqual([...notice().querySelectorAll(".notice-details-body > p")].map((node) => node.textContent), [
    "Wollipog tries the rate source at most once a minute. Try again in 42 seconds.",
    "The last attempt failed: rate table returned HTTP 503.",
  ]);
  await unmount();
});

test("a second Refresh Rates after a successful one inside the floor says it was skipped too (#4056)", async () => {
  const answers: UsagePricingStatus[] = [
    { status: "fresh", source: RATE_SOURCE, fetchedAt: 3, knownModels: 10 },
    { status: "fresh", source: RATE_SOURCE, fetchedAt: 3, knownModels: 10, refreshSkipped: { nextAttemptAt: 60_003, retryAfterMs: 50_000 } },
  ];
  const client = {
    ...usageClient(unpricedUsage()),
    refreshUsagePricing: async () => ({ pricing: answers.shift()! }),
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const notice = () => apiPanel(container).querySelector(".notice")!;
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  assertNoDomNode(buttonNamed(notice(), "Show Details") ?? null, "a refresh that took says nothing more");
  await act(async () => { buttonNamed(notice(), "Refresh Rates")!.click(); await drain(); await drain(); });
  assert.match(notice().querySelector(".notice-body")?.textContent ?? "", /This refresh was skipped because one ran less than a minute ago\.$/);
  await act(async () => { buttonNamed(notice(), "Show Details")!.click(); await Promise.resolve(); });
  assert.deepEqual([...notice().querySelectorAll(".notice-details-body > p")].map((node) => node.textContent), [
    "Wollipog tries the rate source at most once a minute. Try again in 50 seconds.",
    "The last attempt succeeded, so the rates are current.",
  ]);
  await unmount();
});

test("a first load shows the overview's skeleton only after 300ms; a refetch keeps the figures under aria-busy (#3016)", async () => {
  const pending: Array<(value: UsageAggregationResponse) => void> = [];
  const client = {
    ...usageClient(emptyWindow()),
    usage: () => new Promise<UsageAggregationResponse>((resolve) => { pending.push(resolve); }),
  } as unknown as ApiClient;
  const { container, unmount } = await renderStandalone(client);
  const panel = apiPanel(container);
  const loadingLine = () => [...panel.querySelectorAll('[role="status"]')].find((node) => node.textContent === "Loading usage…");
  assert.equal(pending.length, 1, "the first request is in flight");

  await act(async () => { await advanceTimeouts(USAGE_SKELETON_DELAY_MS - USAGE_DEBOUNCE_MS - 10); });
  assert.equal(loadingLine(), undefined, "nothing new under 300ms");
  assertNoDomNode(panel.querySelector(".usage-skeleton-chart"));

  await act(async () => { await advanceTimeouts(10); });
  assert.ok(loadingLine(), "the status line says what is coming");
  const skeleton = panel.querySelector(".usage-skeleton-chart")!.closest('[aria-hidden="true"]')!;
  assert.ok(skeleton.querySelector(".usage-skeleton-figure"), "the headline figure");
  assert.equal(skeleton.querySelectorAll(".usage-skeleton-legend > .skeleton-bar").length, 3, "three legend lines");
  assert.equal(skeleton.querySelectorAll(".usage-skeleton-chart > .skeleton-bar").length, 30, "the chart's columns");

  await act(async () => { pending.shift()!(response([bucket(Date.UTC(2026, 0, 1), 6, 0.06)])); await drain(); });
  assertNoDomNode(panel.querySelector(".usage-skeleton-chart"), "the skeleton gives way to the figures");
  assert.equal(panel.querySelector(".usage-headline-value")?.textContent, "$0.06");

  await chooseRange(container, 30);
  await act(async () => { await advanceTimeouts(USAGE_SKELETON_DELAY_MS); });
  assert.equal(panel.querySelector(".usage-headline-value")?.textContent, "$0.06", "a refetch keeps the previous figures");
  assert.equal(panel.querySelector(".usage-overview")!.closest("[aria-busy]")?.getAttribute("aria-busy"), "true");
  assertNoDomNode(panel.querySelector(".usage-skeleton-chart"), "and never shows the skeleton");
  await act(async () => { pending.shift()!(response([bucket(Date.UTC(2026, 0, 1), 6, 0.06)])); await drain(); });
  assert.equal(panel.querySelector(".usage-overview")!.closest("[aria-busy]")?.getAttribute("aria-busy"), "false");
  await unmount();
});

test("while disconnected the last figures stay, dimmed, under Reconnecting…, and they reload once it is back (#3016)", async () => {
  let calls = 0;
  let unreachable = false;
  const usage = response([bucket(Date.UTC(2026, 0, 1), 6, 0.06)]);
  const client = {
    ...usageClient(usage),
    usage: async (query: { granularity?: UsageAggregationGranularity }) => {
      calls += 1;
      if (unreachable) throw new Error("Failed to fetch");
      return { ...usage, granularity: query.granularity ?? "day" };
    },
  } as unknown as ApiClient;
  const view = await renderWithFleet(client, fleet);
  const panel = apiPanel(view.container);
  assertNoDomNode(panel.querySelector(".is-stale"));

  await act(async () => { view.socket.onclose?.({ code: 1006 }); await drain(); });
  const reconnecting = [...panel.querySelectorAll('[role="status"]')].find((node) => node.textContent === "Reconnecting…");
  assert.ok(reconnecting, "one Reconnecting… line");
  const stale = panel.querySelector(".is-stale");
  assert.ok(stale, "the last figures are dimmed");
  assert.equal(stale!.querySelector(".usage-headline-value")?.textContent, "$0.06", "and still there");
  assert.equal(stale!.contains(reconnecting!), false, "the Reconnecting… line itself is not dimmed");
  assertNoDomNode(panel.querySelector('[role="alert"]'), "never an error while disconnected");

  // A request that fails while the plane is unreachable leaves the dimmed figures, not an error.
  unreachable = true;
  await chooseRange(view.container, 30);
  await act(async () => { await drain(); });
  assertNoDomNode(panel.querySelector('[role="alert"]'), "a failure while disconnected is not an error");
  assert.equal(panel.querySelector(".is-stale .usage-headline-value")?.textContent, "$0.06");

  unreachable = false;
  const before = calls;
  await act(async () => {
    await advanceTimeouts(30_000);
    view.socket.onopen?.();
    view.socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
      runners: fleet, boxes: [], sessions: [], runs: [], pods: [],
    } as unknown as UiSnapshotMessage);
    await drain();
  });
  assertNoDomNode(panel.querySelector(".is-stale"), "back online the figures are current again");
  assert.ok(calls > before, "and are reloaded");
  await view.unmount();
});

test("an empty window while disconnected shows only Reconnecting…, never the empty state (#3016)", async () => {
  const view = await renderWithFleet(usageClient(emptyWindow()), fleet);
  const panel = apiPanel(view.container);
  await act(async () => { view.socket.onclose?.({ code: 1006 }); await drain(); });
  assert.equal(panel.querySelector(".state.offline")?.textContent, "Reconnecting…");
  assertNoDomNode(panel.querySelector(".state-title"), "no No Usage title while disconnected");
  await view.unmount();
});
