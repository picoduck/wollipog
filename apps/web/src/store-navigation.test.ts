import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOX_SELECTION_KEY,
  INBOX_SPLIT_RATIO_KEY,
  SESSIONS_FILTERS_KEY,
  Store,
  loadInboxState,
  loadSessionFilters,
  parseInboxSelection,
  parseInboxSplitRatio,
  parseSessionFilters,
} from "./store.js";
import { BrowserNavigation, encodeResourceId, viewFromPath, viewPath, type View } from "./navigation.js";
import { TestBrowserHistory } from "./test-browser-history.js";
import { MAX_CORRECTIONS, RETURN_QUIET_MS } from "./history-position.js";
import { registerLeaveGuard } from "./leave-guard.js";
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

test("a replace navigation takes the place of the route it corrects, so Back skips it (#2984)", () => {
  const browser = new TestBrowserHistory("/");
  const navigation = new BrowserNavigation(browser.window);
  navigation.current();
  const store = new Store({ name: "inbox" }, (view, options) =>
    options?.replace ? navigation.replace(view) : navigation.push(view));
  store.navigate({ name: "runners", section: "instances" });
  // Instances cannot show on a phone, so its route lands on Machines in place.
  store.navigate({ name: "runners", section: "machines" }, { replace: true });
  assert.deepEqual(store.getState().view, { name: "runners", section: "machines" });
  assert.deepEqual(browser.paths(), ["/", "/connections/machines"]);
  assert.equal(browser.path, "/connections/machines");

  // A replace still runs through the store's own transition, and asks no leave guard: the route it
  // replaces could not be shown, so there is nothing to leave.
  let asked = 0;
  const release = registerLeaveGuard(() => { asked += 1; });
  try {
    store.navigate({ name: "runners", section: "people" }, { replace: true });
  } finally {
    release();
  }
  assert.equal(asked, 0);
  assert.deepEqual(browser.paths(), ["/", "/connections/people"]);
});

test("repeated identical attention activation updates an ephemeral nonce without duplicate history", () => {
  const pushed: View[] = [];
  const target: View = { name: "session", id: "s_1", attention: { eventEpoch: 4, requestId: "request-2" } };
  const store = new Store(target, (view) => pushed.push(view));

  store.navigate(target);
  const first = store.getState().view;
  assert.equal(first.name === "session" ? first.attention?.activationId : undefined, 1);
  store.navigate(target);
  const second = store.getState().view;
  assert.equal(second.name === "session" ? second.attention?.activationId : undefined, 2,
    "the same stable route can re-open and re-focus after an in-panel selection changes");
  assert.deepEqual(pushed, [], "repeat activation must not add an identical browser history entry");
});

test("Back onto /settings/keyboard while Behavior is open still delivers its focus target (#3023)", () => {
  const pushed: View[] = [];
  const store = new Store({ name: "settings", section: "behavior" }, (view) => pushed.push(view));
  const focusOf = () => {
    const view = store.getState().view;
    return view.name === "settings" ? view.focus : undefined;
  };

  store.navigateFromHistory(viewFromPath("/settings/keyboard")!);
  assert.deepEqual(focusOf(), { target: "keyboard-shortcuts", activationId: 1 },
    "the same address is still an arrival the panel must answer");
  store.navigateFromHistory(viewFromPath("/settings/keyboard")!);
  assert.equal(focusOf()?.activationId, 2, "each arrival is a new activation");
  store.navigate(viewFromPath("/settings/keyboard")!);
  assert.equal(focusOf()?.activationId, 3);
  assert.deepEqual(pushed, [], "an activation on the same address writes no history");
  store.navigateFromHistory({ name: "settings", section: "behavior" });
  assert.equal(focusOf()?.activationId, 3, "a plain visit to the same address changes nothing");
});

