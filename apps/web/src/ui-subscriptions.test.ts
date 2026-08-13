import assert from "node:assert/strict";
import { test } from "node:test";
import type { PodView, RunView, SessionView } from "@wollipog/protocol";
import {
  eventHighWater,
  isSessionActivityObservable,
  MAX_UI_SESSION_SUBSCRIPTIONS,
  subscriptionRecoveryRevision,
  UiSubscriptionSynchronizer,
  uiStreamSubscriptions,
} from "./ui-subscriptions.js";

const run = { id: "run-1", sessionIds: ["s2", "s1", "s2"] } as RunView;
const pod = {
  id: "pod-1",
  members: [{ sessionId: "s3" }, { sessionId: "s1" }],
} as PodView;
const sessions = new Map<string, SessionView>();

test("UI session subscriptions follow Inbox, session, run, and pod navigation deterministically", () => {
  const state = { sessions, runs: new Map([[run.id, run]]), pods: new Map([[pod.id, pod]]) };
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "board" } }), { sessionIds: [], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "projects" } }), { sessionIds: [], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "projects", id: "project-1" } }), { sessionIds: [], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({
    ...state,
    view: { name: "inbox" },
    inbox: { selectedSessionId: "s8" },
  }), { sessionIds: ["s8"], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({
    ...state,
    view: { name: "inbox" },
    inbox: { selectedSessionId: null },
  }), { sessionIds: [], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "session", id: "s9" } }), { sessionIds: ["s9"], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "run", id: run.id } }), { sessionIds: ["s1", "s2"], podIds: [] });
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "pod", id: pod.id } }), { sessionIds: ["s1", "s3"], podIds: ["pod-1"] });
  assert.deepEqual(uiStreamSubscriptions({ ...state, view: { name: "run", id: "missing" } }), { sessionIds: [], podIds: [] });
});

test("UI session subscription derivation is bounded for malformed or future oversized run state", () => {
  const oversized = {
    id: "run-large",
    sessionIds: Array.from({ length: MAX_UI_SESSION_SUBSCRIPTIONS + 20 }, (_, i) => `s${i}`),
  } as RunView;
  const result = uiStreamSubscriptions({
    view: { name: "run", id: oversized.id },
    sessions,
    runs: new Map([[oversized.id, oversized]]),
    pods: new Map(),
  });
  assert.equal(result.sessionIds.length, MAX_UI_SESSION_SUBSCRIPTIONS);
  assert.equal(new Set(result.sessionIds).size, result.sessionIds.length);
  assert.deepEqual(result.podIds, []);
});

test("reconnect recovery advances from the greatest cached runner sequence", () => {
  assert.equal(eventHighWater(undefined), 0);
  assert.equal(eventHighWater([
    { id: 1, sessionId: "s1", seq: 9, ts: 1, payload: { kind: "agent_message", text: "late" } },
    { id: 2, sessionId: "s1", seq: 4, ts: 2, payload: { kind: "agent_message", text: "merged older" } },
  ]), 9);
});

test("subscription synchronization is O(1) for event-only state changes and resends after reconnect", () => {
  let derivations = 0;
  const synchronizer = new UiSubscriptionSynchronizer((state) => {
    derivations++;
    return uiStreamSubscriptions(state);
  });
  const runs = new Map([[run.id, run]]);
  const pods = new Map([[pod.id, pod]]);
  const view = { name: "run" as const, id: run.id };
  const state = { view, sessions, runs, pods };

  assert.deepEqual(synchronizer.nextMessage(state, false), null, "wait for advertised support");
  assert.equal(derivations, 1);
  assert.deepEqual(synchronizer.nextMessage(state, true), {
    type: "session_subscriptions", revision: 1, sessionIds: ["s1", "s2"], podIds: [],
  });
  for (let i = 0; i < 100; i++) assert.equal(synchronizer.nextMessage(state, true), null);
  assert.equal(derivations, 1, "event-only store notifications do not rebuild/sort the set");

  synchronizer.resetConnection();
  assert.deepEqual(synchronizer.nextMessage(state, true), {
    type: "session_subscriptions", revision: 1, sessionIds: ["s1", "s2"], podIds: [],
  });
  assert.equal(derivations, 1, "same desired set is reused across reconnect");

  const nextView = { name: "session" as const, id: "s9" };
  assert.deepEqual(synchronizer.nextMessage({ view: nextView, sessions, runs, pods }, true), {
    type: "session_subscriptions", revision: 2, sessionIds: ["s9"], podIds: [],
  });
  assert.equal(derivations, 2);
});

test("subscription synchronization reacts to Inbox selection without requiring a view change", () => {
  let derivations = 0;
  const synchronizer = new UiSubscriptionSynchronizer((state) => {
    derivations++;
    return uiStreamSubscriptions(state);
  });
  const view = { name: "inbox" as const };
  const runs = new Map<string, RunView>();
  const pods = new Map<string, PodView>();

  assert.deepEqual(synchronizer.nextMessage({
    view, sessions, runs, pods, inbox: { selectedSessionId: "s1" },
  }, true), {
    type: "session_subscriptions", revision: 1, sessionIds: ["s1"], podIds: [],
  });
  assert.deepEqual(synchronizer.nextMessage({
    view, sessions, runs, pods, inbox: { selectedSessionId: "s2" },
  }, true), {
    type: "session_subscriptions", revision: 2, sessionIds: ["s2"], podIds: [],
  });
  assert.equal(derivations, 2);
});

