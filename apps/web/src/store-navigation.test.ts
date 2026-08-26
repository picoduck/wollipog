import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOX_SELECTION_KEY,
  INBOX_SPLIT_RATIO_KEY,
  Store,
  loadInboxState,
  parseInboxSelection,
  parseInboxSplitRatio,
} from "./store.js";
import { encodeResourceId, type View } from "./navigation.js";
import { uiStreamSubscriptions } from "./ui-subscriptions.js";
import { saveInstanceStorageValue, type KeyValueStorage } from "./instance-storage.js";
import type { SessionEvent, SessionView } from "@wollipog/protocol";

test("store navigation pushes only real in-app transitions", () => {
  const pushed: View[] = [];
  const store = new Store({ name: "session", id: "s_1" }, (view) => pushed.push(view));

  assert.deepEqual(store.getState().view, { name: "session", id: "s_1" });
  assert.deepEqual(uiStreamSubscriptions(store.getState()), { sessionIds: ["s_1"], podIds: [] },
    "the first socket subscription starts at the deep-linked session, never at Board");
  store.navigate({ name: "session", id: "s_1" });
  assert.deepEqual(pushed, [], "opening the current view must not add duplicate history entries");

  store.navigate({ name: "run", id: "run_1" });
  assert.deepEqual(store.getState().view, { name: "run", id: "run_1" });
  assert.deepEqual(pushed, [{ name: "run", id: "run_1" }]);
});

test("history traversal updates view state without writing a new entry", () => {
  const pushed: View[] = [];
  const store = new Store({ name: "board" }, (view) => pushed.push(view));

  store.navigateFromHistory({ name: "pod", id: "pod_1" });
  assert.deepEqual(store.getState().view, { name: "pod", id: "pod_1" });
  assert.deepEqual(pushed, []);

  store.navigateFromHistory({ name: "pod", id: "pod_1" });
  assert.deepEqual(pushed, [], "duplicate popstate delivery remains inert");
});

test("Settings records one exact return view without accumulating nested Settings entries", () => {
  const origin: View = {
    name: "session",
    id: "s_1",
    location: { path: "src/index.ts", line: 12, column: 4 },
  };
  const store = new Store(origin);

  assert.equal(store.getState().settingsReturnView, null);
  store.navigate({ name: "settings" });
  assert.deepEqual(store.getState().settingsReturnView, origin);

  store.navigate({ name: "settings", section: "keyboard" });
  store.navigate({ name: "settings", section: "network" });
  assert.deepEqual(store.getState().settingsReturnView, origin,
    "section navigation must not replace the non-Settings origin");

  store.navigate(origin);
  assert.equal(store.getState().settingsReturnView, null);
  store.navigate({ name: "settings" });
  assert.deepEqual(store.getState().settingsReturnView, origin,
    "a later visit records one fresh origin rather than appending Settings history");
});

test("direct Settings entry has an Inbox fallback and browser traversal shares reducer semantics", () => {
  const pushed: View[] = [];
  const store = new Store({ name: "settings", section: "network" }, (view) => pushed.push(view));
  assert.deepEqual(store.getState().settingsReturnView, { name: "inbox" });

  store.navigate({ name: "inbox" });
  assert.equal(store.getState().settingsReturnView, null);
  assert.deepEqual(pushed, [{ name: "inbox" }], "Escape return is modeled as a normal in-app push");

  store.navigateFromHistory({ name: "settings", section: "appearance" });
  assert.deepEqual(store.getState().settingsReturnView, { name: "inbox" });
  store.navigateFromHistory({ name: "usage" });
  assert.equal(store.getState().settingsReturnView, null);
});