test("each Machine accounts intent is a new activation, and the address leaves it out (#3240)", () => {
  const pushed: View[] = [];
  const store = new Store({ name: "board" }, (view) => pushed.push(view));
  const intentOf = () => {
    const view = store.getState().view;
    return view.name === "runners" ? view.accounts : undefined;
  };
  const machine = { name: "runners", section: "machines", machineId: "runner-1" } as const;
  store.navigate({ ...machine, accounts: { kind: "add_account", provider: "codex" } });
  assert.deepEqual(intentOf(), { kind: "add_account", provider: "codex", activationId: 1 });
  assert.equal(pushed.length, 1);
  assert.equal(viewPath(store.getState().view), viewPath(machine), "the intent is not part of the address");
  store.navigate({ ...machine, accounts: { kind: "recover_profile", accountId: "work" } });
  assert.deepEqual(intentOf(), { kind: "recover_profile", accountId: "work", activationId: 2 },
    "arriving again on the same Machine is still an activation the section must answer");
  assert.equal(pushed.length, 1, "an activation on the same address writes no history");
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

  store.navigate({ name: "settings", section: "behavior" });
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

test("an editor's leave guard holds in-app navigation until it lets the person leave (#3026)", () => {
  const pushed: View[] = [];
  const store = new Store({ name: "settings", section: "orchestrator" }, (view) => pushed.push(view));
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    store.navigate({ name: "settings", section: "orchestrator" });
    assert.equal(asked.length, 0, "the view already on screen is not a leave");

    store.navigate({ name: "settings", section: "appearance" });
    assert.equal(asked.length, 1);
    assert.deepEqual(store.getState().view, { name: "settings", section: "orchestrator" }, "held while it asks");
    assert.deepEqual(pushed, []);

    // Choosing to leave goes where the link was going, and the guard does not ask again.
    asked[0]!();
    assert.deepEqual(store.getState().view, { name: "settings", section: "appearance" });
    assert.deepEqual(pushed, [{ name: "settings", section: "appearance" }]);
    store.navigate({ name: "inbox" });
    assert.equal(asked.length, 1, "the guard released itself before leaving");
    assert.deepEqual(store.getState().view, { name: "inbox" });
  } finally {
    release();
  }
});

/** A store on browser history, as StoreProvider wires one, opened at `paths[0]` and pushed through the rest. */
function storeOnHistory(...paths: string[]) {
  const browser = new TestBrowserHistory(paths[0]!);
  const navigation = new BrowserNavigation(browser.window);
  const pushed: View[] = [];
  const store = new Store(navigation.current(), (view) => { pushed.push(view); navigation.push(view); });
  navigation.listen((view, traversal) => store.navigateFromHistory(view, traversal));
  for (const path of paths.slice(1)) store.navigate(viewFromPath(path)!);
  pushed.length = 0;
  return { browser, store, pushed };
}

const ORCHESTRATOR: View = { name: "settings", section: "orchestrator" };

test("browser Back with unsaved changes asks first, and Keep Editing keeps the editor and every entry (#3218)", () => {
  const { browser, store, pushed } = storeOnHistory("/settings/appearance", "/settings/orchestrator", "/usage");
  browser.back();
  assert.deepEqual(store.getState().view, ORCHESTRATOR, "no guard yet: Back is immediate");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.back();
    assert.deepEqual(store.getState().view, ORCHESTRATOR, "the editor stays while the move is undone");
    assert.equal(asked.length, 0, "asked once the editor's entry is current again");
    browser.flush();
    assert.equal(asked.length, 1);
    assert.equal(browser.path, "/settings/orchestrator", "the address returns to the editor's entry");
    assert.deepEqual(browser.paths(), ["/settings/appearance", "/settings/orchestrator", "/usage"], "no entry is dropped");
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    assert.deepEqual(pushed, []);
  } finally {
    release();
  }
  // Keep Editing never calls `leave`. With the draft saved, Forward reaches the entry it reached before.
  browser.forward();
  assert.deepEqual(store.getState().view, { name: "usage" });
  assert.equal(browser.path, "/usage");
});

