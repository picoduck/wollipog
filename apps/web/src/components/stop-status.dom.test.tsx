import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { InboxRow } from "./InboxRow.js";
import { SessionStatusIndicators } from "./common.js";

/**
 * #208: a Stop that is waiting for an offline runner is still a pending Stop — capacity may still be
 * held — but nothing is being delivered, so it must not pulse like delivery in progress. Every
 * surface names it the same way, and reconnecting turns it back into Stop Pending.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = (status: "online" | "offline"): RunnerView => ({
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status,
  agents: [],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 63,
} as unknown as RunnerView);

function session(stop: "stop_pending" | "stop_failed"): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    agentId: "claude",
    title: "A Session",
    status: "running",
    column: "doing",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    pendingApproval: null,
    stopOperation: {
      operationId: "stop-1",
      status: stop,
      requestedAt: 1,
      lastAttemptAt: 1,
      attemptCount: 1,
      capacityReleased: false,
      ...(stop === "stop_failed"
        ? { failure: { code: "retry_exhausted", message: "Automatic retries were exhausted.", failedAt: 2 } }
        : {}),
    },
  } as unknown as SessionView;
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push() {}, listen: () => () => {} };

function snapshot(runnerStatus: "online" | "offline", candidate: SessionView): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner(runnerStatus)], boxes: [], projects: [], sessions: [candidate], runs: [], pods: [],
  } as unknown as UiSnapshotMessage;
}

/** The Session header's status line, which derives `disconnected` from the runner exactly so. */
function HeaderStatuses({ candidate }: { candidate: SessionView }) {
  const runnerOnline = useStoreSelector((state) => state.runners.get(candidate.runnerId)?.status === "online");
  return <div className="session-header-statuses"><SessionStatusIndicators session={candidate} disconnected={!runnerOnline} /></div>;
}

let sequence = 0;

async function mount(candidate: SessionView) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `stop-status-${sequence}`,
    runtimeKey: `stop-status-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <div role="grid">
          <InboxRow optionId="row" session={candidate} projectName="Project" selected={false} unread={false}
            pinned={false} rowIndex={1} stalled={false} activityNow={0} threeRow={false}
            onSelect={() => {}} onExpand={() => {}} onSessionMenu={() => {}} />
        </div>
        <HeaderStatuses candidate={candidate} />
      </StoreProvider>,
    );
  });
  const surfaces = () => ({
    inbox: container.querySelector<HTMLElement>('.inbox-row-signals [aria-label^="Activity:"]'),
    header: container.querySelector<HTMLElement>('.session-header-statuses [aria-label^="Activity:"]'),
  });
  return {
    socket,
    surfaces,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

function expectBadge(badge: HTMLElement | null, label: string, tone: string, pulse: boolean) {
  assert.ok(badge, `${label} badge renders`);
  assert.equal(badge.textContent, label);
  assert.equal(badge.getAttribute("aria-label"), `Activity: ${label}`);
  assert.ok(badge.classList.contains("status"), "every status badge is the one recipe");
  assert.ok(badge.classList.contains(`t-${tone}`), `${label} is ${tone}`);
  assert.equal(badge.classList.contains("pulse"), pulse, `${label} ${pulse ? "pulses" : "does not pulse"}`);
}

test("a Stop delivered to an online runner reads Stop Pending and pulses in every surface", async () => {
  const candidate = session("stop_pending");
  const view = await mount(candidate);
  try {
    await act(async () => view.socket.push(snapshot("online", candidate)));
    expectBadge(view.surfaces().inbox, "Stop Pending", "info", true);
    expectBadge(view.surfaces().header, "Stop Pending", "info", true);
  } finally {
    await view.unmount();
  }
});

test("a Stop waiting for an offline runner reads Stop Waiting for Runner, neutral and still, until it reconnects", async () => {
  const candidate = session("stop_pending");
  const view = await mount(candidate);
  try {
    await act(async () => view.socket.push(snapshot("offline", candidate)));
    expectBadge(view.surfaces().inbox, "Stop Waiting for Runner", "neutral", false);
    expectBadge(view.surfaces().header, "Stop Waiting for Runner", "neutral", false);
    // The runner is gone, not the Stop: the header still says the runner is disconnected.
    assert.ok(domWindow.document.querySelector('[aria-label="Health: Disconnected"]'));

    await act(async () => view.socket.push(snapshot("online", candidate)));
    expectBadge(view.surfaces().inbox, "Stop Pending", "info", true);
    expectBadge(view.surfaces().header, "Stop Pending", "info", true);
  } finally {
    await view.unmount();
  }
});

test("a failed Stop reads Stop Failed in danger whether or not the runner is online", async () => {
  const candidate = session("stop_failed");
  for (const runnerStatus of ["online", "offline"] as const) {
    const view = await mount(candidate);
    try {
      await act(async () => view.socket.push(snapshot(runnerStatus, candidate)));
      expectBadge(view.surfaces().inbox, "Stop Failed", "danger", false);
      expectBadge(view.surfaces().header, "Stop Failed", "danger", false);
      assert.equal(view.surfaces().header!.getAttribute("title"), "Automatic retries were exhausted.");
    } finally {
      await view.unmount();
    }
  }
});
