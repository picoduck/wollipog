import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionView } from "@wollipog/protocol";
import { isPartialHistory, Store } from "./store.js";

const event = (seq: number, text = String(seq)): SessionEvent => ({
  id: seq, sessionId: "s1", seq, ts: seq,
  payload: { kind: "agent_message", text, final: true },
});
const events = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => event(first + i));
function fixture(
  shouldDeferLive?: () => boolean,
  initialWindow = { first: 101, last: 110, hasOlder: true },
) {
  const store = new Store();
  store.dispatch({ type: "msg", msg: { type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [{ id: "s1", eventEpoch: 0 } as SessionView], runs: [], pods: [],
  } });
  store.navigate({ name: "session", id: "s1" });
  const generation = store.getState().snapshotRevision;
  store.prepareSubscriptionRecovery(1, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 1, sessionIds: ["s1"], podIds: [] } });
  store.beginEventHistoryLoad("s1", 0, 1, generation);
  store.loadEvents("s1", events(initialWindow.first, initialWindow.last), 0, 1, true, generation, initialWindow.hasOlder);
  store.prepareSubscriptionRecovery(2, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 2, sessionIds: ["s1"], podIds: [] } });
  store.beginEventHistoryLoad("s1", 0, 2, generation);
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation, shouldDeferLive)!;
  assert.ok(fence);
  return { store, generation, fence };
}

test("staging current activity preserves reading rows and exposes an honest settled gap", () => {
  const { store, fence } = fixture();
  const before = store.getState().events.get("s1");
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  assert.equal(store.getState().events.get("s1"), before);
  const gap = store.getState().eventWindows.get("s1")!.laterGap!;
  assert.equal(gap.afterSeq, 110);
  assert.equal(gap.beforeSeq, 10_000);
  assert.equal(gap.tailSeq, 10_009);
  assert.equal(gap.loading, false);
  assert.equal(store.getState().eventHistory.get("s1")?.refreshing, false);
  assert.equal(store.recoveryAfter("s1"), 110, "staging does not publish progress across the omission");
  assert.equal(isPartialHistory(store.getState().eventWindows.get("s1")), true);
});

test("reader-driven pages advance the contiguous reading boundary and explicit following promotes the tail", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  const request = store.beginLaterEventsLoad("s1")!;
  assert.equal(request.after, 110);
  assert.equal(store.beginLaterEventsLoad("s1"), null, "only one reader page owns this boundary");
  assert.equal(store.loadLaterEvents(request, { events: events(111, 310), eventEpoch: 0,
    nextAfter: 310, hasMoreCached: true, cacheComplete: true }), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 310);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.afterSeq, 310);
  assert.equal(store.recoveryAfter("s1"), 110);
  assert.equal(store.promoteDeferredEventTail(fence), true);
  assert.deepEqual(store.getState().events.get("s1")!.map(event => event.seq), events(10_000, 10_009).map(event => event.seq));
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
  assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 10_000);
  assert.equal(store.recoveryAfter("s1"), 10_009);
  assert.equal(store.loadLaterEvents(request, { events: events(311, 510), eventEpoch: 0,
    nextAfter: 510, hasMoreCached: true, cacheComplete: true }), false, "promotion invalidates the old page");
  store.loadOlderEvents("s1", events(9_998, 9_999), true, 10_000, 0);
  assert.equal(store.getState().events.get("s1")![0]!.seq, 9_998, "omitted history remains reachable below the promoted tail");
});

test("a reader page bridging the omission merges the staged tail once", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(115, 119), true, true);
  const request = store.beginLaterEventsLoad("s1")!;
  assert.equal(store.loadLaterEvents(request, { events: events(111, 116), eventEpoch: 0,
    nextAfter: 116, hasMoreCached: true, cacheComplete: true }), true);
  assert.deepEqual(store.getState().events.get("s1")!.map(event => event.seq), events(101, 119).map(event => event.seq));
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
  assert.equal(store.recoveryAfter("s1"), 119);
});