for (const direction of ["Back", "Forward"] as const) {
  test(`browser ${direction} with unsaved changes completes exactly once on Discard Changes (#3218)`, () => {
    const { browser, store, pushed } = storeOnHistory("/settings/appearance", "/settings/orchestrator", "/usage");
    browser.back();
    const asked: Array<() => void> = [];
    const changes: View[] = [];
    let shown = store.getState().view;
    const release = registerLeaveGuard((leave) => asked.push(leave));
    const unsubscribe = store.subscribe(() => {
      if (store.getState().view !== shown) changes.push(shown = store.getState().view);
    });
    try {
      browser.traverse(direction === "Back" ? -1 : 1);
      browser.flush();
      assert.equal(asked.length, 1, `${direction} asks`);
      assert.deepEqual(store.getState().view, ORCHESTRATOR);
      assert.equal(browser.path, "/settings/orchestrator");

      asked[0]!();
      browser.flush();
      const destination: View = direction === "Back" ? { name: "settings", section: "appearance" } : { name: "usage" };
      assert.deepEqual(store.getState().view, destination);
      assert.equal(browser.path, viewPath(destination));
      assert.equal(browser.index, direction === "Back" ? 0 : 2, "exactly one move");
      assert.deepEqual(changes, [destination], "the view changed once, to the destination");
      assert.equal(asked.length, 1, "the guard released itself before leaving, so it is not asked again");
      assert.deepEqual(browser.paths(), ["/settings/appearance", "/settings/orchestrator", "/usage"]);
      assert.deepEqual(pushed, []);
    } finally {
      unsubscribe();
      release();
    }
  });
}

test("a Back of several entries is held and completed as the same move (#3218)", () => {
  const { browser, store } = storeOnHistory("/usage", "/runs", "/settings/orchestrator");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.traverse(-2);
    browser.flush();
    assert.equal(asked.length, 1);
    assert.equal(browser.path, "/settings/orchestrator");
    asked[0]!();
    browser.flush();
    assert.deepEqual(store.getState().view, { name: "usage" });
    assert.equal(browser.index, 0);
  } finally {
    release();
  }
});

test("a second Back while the first is undone still returns to the editor's entry (#3218)", () => {
  const { browser, store } = storeOnHistory("/usage", "/runs", "/settings/orchestrator");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.back();
    browser.back();
    browser.flush();
    assert.equal(browser.path, "/settings/orchestrator");
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    assert.equal(asked.length, 1, "asked once, after the editor's entry is current");
    asked[0]!();
    browser.flush();
    assert.deepEqual(store.getState().view, { name: "runs" }, "Discard completes the first move");
  } finally {
    release();
  }
});

test("two Backs before the undo lands, with entries beyond the editor, return to it once (#3218 review)", () => {
  const { browser, store } = storeOnHistory("/usage", "/runs", "/settings/orchestrator", "/settings/appearance", "/settings/behavior");
  browser.traverse(-2);
  assert.deepEqual(store.getState().view, ORCHESTRATOR);
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.back();
    browser.back();
    // Bounded, unlike `flush`: a return that never settles must fail here rather than hang.
    for (let step = 0; step < 24 && browser.pending.length > 0; step += 1) browser.traverse(browser.pending.shift()!);
    assert.deepEqual(browser.pending, [], "the return settles");
    assert.equal(browser.path, "/settings/orchestrator");
    assert.equal(asked.length, 1);
    assert.equal(browser.entries.length, 5, "no entry is dropped");
    asked[0]!();
    browser.flush();
    assert.deepEqual(store.getState().view, { name: "runs" }, "Discard completes the first move");
  } finally {
    release();
  }
});

test("a Forward that lands before the return makes the return's move land nowhere, and it still settles (#3218 review)", () => {
  const { browser, store } = storeOnHistory("/usage", "/runs", "/settings/orchestrator");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.traverse(-2);
    // Before the return's +2 lands: from Runs it would pass the last entry, so it never arrives.
    browser.forward();
    for (let step = 0; step < 100 && browser.pending.length > 0; step += 1) browser.traverse(browser.pending.shift()!);
    assert.equal(browser.path, "/settings/orchestrator");
    assert.deepEqual(store.getState().view, ORCHESTRATOR, "the dirty editor stays");
    assert.equal(asked.length, 1, "and asks before leaving");
    asked[0]!();
    browser.flush();
    assert.deepEqual(store.getState().view, { name: "usage" }, "Discard completes the first move");
  } finally {
    release();
  }
});

