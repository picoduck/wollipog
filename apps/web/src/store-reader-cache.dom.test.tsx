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

async function mountReader(store: Store, scope: string) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  let api!: FollowTailApi;
  function Reader({ id, epoch }: { id: string; epoch: number }) {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    api = useFollowTail({ scrollRef, contentRevision: 1, sessionId: id, persistenceScope: scope, rowGeneration: epoch });
    return <div ref={scrollRef} />;
  }
  function Screen() {
    const state = React.useSyncExternalStore(store.subscribe, store.getState);
    return state.view.name === "session"
      ? <Reader key={state.view.id} id={state.view.id} epoch={state.sessions.get(state.view.id)?.eventEpoch ?? 0} />
      : null;
  }
  await act(async () => root.render(<React.StrictMode><Screen /></React.StrictMode>));
  return {
    api: () => api,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("mounted-reader cleanup cannot recreate a position navigation or an epoch change expired", async () => {
  for (const scenario of ["oversized", "gapped", "epoch", "legacy"] as const) {
    const scope = `mounted-reader-expiry-${scenario}`;
    const store = new Store({ name: "session", id: "s1" }, undefined, scope);
    snapshot(store, [session("s1")]);
    load(store, "s1", events("s1", 100, scenario === "oversized" ? 2001 : 101));
    const mounted = await mountReader(store, scope);
    try {
      await act(async () => {
        mounted.api().onVisibleAnchorChange({ key: "150", offset: -12, index: 50 });
        mounted.api().pause();
      });
      assert.equal(hasSavedFollowTailAnchor(scope, "s1"), true);
      await act(async () => {
        if (scenario === "gapped") {
          store.dispatch({ type: "msg", msg: { type: "session_event", event: events("s1", 205, 1)[0]! } });
        } else if (scenario === "epoch") {
          store.dispatch({ type: "msg", msg: { type: "session_upsert", session: session("s1", 1) } });
        } else if (scenario === "legacy") {
          snapshot(store, [session("s1")], false);
        }
        store.navigate({ name: "board" });
      });
      assert.equal(hasSavedFollowTailAnchor(scope, "s1"), false,
        `${scenario}: the real navigation-then-unmount order must leave the position expired`);
      await act(async () => store.navigate({ name: "session", id: "s1" }));
      assert.equal(mounted.api().state, "following", "a reader without retained rows opens at the tail");
      assert.equal(mounted.api().getInitialAnchor(), null);
      await act(async () => {
        mounted.api().onVisibleAnchorChange({ key: "300", offset: 20, index: 3 });
        mounted.api().pause();
      });
      assert.equal(hasSavedFollowTailAnchor(scope, "s1"), true, "the fresh mount can save a new valid position");
    } finally { await mounted.unmount(); }
  }
});

test("a cold Store invalidates a mounted predecessor's position when that session opens", async () => {
  const scope = "mounted-reader-new-store";
  const oldStore = new Store({ name: "session", id: "s1" }, undefined, scope);
  snapshot(oldStore, [session("s1")]);
  load(oldStore, "s1");
  const mounted = await mountReader(oldStore, scope);
  await act(async () => {
    mounted.api().onVisibleAnchorChange({ key: "150", offset: -12, index: 50 });
    mounted.api().pause();
  });
  const replacement = new Store({ name: "board" }, undefined, scope);
  snapshot(replacement, [session("s1")]);
  replacement.navigate({ name: "session", id: "s1" });
  await mounted.unmount();
  assert.equal(hasSavedFollowTailAnchor(scope, "s1"), false,
    "cleanup of the previous Store's mounted session must not resurrect an unrestorable anchor");
});

test("an epoch change renews the still-mounted reader without accepting callbacks from its old log", async () => {
  const scope = "mounted-reader-new-epoch";
  const store = new Store({ name: "session", id: "s1" }, undefined, scope);
  snapshot(store, [session("s1")]);
  load(store, "s1");
  const mounted = await mountReader(store, scope);
  try {
    await act(async () => {
      mounted.api().onVisibleAnchorChange({ key: "150", offset: -12, index: 50 });
      mounted.api().pause();
    });
    const previousLog = mounted.api();
    await act(async () => {
      store.dispatch({ type: "msg", msg: { type: "session_upsert", session: session("s1", 1) } });
      store.beginEventHistoryLoad("s1", 1, 1);
      store.loadEvents("s1", events("s1", 500), 1, 1, true, store.getState().snapshotRevision, true, true);
    });
    await act(async () => {
      mounted.api().onVisibleAnchorChange({ key: "550", offset: -5, index: 50 });
      mounted.api().pause();
      previousLog.onVisibleAnchorChange({ key: "150", offset: -12, index: 50 });
      previousLog.onAnchorLost({ key: "550", offset: -5, index: 50 });
    });
    assert.equal(hasSavedFollowTailAnchor(scope, "s1"), true,
      "the same mounted reader can save a new position after its event epoch changes");
    await act(async () => store.navigate({ name: "board" }));
    await act(async () => store.navigate({ name: "session", id: "s1" }));
    assert.deepEqual(mounted.api().getInitialAnchor(), { key: "550", offset: -5, index: 50 });
    assert.equal(mounted.api().state, "paused");
    assert.equal(store.getState().eventWindows.get("s1")?.eventEpoch, 1);
  } finally { await mounted.unmount(); }
});

test("an explicit inactive-history reset discards only its reader cache even without a changed wire epoch", async () => {
  for (const eventEpoch of [undefined, 0]) {
    const scope = `reader-explicit-reset-${eventEpoch}`;
    const store = new Store({ name: "board" }, undefined, scope);
    snapshot(store, [session("s1"), session("s2")]);
    load(store, "s1");
    await pause(scope, "s1");
    load(store, "s2", undefined, 2);
    await pause(scope, "s2");
    store.navigate({ name: "board" });
    store.dispatch({ type: "msg", msg: {
      type: "session_events_reset", sessionId: "s1", events: events("s1", 1, 1),
      ...(eventEpoch === undefined ? {} : { eventEpoch }),
    } });
    store.navigate({ name: "session", id: "s1" });
    assert.equal(store.getState().events.has("s1"), false,
      "the accepted reset cannot restore the old retained log while awaiting fresh history");
    assert.equal(hasSavedFollowTailAnchor(scope, "s1"), false);
    store.navigate({ name: "session", id: "s2" });
    assert.equal(store.getState().events.get("s2")?.length, 101);
    assert.equal(hasSavedFollowTailAnchor(scope, "s2"), true);
  }
});

test("snapshot eviction leaves a mounted reader's Pause and Resume controls working without reviving its saved position", async () => {
  const scope = "mounted-reader-snapshot-eviction";
  const store = new Store({ name: "session", id: "active" }, undefined, scope);
  snapshot(store, [session("active")]);
  load(store, "active");
  const mounted = await mountReader(store, scope);
  try {
    await act(async () => {
      mounted.api().onVisibleAnchorChange({ key: "150", offset: -12, index: 50 });
      mounted.api().pause();
    });
    for (let index = 0; index < 200; index++) await pause(scope, `browsed-${index}`);
    assert.equal(hasSavedFollowTailAnchor(scope, "active"), false, "the snapshot bound evicted the older mounted position");
    await act(async () => mounted.api().follow());
    assert.equal(mounted.api().state, "following", "Resume still changes the mounted reader after its snapshot was evicted");
    await act(async () => mounted.api().pause());
    assert.equal(mounted.api().state, "paused", "Pause also remains usable without a persisted snapshot");
    assert.equal(hasSavedFollowTailAnchor(scope, "active"), false);
  } finally { await mounted.unmount(); }
  assert.equal(hasSavedFollowTailAnchor(scope, "active"), false, "unmount must not resurrect the evicted position");
});

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