test("Inbox state preserves one selection per split and clamps the persisted ratio", () => {
  const store = new Store({ name: "inbox" });
  store.setInboxSelection("all-session");
  store.setInboxSplit("project-a");
  assert.equal(store.getState().inbox.selectedSessionId, null);
  store.setInboxSelection("project-session");
  store.setInboxSplit(null);
  assert.equal(store.getState().inbox.selectedSessionId, "all-session");
  store.setInboxSplit("project-a");
  assert.equal(store.getState().inbox.selectedSessionId, "project-session");
  assert.deepEqual([...store.getState().inbox.selectedBySplit], [
    [null, "all-session"],
    ["project-a", "project-session"],
  ]);

  store.setInboxRatio(0.9);
  assert.equal(store.getState().inbox.splitRatio, 0.75);
  store.setInboxRatio(0.1);
  assert.equal(store.getState().inbox.splitRatio, 0.25);
  assert.equal(parseInboxSplitRatio("not-a-number"), 0.4);
});

test("Inbox removal preserves an active tombstone while explicit clearing remains distinct", () => {
  const store = new Store({ name: "inbox" });
  store.setInboxSelection("selected");
  store.dispatch({ type: "msg", msg: { type: "session_removed", sessionId: "selected" } });
  assert.equal(store.getState().inbox.selectedSessionId, "selected",
    "the view needs the removed id to repair against its visual slot");
  assert.equal(store.getState().inbox.selectionCleared, false);

  store.setInboxSelection(null);
  assert.equal(store.getState().inbox.selectionCleared, true);

  store.setInboxSelection(null, null, true, true);
  assert.equal(store.getState().inbox.selectionCleared, false,
    "automatic empty-state repair must not be mistaken for a user clear");
});

test("Inbox selection persistence is defensive and isolated by control-plane instance", () => {
  const values = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  saveInstanceStorageValue(INBOX_SELECTION_KEY, JSON.stringify({
    selectedSessionId: "remote-session",
    splitKey: "project-a",
    selectedBySplit: [[null, "all-session"], ["project-a", "remote-session"]],
  }), "remote-a", storage);
  saveInstanceStorageValue(INBOX_SPLIT_RATIO_KEY, "0.6", "remote-a", storage);

  assert.deepEqual(loadInboxState("remote-a", storage), {
    selectedSessionId: "remote-session",
    splitKey: "project-a",
    splitRatio: 0.6,
    selectedBySplit: new Map([[null, "all-session"], ["project-a", "remote-session"]]),
  });
  assert.deepEqual(loadInboxState("remote-b", storage), {
    selectedSessionId: null,
    splitKey: null,
    splitRatio: 0.4,
    selectedBySplit: new Map(),
  });
  assert.deepEqual(parseInboxSelection("{broken"), {
    selectedSessionId: null,
    splitKey: null,
    selectedBySplit: new Map(),
  });
});

test("mobile Inbox actions update live state without overwriting desktop persistence", () => {
  const values = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  saveInstanceStorageValue(INBOX_SELECTION_KEY, JSON.stringify({
    selectedSessionId: "desktop-session",
    splitKey: null,
    selectedBySplit: [[null, "desktop-session"]],
  }), "mobile-test", storage);
  const persistedBefore = loadInboxState("mobile-test", storage);
  const store = new Store({ name: "inbox" }, undefined, "mobile-test", storage);

  store.setInboxPersistenceEnabled(false);
  store.setInboxSelection("phone-session", null, false);
  store.setInboxSplit("phone-project", false);
  store.dispatch({ type: "msg", msg: { type: "session_removed", sessionId: "phone-session" } });

  assert.equal(store.getState().inbox.splitKey, "phone-project");
  assert.deepEqual(loadInboxState("mobile-test", storage), persistedBefore,
    "phone-width interactions must not replace the desktop split or selection");

  store.setInboxPersistenceEnabled(true);
  assert.deepEqual(store.getState().inbox, persistedBefore,
    "returning to desktop restores its durable state before persistence resumes");
  store.dispatch({ type: "msg", msg: { type: "session_removed", sessionId: "phone-session" } });
  assert.deepEqual(loadInboxState("mobile-test", storage), persistedBefore,
    "post-mobile socket cleanup cannot serialize the discarded phone selection");
});

