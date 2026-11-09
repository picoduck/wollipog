import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SubscriptionUsageBucket, SubscriptionUsageResponse, SubscriptionUsageSourceView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode, textBefore } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { AccountUsageMeters } from "./AccountChoice.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { subscriptionFullTime } from "./SubscriptionsTab.js";
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

installDomTestCleanup(domWindow);

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const window_ = (id: string, label: string, left: number | undefined, extra: Partial<SubscriptionUsageBucket> = {}): SubscriptionUsageBucket => ({
  id,
  label,
  ...(left === undefined ? {} : { remainingPercent: left, usedPercent: 100 - left }),
  resetsAt: NOW + 6 * DAY + 37 * 60_000 + 11_000,
  status: "available",
  ...extra,
});

const source = (over: Partial<SubscriptionUsageSourceView> = {}): SubscriptionUsageSourceView => ({
  sourceId: "a".repeat(32),
  runnerId: "runner-1",
  runnerName: "build-box",
  runnerStatus: "online",
  agentId: "codex",
  agentName: "Codex App Server",
  provider: "codex",
  providerAccountId: "work",
  accountLabel: "work.person@example.test",
  plan: "pro",
  state: "available",
  freshness: "fresh",
  fetchedAt: NOW,
  buckets: [],
  ...over,
});

const response = (sources: SubscriptionUsageSourceView[], refresh?: SubscriptionUsageResponse["refresh"]): SubscriptionUsageResponse => ({
  sources, staleAfterMs: 600_000, generatedAt: NOW, ...(refresh ? { refresh } : {}),
});

const THREE_WINDOWS = [
  window_("weekly", "Weekly", 58),
  window_("five_hour", "Five-Hour Window", 20, { resetsAt: NOW + 2 * HOUR + 5 * 60_000 }),
  window_("spark", "Spark Weekly", 0, { status: "exhausted" }),
];

interface Toast { message: string; tone?: string }

