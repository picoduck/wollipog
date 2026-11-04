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
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { UsageView } from "./UsageView.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// `UsageView` debounces its request through `window.setTimeout`; as in UsageView.dom.test.tsx a
// timeout fires only when a test advances this clock, so no test races a real timer.
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
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const settleLoad = async () => {
  await drain();
  const until = clockNow + 120;
  for (;;) {
    const [next] = [...pendingTimeouts].filter(([, timeout]) => timeout.at <= until).sort(([, a], [, b]) => a.at - b.at);
    if (!next) break;
    pendingTimeouts.delete(next[0]);
    clockNow = next[1].at;
    next[1].run();
    await drain();
  }
  clockNow = until;
  await drain();
};
installDomTestCleanup(domWindow, { reset: () => pendingTimeouts.clear() });

const DAY = 86_400_000;
/** An exclusive midnight, so the default 30-day range is exactly the 30 days Aug 5 – Sep 3. */
const THROUGH = Date.UTC(2026, 8, 4);

const amount = (costUsd: number, tokens = Math.round(costUsd * 1_000)): UsageAmount => ({
  inputTokens: tokens, outputTokens: 0, costUsd, uncachedInputTokens: tokens, cachedInputTokens: 0,
  cacheCreationTokens: 0, reasoningTokens: 0, cacheSavingsUsd: 0, costSource: "providerReported", unpricedRecords: 0,
  processedTokens: tokens,
});

/** A daily window with Claude Code usage on the given days, and ACP usage by `gemini` on the last. */
function window30(days: Array<[number, number]>, coverageStartedAt = 0): UsageAggregationResponse {
  const lastDay = THROUGH - DAY;
  const claude = days.map(([bucketTs, cost]) => ({ bucketTs, driver: "claude-code" as const, ...amount(cost) }));
  const acp = { bucketTs: lastDay, driver: "acp" as const, ...amount(1) };
  const split = [...claude, acp];
  const series = [...new Set(split.map((row) => row.bucketTs))].sort((a, b) => b - a).map((bucketTs) => {
    const cost = split.filter((row) => row.bucketTs === bucketTs).reduce((sum, row) => sum + row.costUsd, 0);
    return { bucketTs, ...amount(cost) };
  });
  const claudeTotal = amount(claude.reduce((sum, row) => sum + row.costUsd, 0));
  const total = amount(claudeTotal.costUsd + 1);
  return {
    granularity: "day",
    supportedGranularities: ["hour", "day", "week"],
    hourlyDataAvailable: true,
    since: Math.max(THROUGH - 30 * DAY, Math.floor(coverageStartedAt / DAY) * DAY),
    through: THROUGH,
    retention: { hourlyDays: 30, dailyDays: 365, coverageStartedAt },
    canManageRetention: false,
    privacy: "Content-free usage accounting.",
    totals: total,
    series,
    seriesByDriver: split.sort((a, b) => b.bucketTs - a.bucketTs),
    byDriver: [{ key: "claude-code", ...claudeTotal }, { key: "acp", ...amount(1) }],
    // The plane's shape: one row per agent and model, keyed `<agent id> / <model>`.
    byAgent: [
      { key: "claude / claude-fable-5-1", ...claudeTotal },
      { key: "gemini / gemini-3-pro", ...amount(0.6) },
      { key: "gemini / gemini-3-flash", ...amount(0.4) },
    ],
    byRunner: [],
    byModel: [],
  };
}

const client = (data: UsageAggregationResponse) => ({
  ...api,
  subscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
  refreshSubscriptionUsage: async () => ({ sources: [], staleAfterMs: 600_000, generatedAt: Date.now() }),
  usageDailyBudget: async () => ({ dailyBudget: { perUserUsd: null, updatedAt: null } }),
  usageUsers: async () => ({ users: [] }),
  usage: async (query: { granularity?: UsageAggregationGranularity }) => ({ ...data, granularity: query.granularity ?? data.granularity }),
}) as unknown as ApiClient;