test("live traffic while deferred stays bounded and cannot fill unseen history behind the reader", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  for (const seq of [111, 500, 10_009, 10_010])
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(seq) } });
  assert.deepEqual(store.getState().events.get("s1")!.map(event => event.seq), events(101, 110).map(event => event.seq));
  assert.equal(store.recoveryAfter("s1"), 110);
  assert.equal(store.promoteDeferredEventTail(fence), true);
  assert.deepEqual(store.getState().events.get("s1")!.map(event => event.seq), events(10_000, 10_010).map(event => event.seq));
});

test("a distant visible live row prevents staging without clipping a possible saved anchor", () => {
  const { store, fence } = fixture();
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_020) } });
  const before = store.getState().events.get("s1");
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
  assert.equal(store.getState().events.get("s1"), before);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_020);
  store.prepareSubscriptionRecovery(3, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 3, sessionIds: ["s1"], podIds: [] } });
  assert.equal(store.recoveryAfter("s1"), 110, "a subscription captures only loaded contiguity, never the distant live maximum");
});

test("cancelled, replaced, inactive and epoch-obsolete operations cannot stage or promote", () => {
  const { store, fence, generation } = fixture();
  const replacement = store.beginEventGapRecovery("s1", 0, 2, generation)!;
  assert.equal(store.isEventGapRecoveryCurrent(fence), false);
  assert.equal(store.isEventGapRecoveryCurrent(replacement), true);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
  assert.equal(store.deferEventTail(replacement, events(10_000, 10_009), true, true), true);
  store.cancelEventGapRecovery(fence);
  assert.ok(store.getState().eventWindows.get("s1")!.laterGap, "obsolete cancellation cannot clear the replacement");
  store.cancelEventGapRecovery(replacement);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
  assert.equal(store.promoteDeferredEventTail(replacement), false);
  const current = store.beginEventGapRecovery("s1", 0, 2, generation)!;
  store.deferEventTail(current, events(10_000, 10_009), true, true);
  store.navigate({ name: "board" });
  assert.equal(store.promoteDeferredEventTail(current), false);
  store.navigate({ name: "session", id: "s1" });
  assert.equal(store.getState().eventWindows.get("s1")?.laterGap, undefined);
  assert.deepEqual(store.getState().events.get("s1")?.map(event => event.seq), events(101, 110).map(event => event.seq), "the contiguous reader cache survives without private staged payloads");
  store.dispatch({ type: "msg", msg: { type: "session_events_reset", sessionId: "s1", eventEpoch: 1, events: [] } });
  assert.equal(store.deferEventTail(current, events(10_000, 10_009), true, true), false);
});

test("invalid reader pages cannot skip a gap or settle another page owner", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  const request = store.beginLaterEventsLoad("s1")!;
  assert.equal(store.loadLaterEvents(request, { events: [event(111), event(113)], eventEpoch: 0,
    nextAfter: 113, hasMoreCached: true, cacheComplete: true }), false);
  store.failLaterEventsLoad(request, "Missing interval");
  const next = store.beginLaterEventsLoad("s1")!;
  store.failLaterEventsLoad(request, "Old failure");
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.loading, true);
  assert.equal(store.loadLaterEvents(next, { events: events(111, 112), eventEpoch: 1,
    nextAfter: 112, hasMoreCached: true, cacheComplete: true }), false);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 110);
});

test("deferred live buffering obeys count and byte bounds, without promoting an unproven trimmed tail", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  for (let seq = 10_010; seq < 12_030; seq++)
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(seq) } });
  const gap = store.getState().eventWindows.get("s1")!.laterGap!;
  assert.ok(gap.tailSeq - gap.beforeSeq + 1 <= 2_000);
  assert.equal(store.getState().events.get("s1")!.length, 10);
  assert.equal(store.promoteDeferredEventTail(fence), false, "trimmed-away REST proof requires a fresh bounded read");
  const replacement = store.beginEventGapRecovery("s1", 0, 2, store.getState().snapshotRevision)!;
  assert.equal(store.deferEventTail(replacement, [event(20_000, "x".repeat(8 * 1024 * 1024))], true, true), false);
  assert.equal(store.getState().events.get("s1")!.length, 10);
});