test("after a reload the entries ahead are unseen, and a return still waits for its own move (#3218 review)", () => {
  const browser = new TestBrowserHistory("/usage");
  const before = new BrowserNavigation(browser.window);
  const first = new Store(before.current(), (view) => before.push(view));
  for (const path of ["/runs", "/settings/orchestrator", "/settings/appearance", "/settings/behavior"]) first.navigate(viewFromPath(path)!);
  browser.traverse(-2);
  // The reloaded page: the same entries and positions, and a new navigation that cannot see past its own.
  const navigation = new BrowserNavigation(browser.window);
  const store = new Store(navigation.current(), (view) => navigation.push(view));
  navigation.listen((view, traversal) => store.navigateFromHistory(view, traversal));
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.traverse(-2);
    browser.forward();
    browser.back();
    browser.flush();
    assert.equal(browser.index, 2);
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    assert.equal(asked.length, 1);
    asked[0]!();
    browser.flush();
    assert.equal(browser.index, 0, "Discard completes the Back of two entries");
    assert.deepEqual(store.getState().view, { name: "usage" });
  } finally {
    release();
  }
});

test("twelve Backs before the return lands still settle on the editor's entry, asked once (#3218)", () => {
  const paths = Array.from({ length: 20 }, (_, index) => `/runs/~${encodeResourceId(`run-${index}`)}`);
  const { browser, store } = storeOnHistory(...paths, "/settings/orchestrator");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    // Twelve Backs before any of the app's own moves lands: each one calls for another correction.
    for (let press = 0; press < 12; press += 1) browser.back();
    for (let step = 0; step < 100 && browser.pending.length > 0; step += 1) browser.traverse(browser.pending.shift()!);
    assert.deepEqual(browser.pending, [], "the moves settle");
    assert.equal(browser.path, "/settings/orchestrator");
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    assert.equal(asked.length, 1);
  } finally {
    release();
  }
});

test("a return that needs more than its bound of corrections stops, keeping the editor and its draft (#3218)", () => {
  const paths = Array.from({ length: MAX_CORRECTIONS + 10 }, (_, index) => `/runs/~${encodeResourceId(`run-${index}`)}`);
  const { browser, store } = storeOnHistory(...paths, "/settings/orchestrator");
  const release = registerLeaveGuard(() => {});
  try {
    for (let press = 0; press < MAX_CORRECTIONS + 5; press += 1) browser.back();
    for (let step = 0; step < 1000 && browser.pending.length > 0; step += 1) browser.traverse(browser.pending.shift()!);
    assert.deepEqual(browser.pending, [], "the moves settle");
    assert.deepEqual(store.getState().view, ORCHESTRATOR, "the editor never left the screen");
  } finally {
    release();
  }
});

test("a return's move that lands nowhere is given up after a quiet spell, and the return completes (#3218)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, store } = storeOnHistory("/usage", "/runs", "/settings/orchestrator");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  const go = browser.window.history.go!;
  let dropped = 0;
  // The browser drops the first move it is asked for, as it does one past either end.
  browser.window.history.go = (delta) => { if (dropped++ > 0) go(delta); };
  try {
    browser.back();
    browser.flush();
    assert.equal(browser.path, "/runs", "the return's first move landed nowhere");
    assert.equal(asked.length, 0);
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    t.mock.timers.tick(RETURN_QUIET_MS);
    browser.flush();
    assert.equal(browser.path, "/settings/orchestrator");
    assert.equal(asked.length, 1);
  } finally {
    release();
  }
});

