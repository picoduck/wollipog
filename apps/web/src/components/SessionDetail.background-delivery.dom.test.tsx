import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BackgroundDeliveryView, ControlPlaneToUi, ProjectView, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail, type SessionDetailMode } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { staticPinnedSummary } from "./pinned-summary-state.js";

/**
 * #2329: a session with several background deliveries names the same one on every surface. The
 * control plane lists retained deliveries before Result Blocked ones, so a Notification Pending
 * delivery can come first; the session bar, the Pinned Summary's badge and the Sessions preview
 * header's badge all name the blocked one.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 72, width: 1200, height: 72, toJSON: () => ({}) }),
});
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
});

const RUNNER_ID = "runner-delivery";

const runner = {
  runnerId: RUNNER_ID, hostname: "mac-studio.local", os: "macos", version: "1", status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude", available: true }],
  editors: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 146,
} as unknown as RunnerView;

const project = {
  id: "payments", name: "Payments Service", hidden: false, locations: [], activeSessionCount: 0,
  unarchivedSessionCount: 1, totalSessionCount: 1, createdAt: 1, updatedAt: 1,
} as ProjectView;

const pending: BackgroundDeliveryView = {
  continuationId: "bgcont-pending", parentTurnId: "turn-1", jobCount: 1, terminalCount: 1,
  watchdogState: "dashboard_observation_pending",
};
const blocked: BackgroundDeliveryView = {
  parentTurnId: "turn-2", jobCount: 2, terminalCount: 1, watchdogState: "continuation_blocked",
};
const delayed: BackgroundDeliveryView = {
  parentTurnId: "turn-3", jobCount: 1, terminalCount: 1, watchdogState: "result_not_projected",
};

const session = (backgroundDeliveries: BackgroundDeliveryView[]) => ({
  id: "several-deliveries", runnerId: RUNNER_ID, workspaceId: null, workspaceName: null, projectId: project.id,
  projectName: project.name, agentId: "claude", agentName: "Claude Code", title: "Several Deliveries", status: "idle",
  column: "review", runId: null, useWorktree: false, worktreePath: null, worktrees: [],
  backgroundWorkTracking: "managed", backgroundDeliveries, archived: false, createdAt: 1, updatedAt: 1,
  lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
  driver: "claude", model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as unknown as SessionView);

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

interface Observed {
  /** The session bar's primary status, or null in the preview, which has no bar. */
  sessionBar: string | null;
  /** Every delivery badge, by where it sits. */
  pinnedSummary: string[];
  previewHeader: string[];
  /** The panels the Pinned Summary's delivery badge asked the right panel to show. */
  opened: string[];
}

/** A delivery badge's label, from its accessible name ("Background Work: Result Blocked. …"). */
function deliveryLabels(scope: Element | null): string[] {
  return [...scope?.querySelectorAll<HTMLElement>('[data-group="background-work"][aria-label^="Background Work: "]') ?? []]
    .map((badge) => badge.textContent ?? "");
}

async function observe(mode: SessionDetailMode, backgroundDeliveries: BackgroundDeliveryView[]): Promise<Observed> {
  const socket = new FakeSocket();
  const opened: string[] = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    git: () => new Promise<never>(() => {}),
    gitSummary: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({ desired: [], reported: null }),
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "delivery-test", runtimeKey: "delivery-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: "several-deliveries" }), push: () => {}, listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show(panel: string) { opened.push(panel); }, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const feedback = { confirm: async () => false, showToast: () => 0, dismissToast: () => {} };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SessionDetail sessionId="several-deliveries" mode={mode} rightPanel={rightPanel}
              onOpenTerminal={() => {}} pinnedSummary={mode === "expanded" ? staticPinnedSummary(true) : undefined}
              composerDraftLoader={async () => null} />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [project], sessions: [session(backgroundDeliveries)], runs: [], pods: [],
    } as ControlPlaneToUi));
    await settle();
    await settle();

    const summary = container.querySelector('aside.ps[aria-label="Pinned Summary"]');
    const summaryBadge = summary?.querySelector<HTMLButtonElement>('[data-group="background-work"][aria-label^="Background Work: "]');
    if (summaryBadge) await act(async () => { summaryBadge.click(); });
    return {
      sessionBar: container.querySelector("header.session-bar .session-status-button .status")?.textContent ?? null,
      pinnedSummary: deliveryLabels(summary),
      previewHeader: deliveryLabels(container.querySelector(".session-preview-head")),
      opened,
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("a pending delivery listed before a blocked one: the bar and the Pinned Summary both name Result Blocked", async () => {
  const observed = await observe("expanded", [pending, blocked]);
  assert.deepEqual(observed, {
    sessionBar: "Result Blocked",
    pinnedSummary: ["Result Blocked"],
    previewHeader: [],
    opened: ["background"],
  });
});

test("a pending delivery listed before a blocked one: the Sessions preview header names Result Blocked", async () => {
  const observed = await observe("preview", [pending, blocked]);
  assert.deepEqual(observed.previewHeader, ["Result Blocked"]);
  assert.equal(observed.sessionBar, null, "the preview has no session bar");
});

test("with only pending deliveries every surface names the first one, as before", async () => {
  const expanded = await observe("expanded", [pending, delayed]);
  // A passive delivery never outranks the lifecycle on the bar (#2275); it is listed in its popover.
  assert.equal(expanded.sessionBar, "Awaiting Prompt");
  assert.deepEqual(expanded.pinnedSummary, ["Notification Pending"]);
  const preview = await observe("preview", [pending, delayed]);
  assert.deepEqual(preview.previewHeader, ["Notification Pending"]);
});
