import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionView } from "@wollipog/protocol";
import { isPartialHistory, Store } from "./store.js";

const event = (seq: number, text = String(seq)): SessionEvent => ({
  id: seq, sessionId: "s1", seq, ts: seq,
  payload: { kind: "agent_message", text, final: true },
});
const events = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => event(first + i));
function fixture() {
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
  store.loadEvents("s1", events(101, 110), 0, 1, true, generation, true);
  store.prepareSubscriptionRecovery(2, ["s1"]);
  store.dispatch({ type: "msg", msg: { type: "session_subscriptions_applied", revision: 2, sessionIds: ["s1"], podIds: [] } });
  store.beginEventHistoryLoad("s1", 0, 2, generation);
  const fence = store.beginEventGapRecovery("s1", 0, 2, generation)!;
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