async function renderTab(client: Partial<ApiClient>, tab: "subscriptions" | undefined = "subscriptions") {
  const toasts: Toast[] = [];
  const feedback = {
    confirm: async () => false,
    showToast: (message: string, options?: { tone?: string }) => { toasts.push({ message, tone: options?.tone }); return toasts.length; },
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  const full = {
    ...api,
    // The API Usage tab is not under test: its request never settles.
    usage: () => new Promise(() => undefined),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
    usageUsers: async () => ({ users: [] }),
    ...client,
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={full}>
        <FeedbackContext.Provider value={feedback as never}><UsageView tab={tab} /></FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const panel = () => container.querySelector<HTMLElement>("#usage-subscriptions-panel");
  return {
    container,
    panel,
    toasts,
    tab: (key: string) => container.querySelector<HTMLButtonElement>(`#usage-${key}-tab`)!,
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("an account with three windows is one surface with a meter, \"N% left\" and a reset per window", async () => {
  const view = await renderTab({ subscriptionUsage: async () => response([source({ buckets: THREE_WINDOWS })]) });
  try {
    const surfaces = view.panel()!.querySelectorAll(".subscription-plan");
    assert.equal(surfaces.length, 1);
    const surface = surfaces[0]!;
    assert.equal(surface.querySelector(".subscription-plan-title")?.textContent, "Codex Pro", "provider and plan, no dash");
    const rows = [...surface.querySelectorAll(".subscription-window")];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(row.querySelector('.meter[role="progressbar"]'), "each window has a meter");
      assert.match(row.querySelector(".subscription-window-left")?.textContent ?? "", /^\d+% left$/);
      assert.match(row.querySelector(".subscription-window-reset")?.textContent ?? "", /^Resets in /);
    }
    assert.deepEqual(rows.map((row) => row.querySelector(".subscription-window-left")?.textContent), ["58% left", "20% left", "0% left"]);
    assert.equal(rows[0]!.querySelector(".subscription-window-reset")?.textContent, "Resets in 7 days");
    // One reading per window: never a remaining and a used percentage side by side.
    assert.doesNotMatch(surface.textContent ?? "", /Remaining|Used|42%|80%/);
    // The full reset time is in the tooltip, to the minute; nothing on the tab shows seconds.
    const title = rows[0]!.querySelector(".subscription-window-reset")?.getAttribute("title") ?? "";
    assert.equal(title, subscriptionFullTime(THREE_WINDOWS[0]!.resetsAt!));
    const everyTime = [view.panel()!.textContent ?? "", ...[...view.panel()!.querySelectorAll("[title]")].map((node) => node.getAttribute("title") ?? "")];
    for (const text of everyTime) assert.doesNotMatch(text, /\d:\d\d:\d\d/, `no seconds in "${text}"`);
  } finally {
    await view.unmount();
  }
});

const shared = (runnerId: string, runnerName: string, over: Partial<SubscriptionUsageSourceView> = {}) => source({
  sourceId: runnerId.padEnd(32, "0"), runnerId, runnerName, subscriptionKey: "shared-subscription", ...over,
});

test("one subscription on two machines is one account with merged meters and a machine list", async () => {
  const view = await renderTab({ subscriptionUsage: async () => response([
    shared("laptop", "Laptop", { fetchedAt: NOW - HOUR, buckets: [window_("weekly", "Weekly", 90)] }),
    shared("box", "Box", { fetchedAt: NOW, buckets: [window_("weekly", "Weekly", 40), window_("five_hour", "Five-Hour Window", 70)] }),
  ]) });
  try {
    const surfaces = view.panel()!.querySelectorAll(".subscription-plan");
    assert.equal(surfaces.length, 1);
    assert.match(view.panel()!.querySelector(".section-title")?.textContent ?? "", /^1 Account$/);
    const surface = surfaces[0]!;
    assert.deepEqual(
      [...surface.querySelectorAll(".subscription-window")].map((row) => row.querySelector(".subscription-window-left")?.textContent),
      ["40% left", "70% left"],
      "the newest reading of each window",
    );
    assert.equal(surface.querySelector(".subscription-plan-machine")?.textContent, "On 2 Machines");
    assert.equal(surface.querySelector("details summary")?.textContent, "On 2 Machines");
    assert.deepEqual(
      [...surface.querySelectorAll("details .subscription-unavailable-name")].map((name) => name.textContent),
      ["Codex App Server on Laptop", "Codex App Server on Box"],
    );
  } finally {
    await view.unmount();
  }
});

test("an offline machine is named in the list while the account stays healthy", async () => {
  const view = await renderTab({ subscriptionUsage: async () => response([
    shared("laptop", "Laptop", { buckets: [window_("weekly", "Weekly", 90)] }),
    shared("studio", "Studio", { fetchedAt: NOW - HOUR, runnerStatus: "offline", freshness: "stale", buckets: [window_("weekly", "Weekly", 95)] }),
  ]) });
  try {
    const surface = view.panel()!.querySelector(".subscription-plan")!;
    assertNoDomNode(surface.querySelector(".subscription-plan-head .status"), "another machine still reports this account");
    const rows = [...surface.querySelectorAll("details .subscription-unavailable-row")];
    assertNoDomNode(rows[0]!.querySelector(".status"), "a healthy machine has no badge");
    assert.equal(rows[1]!.querySelector(".status")?.textContent, "Offline");
    assert.match(rows[1]!.querySelector(".subscription-unavailable-reason")?.textContent ?? "", /The machine is offline\. Last update /);
  } finally {
    await view.unmount();
  }
});

test("a signed-in machine with no reading yet joins the account instead of Sources Unavailable", async () => {
  const view = await renderTab({ subscriptionUsage: async () => response([
    shared("laptop", "Laptop", { buckets: [window_("weekly", "Weekly", 90)] }),
    shared("box", "Box", { state: "unavailable", detail: "Codex subscription usage has not been fetched yet." }),
  ]) });
  try {
    assert.doesNotMatch(view.panel()!.textContent ?? "", /Sources? Unavailable/);
    const rows = [...view.panel()!.querySelectorAll("details .subscription-unavailable-row")];
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.querySelector(".status")?.textContent, "Unavailable");
  } finally {
    await view.unmount();
  }
});

test("Refresh Account asks every machine on the subscription, and shows the last answer", async () => {
  const requests: unknown[] = [];
  const stale = [
    shared("laptop", "Laptop", { providerAccountId: "work", buckets: [window_("weekly", "Weekly", 90)] }),
    shared("box", "Box", { providerAccountId: "work-copy", buckets: [window_("weekly", "Weekly", 90)] }),
  ];
  const view = await renderTab({
    subscriptionUsage: async () => response(stale),
    refreshSubscriptionUsage: async (target: unknown) => {
      requests.push(target);
      return {
        ...response([stale[0]!, { ...stale[1]!, buckets: [window_("weekly", "Weekly", requests.length === 1 ? 80 : 10)] }], { attempted: 1, failed: 0 }),
        generatedAt: NOW + requests.length,
      };
    },
  });
  try {
    await act(async () => { view.button("Refresh Account")!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(requests, [
      { runnerId: "laptop", providerAccountId: "work" },
      { runnerId: "box", providerAccountId: "work-copy" },
    ]);
    assert.equal(view.toasts.at(-1)?.message, "Account refreshed.");
  } finally {
    await view.unmount();
  }
});

test("one machine failing a shared refresh is reported, and the others still count", async () => {
  const sources = [
    shared("laptop", "Laptop", { providerAccountId: "work", buckets: [window_("weekly", "Weekly", 90)] }),
    shared("box", "Box", { providerAccountId: "work-copy", buckets: [window_("weekly", "Weekly", 90)] }),
  ];
  const view = await renderTab({
    subscriptionUsage: async () => response(sources),
    refreshSubscriptionUsage: async (target?: { runnerId: string }) => {
      if (target?.runnerId === "box") throw new Error("unreachable");
      return response(sources, { attempted: 1, failed: 0 });
    },
  });
  try {
    await act(async () => { view.button("Refresh Account")!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.equal(view.toasts.at(-1)?.message, "1 of 2 machines couldn't refresh. The last known values are still shown.");
    assert.equal(view.toasts.at(-1)?.tone, "warning");
  } finally {
    await view.unmount();
  }
});

test("the tab's attention count reads each subscription once, not once per machine", async () => {
  const view = await renderTab({ subscriptionUsage: async () => response([
    shared("laptop", "Laptop", { buckets: [window_("five_hour", "Five-Hour Window", 20)] }),
    shared("box", "Box", { buckets: [window_("five_hour", "Five-Hour Window", 20)] }),
  ]) });
  try {
    const badges = [...view.panel()!.querySelectorAll(".subscription-window .status")];
    assert.equal(badges.length, 1);
    assert.equal(view.tab("subscriptions").querySelector(".count-badge")?.textContent, "1");
  } finally {
    await view.unmount();
  }
});

test("a healthy account has no badge, and a window with 20% left is Approaching Limit and counted", async () => {
  const healthy = source({ buckets: [window_("weekly", "Weekly", 58), window_("five_hour", "Five-Hour Window", 70)] });
  const close = source({
    sourceId: "b".repeat(32), provider: "claude", agentName: "Claude Code", plan: "max", providerAccountId: "personal",
    buckets: [window_("five_hour", "Five-Hour Window", 20)],
  });
  const view = await renderTab({ subscriptionUsage: async () => response([healthy, close]) });
  try {
    const [first, second] = [...view.panel()!.querySelectorAll(".subscription-plan")];
    assertNoDomNode(first!.querySelector(".subscription-plan-head .status"), "no Available badge on a healthy account");
    assertNoDomNode(first!.querySelector(".subscription-window .status"));
    assert.doesNotMatch(view.panel()!.textContent ?? "", /Available/);
    const row = second!.querySelector(".subscription-window")!;
    assert.equal(row.querySelector(".status")?.textContent, "Approaching Limit");
    assert.equal(row.querySelector(".meter")?.className, "meter t-warning");
    assert.equal(second!.querySelector(".subscription-plan-title")?.textContent, "Claude Max");
    // The tab counts exactly the Approaching Limit and Exhausted badges.
    const badges = [...view.panel()!.querySelectorAll(".subscription-window .status")]
      .filter((badge) => /^(Approaching Limit|Exhausted)$/.test(badge.textContent ?? ""));
    assert.equal(badges.length, 1);
    assert.equal(view.tab("subscriptions").querySelector(".count-badge")?.textContent, "1");
    assert.equal(view.tab("subscriptions").getAttribute("aria-label"), "Subscriptions, 1 Need Attention");
  } finally {
    await view.unmount();
  }
});

test("the same windows read the same percentages and tones here and in Switch Account", async () => {
  const buckets = [
    ...THREE_WINDOWS,
    window_("warned", "Provider Warned", 60, { status: "warning" }),
    window_("edge", "Edge", 24.6),
    // Headroom that rounds to "0% left" is still headroom: Exhausted needs nothing left.
    window_("sliver", "Sliver", 0.4),
  ];
  const view = await renderTab({ subscriptionUsage: async () => response([source({ buckets })]) });
  const meters = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(meters as never);
  const metersRoot = createRoot(meters);
  try {
    await act(async () => metersRoot.render(<AccountUsageMeters buckets={buckets} />));
    const read = (scope: Element) => [...scope.querySelectorAll('.meter[role="progressbar"]')]
      .map((meter) => ({ name: meter.getAttribute("aria-label"), left: meter.getAttribute("aria-valuenow"), tone: meter.className }));
    const here = read(view.panel()!);
    assert.deepEqual(here, read(meters));
    assert.deepEqual(here.map(({ left, tone }) => [left, tone]), [
      ["58", "meter"],
      ["20", "meter t-warning"],
      ["0", "meter t-danger"],
      ["60", "meter t-warning"],
      ["25", "meter"],
      ["0", "meter t-warning"],
    ]);
    // The figures beside them agree with the meters.
    assert.deepEqual(
      [...view.panel()!.querySelectorAll(".subscription-window-left")].map((node) => node.textContent),
      ["58% left", "20% left", "0% left", "60% left", "25% left", "0% left"],
    );
    assert.deepEqual(
      [...meters.querySelectorAll(".account-usage-text")].map((node) => node.textContent?.replace(/^.* · /, "")),
      ["58% left", "20% left", "0% left", "60% left", "25% left", "0% left"],
    );
    assert.deepEqual(
      [...view.panel()!.querySelectorAll(".subscription-window")].map((row) => row.querySelector(".status")?.textContent ?? null),
      [null, "Approaching Limit", "Exhausted", "Approaching Limit", null, "Approaching Limit"],
    );
  } finally {
    await act(async () => metersRoot.unmount());
    meters.remove();
    await view.unmount();
  }
});

test("a window the provider does not measure says so with its reset, never a bare dash", async () => {
  const view = await renderTab({
    subscriptionUsage: async () => response([source({ buckets: [window_("five_hour", "Five-Hour Window", undefined)] })]),
  });
  try {
    const row = view.panel()!.querySelector(".subscription-window")!;
    assert.ok(row.classList.contains("unmeasured"));
    assertNoDomNode(row.querySelector(".meter"), "no meter without a level");
    assert.equal(row.querySelector(".subscription-window-left")?.textContent, "No percentage reported");
    assert.match(row.querySelector(".subscription-window-reset")?.textContent ?? "", /^Resets in /);
    assert.doesNotMatch(row.textContent ?? "", /—/);
  } finally {
    await view.unmount();
  }
});

test("three sources without windows fold into one collapsed line that opens to a row each", async () => {
  const offline = source({
    sourceId: "c".repeat(32), runnerId: "runner-2", runnerName: "laptop", runnerStatus: "offline",
    provider: "claude", agentName: "Claude Code", state: "unavailable", freshness: "stale", fetchedAt: NOW - 2 * DAY,
  });
  const apiKey = source({
    sourceId: "d".repeat(32), state: "not_applicable", providerAccountId: undefined, accountLabel: undefined,
    detail: "Codex is using API-key billing; subscription allowances do not apply.",
  });
  const unsupported = source({
    sourceId: "e".repeat(32), runnerName: "old-box", state: "unsupported", providerAccountId: undefined, accountLabel: undefined,
  });
  const view = await renderTab({
    subscriptionUsage: async () => response([source({ buckets: THREE_WINDOWS }), offline, apiKey, unsupported]),
  });
  try {
    const disclosures = view.panel()!.querySelectorAll("details.disclosure");
    assert.equal(disclosures.length, 1);
    const details = disclosures[0] as unknown as HTMLDetailsElement;
    assert.equal(details.open, false, "collapsed until opened");
    assert.equal(details.querySelector("summary")?.textContent, "3 Sources Unavailable");
    assert.equal(view.panel()!.querySelectorAll(".subscription-plan").length, 1, "the unavailable sources take no surfaces");
    assert.equal(view.panel()!.querySelector(".section-title")?.textContent, "1 Account");
    const rows = [...details.querySelectorAll(".subscription-unavailable-row")];
    assert.deepEqual(rows.map((row) => row.querySelector(".subscription-unavailable-name")?.textContent), [
      "Claude Code on laptop",
      "Codex App Server on build-box",
      "Codex App Server on old-box",
    ]);
    const reasons = rows.map((row) => row.querySelector(".subscription-unavailable-reason")?.textContent ?? "");
    assert.match(reasons[0]!, /^The machine is offline\. Last update .+\.$/);
    assert.equal(reasons[1], "Codex is using API-key billing; subscription allowances do not apply.");
    assert.equal(reasons[2], "This version of Codex App Server doesn't report subscription usage.");
    assert.deepEqual(rows.map((row) => [row.querySelector(".status")?.textContent, row.querySelector(".status")?.className.includes("t-neutral")]), [
      ["Offline", true],
      ["Not Applicable", true],
      ["Unsupported", true],
    ]);
  } finally {
    await view.unmount();
  }
});

test("with no sources the tab is No Subscriptions Connected with Open Connections and no Refresh", async () => {
  let opened = 0;
  const toasts: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = { ...api, usage: () => new Promise(() => undefined), subscriptionUsage: async () => response([]),
    usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }), usageUsers: async () => ({ users: [] }) } as unknown as ApiClient;
  try {
    await act(async () => {
      root.render(<ApiProvider client={client}><UsageView tab="subscriptions" onOpenConnections={() => opened++} /></ApiProvider>);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const panel = container.querySelector("#usage-subscriptions-panel")!;
    assert.match(panel.textContent ?? "", /No Subscriptions Connected/);
    assert.match(panel.textContent ?? "", /Sign in to Codex or Claude on a connected machine, and each plan's remaining allowance shows here\./);
    assert.equal([...container.querySelectorAll("button")].some((button) => /Refresh/.test(button.textContent ?? "") ||
      /Refresh/.test(button.getAttribute("aria-label") ?? "")), false, "nothing to refresh");
    const link = panel.querySelector<HTMLAnchorElement>("a.btn")!;
    assert.equal(link.textContent, "Open Connections");
    assert.equal(link.getAttribute("href"), "/connections/machines");
    await act(async () => { link.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as never); });
    assert.equal(opened, 1);
    assert.deepEqual(toasts, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Refresh All keeps its label while busy and a partial failure is a warning toast", async () => {
  let release: (value: SubscriptionUsageResponse) => void = () => undefined;
  const targets: unknown[] = [];
  const view = await renderTab({
    subscriptionUsage: async () => response([source({ buckets: THREE_WINDOWS })]),
    refreshSubscriptionUsage: (target?: unknown) => {
      targets.push(target);
      return new Promise<SubscriptionUsageResponse>((resolve) => { release = resolve; });
    },
  });
  try {
    const refreshAll = view.button("Refresh All")!;
    assert.ok(refreshAll, "Refresh All is in the section head");
    assert.match(view.panel()!.querySelector(".section-head")?.textContent ?? "", /^1 AccountUpdated /);
    await act(async () => { refreshAll.click(); await Promise.resolve(); });
    assert.equal(refreshAll.textContent, "Refresh All", "the label stays while busy");
    assert.equal(refreshAll.getAttribute("aria-busy"), "true");
    assert.deepEqual(targets, [undefined]);
    // A second press, or an account's refresh, waits for the one in flight.
    await act(async () => { refreshAll.click(); view.button("Refresh Account")!.click(); await Promise.resolve(); });
    assert.equal(targets.length, 1);
    await act(async () => {
      release(response([source({ buckets: THREE_WINDOWS })], { attempted: 3, failed: 2 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(refreshAll.getAttribute("aria-busy"), null);
    assert.deepEqual(view.toasts, [{ message: "2 of 3 machines couldn't refresh. The last known values are still shown.", tone: "warning" }]);
    assertNoDomNode(view.panel()!.querySelector('[role="status"]:not(.sr-only)'), "the result is a toast, not a status line that stays");

    await act(async () => { view.button("Refresh Account")!.click(); await Promise.resolve(); });
    assert.deepEqual(targets[1], { runnerId: "runner-1", providerAccountId: "work" });
    await act(async () => { release(response([source({ buckets: THREE_WINDOWS })], { attempted: 0, failed: 0 })); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(view.toasts[1], { message: "No machine was online to refresh. The last known values are unchanged.", tone: "warning" });

    await act(async () => { refreshAll.click(); await Promise.resolve(); });
    await act(async () => { release(response([source({ buckets: THREE_WINDOWS })], { attempted: 2, failed: 0 })); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(view.toasts[2], { message: "Subscriptions refreshed.", tone: "success" });
  } finally {
    await view.unmount();
  }
});

test("only a Codex account offers Refresh Account, as a small icon button beside the email reveal", async () => {
  const claude = source({ sourceId: "b".repeat(32), provider: "claude", agentName: "Claude Code", plan: "max", providerAccountId: "personal",
    accountLabel: "me@example.test", buckets: [window_("weekly", "Weekly", 40)] });
  const view = await renderTab({ subscriptionUsage: async () => response([source({ buckets: THREE_WINDOWS }), claude]) });
  try {
    const [codex, other] = [...view.panel()!.querySelectorAll(".subscription-plan")];
    const actions = [...codex!.querySelectorAll(".subscription-plan-actions > button")];
    assert.deepEqual(actions.map((button) => [button.getAttribute("aria-label"), button.className]), [
      ["Show Account Email", "icon-btn sm pid-toggle"],
      ["Refresh Account", "icon-btn sm"],
    ]);
    assert.deepEqual([...other!.querySelectorAll(".subscription-plan-actions > button")].map((button) => button.getAttribute("aria-label")),
      ["Show Account Email"]);
  } finally {
    await view.unmount();
  }
});

test("the account is masked behind an Account lead and revealed only by its control", async () => {
  const view = await renderTab({
    subscriptionUsage: async () => response([
      source({ buckets: THREE_WINDOWS }),
      // An unbound source's label is the provider's report, masked whatever its shape.
      source({ sourceId: "b".repeat(32), providerAccountId: undefined, accountLabel: "Reported Name", buckets: THREE_WINDOWS }),
    ]),
  });
  try {
    assert.equal(view.container.innerHTML.includes("@example.test"), false);
    assert.equal(view.container.innerHTML.includes("Reported Name"), false);
    for (const account of view.panel()!.querySelectorAll(".subscription-plan-account")) {
      const mask = account.querySelector(".pid-mask")!;
      assert.equal(mask.textContent, "Email Hidden");
      assert.equal(textBefore(account, mask), "Account");
    }
    const meta = view.panel()!.querySelector(".subscription-plan-meta")!;
    assert.match(meta.textContent ?? "", /^Codex App Server on build-box/);
    await act(async () => { view.button("Show Account Email")!.click(); });
    assert.equal(view.panel()!.querySelector(".subscription-plan-account .pid-value")?.textContent, "work.person@example.test");
    assert.ok(view.button("Hide Account Email"));
  } finally {
    await view.unmount();
  }
});

test("a stale or signed-out account carries its one badge; the detail keeps its redaction", async () => {
  const view = await renderTab({
    subscriptionUsage: async () => response([
      source({ freshness: "stale", buckets: THREE_WINDOWS, detail: "Refresh for someone@example.test failed." }),
      source({ sourceId: "b".repeat(32), state: "unauthenticated", buckets: THREE_WINDOWS }),
    ]),
  });
  try {
    const heads = [...view.panel()!.querySelectorAll(".subscription-plan-head")];
    assert.deepEqual(heads.map((head) => [...head.querySelectorAll(".status")].map((badge) => badge.textContent)), [
      ["Last Known — Stale"],
      ["Sign-In Required"],
    ]);
    assert.equal(view.container.innerHTML.includes("someone@example.test"), false);
  } finally {
    await view.unmount();
  }
});

test("loading is three skeleton rows in one surface, and a failed load is an error with Retry", async () => {
  let fail = true;
  let resolveFirst: () => void = () => undefined;
  const view = await renderTab({
    subscriptionUsage: () => new Promise<SubscriptionUsageResponse>((resolve, reject) => {
      resolveFirst = () => (fail ? reject(new Error("upstream 502")) : resolve(response([source({ buckets: THREE_WINDOWS })])));
    }),
  });
  try {
    const skeleton = view.panel()!.querySelector('.surface[role="status"]')!;
    assert.equal(skeleton.querySelectorAll(".row").length, 3);
    assert.match(skeleton.textContent ?? "", /Loading subscriptions…/);
    await act(async () => { resolveFirst(); await Promise.resolve(); await Promise.resolve(); });
    const alert = view.panel()!.querySelector('[role="alert"]')!;
    assert.match(alert.textContent ?? "", /Couldn't Load Subscriptions/);
    assert.doesNotMatch(alert.textContent ?? "", /upstream 502/, "the raw message waits behind Show Details");
    await act(async () => { view.button("Show Details")!.click(); });
    assert.match(view.panel()!.textContent ?? "", /upstream 502/);
    fail = false;
    await act(async () => { view.button("Retry")!.click(); await Promise.resolve(); });
    await act(async () => { resolveFirst(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(view.panel()!.querySelectorAll(".subscription-plan").length, 1);
  } finally {
    await view.unmount();
  }
});