test("older prepends preserve deferred current activity and its pending forward boundary", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  const request = store.beginLaterEventsLoad("s1")!;
  store.loadOlderEvents("s1", events(99, 100), true, 101, 0);
  assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 99);
  assert.ok(store.getState().eventWindows.get("s1")!.laterGap);
  assert.equal(store.loadLaterEvents(request, { events: events(111, 112), eventEpoch: 0,
    nextAfter: 112, hasMoreCached: true, cacheComplete: true }), true);
  assert.equal(store.getState().events.get("s1")![0]!.seq, 99);
  assert.equal(store.promoteDeferredEventTail(fence), true);
});

test("an authoritative same-base window replacement revokes an outstanding deferred owner", () => {
  const { store, fence, generation } = fixture();
  store.loadEvents("s1", events(101, 112), 0, 2, true, generation, true);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 112);
});

test("gapped live delivery beyond a staged HTTP tail cannot become promotion or subscription proof", () => {
  const { store, fence } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_020) } });
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 110);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.tailSeq, 10_020);
  assert.equal(store.promoteDeferredEventTail(fence), false);
  assert.equal(store.recoveryAfter("s1"), 110);
  store.prepareSubscriptionRecovery(3, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 3, sessionIds: ["s1"], podIds: [] } });
  assert.equal(store.recoveryAfter("s1"), 110);
});

test("an owned partial replacement retains its completion/error fence while revoking staged pages", () => {
  const { store, fence, generation } = fixture();
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  const request = store.beginLaterEventsLoad("s1")!;
  store.beginEventHistoryLoad("s1", 0, 2, generation);
  assert.equal(store.loadEventGapWindow(fence, events(20_000, 20_009), false, true), true);
  assert.equal(store.isEventGapRecoveryCurrent(fence), true);
  assert.equal(store.getState().eventHistory.get("s1")?.refreshing, true);
  assert.equal(store.getState().eventWindows.get("s1")?.laterGap, undefined);
  assert.equal(store.loadLaterEvents(request, { events: events(111, 112), eventEpoch: 0,
    nextAfter: 112, cacheComplete: true, hasMoreCached: true }), false);
  store.failEventHistoryLoad("s1", "Incomplete bounded tail", 0, 2, generation);
  assert.equal(store.getState().eventHistory.get("s1")?.refreshing, false);
  assert.equal(store.getState().eventHistory.get("s1")?.error, "Incomplete bounded tail");
  store.cancelEventGapRecovery(fence);
  assert.equal(store.loadEventGapWindow(fence, events(30_000, 30_009), true, true), false);
});

test("paused live delivery before tail staging preserves the reading slice and cannot poison retry", () => {
  const { store, fence } = fixture(() => true);
  const reading = store.getState().events.get("s1");
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  assert.equal(store.getState().events.get("s1"), reading);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  assert.equal(store.promoteDeferredEventTail(fence), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
});

test("pausing during forward recovery defers future live while following and forward pages remain normal", () => {
  let paused = false;
  const { store, fence, generation } = fixture(() => paused);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(111) } });
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 111);
  paused = true;
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  store.loadEvents("s1", events(112, 310), 0, 2, false, generation);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 310);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.afterSeq, 310);
  assert.equal(store.promoteDeferredEventTail(fence), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
});

test("a future frame visible before pause remains protected rather than clipped into a synthetic gap", () => {
  let paused = false;
  const { store, fence } = fixture(() => paused);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  paused = true;
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_011) } });
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
});

test("pre-stage live gaps cannot provide HTTP completeness or promotion proof", () => {
  const { store, fence } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_020) } });
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.tailSeq, 10_020);
  assert.equal(store.promoteDeferredEventTail(fence), false);
  assert.equal(store.recoveryAfter("s1"), 110);
});

