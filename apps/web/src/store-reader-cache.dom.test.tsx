import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent, SessionView } from "@wollipog/protocol";
import { Store } from "./store.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { hasSavedFollowTailAnchor, useFollowTail, type FollowTailApi } from "./useFollowTail.js";

const dom = new Window({ url: "http://localhost" });
installDomTestCleanup(dom);
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const session = (id: string, eventEpoch = 0) => ({ id, eventEpoch } as SessionView);
const events = (id: string, first = 100, count = 101): SessionEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    id: first + index, seq: first + index, sessionId: id, ts: first + index,
    payload: { kind: "agent_message", text: `${id}:${first + index}` },
  }));
function snapshot(store: Store, sessions: SessionView[], targeted = true) {
  store.dispatch({ type: "msg", msg: {
    type: "snapshot", runners: [], boxes: [], sessions, runs: [], pods: [],
    capabilities: { sessionSubscriptions: targeted },
  } });
}
function acknowledge(store: Store, id: string, revision: number) {
  store.prepareSubscriptionRecovery(revision, [id]);
  store.dispatch({ type: "msg", msg: {
    type: "session_subscriptions_applied", revision, sessionIds: [id], podIds: [],
  } });
  store.beginEventHistoryLoad(id, store.eventEpoch(id), revision);
}
function load(store: Store, id: string, rows = events(id), revision = 1) {
  store.navigate({ name: "session", id });
  acknowledge(store, id, revision);
  store.loadEvents(id, rows, 0, revision, true, store.getState().snapshotRevision, true, true);
}
async function pause(scope: string, id: string, restoreOnly = false) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  let api!: FollowTailApi;
  function Reader() {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    api = useFollowTail({ scrollRef, contentRevision: 1, sessionId: id, persistenceScope: scope });
    return <div ref={scrollRef} />;
  }
  await act(async () => root.render(<Reader />));
  const restored = { state: api.state, anchor: api.getInitialAnchor() };
  if (!restoreOnly) await act(async () => {
    api.onVisibleAnchorChange({ key: "150", offset: -12, index: 50 });
    api.pause();
  });
  await act(async () => root.unmount());
  container.remove();
  assert.equal(hasSavedFollowTailAnchor(scope, id), true);
  return restored;
}

test("a paused reader returns immediately to its loaded window and recovers only the unseen tail", async () => {
  const scope = "reader-return";
  const store = new Store({ name: "session", id: "s1" }, undefined, scope);
  snapshot(store, [session("s1"), session("s2")]);
  load(store, "s1");
  await pause(scope, "s1");
  store.navigate({ name: "session", id: "s2" });
  assert.equal(store.getState().events.has("s1"), false, "inactive history stays outside visible streams");
  store.dispatch({ type: "msg", msg: { type: "session_event", event: events("s1", 210, 1)[0]! } });
  store.navigate({ name: "session", id: "s1" });
  assert.deepEqual(store.getState().events.get("s1")?.map((event) => event.seq), events("s1").map((event) => event.seq));
  assert.equal(hasSavedFollowTailAnchor(scope, "s1"), true, "the paused position still has its rows");
  assert.equal(store.getState().eventWindows.get("s1")?.baseSeq, 100);
  assert.deepEqual(await pause(scope, "s1", true), {
    state: "paused", anchor: { key: "150", offset: -12, index: 50 },
  }, "the mounted reader restores the same row and viewport offset");
  acknowledge(store, "s1", 2);
  store.dispatch({ type: "msg", msg: { type: "session_event", event: events("s1", 212, 1)[0]! } });
  assert.equal(store.recoveryAfter("s1"), 200, "post-ack live traffic cannot skip unseen events");
  store.loadEvents("s1", events("s1", 201, 11), 0, 2);
  assert.deepEqual(store.getState().events.get("s1")?.map((event) => event.seq), events("s1", 100, 113).map((event) => event.seq));
});

