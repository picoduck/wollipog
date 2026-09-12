import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  BACKGROUND_OBSERVATION_RETRY_MS,
  BackgroundDeliveryObservationTracker,
  StoreProvider,
  useStoreSelector,
} from "./store.js";
import type { SessionView } from "@wollipog/protocol";
import type { UiConnectionRuntime, UiSocket } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

class FakeSocket implements UiSocket {
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCount = 0;
  readonly sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.closeCount += 1; }
}

function runtime(instanceId: string, runtimeKey: string, sockets: FakeSocket[]): UiConnectionRuntime {
  return {
    instanceId,
    runtimeKey,
    createSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    close() {
      for (const socket of sockets) socket.close();
    },
  };
}

function SessionTitles() {
  const sessions = useStoreSelector((state) => state.sessions);
  return <div data-testid="titles">{[...sessions.values()].map((session) => session.title).join(",")}</div>;
}

function snapshot(id: string, title: string): string {
  return JSON.stringify({
    type: "snapshot",
    runners: [],
    runs: [],
    pods: [],
    sessions: [{
      id,
      title,
      workspaceId: null,
      agentId: null,
      status: "idle",
      driver: "codex",
      useWorktree: false,
      config: {},
      archived: false,
      eventEpoch: 0,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
}

test("changing instance runtimes closes the old socket before the replacement remains active", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const aSockets: FakeSocket[] = [];
  const bSockets: FakeSocket[] = [];
  const instanceA = runtime("instance-a", "instance-a:1", aSockets);
  const instanceB = runtime("instance-b", "instance-b:1", bSockets);

  await act(async () => {
    root.render(<StoreProvider connection={instanceA}><div>A</div></StoreProvider>);
  });
  assert.equal(aSockets.length, 1);
  assert.equal(aSockets[0]!.closeCount, 0);

  await act(async () => {
    root.render(<StoreProvider connection={instanceB}><div>B</div></StoreProvider>);
  });
  assert.equal(aSockets[0]!.closeCount, 1, "the previous instance socket is closed during effect cleanup");
  assert.equal(bSockets.length, 1);
  assert.equal(bSockets[0]!.closeCount, 0);

  await act(async () => { root.unmount(); });
  assert.equal(bSockets[0]!.closeCount, 1);
  container.remove();
});

test("initial and reconnect snapshots acknowledge unobserved background delivery projections", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const sockets: FakeSocket[] = [];
  await act(async () => {
    root.render(<StoreProvider connection={runtime("delivery", "delivery:1", sockets)}><div /></StoreProvider>);
  });
  const frame = JSON.parse(snapshot("session-1", "Background Delivery")) as {
    sessions: Array<Record<string, unknown>>;
  };
  frame.sessions[0]!.backgroundDeliveries = [{
    continuationId: "bgcont-1",
    parentTurnId: "turn-1",
    jobCount: 1,
    terminalCount: 1,
    notificationQueuedAt: 100,
    watchdogState: "dashboard_observation_pending",
  }];
  await act(async () => {
    sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });
  });
  assert.deepEqual(sockets[0]!.sent.map((data) => JSON.parse(data)), [{
    type: "background_delivery_observed",
    sessionId: "session-1",
    continuationId: "bgcont-1",
  }]);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("background delivery observation retries are deduplicated and self-healing", () => {
  const tracker = new BackgroundDeliveryObservationTracker();
  const pending = {
    id: "session-1",
    backgroundDeliveries: [{
      continuationId: "bgcont-1",
      parentTurnId: "turn-1",
      jobCount: 1,
      terminalCount: 1,
      notificationQueuedAt: 100,
    }],
  } as SessionView;
  const expected = [{
    type: "background_delivery_observed",
    sessionId: "session-1",
    continuationId: "bgcont-1",
  }];
  assert.deepEqual(tracker.due([pending], 1_000, true), expected);
  assert.deepEqual(tracker.due([pending], 1_001, true), [], "upserts do not amplify an in-flight receipt");
  assert.equal(tracker.nextRetryAt(), 1_000 + BACKGROUND_OBSERVATION_RETRY_MS);
  assert.deepEqual(
    tracker.due([pending], 1_000 + BACKGROUND_OBSERVATION_RETRY_MS, true),
    expected,
    "a dropped or rate-limited receipt retries after the server admission window",
  );
  assert.deepEqual(tracker.due([{
    ...pending,
    backgroundDeliveries: [{
      ...pending.backgroundDeliveries![0]!,
      dashboardObservedAt: 2_000,
    }],
  }], 2_000 + BACKGROUND_OBSERVATION_RETRY_MS, true), []);
  assert.equal(tracker.nextRetryAt(), undefined);
});

test("a new generation remounts the same profile while an equivalent runtime key stays connected", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const firstSockets: FakeSocket[] = [];
  const equivalentSockets: FakeSocket[] = [];
  const repairedSockets: FakeSocket[] = [];

  await act(async () => {
    root.render(<StoreProvider connection={runtime("profile-a", "profile-a:1", firstSockets)}><div /></StoreProvider>);
  });
  await act(async () => {
    root.render(<StoreProvider connection={runtime("profile-a", "profile-a:1", equivalentSockets)}><div /></StoreProvider>);
  });
  assert.equal(firstSockets[0]!.closeCount, 0, "equivalent runtime objects do not reconnect");
  assert.equal(equivalentSockets.length, 0);

  await act(async () => {
    root.render(<StoreProvider connection={runtime("profile-a", "profile-a:2", repairedSockets)}><div /></StoreProvider>);
  });
  assert.equal(firstSockets[0]!.closeCount, 1);
  assert.equal(repairedSockets.length, 1, "repairing a profile creates a fresh store/socket generation");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a late frame from the previous generation cannot populate the replacement store", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const oldSockets: FakeSocket[] = [];
  const newSockets: FakeSocket[] = [];

  await act(async () => {
    root.render(
      <StoreProvider connection={runtime("profile-a", "profile-a:1", oldSockets)}>
        <SessionTitles />
      </StoreProvider>,
    );
  });
  const lateOldFrame = oldSockets[0]!.onmessage;
  await act(async () => { oldSockets[0]!.onmessage?.({ data: snapshot("same-id", "Old Instance") }); });
  assert.equal(container.querySelector('[data-testid="titles"]')?.textContent, "Old Instance");

  await act(async () => {
    root.render(
      <StoreProvider connection={runtime("profile-a", "profile-a:2", newSockets)}>
        <SessionTitles />
      </StoreProvider>,
    );
  });
  await act(async () => { newSockets[0]!.onmessage?.({ data: snapshot("same-id", "New Instance") }); });
  assert.equal(container.querySelector('[data-testid="titles"]')?.textContent, "New Instance");

  await act(async () => { lateOldFrame?.({ data: snapshot("same-id", "Late Old Frame") }); });
  assert.equal(container.querySelector('[data-testid="titles"]')?.textContent, "New Instance");

  await act(async () => { root.unmount(); });
  container.remove();
});