test("pre-stage delivery is bounded by event count and aggregate payload bytes", () => {
  const { store, fence } = fixture(() => true);
  for (let seq = 10_010; seq < 12_030; seq++)
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(seq) } });
  const buffers = (store as unknown as { pendingGapLive: Map<string, { events: SessionEvent[]; bytes: number }> }).pendingGapLive;
  assert.equal(buffers.get("s1")!.events.length, 2_000);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(12_030, "x".repeat(8 * 1024 * 1024)) } });
  assert.ok([...buffers.values()].reduce((bytes, buffer) => bytes + buffer.bytes, 0) <= 8 * 1024 * 1024);
  assert.equal(store.getState().events.get("s1")!.length, 10);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  assert.equal(buffers.size, 0);
  assert.equal(store.promoteDeferredEventTail(fence), false, "trimmed HTTP proof requires a fresh bounded follow read");
});

test("cancellation, replacement, navigation and epoch reset discard pre-stage frames", () => {
  for (const cleanup of ["cancel", "replace", "navigate", "epoch"] as const) {
    const { store, fence, generation } = fixture(() => true);
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
    const buffers = (store as unknown as { pendingGapLive: Map<string, unknown> }).pendingGapLive;
    assert.equal(buffers.size, 1);
    if (cleanup === "cancel") store.cancelEventGapRecovery(fence);
    else if (cleanup === "replace") store.loadEvents("s1", events(101, 110), 0, 2, true, generation, true);
    else if (cleanup === "navigate") store.navigate({ name: "board" });
    else store.dispatch({ type: "msg", msg: { type: "session_events_reset", sessionId: "s1", eventEpoch: 1, events: [] } });
    assert.equal(buffers.size, 0, cleanup);
    assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
  }
  const { store, fence, generation } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  const replacement = store.beginEventGapRecovery("s1", 0, 2, generation, () => true)!;
  store.cancelEventGapRecovery(fence);
  assert.equal(store.deferEventTail(replacement, events(10_000, 10_009), true, true), true);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.tailSeq, 10_009);
});

test("a connected HTTP tail still settles the reading prefix without claiming gapped pre-stage live", () => {
  const { store, fence } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(125) } });
  assert.equal(store.deferEventTail(fence, events(111, 120), true, true), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 120);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.afterSeq, 120);
  assert.equal(store.promoteDeferredEventTail(fence), false);
});

test("pre-stage and staged buffers share the byte budget across relevant sessions", () => {
  const store = new Store();
  store.dispatch({ type: "msg", msg: { type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true }, runners: [], boxes: [],
    sessions: ["s1", "s2"].map(id => ({ id, eventEpoch: 0 } as SessionView)),
    runs: [{ id: "r1", sessionIds: ["s1", "s2"] } as never], pods: [],
  } });
  store.navigate({ name: "run", id: "r1" });
  const generation = store.getState().snapshotRevision;
  store.prepareSubscriptionRecovery(1, ["s1", "s2"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 1,
    sessionIds: ["s1", "s2"], podIds: [] } });
  const fences = ["s1", "s2"].map(id => {
    store.beginEventHistoryLoad(id, 0, 1, generation);
    store.loadEvents(id, events(101, 110).map(row => ({ ...row, sessionId: id })), 0, 1, true, generation, true);
    store.beginEventHistoryLoad(id, 0, 1, generation);
    return store.beginEventGapRecovery(id, 0, 1, generation, () => true)!;
  });
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010, "x".repeat(4 * 1024 * 1024)) } });
  const largeTail = events(10_000, 10_001).map(row => ({ ...row, sessionId: "s2",
    payload: { kind: "agent_message" as const, text: "x".repeat(2 * 1024 * 1024), final: true } }));
  assert.equal(store.deferEventTail(fences[1]!, largeTail, true, true), true);
  const privateBuffers = store as unknown as {
    pendingGapLive: Map<string, { bytes: number }>;
    deferredTails: Map<string, { bytes: number }>;
  };
  const total = [...privateBuffers.pendingGapLive.values(), ...privateBuffers.deferredTails.values()]
    .reduce((bytes, buffer) => bytes + buffer.bytes, 0);
  assert.ok(total <= 8 * 1024 * 1024);
  assert.equal(store.getState().events.get("s1")!.length, 10);
  assert.equal(store.getState().events.get("s2")!.length, 10);
  store.cancelEventGapRecovery(fences[0]!);
  store.cancelEventGapRecovery(fences[1]!);
  assert.equal(privateBuffers.pendingGapLive.size + privateBuffers.deferredTails.size, 0);
});