test("same-epoch reconnect preserves a paused cache but a replacement log or legacy snapshot expires its anchor", async () => {
  for (const scenario of ["same", "epoch", "legacy"] as const) {
    const scope = `reader-reconnect-${scenario}`;
    const store = new Store({ name: "session", id: "s1" }, undefined, scope);
    snapshot(store, [session("s1")]);
    load(store, "s1");
    await pause(scope, "s1");
    store.navigate({ name: "board" });
    snapshot(store, [session("s1", scenario === "epoch" ? 1 : 0)], scenario !== "legacy");
    store.navigate({ name: "session", id: "s1" });
    assert.equal(store.getState().events.has("s1"), scenario === "same");
    assert.equal(hasSavedFollowTailAnchor(scope, "s1"), scenario === "same");
    if (scenario === "same") {
      acknowledge(store, "s1", 1);
      assert.equal(store.recoveryAfter("s1"), 200);
    }
  }
});

test("evicted and oversized readers open at the tail without retaining an unrestorable paused anchor", async () => {
  const scope = "reader-eviction";
  const store = new Store({ name: "board" }, undefined, scope);
  const sessions = Array.from({ length: 10 }, (_, index) => session(`s${index}`));
  snapshot(store, sessions);
  for (let index = 0; index < 9; index++) {
    load(store, `s${index}`, undefined, index + 1);
    await pause(scope, `s${index}`);
    store.navigate({ name: "board" });
  }
  store.navigate({ name: "session", id: "s0" });
  assert.equal(store.getState().events.has("s0"), false);
  assert.equal(hasSavedFollowTailAnchor(scope, "s0"), false);
  store.navigate({ name: "session", id: "s8" });
  assert.equal(store.getState().events.get("s8")?.length, 101, "recent readers remain restorable");
  assert.equal(hasSavedFollowTailAnchor(scope, "s8"), true);
  load(store, "s9", events("s9", 100, 2001), 20);
  await pause(scope, "s9");
  store.navigate({ name: "board" });
  store.navigate({ name: "session", id: "s9" });
  assert.equal(store.getState().events.has("s9"), false);
  assert.equal(hasSavedFollowTailAnchor(scope, "s9"), false);
});

test("a live gap is never retained as a complete reader window", async () => {
  const scope = "reader-gapped";
  const store = new Store({ name: "session", id: "s1" }, undefined, scope);
  snapshot(store, [session("s1")]);
  load(store, "s1");
  await pause(scope, "s1");
  store.dispatch({ type: "msg", msg: { type: "session_event", event: events("s1", 205, 1)[0]! } });
  store.navigate({ name: "board" });
  store.navigate({ name: "session", id: "s1" });
  assert.equal(store.getState().events.has("s1"), false);
  assert.equal(hasSavedFollowTailAnchor(scope, "s1"), false, "full-gap recovery cannot be skipped by restoring a gapped cache");
});

test("UTF-8 payload pressure evicts inactive readers without clearing another instance's position", async () => {
  const scope = "reader-byte-bound";
  const otherScope = "another-instance";
  const store = new Store({ name: "board" }, undefined, scope);
  snapshot(store, [session("s1"), session("s2")]);
  const heavy = (id: string) => [{
    ...events(id, 150, 1)[0]!, payload: { kind: "agent_message" as const, text: "é".repeat(2 * 1024 * 1024 + 1) },
  }];
  load(store, "s1", heavy("s1"));
  await pause(scope, "s1");
  await pause(otherScope, "s1");
  store.navigate({ name: "board" });
  load(store, "s2", heavy("s2"), 2);
  await pause(scope, "s2");
  store.navigate({ name: "board" });
  store.navigate({ name: "session", id: "s1" });
  assert.equal(store.getState().events.has("s1"), false, "two four-MiB windows exceed the shared eight-MiB bound");
  assert.equal(hasSavedFollowTailAnchor(scope, "s1"), false);
  assert.equal(hasSavedFollowTailAnchor(otherScope, "s1"), true);
  store.navigate({ name: "session", id: "s2" });
  assert.equal(store.getState().events.get("s2")?.length, 1);
});

test("recreating a Store cannot restore an anchor without its matching event window", async () => {
  const scope = "reader-new-store";
  await pause(scope, "s1");
  const replacement = new Store({ name: "session", id: "s1" }, undefined, scope);
  assert.equal(hasSavedFollowTailAnchor(scope, "s1"), false);
  snapshot(replacement, [session("s1")]);
  acknowledge(replacement, "s1", 1);
  assert.equal(replacement.recoveryAfter("s1"), 0);
});
