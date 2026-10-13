import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  BACKGROUND_OBSERVATION_RETRY_MS,
  BackgroundDeliveryObservationTracker,
  StoreProvider,
  useStore,
  useStoreSelector,
} from "./store.js";
import {
  MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW,
  UI_SUBSCRIPTION_RATE_WINDOW_MS,
  type SessionView,
} from "@wollipog/protocol";
import { UI_SUBSCRIPTION_PACE_BURST } from "./ui-subscriptions.js";
import type { UiConnectionRuntime, UiSocket } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { withScopedClockOverrides } from "./components/test-clock-overrides.js";

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

test("reconnects back off with bounded jitter, reset only after authentication, and preserve authorization cadence", async () => {
  const timers = new Map<number, { run: () => void; delay: number }>();
  let nextId = 1;
  let random = 0;
  const originalRandom = Math.random;
  Math.random = () => random;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const sockets: FakeSocket[] = [];
  try {
    await withScopedClockOverrides(domWindow, {
      setTimeout: (run: () => void, delay: number) => { const id = nextId++; timers.set(id, { run, delay }); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
    }, async () => {
      await act(async () => {
        root.render(<StoreProvider connection={runtime("backoff", "backoff:1", sockets)}><div /></StoreProvider>);
      });
      const fail = async (code = 1006) => {
        await act(async () => { sockets.at(-1)!.onclose?.({ code }); });
        const id = nextId - 1;
        assert.ok(timers.has(id));
        return { id, ...timers.get(id)! };
      };
      const fire = async (timer: { id: number; run: () => void }) => {
        timers.delete(timer.id);
        await act(async () => { timer.run(); });
      };
      for (const expected of [750, 1_500, 3_000, 6_000, 12_000, 15_000, 15_000]) {
        const timer = await fail();
        assert.equal(timer.delay, expected, "the jitter window grows exponentially and stops at the ceiling");
        await fire(timer);
        await act(async () => { sockets.at(-1)!.onopen?.(); });
      }
      random = 0.9;
      const ceiling = await fail();
      assert.equal(ceiling.delay, 28_500, "jitter varies the delay within the capped window");
      await fire(ceiling);
      await act(async () => { sockets.at(-1)!.onmessage?.({ data: snapshot("session", "Authenticated") }); });
      random = 0;
      const reset = await fail();
      assert.equal(reset.delay, 750, "an authenticated frame resets the backoff window");
      await fire(reset);
      const unauthorized = await fail(1008);
      assert.equal(unauthorized.delay, 10_000, "authorization failures retain their slow fixed retry");
      await fire(unauthorized);
      const next = await fail();
      assert.equal(next.delay, 1_500, "authorization closes do not advance or reset ordinary backoff");
      await act(async () => { root.unmount(); });
      assert.equal(timers.size, 0, "unmount cancels retry and activity timers");
    });
  } finally {
    Math.random = originalRandom;
    await act(async () => { root.unmount(); });
    container.remove();
  }
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

test("paged snapshots acknowledge background deliveries as their authorized rows arrive", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const sockets: FakeSocket[] = [];
  await act(async () => {
    root.render(<StoreProvider connection={runtime("paged-delivery", "paged-delivery:1", sockets)}><div /></StoreProvider>);
  });
  const frame = JSON.parse(snapshot("session-1", "Background Delivery"));
  const sessions = frame.sessions;
  sessions[0].projection = "summary";
  sessions[0].backgroundDeliveries = [{ continuationId: "bgcont-1", parentTurnId: "turn-1",
    jobCount: 1, terminalCount: 1, notificationQueuedAt: 100 }];
  await act(async () => {
    sockets[0]!.onmessage?.({ data: JSON.stringify({ ...frame, sessions: [], sessionsComplete: false }) });
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "session_snapshot_page", sessions, complete: true }) });
  });
  assert.deepEqual(sockets[0]!.sent.map((data) => JSON.parse(data)), [{
    type: "background_delivery_observed", sessionId: "session-1", continuationId: "bgcont-1",
  }]);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("paged loading sends one complete stream selection, then reacts to live changes", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const sockets: FakeSocket[] = [];
  try {
    await act(async () => {
      root.render(<StoreProvider connection={runtime("paged-subscriptions", "paged-subscriptions:1", sockets)}
        navigation={{ current: () => ({ name: "board" }), push() {}, listen: () => () => {} }}><div /></StoreProvider>);
    });
    const socket = sockets[0]!;
    Object.defineProperty(socket, "readyState", { value: 1 });
    const messages = () => socket.sent.map((data) => JSON.parse(data)).filter((msg) => msg.type === "session_subscriptions");
    const frame = JSON.parse(snapshot("busy-1", "First"));
    const first = { ...frame.sessions[0], projection: "summary", status: "running" };
    const second = { ...first, id: "busy-2", title: "Second" };
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ ...frame, sessions: [], sessionsComplete: false,
        capabilities: { sessionSubscriptions: true } }) });
    });
    assert.deepEqual(messages(), [], "an empty header cannot spend subscription admission");
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "session_snapshot_page", sessions: [first], complete: false }) });
    });
    assert.deepEqual(messages(), [], "partial inventory cannot send repeated growing selections");
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "session_snapshot_page", sessions: [second], complete: true }) });
    });
    assert.deepEqual(messages(), [{ type: "session_subscriptions", revision: 1, sessionIds: ["busy-1", "busy-2"], podIds: [] }]);
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "session_subscriptions_applied", revision: 1,
        sessionIds: ["busy-1", "busy-2"], podIds: [] }) });
      socket.onmessage?.({ data: JSON.stringify({ type: "session_upsert", session: { ...second, status: "idle" } }) });
    });
    assert.deepEqual(messages()[1], { type: "session_subscriptions", revision: 2, sessionIds: ["busy-1"], podIds: [] },
      "post-snapshot live changes still update acknowledged streams");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a legacy full snapshot sends its targeted stream selection immediately", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const sockets: FakeSocket[] = [];
  try {
    await act(async () => {
      root.render(<StoreProvider connection={runtime("full-subscriptions", "full-subscriptions:1", sockets)}
        navigation={{ current: () => ({ name: "board" }), push() {}, listen: () => () => {} }}><div /></StoreProvider>);
    });
    const socket = sockets[0]!;
    Object.defineProperty(socket, "readyState", { value: 1 });
    const frame = JSON.parse(snapshot("busy-1", "First"));
    frame.sessions[0].status = "running";
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ ...frame, capabilities: { sessionSubscriptions: true } }) });
    });
    assert.deepEqual(socket.sent.map((data) => JSON.parse(data)), [{
      type: "session_subscriptions", revision: 1, sessionIds: ["busy-1"], podIds: [],
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("rapid switching is paced under the server budget and still ends on the final selection", async () => {
  const timers = new Map<number, { run: () => void; delay: number }>();
  let nextId = 1;
  // The pacer runs on the monotonic clock; the wall clock is stepped separately below.
  let now = 1_000_000;
  let wallStep = 0;
  const originalNow = Date.now;
  const originalPerformanceNow = performance.now;
  Date.now = () => now + wallStep;
  performance.now = () => now;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const sockets: FakeSocket[] = [];
  let navigate!: ReturnType<typeof useStore>["navigate"];
  function Navigator() {
    navigate = useStore().navigate;
    return null;
  }
  try {
    await withScopedClockOverrides(domWindow, {
      setTimeout: (run: () => void, delay: number) => { const id = nextId++; timers.set(id, { run, delay }); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
    }, async () => {
      await act(async () => {
        root.render(<StoreProvider connection={runtime("paced-subscriptions", "paced-subscriptions:1", sockets)}
          navigation={{ current: () => ({ name: "board" }), push() {}, listen: () => () => {} }}><Navigator /></StoreProvider>);
      });
      const socket = sockets[0]!;
      Object.defineProperty(socket, "readyState", { value: 1 });
      const selections = () => socket.sent.map((data) => JSON.parse(data))
        .filter((msg) => msg.type === "session_subscriptions").map((msg) => msg.sessionIds);
      const frame = JSON.parse(snapshot("s0", "Session 0"));
      const ids = Array.from({ length: 2 * MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW }, (_, index) => `s${index}`);
      await act(async () => {
        socket.onmessage?.({ data: JSON.stringify({ ...frame, capabilities: { sessionSubscriptions: true },
          sessions: ids.map((id) => ({ ...frame.sessions[0], id, title: id })) }) });
      });
      assert.deepEqual(selections(), [[]], "the board's empty selection spends the first replacement");
      const firstPacedTimer = nextId;
      for (const id of ids) {
        now += 10;
        await act(async () => { navigate({ name: "session", id }); });
      }
      const sent = selections();
      assert.equal(sent.length, UI_SUBSCRIPTION_PACE_BURST, "only the burst is sent while switching outpaces the budget");
      assert.deepEqual(sent.at(-1), [`s${UI_SUBSCRIPTION_PACE_BURST - 2}`]);
      const paced = [...timers].filter(([id]) => id >= firstPacedTimer);
      assert.equal(paced.length, 1, "one trailing send is scheduled however many selections are skipped");
      const [timerId, timer] = paced[0]!;
      assert.ok(timer.delay > 0 && timer.delay < UI_SUBSCRIPTION_RATE_WINDOW_MS);
      now += timer.delay;
      // An NTP correction or manual change steps only the wall clock; the server window has not moved.
      wallStep = UI_SUBSCRIPTION_RATE_WINDOW_MS * 6;
      timers.delete(timerId);
      await act(async () => { timer.run(); });
      assert.deepEqual(selections().at(-1), [ids.at(-1)], "the trailing send carries the final selection");
      assert.equal(selections().length, UI_SUBSCRIPTION_PACE_BURST + 1, "skipped selections are never sent");
      const afterStep = nextId;
      for (const id of ids.slice(0, UI_SUBSCRIPTION_PACE_BURST)) {
        now += 10;
        await act(async () => { navigate({ name: "session", id }); });
      }
      // Only the ~1.4 tokens the monotonic clock earned while the trailing send waited remain; a
      // wall-clock pacer would treat the step as six idle windows and release a whole burst.
      assert.ok(selections().length - (UI_SUBSCRIPTION_PACE_BURST + 1) <= 2,
        "a wall-clock step grants no refill, so switching after it is still paced");
      assert.equal([...timers.keys()].filter((id) => id >= afterStep).length, 1);

      await act(async () => { socket.onclose?.({ code: 1013 }); });
      const reconnect = timers.get(nextId - 1)!;
      assert.ok(reconnect.delay >= UI_SUBSCRIPTION_RATE_WINDOW_MS,
        "a rate-limited close waits out the server window instead of being refused again");
      assert.ok(reconnect.delay <= 30_000, "the wait stays within the ordinary backoff ceiling");
      await act(async () => { root.unmount(); });
      assert.equal(timers.size, 0, "unmount cancels paced and retry timers");
    });
  } finally {
    Date.now = originalNow;
    performance.now = originalPerformanceNow;
    await act(async () => { root.unmount(); });
    container.remove();
  }
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