test("finishing a small forward gap publishes buffered live without moving its frozen cursor", () => {
  const { store, fence, generation } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(115) } });
  store.loadEvents("s1", events(111, 112), 0, 2, true, generation);
  const cursor = store.recoveryAfter("s1");
  store.finishEventGapRecovery(fence);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 115);
  assert.equal(store.recoveryAfter("s1"), cursor);
  assert.equal(store.getState().eventHistory.get("s1")!.refreshing, false);
  assert.equal(store.isEventGapRecoveryCurrent(fence), false);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(116) } });
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 116);
});

test("resuming before the HTTP tail returns carries pre-stage live into the owned replacement", () => {
  let paused = true;
  const { store, fence } = fixture(() => paused);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  paused = false;
  assert.equal(store.loadEventGapWindow(fence, events(10_000, 10_009), true, true), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
});

test("an oversized pre-stage live frame remains an observed gap and cannot certify a stale HTTP tail", () => {
  const { store, fence } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010, "x".repeat(8 * 1024 * 1024)) } });
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap!.tailSeq, 10_010);
  assert.equal(store.promoteDeferredEventTail(fence), false);
});

test("finishing a staged gap preserves its owner and finishing an error does not clear the error", () => {
  const { store, fence } = fixture(() => true);
  store.deferEventTail(fence, events(10_000, 10_009), true, true);
  store.finishEventGapRecovery(fence);
  assert.equal(store.isEventGapRecoveryCurrent(fence), true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  assert.equal(store.promoteDeferredEventTail(fence), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
  const failed = fixture(() => true);
  failed.store.dispatch({ type: "msg", msg: { type: "session_event", event: event(115) } });
  failed.store.failEventHistoryLoad("s1", "Incomplete recovery", 0, 2, failed.generation);
  failed.store.finishEventGapRecovery(failed.fence);
  assert.equal(failed.store.getState().eventHistory.get("s1")!.error, "Incomplete recovery");
  assert.equal(failed.store.getState().events.get("s1")!.at(-1)!.seq, 115);
});

test("obsolete completion cannot flush or revoke a replacement's private live owner", () => {
  const { store, fence, generation } = fixture(() => true);
  const replacement = store.beginEventGapRecovery("s1", 0, 2, generation, () => true)!;
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  store.finishEventGapRecovery(fence);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 110);
  assert.equal(store.isEventGapRecoveryCurrent(replacement), true);
  store.deferEventTail(replacement, events(10_000, 10_009), true, true);
  assert.equal(store.promoteDeferredEventTail(replacement), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
});

test("a dropped future payload beyond a connected HTTP prefix is reachable by one reader page", () => {
  const { store, fence } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(125, "x".repeat(8 * 1024 * 1024)) } });
  assert.equal(store.deferEventTail(fence, events(111, 120), true, true), true);
  const gap = store.getState().eventWindows.get("s1")!.laterGap!;
  assert.equal(gap.afterSeq, 120);
  assert.equal(gap.beforeSeq, 125);
  assert.equal(gap.tailSeq, 125);
  assert.equal(store.promoteDeferredEventTail(fence), false);
  const request = store.beginLaterEventsLoad("s1")!;
  assert.equal(store.loadLaterEvents(request, { events: events(121, 125), eventEpoch: 0,
    nextAfter: 125, hasMoreCached: false, cacheComplete: true }), true);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 125);
});

test("finishing a small gap reports an observed live frame that exceeded the payload budget", () => {
  const { store, fence, generation } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(115, "x".repeat(8 * 1024 * 1024)) } });
  store.loadEvents("s1", events(111, 112), 0, 2, true, generation);
  const reading = store.getState().events.get("s1");
  const cursor = store.recoveryAfter("s1");
  store.finishEventGapRecovery(fence);
  assert.equal(store.getState().eventHistory.get("s1")!.error,
    "Newer activity could not be retained. Jump to latest to refresh.");
  assert.equal(store.getState().eventHistory.get("s1")!.refreshing, false);
  assert.equal(store.getState().events.get("s1"), reading);
  assert.equal(store.recoveryAfter("s1"), cursor);
  assert.equal(store.isEventGapRecoveryCurrent(fence), false);
});