test("a Forward then a Back before the return lands, near the first entry, still settles (#3218)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, store } = storeOnHistory("/settings/orchestrator", "/runs", "/usage");
  browser.traverse(-2);
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.traverse(2);
    // Before the return's -2 lands: from Runs it would pass the first entry, so it lands nowhere,
    // and the return waits a quiet spell for it before settling from where the history is.
    browser.back();
    browser.flush();
    assert.equal(asked.length, 0);
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    t.mock.timers.tick(RETURN_QUIET_MS);
    browser.flush();
    assert.equal(browser.path, "/settings/orchestrator");
    assert.deepEqual(store.getState().view, ORCHESTRATOR);
    assert.equal(asked.length, 1);
  } finally {
    release();
  }
});

test("with no unsaved changes Back and Forward are immediate, and a save in flight decides later (#3218)", () => {
  const { browser, store } = storeOnHistory("/settings/appearance", "/settings/orchestrator");
  browser.back();
  assert.deepEqual(store.getState().view, { name: "settings", section: "appearance" });
  browser.forward();
  assert.deepEqual(store.getState().view, ORCHESTRATOR);

  // A save in flight holds on to `leave` and calls it once the save succeeds, without asking.
  let afterSave: (() => void) | null = null;
  const release = registerLeaveGuard((leave) => { afterSave = leave; });
  try {
    browser.back();
    browser.flush();
    assert.deepEqual(store.getState().view, ORCHESTRATOR, "held while the save is in flight");
    afterSave!();
    browser.flush();
    assert.deepEqual(store.getState().view, { name: "settings", section: "appearance" });
  } finally {
    release();
  }
});

test("a guard released while the move is undone lets it complete without asking (#3218)", () => {
  const { browser, store } = storeOnHistory("/settings/appearance", "/settings/orchestrator");
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  browser.back();
  release();
  browser.flush();
  assert.equal(asked.length, 0);
  assert.deepEqual(store.getState().view, { name: "settings", section: "appearance" });
  assert.equal(browser.path, "/settings/appearance");
});

test("an entry written before positions were recorded is left at once, as before (#3218)", () => {
  const browser = new TestBrowserHistory("/usage");
  browser.window.history.pushState(null, "", "/settings/orchestrator");
  const navigation = new BrowserNavigation(browser.window);
  const store = new Store(navigation.current(), (view) => navigation.push(view));
  navigation.listen((view, traversal) => store.navigateFromHistory(view, traversal));
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  try {
    browser.back();
    browser.flush();
    assert.equal(asked.length, 0, "the distance to an unrecorded entry is unknown");
    assert.deepEqual(store.getState().view, { name: "usage" });
  } finally {
    release();
  }
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
  assert.equal(parseInboxSplitRatio("not-a-number"), 0.45);
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
    splitRatio: 0.45,
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

test("board Machine and Agent filters persist per instance and survive a reload", () => {
  const backing = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
    removeItem: (key) => void backing.delete(key),
  };

  const store = new Store({ name: "board" }, undefined, "instance-1", storage);
  assert.deepEqual(store.getState().filters, { runnerId: null, agentId: null });
  store.setFilters({ runnerId: "runner-1" });
  store.setFilters({ agentId: "agent-1" });

  const reloaded = new Store({ name: "board" }, undefined, "instance-1", storage);
  assert.deepEqual(reloaded.getState().filters, { runnerId: "runner-1", agentId: "agent-1" },
    "a reload must not silently widen the board back to every machine");

  const otherInstance = new Store({ name: "board" }, undefined, "instance-2", storage);
  assert.deepEqual(otherInstance.getState().filters, { runnerId: null, agentId: null },
    "instances do not share board filters");

  saveInstanceStorageValue(SESSIONS_FILTERS_KEY, "not json", "instance-1", storage);
  assert.deepEqual(loadSessionFilters("instance-1", storage), { runnerId: null, agentId: null },
    "a corrupt stored value falls back to unfiltered");
  assert.deepEqual(parseSessionFilters(JSON.stringify({ runnerId: 7, agentId: "" })),
    { runnerId: null, agentId: null }, "non-string and empty ids are rejected shapes");
});