test("Inbox selection owns the retained live stream and changes targeted subscriptions", () => {
  const store = new Store({ name: "inbox" });
  const first = { id: 1, sessionId: "s1", seq: 1, ts: 1, payload: { kind: "agent_message", text: "one" } } as SessionEvent;
  const second = { id: 2, sessionId: "s2", seq: 1, ts: 2, payload: { kind: "agent_message", text: "two" } } as SessionEvent;

  store.setInboxSelection("s1");
  assert.deepEqual(uiStreamSubscriptions(store.getState()), { sessionIds: ["s1"], podIds: [] });
  store.dispatch({ type: "msg", msg: { type: "session_event", event: first } });
  assert.equal(store.getState().events.get("s1")?.length, 1);
  const retained = store.getState().events.get("s1");
  store.navigate({ name: "session", id: "s1" });
  store.navigate({ name: "inbox" });
  assert.equal(store.getState().events.get("s1"), retained,
    "expand and collapse retain the selected preview timeline identity");

  store.setInboxSelection("s2");
  assert.deepEqual(uiStreamSubscriptions(store.getState()), { sessionIds: ["s2"], podIds: [] });
  assert.equal(store.getState().events.has("s1"), false, "the prior preview stream is released");
  store.dispatch({ type: "msg", msg: { type: "session_event", event: second } });
  assert.equal(store.getState().events.get("s2")?.length, 1);
});

test("dot-segment resource ids serialize without browser path collapse", () => {
  // `new URL()` applies the same dot-segment normalization as pushState/navigation.
  for (const id of [".", ".."] as const) {
    const encoded = encodeResourceId(id);
    const path = new URL(`/sessions/~${encoded}`, "https://manager.example.test").pathname;
    assert.equal(path, `/sessions/~${encoded}`);
  }
});

test("the first snapshot makes missing run and pod routes authoritative", () => {
  const store = new Store({ name: "run", id: "missing" });
  assert.equal(store.getState().snapshotLoaded, false);
  store.dispatch({ type: "msg", msg: { type: "snapshot", runners: [], sessions: [], runs: [], pods: [] } });
  assert.equal(store.getState().snapshotLoaded, true);
  assert.deepEqual(store.getState().view, { name: "run", id: "missing" });
});

test("an exact authorized lookup can hydrate an archived session omitted from snapshots", () => {
  const store = new Store({ name: "session", id: "archived.txt" });
  store.loadSession({ id: "archived.txt", archived: true, eventEpoch: 0 } as SessionView);
  assert.equal(store.getState().sessions.get("archived.txt")?.archived, true);
  assert.deepEqual(uiStreamSubscriptions(store.getState()), { sessionIds: ["archived.txt"], podIds: [] });
});

test("a targeted reconnect keeps the routed archived timeline mounted until exact revalidation", () => {
  const store = new Store({ name: "session", id: "archived.txt" });
  const archived = { id: "archived.txt", archived: true, eventEpoch: 0 } as SessionView;
  const event = {
    id: 1, sessionId: archived.id, seq: 1, ts: 1,
    payload: { kind: "agent_message", text: "retained history" },
  } as SessionEvent;
  store.loadSession(archived);
  store.loadEvents(archived.id, [event]);
  const retainedEvents = store.getState().events.get(archived.id);

  store.dispatch({
    type: "msg",
    msg: {
      type: "snapshot", runners: [], sessions: [], runs: [], pods: [],
      capabilities: { sessionSubscriptions: true },
    },
  });
  assert.equal(store.getState().snapshotRevision, 1);
  assert.equal(store.getState().sessions.get(archived.id), archived,
    "the rendered detail row survives the non-archived snapshot");
  assert.equal(store.getState().events.get(archived.id), retainedEvents,
    "targeted reconnect keeps timeline identity and scroll ownership stable");

  store.dispatch({ type: "msg", msg: { type: "session_removed", sessionId: archived.id } });
  assert.equal(store.getState().sessions.has(archived.id), false,
    "an explicit removal still wins and cannot be resurrected by the next snapshot");
  store.dispatch({
    type: "msg",
    msg: {
      type: "snapshot", runners: [], sessions: [], runs: [], pods: [],
      capabilities: { sessionSubscriptions: true },
    },
  });
  assert.equal(store.getState().sessions.has(archived.id), false);
});