test("bridging a staged gap retires its paused-live owner", () => {
  const { store, fence } = fixture(() => true);
  assert.equal(store.deferEventTail(fence, events(115, 119), true, true), true);
  const request = store.beginLaterEventsLoad("s1")!;
  assert.equal(store.loadLaterEvents(request, { events: events(111, 116), eventEpoch: 0,
    nextAfter: 116, hasMoreCached: true, cacheComplete: true }), true);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(120) } });
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 120);
  assert.equal(store.isEventGapRecoveryCurrent(fence), false);
});

test("count-trimmed pre-stage rows cannot hide a gap behind their highest retained seq", () => {
  const { store, fence, generation } = fixture(() => true);
  for (let seq = 111; seq <= 2_120; seq++)
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(seq) } });
  store.loadEvents("s1", events(111, 112), 0, 2, true, generation);
  const cursor = store.recoveryAfter("s1");
  store.finishEventGapRecovery(fence);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 2_120);
  assert.ok(store.getState().eventHistory.get("s1")!.error, "retained maximum is not contiguous recovery proof");
  assert.equal(store.recoveryAfter("s1"), cursor);
});

test("finishing dropped live preserves an existing recovery error", () => {
  const { store, fence, generation } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(115, "x".repeat(8 * 1024 * 1024)) } });
  store.failEventHistoryLoad("s1", "Existing recovery failure", 0, 2, generation);
  store.finishEventGapRecovery(fence);
  assert.equal(store.getState().eventHistory.get("s1")!.error, "Existing recovery failure");
});

function emptyThenLiveFixture(firstLiveSeq = 1) {
  const store = new Store();
  store.dispatch({ type: "msg", msg: { type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true }, runners: [], boxes: [],
    sessions: [{ id: "s1", eventEpoch: 0 } as SessionView], runs: [], pods: [],
  } });
  store.navigate({ name: "session", id: "s1" });
  const generation = store.getState().snapshotRevision;
  store.prepareSubscriptionRecovery(1, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 1, sessionIds: ["s1"], podIds: [] } });
  store.beginEventHistoryLoad("s1", 0, 1, generation);
  store.loadEvents("s1", [], 0, 1, true, generation, false);
  assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 0);
  for (const row of events(firstLiveSeq, firstLiveSeq + 9)) store.dispatch({ type: "msg", msg: { type: "session_event", event: row } });
  store.prepareSubscriptionRecovery(2, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 2, sessionIds: ["s1"], podIds: [] } });
  store.beginEventHistoryLoad("s1", 0, 2, generation);
  return { store, generation };
}

test("a populated initial empty window can own paused staged recovery without changing its rows or cursor", () => {
  const { store, generation } = emptyThenLiveFixture();
  const reading = store.getState().events.get("s1");
  const cursor = store.recoveryAfter("s1");
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation, () => true);
  assert.ok(fence, "live rows make the initial zero-base window a valid reading slice");
  assert.equal(fence.baseSeq, 1);
  assert.equal(store.isEventGapRecoveryCurrent(fence), true);
  assert.equal(store.getState().events.get("s1"), reading);
  assert.equal(store.recoveryAfter("s1"), cursor);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  assert.equal(store.getState().events.get("s1"), reading);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), true);
  const request = store.beginLaterEventsLoad("s1")!;
  assert.equal(request.after, 10);
  assert.equal(store.loadLaterEvents(request, { events: events(11, 210), eventEpoch: 0,
    nextAfter: 210, hasMoreCached: true, cacheComplete: true }), true);
  assert.equal(store.getState().events.get("s1")![0]!.seq, 1);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 210);
  assert.equal(store.promoteDeferredEventTail(fence), true);
  assert.equal(store.getState().events.get("s1")![0]!.seq, 10_000);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
});