async function render(data: UsageAggregationResponse, wrap: (view: React.ReactElement) => React.ReactElement = (view) => view) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client(data)}>{wrap(<UsageView />)}</ApiProvider>);
  });
  await act(async () => {
    await settleLoad();
    await Promise.resolve();
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const readout = (container: HTMLElement) => container.querySelector(".usage-chart-readout")?.textContent ?? "";
const hits = (container: HTMLElement) => [...container.querySelectorAll<SVGRectElement>(".usage-chart-hit")];
const pointer = async (target: Element, type: string, pointerType: "mouse" | "touch") => {
  await act(async () => {
    target.dispatchEvent(new domWindow.PointerEvent(type, { bubbles: true, pointerType }) as never);
    await Promise.resolve();
  });
};
const tap = async (target: Element) => {
  await pointer(target, "pointerdown", "touch");
  await act(async () => {
    (target as unknown as HTMLElement).focus();
    target.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }) as never);
    await Promise.resolve();
  });
};
const key = async (target: Element, keyName: string) => {
  await act(async () => {
    fireDomEvent.keyDown(target as unknown as HTMLElement, { key: keyName });
    await Promise.resolve();
  });
};

test("usage on 3 of 30 days draws 30 columns whose axis spans the whole range", async () => {
  const { container, cleanup } = await render(window30([[THROUGH - 26 * DAY, 4], [THROUGH - 12 * DAY, 16.1], [THROUGH - DAY, 2]]));
  const columns = [...container.querySelectorAll(".usage-chart-column")];
  assert.equal(columns.length, 30);
  assert.equal(columns.filter((column) => column.querySelector(".usage-chart-segment")).length, 3, "27 columns are at zero");
  const labels = [...container.querySelectorAll(".usage-chart-axis")];
  assert.equal(labels[0]?.textContent, "Aug 5", "the axis starts where the range does, not at the first day of usage");
  assert.equal(labels.at(-1)?.textContent, "Sep 3");
  assert.equal(labels.at(-1)?.getAttribute("text-anchor"), "end", "the last label ends at the plot's edge");
  assert.ok(labels.slice(0, -1).every((label) => label.getAttribute("text-anchor") === "middle"));
  assert.equal(hits(container).length, 30, "every recorded day is a target, zero or not");
  assertNoDomNode(container.querySelector(".usage-chart-unrecorded"), "a fully recorded range has no Not Recorded band");
  await cleanup();
});

test("days before recording started are one Not Recorded band the arrow keys skip", async () => {
  const coverageStartedAt = THROUGH - 10 * DAY;
  const { container, cleanup } = await render(window30([[THROUGH - 3 * DAY, 3]], coverageStartedAt));
  assert.equal(container.querySelectorAll(".usage-chart-column").length, 30, "the axis still spans the chosen 30 days");
  const bands = [...container.querySelectorAll(".usage-chart-unrecorded")];
  assert.equal(bands.length, 1, "the 20 unrecorded days are one band");
  assert.equal(bands[0]!.textContent, "Not Recorded");
  const band = bands[0]!.querySelector("rect")!;
  const firstHit = hits(container)[0]!;
  assert.equal(Number(band.getAttribute("x")) + Number(band.getAttribute("width")), Number(firstHit.getAttribute("x")),
    "the band ends where the first recorded column starts");

  const targets = hits(container);
  assert.equal(targets.length, 10, "only recorded days are targets");
  assert.deepEqual(targets.map((hit) => hit.getAttribute("tabindex")), ["0", ...Array(9).fill("-1")],
    "Tab enters the group once, at its first recorded day");
  await act(async () => { (targets[0] as unknown as HTMLElement).focus(); });
  assert.match(readout(container), /^Aug 25, 2026/, "focus replaces the resting line with the column's split");
  await key(targets[0]!, "ArrowLeft");
  assert.equal(domWindow.document.activeElement, targets[0], "there is no column to the left of the band to land on");
  await key(targets[0]!, "ArrowRight");
  assert.equal(domWindow.document.activeElement, targets[1]);
  assert.match(readout(container), /^Aug 26, 2026/);
  assert.equal(targets[1]!.getAttribute("tabindex"), "0", "the group remembers where focus left it");
  await key(targets[1]!, "End");
  assert.equal(domWindow.document.activeElement, targets[9]);
  await key(targets[9]!, "Home");
  assert.equal(domWindow.document.activeElement, targets[0], "Home lands on the first recorded day, never the band");
  await key(targets[0]!, "Escape");
  assert.match(readout(container), /^Daily average/, "Escape clears the readout");
  await cleanup();
});