test("subscription synchronization reacts to busy-session metadata but not activity-only state", () => {
  let derivations = 0;
  const synchronizer = new UiSubscriptionSynchronizer((state) => {
    derivations++;
    return uiStreamSubscriptions(state);
  });
  const view = { name: "board" as const };
  const runs = new Map<string, RunView>();
  const pods = new Map<string, PodView>();
  const idle = new Map([["s1", { id: "s1", status: "idle", archived: false } as SessionView]]);
  const running = new Map([["s1", { id: "s1", status: "running", archived: false } as SessionView]]);

  assert.deepEqual(synchronizer.nextMessage({ view, sessions: idle, runs, pods }, true), {
    type: "session_subscriptions", revision: 1, sessionIds: [], podIds: [],
  });
  assert.equal(synchronizer.nextMessage({ view, sessions: idle, runs, pods }, true), null);
  assert.equal(derivations, 1, "activity-only state leaves all subscription inputs stable");
  assert.deepEqual(synchronizer.nextMessage({ view, sessions: running, runs, pods }, true), {
    type: "session_subscriptions", revision: 2, sessionIds: ["s1"], podIds: [],
  });
  assert.equal(derivations, 2);
});

test("post-ack recovery waits for the exact current stream selection", () => {
  assert.equal(subscriptionRecoveryRevision({
    mode: "unknown", requestedRevision: 0, appliedRevision: 0, sessionIds: [], podIds: [],
  }, ["s1"]), null);
  assert.equal(subscriptionRecoveryRevision({
    mode: "legacy", requestedRevision: 0, appliedRevision: 0, sessionIds: [], podIds: [],
  }, ["s1"]), 0);
  assert.equal(subscriptionRecoveryRevision({
    mode: "targeted", requestedRevision: 2, appliedRevision: 1, sessionIds: ["s1"], podIds: [],
  }, ["s1"]), null, "an older acknowledgement cannot release the newest recovery cursor");
  assert.equal(subscriptionRecoveryRevision({
    mode: "targeted", requestedRevision: 1, appliedRevision: 1, sessionIds: ["s1"], podIds: [],
  }, ["s1", "s2"]), null, "stale ack for the prior view cannot open recovery race");
  assert.equal(subscriptionRecoveryRevision({
    mode: "targeted", requestedRevision: 2, appliedRevision: 2, sessionIds: ["s1", "s2"], podIds: ["p1"],
  }, ["s2", "s1"], ["p1"]), 2);
});

test("busy sessions join every targeted subscription after required detail streams", () => {
  const busySessions = new Map<string, SessionView>([
    ["busy-b", { id: "busy-b", status: "running", archived: false } as SessionView],
    ["busy-a", { id: "busy-a", status: "input_required", archived: false } as SessionView],
    ["idle", { id: "idle", status: "idle", archived: false } as SessionView],
    ["archived", { id: "archived", status: "running", archived: true } as SessionView],
  ]);
  assert.deepEqual(uiStreamSubscriptions({
    view: { name: "session", id: "detail" }, sessions: busySessions, runs: new Map(), pods: new Map(),
  }), { sessionIds: ["detail", "busy-a", "busy-b"], podIds: [] });
});

test("required streams remain observable at the subscription cap", () => {
  const busySessions = new Map<string, SessionView>(Array.from(
    { length: MAX_UI_SESSION_SUBSCRIPTIONS + 5 },
    (_, index) => [`busy-${String(index).padStart(3, "0")}`, {
      id: `busy-${String(index).padStart(3, "0")}`, status: "running", archived: false,
    } as SessionView],
  ));
  const result = uiStreamSubscriptions({
    view: { name: "session", id: "selected-last" }, sessions: busySessions, runs: new Map(), pods: new Map(),
  });
  assert.equal(result.sessionIds.length, MAX_UI_SESSION_SUBSCRIPTIONS);
  assert.equal(result.sessionIds[0], "selected-last");
});

test("activity observability requires a legacy stream or an applied targeted selection", () => {
  assert.equal(isSessionActivityObservable({
    mode: "legacy", requestedRevision: 0, appliedRevision: 0, sessionIds: [], podIds: [],
  }, "s1"), true);
  assert.equal(isSessionActivityObservable({
    mode: "targeted", requestedRevision: 2, appliedRevision: 1, sessionIds: ["s1"], podIds: [],
  }, "s1"), true, "the old applied selection remains observable while its replacement is pending");
  assert.equal(isSessionActivityObservable({
    mode: "targeted", requestedRevision: 2, appliedRevision: 1, sessionIds: ["s1"], podIds: [],
  }, "s2"), false, "a newly requested id is not observable before its acknowledgement");
  assert.equal(isSessionActivityObservable({
    mode: "targeted", requestedRevision: 2, appliedRevision: 2, sessionIds: ["s1"], podIds: [],
  }, "s1"), true);
  assert.equal(isSessionActivityObservable({
    mode: "unknown", requestedRevision: 0, appliedRevision: 0, sessionIds: [], podIds: [],
  }, "s1"), false);
});