test("a zero-base owner connects an adjacent tail and retains ordinary completion contiguity", () => {
  const { store, generation } = emptyThenLiveFixture();
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation, () => true);
  assert.ok(fence);
  assert.equal(store.deferEventTail(fence, events(11, 20), true, false), true);
  assert.deepEqual(store.getState().events.get("s1")!.map(row => row.seq), events(1, 20).map(row => row.seq));
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
  store.finishEventGapRecovery(fence);
  assert.equal(store.getState().eventHistory.get("s1")!.error, null);
  assert.equal(store.isEventGapRecoveryCurrent(fence), false);
});

test("zero-base live owners still reject stale epoch, generation and replacement completions", () => {
  const { store, generation } = emptyThenLiveFixture();
  assert.equal(store.beginEventGapRecovery("s1", 1, 2, generation), null);
  assert.equal(store.beginEventGapRecovery("s1", 0, 2, generation - 1), null);
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation, () => true);
  assert.ok(fence);
  store.loadEvents("s1", events(1, 10), 0, 2, true, generation, false);
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10);
});

test("a populated zero-base window cannot certify a missing initial prefix from its first live seq", () => {
  const { store, generation } = emptyThenLiveFixture(11);
  assert.equal(store.recoveryAfter("s1"), 0);
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation, () => true);
  assert.ok(fence);
  assert.equal(fence.baseSeq, 1, "a known empty log begins at seq1 even if delivery missed its prefix");
  const reading = store.getState().events.get("s1");
  assert.equal(store.deferEventTail(fence, events(10_000, 10_009), true, true), false);
  assert.equal(store.getState().events.get("s1"), reading);
  assert.equal(store.recoveryAfter("s1"), 0);
  store.loadEvents("s1", events(1, 10), 0, 2, false, generation);
  assert.equal(store.deferEventTail(fence, events(21, 30), true, false), true);
  assert.deepEqual(store.getState().events.get("s1")!.map(row => row.seq), events(1, 30).map(row => row.seq));
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
});

test("an owned empty replacement retains a valid populated zero-base operation", () => {
  const { store, generation } = emptyThenLiveFixture();
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation, () => true);
  assert.ok(fence);
  assert.equal(store.loadEventGapWindow(fence, [], true, false), true);
  assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 0);
  assert.equal(fence.baseSeq, 1);
  assert.equal(store.isEventGapRecoveryCurrent(fence), true);
  assert.equal(store.deferEventTail(fence, events(11, 20), true, false), true);
  assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 20);
  assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
});


for (const initialWindow of [
  { first: 101, last: 110, hasOlder: true },
  { first: 1, last: 10, hasOlder: false },
]) {
  test(`an empty incomplete owned tail preserves known earlier activity below its live-only base ${initialWindow.first}`, () => {
    const { store, fence, generation } = fixture(() => true, initialWindow);
    const cursor = store.recoveryAfter("s1");
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
    assert.equal(store.loadEventGapWindow(fence, [], false, false), true);
    assert.deepEqual(store.getState().events.get("s1")!.map(row => row.seq), [10_010]);
    assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 10_010);
    assert.equal(store.getState().eventWindows.get("s1")!.hasOlder, true,
      "an incomplete empty HTTP answer cannot erase observed history below buffered live activity");
    assert.equal(store.getState().eventWindows.get("s1")!.laterGap, undefined);
    assert.equal(store.isEventGapRecoveryCurrent(fence), true);
    assert.equal(store.recoveryAfter("s1"), cursor);
    assert.equal(store.getState().eventHistory.get("s1")!.refreshing, true);
    store.failEventHistoryLoad("s1", "Incomplete bounded tail", 0, 2, generation);
    store.finishEventGapRecovery(fence);
    assert.equal(store.getState().eventHistory.get("s1")!.error, "Incomplete bounded tail");
    assert.equal(store.beginOlderEventsLoad("s1", 10_010, 0), true);
    store.loadOlderEvents("s1", events(9_990, 10_009), true, 10_010, 0);
    assert.equal(store.getState().events.get("s1")![0]!.seq, 9_990, "earlier history remains reachable below the replacement");
    assert.equal(store.recoveryAfter("s1"), cursor, "an older prepend cannot certify forward recovery progress");
  });
}

