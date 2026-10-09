import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlPlaneToUi, SessionEvent, SessionView } from "@wollipog/protocol";
import { notifyDecision } from "./notify.js";
import { sessionsEqualIgnoringStreaming, Store, type State, type StorePublishScheduler } from "./store.js";

/**
 * Socket frames received within one animation frame are published as one store update (#2763).
 * Each frame is still reduced at once, in arrival order; only what subscribers see waits for the
 * frame. These tests drive a Store with a hand-cranked frame scheduler.
 */

const session = (id: string, patch: Partial<SessionView> = {}): SessionView =>
  ({ id, eventEpoch: 0, status: "running", title: id, messageCount: 0, ...patch } as SessionView);
const event = (sessionId: string, seq: number): SessionEvent => ({
  id: seq,
  sessionId,
  seq,
  ts: seq,
  payload: { kind: "agent_message", text: `${sessionId}:${seq}` },
});

function frames() {
  const pending: Array<() => void> = [];
  let requested = 0;
  const scheduler: StorePublishScheduler = (publish) => {
    requested += 1;
    pending.push(publish);
    return () => {
      const index = pending.indexOf(publish);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  return {
    scheduler,
    /** Run the animation frame: every publication waiting for it. */
    run() {
      for (const publish of pending.splice(0)) publish();
    },
    get waiting() { return pending.length; },
    get requested() { return requested; },
  };
}

/** A store showing two live sessions, with a frame scheduler installed after the snapshot. */
function liveStore() {
  const store = new Store({ name: "session", id: "s1" });
  store.dispatch({
    type: "msg",
    msg: { type: "snapshot", runners: [], boxes: [], sessions: [session("s1"), session("s2")], runs: [], pods: [] },
  });
  const clock = frames();
  store.setPublishScheduler(clock.scheduler);
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  return { store, clock, notified: () => notified };
}

const seqs = (state: State, sessionId: string) => state.events.get(sessionId)?.map((entry) => entry.seq) ?? [];

test("socket frames received within one animation frame are published as one store update", () => {
  const { store, clock, notified } = liveStore();
  const before = store.getState();
  for (let seq = 1; seq <= 5; seq += 1) store.receiveFrame({ type: "session_event", event: event("s1", seq) });
  store.receiveFrame({ type: "session_upsert", session: session("s1", { messageCount: 5 }) });

  assert.equal(notified(), 0, "nothing is published before the frame");
  assert.equal(store.getState(), before, "subscribers still see the whole previous state");
  assert.equal(clock.requested, 1, "one frame is requested for the whole batch");
  assert.equal(store.eventHighWater("s1"), 5, "but every frame was already reduced, in order");

  clock.run();
  assert.equal(notified(), 1, "the batch is one store update");
  assert.deepEqual(seqs(store.getState(), "s1"), [1, 2, 3, 4, 5]);
  assert.equal(store.getState().sessions.get("s1")?.messageCount, 5);

  store.receiveFrame({ type: "session_event", event: event("s1", 6) });
  assert.equal(clock.requested, 2, "the next frame's batch requests its own frame");
  clock.run();
  assert.equal(notified(), 2);
});

test("an upsert is never observable ahead of the event that caused it, in any batch", () => {
  const { store, clock } = liveStore();
  // The control plane sends an event, then (paced) the upsert counting it. An upsert's
  // messageCount must never exceed the newest event seq anything can observe.
  const check = (state: State, where: string) => {
    // s1 is the session on screen, so its events are retained; s2's frames interleave with it.
    const count = state.sessions.get("s1")?.messageCount ?? 0;
    const high = Math.max(0, ...seqs(state, "s1"));
    assert.ok(count <= high, `${where}: the upsert counts ${count} events but only ${high} are visible`);
  };
  store.observeTransitions((_previous, next) => check(next, "transition"));
  store.subscribe(() => check(store.getState(), "published"));
  const frame: ControlPlaneToUi[] = [];
  for (let seq = 1; seq <= 12; seq += 1) {
    frame.push({ type: "session_event", event: event("s1", seq) });
    frame.push({ type: "session_event", event: event("s2", seq) });
    if (seq % 3 === 0) {
      frame.push({ type: "session_upsert", session: session("s1", { messageCount: seq }) });
      frame.push({ type: "session_upsert", session: session("s2", { messageCount: seq }) });
    }
    // Batches of irregular size, some ending between an event and its upsert.
    if (seq % 4 === 0 || seq === 7) {
      for (const msg of frame.splice(0)) store.receiveFrame(msg);
      clock.run();
    }
  }
  for (const msg of frame.splice(0)) store.receiveFrame(msg);
  // A user action between frames publishes the waiting frames first, still in order.
  store.setFilters({ runnerId: "runner-1" });
  check(store.getState(), "after the action");
  assert.deepEqual(seqs(store.getState(), "s1"), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(store.getState().sessions.get("s1")?.messageCount, 12);
});

test("a non-socket dispatch publishes the waiting frames with it, before its own change is seen", () => {
  const { store, clock, notified } = liveStore();
  store.receiveFrame({ type: "session_event", event: event("s1", 1) });
  assert.equal(notified(), 0);
  const seen: Array<{ seqs: number[]; view: string }> = [];
  store.subscribe(() => {
    const state = store.getState();
    seen.push({ seqs: seqs(state, "s1"), view: state.view.name });
  });
  store.setFilters({ runnerId: "runner-late" });
  assert.equal(clock.waiting, 0, "the scheduled frame is cancelled");
  assert.deepEqual(seen, [{ seqs: [1], view: "session" }], "one update carries the frame and the action");
  assert.equal(store.getState().filters.runnerId, "runner-late");
  clock.run();
  assert.equal(notified(), 1, "the cancelled frame publishes nothing more");
});

test("snapshots, history resets and epoch changes publish at once, with the frames before them", () => {
  const { store, clock, notified } = liveStore();
  store.receiveFrame({ type: "session_event", event: event("s1", 1) });
  store.receiveFrame({ type: "session_events_reset", sessionId: "s1", eventEpoch: 1, events: [] });
  assert.equal(notified(), 1, "a history reset is not held back");
  assert.equal(clock.waiting, 0);
  assert.equal(store.getState().eventEpochs.get("s1"), 1);

  store.receiveFrame({ type: "session_event", event: event("s2", 1) });
  store.receiveFrame({ type: "session_upsert", session: session("s2", { eventEpoch: 2 }) });
  assert.equal(notified(), 2, "an upsert that changes the history epoch is published at once");
  assert.equal(store.getState().sessions.get("s2")?.eventEpoch, 2);

  store.receiveFrame({ type: "session_event", event: event("s1", 2) });
  store.receiveFrame({
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1"), session("s2")], runs: [], pods: [],
  });
  assert.equal(notified(), 3, "a snapshot is published at once");
  assert.equal(clock.waiting, 0);
});

test("frames waiting for their animation frame never change the activity or stalls already published", () => {
  const store = new Store({ name: "board" });
  store.tickActivity(0);
  store.dispatch({ type: "conn", conn: "online" });
  const busy = { ...session("busy"), archived: false, updatedAt: 0, lastEventAt: 0 } as SessionView;
  store.dispatch({
    type: "msg", now: 0,
    msg: { type: "snapshot", runners: [], boxes: [], sessions: [busy], runs: [], pods: [] },
  });
  store.tickActivity(600_000);
  const published = store.getState();
  const publishedActivity = published.activity.get("busy");
  assert.equal(published.stalledSessionIds.has("busy"), true, "ten silent minutes stall the session");
  const clock = frames();
  store.setPublishScheduler(clock.scheduler);

  store.receiveFrame({ type: "session_event", event: { ...event("busy", 1), ts: 600_000 } }, 600_000);
  store.receiveFrame({ type: "session_event", event: { ...event("busy", 2), ts: 600_001 } }, 600_001);
  assert.equal(store.getState(), published);
  assert.equal(published.stalledSessionIds.has("busy"), true, "the published stall set keeps its member");
  assert.equal(published.stalledCount, 1, "and agrees with its count");
  assert.equal(published.activity.get("busy"), publishedActivity, "the published activity has no new event");

  clock.run();
  const next = store.getState();
  assert.equal(next.stalledSessionIds.has("busy"), false, "the published frames clear the stall");
  assert.equal(next.stalledCount, 0);
  assert.equal(next.activity.get("busy")?.lastEventAt, 600_001);
  assert.notEqual(next.stalledSessionIds, published.stalledSessionIds, "a membership change is a new set");
});

test("without a frame scheduler, as in a hidden tab, every frame publishes at once", () => {
  const store = new Store({ name: "session", id: "s1" });
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  store.receiveFrame({ type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [] });
  store.receiveFrame({ type: "session_event", event: event("s1", 1) });
  store.receiveFrame({ type: "session_event", event: event("s1", 2) });
  assert.equal(notified, 3);
  assert.deepEqual(seqs(store.getState(), "s1"), [1, 2]);

  // A scheduler that declines (the tab is hidden) publishes at once too.
  store.setPublishScheduler(() => null);
  store.receiveFrame({ type: "session_event", event: event("s1", 3) });
  assert.equal(notified, 4);

  // Removing the scheduler publishes anything still waiting.
  const clock = frames();
  store.setPublishScheduler(clock.scheduler);
  store.receiveFrame({ type: "session_event", event: event("s1", 4) });
  assert.equal(notified, 4);
  store.setPublishScheduler(null);
  assert.equal(notified, 5);
  assert.deepEqual(seqs(store.getState(), "s1"), [1, 2, 3, 4]);
});

test("a status transition superseded within one frame still reaches transition observers", () => {
  const { store, clock } = liveStore();
  const notifications: string[] = [];
  store.observeTransitions((previous, next) => {
    if (previous.sessions === next.sessions) return;
    for (const [id, current] of next.sessions) {
      const payload = notifyDecision(previous.sessions.get(id), current);
      if (payload) notifications.push(payload.title);
    }
  });
  store.receiveFrame({ type: "session_upsert", session: session("s1", { status: "idle" }) });
  store.receiveFrame({ type: "session_upsert", session: session("s1", { status: "running" }) });
  clock.run();
  assert.equal(store.getState().sessions.get("s1")?.status, "running", "subscribers see only the last state");
  assert.deepEqual(notifications, ["s1 is awaiting a prompt"], "the turn that ended in between is still notified");
});

test("a session map differing only in streaming fields counts as unchanged for the shell", () => {
  const base = session("s1", { status: "running", pendingApproval: null });
  const previous = new Map([["s1", base]]);
  const streamed = new Map([["s1", {
    ...JSON.parse(JSON.stringify(base)) as SessionView,
    updatedAt: 9, lastEventAt: 9, messageCount: 9, preview: "more", tokensIn: 9, tokensOut: 9,
    contextTokensUsed: 9, costUsd: 0.5, toolCallCount: 3,
  }]]);
  assert.equal(sessionsEqualIgnoringStreaming(previous, streamed), true, "live counters and the preview are ignored");
  assert.equal(sessionsEqualIgnoringStreaming(previous, new Map([["s1", { ...base, status: "idle" as const }]])), false);
  assert.equal(sessionsEqualIgnoringStreaming(previous, new Map([["s1", { ...base, title: "Renamed" }]])), false);
  assert.equal(sessionsEqualIgnoringStreaming(previous, new Map([["s1", {
    ...base, pendingApproval: { requestId: "r1", title: "Run" } as SessionView["pendingApproval"],
  }]])), false, "a nested change is a change");
  assert.equal(sessionsEqualIgnoringStreaming(previous, new Map([...previous, ["s2", session("s2")]])), false);
  assert.equal(sessionsEqualIgnoringStreaming(previous, new Map([["s2", base]])), false);
});