test("at rest the readout gives the average and peak; hover and taps replace it in place", async () => {
  const { container, cleanup } = await render(window30([[THROUGH - 26 * DAY, 4], [THROUGH - 12 * DAY, 16.1], [THROUGH - DAY, 2]]));
  // $23.10 over 30 recorded days: $0.77. The peak is Aug 23's $16.10.
  assert.equal(readout(container), "Daily average $0.77 · Peak $16.10 on Aug 23");
  assert.doesNotMatch(container.textContent ?? "", /Hover or focus/, "the instruction is gone");
  const svg = container.querySelector(".usage-chart-svg")!;
  const targets = hits(container);
  const peak = targets[18]!;

  await pointer(peak, "pointerover", "mouse");
  assert.match(readout(container), /^Aug 23, 2026 · 00:00–23:59 UTC.*Claude Code\$16\.10.*Total\$16\.10/);
  assert.ok(svg.classList.contains("has-active"), "the other columns recede while one is hovered");
  assert.ok(container.querySelectorAll(".usage-chart-column")[18]!.classList.contains("is-hovered"));
  await pointer(container.querySelector(".usage-chart")!, "pointerout", "mouse");
  await pointer(container.querySelector(".usage-chart")!, "pointerleave", "mouse");
  assert.equal(readout(container), "Daily average $0.77 · Peak $16.10 on Aug 23", "leaving the chart restores the resting line");
  assert.ok(!svg.classList.contains("has-active"));

  // A touch press is not a hover, and a tap's focus is not the keyboard's: only the tap selects.
  await pointer(peak, "pointerover", "touch");
  assert.match(readout(container), /^Daily average/);
  await tap(peak);
  assert.match(readout(container), /^Aug 23, 2026/, "a tap selects the column");
  await tap(targets[29]!);
  assert.match(readout(container), /^Sep 3, 2026.*Claude Code\$2\.00.*Other Agents\$1\.00/, "a tap on another column moves the selection");
  await tap(targets[29]!);
  assert.match(readout(container), /^Daily average/, "a second tap on the same column clears it");
  await tap(peak);
  assert.match(readout(container), /^Aug 23, 2026/);
  await pointer(domWindow.document.body as unknown as Element, "pointerdown", "touch");
  assert.match(readout(container), /^Daily average/, "a tap outside the columns clears it");
  await cleanup();
});

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

test("one ACP agent names the ACP series in the driver list, readout and table, never ACP", async () => {
  const runner: RunnerView = {
    runnerId: "runner-1", hostname: "build-box", os: "linux", version: "1", status: "online",
    agents: [
      { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
      { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], env: {} },
    ],
    workspaces: [], editors: [], connectedAt: 1, lastSeen: 1, protocolVersion: 75,
  };
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "usage-chart", runtimeKey: "usage-chart:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "usage" }), push() {}, listen: () => () => {} };
  const { container, cleanup } = await render(
    window30([[THROUGH - DAY, 2]]),
    (view) => <StoreProvider connection={connection} navigation={navigation}>{view}</StoreProvider>,
  );
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [], sessions: [], runs: [], pods: [],
    });
    await Promise.resolve();
  });
  const names = [...container.querySelectorAll(".usage-driver-name")].map((node) => node.textContent);
  assert.deepEqual(names, ["Claude Code", "Gemini CLI"]);
  const peak = hits(container).at(-1)!;
  await pointer(peak, "pointerover", "mouse");
  assert.match(readout(container), /Gemini CLI\$1\.00/);
  const headers = [...container.querySelectorAll(".usage-tables-section thead th")].map((node) => node.textContent);
  assert.ok(headers.includes("Gemini CLI"), `the period table names the agent: ${headers.join(", ")}`);
  assert.doesNotMatch(container.textContent ?? "", /\bACP\b/, "the protocol's name appears nowhere");
  await cleanup();
});