test("an empty incomplete owned tail retains an existing earlier flag without inventing it for duplicate-only live", () => {
  for (const hasOlder of [true, false]) {
    const { store, fence } = fixture(() => true, { first: 101, last: 110, hasOlder });
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(101) } });
    assert.equal(store.loadEventGapWindow(fence, [], false, false), true);
    assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 101);
    assert.equal(store.getState().eventWindows.get("s1")!.hasOlder, hasOlder,
      "a duplicate at the same base only carries availability that was already known");
  }
});

test("an empty incomplete owned tail without buffered live preserves its existing window", () => {
  const { store, fence } = fixture(() => true);
  const window = store.getState().eventWindows.get("s1");
  const reading = store.getState().events.get("s1");
  assert.equal(store.loadEventGapWindow(fence, [], false, false), true);
  assert.equal(store.getState().eventWindows.get("s1"), window);
  assert.deepEqual(store.getState().events.get("s1"), reading);
});

test("a complete empty owned tail trusts its earlier-history answer despite buffered live and known old rows", () => {
  const { store, fence } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  assert.equal(store.loadEventGapWindow(fence, [], true, false), true);
  assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 10_010);
  assert.equal(store.getState().eventWindows.get("s1")!.hasOlder, false);
  assert.equal(store.getState().eventHistory.get("s1")!.refreshing, false);
});

for (const complete of [false, true]) {
  test(`a nonempty owned tail keeps the supplied earlier-history flag when complete is ${complete}`, () => {
    const { store, fence } = fixture(() => true);
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
    assert.equal(store.loadEventGapWindow(fence, events(10_000, 10_009), complete, false), true);
    assert.equal(store.getState().eventWindows.get("s1")!.baseSeq, 10_000);
    assert.equal(store.getState().eventWindows.get("s1")!.hasOlder, false);
    assert.equal(store.getState().events.get("s1")!.at(-1)!.seq, 10_010);
    assert.equal(store.getState().eventHistory.get("s1")!.refreshing, !complete);
  });
}

for (const obsolete of ["cancelled", "inactive", "epoch", "generation", "revision"] as const) {
  test(`an empty incomplete owned tail cannot restore earlier availability for a ${obsolete} owner`, () => {
    const { store, fence, generation } = fixture(() => true);
    store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
    if (obsolete === "cancelled") store.cancelEventGapRecovery(fence);
    else if (obsolete === "inactive") store.navigate({ name: "board" });
    else if (obsolete === "epoch") store.dispatch({ type: "msg", msg: {
      type: "session_events_reset", sessionId: "s1", eventEpoch: 1, events: [],
    } });
    else if (obsolete === "generation") store.dispatch({ type: "msg", msg: { type: "snapshot",
      capabilities: { sessionSubscriptions: true, boundedDelivery: true }, runners: [], boxes: [],
      sessions: [{ id: "s1", eventEpoch: 0 } as SessionView], runs: [], pods: [],
    } });
    else {
      store.prepareSubscriptionRecovery(3, ["s1"]);
      store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 3, sessionIds: ["s1"], podIds: [] } });
      store.beginEventHistoryLoad("s1", 0, 3, generation);
    }
    const before = store.getState();
    assert.equal(store.loadEventGapWindow(fence, [], false, false), false);
    assert.equal(store.getState(), before, "an obsolete answer cannot mutate rows, window, history or pending live ownership");
  });
}

test("a replaced empty incomplete tail cannot consume the new owner's live buffer or earlier evidence", () => {
  const { store, fence, generation } = fixture(() => true);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(10_010) } });
  const current = store.beginEventGapRecovery("s1", 0, 2, generation, () => true);
  assert.ok(current);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: event(20_010) } });
  const before = store.getState();
  assert.equal(store.loadEventGapWindow(fence, [], false, false), false);
  assert.equal(store.getState(), before);
  assert.equal(store.loadEventGapWindow(current, [], false, false), true);
  assert.deepEqual(store.getState().events.get("s1")!.map(row => row.seq), [20_010]);
  assert.equal(store.getState().eventWindows.get("s1")!.hasOlder, true);
  assert.equal(store.isEventGapRecoveryCurrent(current), true);
});
