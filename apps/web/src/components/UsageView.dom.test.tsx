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
  UserCostWindows,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { periodLabel } from "../usage-view-model.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { UsageView } from "./UsageView.js";

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
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
  await act(async () => { option("Group By", "Week").click(); await settleLoad(); });
  await act(async () => { finishRetention!(); await settleLoad(); });
  assert.equal(option("Group By", "Week").getAttribute("aria-checked"), "true");
  assert.equal(breakdownTabLabels(container)[0], "By Week");

  await act(async () => root.unmount());
  container.remove();
});

test("shortening retention asks in the in-app confirmation dialog, and only Shorten Retention saves", async () => {
  const at = Date.UTC(2026, 8, 21);
  const writes: { hourlyDays: number; dailyDays: number }[] = [];
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
    updateUsageRetention: async (input: { hourlyDays: number; dailyDays: number }) => {
      writes.push(input);
      return { retention: { ...input, coverageStartedAt: 0 } };
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><FeedbackProvider><UsageView /></FeedbackProvider></ApiProvider>));
  await act(async () => { await settleLoad(); });
  // Dialogs are portalled to <body>, outside the view's container.
  const dialog = () => domWindow.document.body.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const dialogButton = (name: string) => {
    const button = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name);
    assert.ok(button, `expected ${name} in the confirmation`);
    return button;
  };
  const hourly = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Hourly Buckets"))!.querySelector("input")!;
  const save = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Save Retention") as HTMLButtonElement;

  await act(async () => { fireDomEvent.change(hourly, { target: { value: "7" } }); });
  await act(async () => { save.click(); await Promise.resolve(); });
  assert.ok(dialog(), "the confirmation is the app's dialog, not the browser's");
  assert.match(dialog()!.textContent ?? "", /Shorten Usage Retention[\s\S]*permanently removed/);
  assert.equal(dialogButton("Cancel").className, "btn");
  assert.equal(dialogButton("Shorten Retention").className, "btn danger");

  await act(async () => { dialogButton("Cancel").click(); await drain(); });
  assertNoDomNode(dialog());
  assert.deepEqual(writes, [], "Cancel keeps the current retention");

  await act(async () => { save.click(); await Promise.resolve(); });
  await act(async () => { dialogButton("Shorten Retention").click(); await settleLoad(); });
  assertNoDomNode(dialog());
  assert.deepEqual(writes, [{ hourlyDays: 7, dailyDays: 365 }]);

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
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Weekly usage is temporarily unavailable/);
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
  await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
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
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
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
  const navigation: ViewNavigation = { current: () => ({ name: "usage" }), push() {}, listen: () => () => {} };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}><UsageView /></StoreProvider>
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
    await act(async () => root.render(<ApiProvider client={client}><UsageView /></ApiProvider>));
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
    await act(async () => root.render(<ApiProvider client={usageClient(response([]), people, 25)}><UsageView /></ApiProvider>));
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
    await act(async () => root.render(<ApiProvider client={usageClient(response([]), people)}><UsageView /></ApiProvider>));
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
    root.render(<ApiProvider client={client}><UsageView /></ApiProvider>);
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
      row.querySelector(".usage-series-swatch")?.className,
      row.querySelector(".usage-driver-name")?.textContent,
      row.querySelector(".usage-driver-share")?.textContent,
      row.querySelector("strong")?.textContent,
    ]),
    [
      ["usage-series-swatch usage-series-1", "Claude Code", "80%", "$4.00"],
      ["usage-series-swatch usage-series-2", "Codex", "20%", "$1.00"],
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
