import assert from "node:assert/strict";
import { test } from "node:test";
import { pushPositionedEntry, type HistoryTraversal } from "./history-position.js";
import { TestBrowserHistory } from "./test-browser-history.js";
import { registerLeaveGuard } from "./leave-guard.js";
import {
  DesktopInstanceNavigation,
  instanceRouteFromPath,
  instanceViewPath,
  loadLastInstanceView,
} from "./instance-navigation.js";

test("instances without a saved route start in Inbox", () => {
  assert.deepEqual(loadLastInstanceView("never-saved-instance"), { name: "inbox" });
});

test("desktop instance routes keep identical resources unambiguous", () => {
  const local = instanceViewPath("local", { name: "session", id: "same/session" });
  const remote = instanceViewPath("remote-a", { name: "session", id: "same/session" });
  assert.notEqual(local, remote);
  assert.deepEqual(instanceRouteFromPath(new URL(local, "https://app.local").pathname), {
    instanceId: "local",
    view: { name: "session", id: "same/session" },
  });
  assert.deepEqual(instanceRouteFromPath(new URL(remote, "https://app.local").pathname), {
    instanceId: "remote-a",
    view: { name: "session", id: "same/session" },
  });
});

test("desktop navigation wraps legacy routes and ignores another profile's history entry", () => {
  const listeners = new Set<() => void>();
  const location = { pathname: "/runs", search: "", hash: "" };
  const writes: Array<["push" | "replace", string]> = [];
  const write = (kind: "push" | "replace", path: string | URL | null | undefined) => {
    // A replace without a URL records only the entry's position (#3218) and keeps its address.
    if (path == null) return;
    const url = new URL(String(path), "https://tauri.localhost");
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
    writes.push([kind, `${url.pathname}${url.search}`]);
  };
  const target = {
    location,
    history: {
      state: { retained: true },
      pushState(_state: unknown, _unused: string, path?: string | URL | null) { write("push", path); },
      replaceState(_state: unknown, _unused: string, path?: string | URL | null) { write("replace", path); },
    },
    addEventListener(_type: "popstate", listener: () => void) { listeners.add(listener); },
    removeEventListener(_type: "popstate", listener: () => void) { listeners.delete(listener); },
  };
  const activated: Array<{ instanceId: string; view: unknown }> = [];
  const navigation = new DesktopInstanceNavigation("remote-a", target, (instanceId, view) => {
    activated.push({ instanceId, view });
  });
  assert.deepEqual(navigation.current(), { name: "runs" });
  assert.equal(writes[0]?.[0], "replace");
  assert.deepEqual(instanceRouteFromPath(location.pathname), {
    instanceId: "remote-a",
    view: { name: "runs" },
  });

  const seen: unknown[] = [];
  const unlisten = navigation.listen((view) => seen.push(view));
  const other = new URL(instanceViewPath("remote-b", { name: "board" }), "https://tauri.localhost");
  location.pathname = other.pathname;
  for (const listener of listeners) listener();
  assert.deepEqual(seen, []);

  const own = new URL(instanceViewPath("remote-a", { name: "runners", section: "instances" }), "https://tauri.localhost");
  location.pathname = own.pathname;
  for (const listener of listeners) listener();
  assert.deepEqual(seen, [{ name: "runners", section: "instances" }]);
  navigation.activate({ name: "session", id: "same" });
  assert.deepEqual(activated, [{ instanceId: "remote-a", view: { name: "session", id: "same" } }]);
  unlisten();
});

test("instance routes round-trip query-bearing views and reject malformed or noncanonical input", () => {
  const scopedView = {
    name: "session" as const,
    id: "session-1",
    location: { path: "src/example.ts", line: 30 },
  };
  const path = instanceViewPath("profile/with space", scopedView);
  const url = new URL(path, "https://app.local");
  assert.deepEqual(instanceRouteFromPath(url.pathname, url.search), {
    instanceId: "profile/with space",
    view: scopedView,
  });
  for (const invalid of [
    "/sessions/~abc",
    "/instances/~",
    "/instances/~not-base64/sessions/~abc",
    `${url.pathname}?line=30&extra=1`,
  ]) {
    const parsed = new URL(invalid, "https://app.local");
    assert.equal(instanceRouteFromPath(parsed.pathname, parsed.search), null, invalid);
  }
});

test("an instance's old Settings address opens its new view and replaces its own entry (#3023)", () => {
  const encoded = instanceViewPath("remote-a", { name: "inbox" }).replace(/\/$/, "");
  const behavior = { name: "settings", section: "behavior" } as const;
  const keyboard = { ...behavior, focus: { target: "keyboard-shortcuts" } };
  assert.deepEqual(instanceRouteFromPath(`${encoded}/settings/keyboard`), { instanceId: "remote-a", view: keyboard });
  assert.deepEqual(instanceRouteFromPath(`${encoded}/settings/session-naming`), { instanceId: "remote-a", view: behavior });
  // Only the alias itself: a query or a noncanonical instance encoding is still refused.
  assert.equal(instanceRouteFromPath(`${encoded}/settings/keyboard`, "?x=1"), null);
  assert.equal(instanceRouteFromPath(`${encoded}=/settings/keyboard`), null);

  const listeners = new Set<() => void>();
  const location = { pathname: `${encoded}/settings/keyboard`, search: "", hash: "" };
  const writes: string[] = [];
  const target = {
    location,
    history: {
      state: null,
      pushState() {},
      replaceState(_state: unknown, _unused: string, path?: string | URL | null) {
        if (path == null) return;
        const url = new URL(String(path), "https://app.local");
        location.pathname = url.pathname;
        location.search = url.search;
        writes.push(`${url.pathname}${url.search}`);
      },
    },
    addEventListener(_type: "popstate", listener: () => void) { listeners.add(listener); },
    removeEventListener(_type: "popstate", listener: () => void) { listeners.delete(listener); },
  };
  const navigation = new DesktopInstanceNavigation("remote-a", target);
  assert.deepEqual(navigation.current(), keyboard);
  assert.deepEqual(writes, [instanceViewPath("remote-a", behavior)], "the alias replaces its own entry");

  // Back onto an entry recorded before the fold: the view keeps its focus target, and the entry is replaced.
  const seen: unknown[] = [];
  navigation.listen((view) => seen.push(view));
  location.pathname = `${encoded}/settings/keyboard`;
  for (const listener of listeners) listener();
  assert.deepEqual(seen, [keyboard]);
  assert.deepEqual(writes, [instanceViewPath("remote-a", behavior), instanceViewPath("remote-a", behavior)]);
});

test("an instance's replace takes the current entry's place, so Back skips the route it corrected (#2984)", () => {
  const browser = new TestBrowserHistory(instanceViewPath("remote-a", { name: "usage" }));
  const navigation = new DesktopInstanceNavigation("remote-a", browser.window);
  navigation.current();
  navigation.push({ name: "runners", section: "instances" });
  navigation.replace({ name: "runners", section: "machines" });
  assert.deepEqual(browser.paths(), [
    instanceViewPath("remote-a", { name: "usage" }),
    instanceViewPath("remote-a", { name: "runners", section: "machines" }),
  ]);
});

test("an instance's own Back is offered for holding, and its return to the editor is not delivered (#3218)", () => {
  const browser = new TestBrowserHistory(instanceViewPath("remote-a", { name: "usage" }));
  const navigation = new DesktopInstanceNavigation("remote-a", browser.window);
  navigation.current();
  navigation.push({ name: "settings", section: "orchestrator" });
  const seen: Array<{ view: unknown; traversal?: HistoryTraversal }> = [];
  navigation.listen((view, traversal) => seen.push({ view, traversal }));

  browser.back();
  assert.deepEqual(seen.map((move) => move.view), [{ name: "usage" }]);
  const traversal = seen[0]!.traversal!;
  assert.ok(traversal, "a move within the instance's recorded entries can be held");
  let returned = 0;
  traversal.undo(() => { returned += 1; });
  browser.flush();
  assert.equal(returned, 1);
  assert.equal(browser.path, instanceViewPath("remote-a", { name: "settings", section: "orchestrator" }));
  assert.equal(seen.length, 1, "the return to the editor's entry is not a move to show");

  traversal.redo();
  browser.flush();
  assert.deepEqual(seen.map((move) => move.view), [{ name: "usage" }, { name: "usage" }]);
  assert.equal(browser.index, 0);
});

test("a Back to another instance's entry is held by the open instance's editor before it opens (#3218)", () => {
  const browser = new TestBrowserHistory(instanceViewPath("remote-a", { name: "usage" }));
  const first = new DesktopInstanceNavigation("remote-a", browser.window);
  first.current();
  first.push({ name: "runs" });
  const navigation = new DesktopInstanceNavigation("remote-b", browser.window);
  pushPositionedEntry(browser.window.history, instanceViewPath("remote-b", { name: "settings", section: "orchestrator" }));
  navigation.current();
  // Positions written by the first instance continue: the second's entry sits one past them.
  assert.equal((browser.window.history.state as { wollipogEntry: { index: number } }).wollipogEntry.index, 2);
  const seen: unknown[] = [];
  navigation.listen((view) => seen.push(view));
  const asked: Array<() => void> = [];
  const release = registerLeaveGuard((leave) => asked.push(leave));
  // What InstanceProvider's popstate listener does: open the other instance unless this one holds.
  const opened: string[] = [];
  const onPopState = () => {
    const route = instanceRouteFromPath(browser.window.location.pathname);
    if (route && route.instanceId !== "remote-b" && !navigation.holdDeparture()) opened.push(route.instanceId);
  };
  browser.window.addEventListener("popstate", onPopState);
  try {
    browser.back();
    assert.deepEqual(opened, [], "not opened while the editor asks");
    browser.flush();
    assert.equal(asked.length, 1);
    assert.equal(browser.path, instanceViewPath("remote-b", { name: "settings", section: "orchestrator" }));
    assert.deepEqual(seen, [], "the return is not a move for this instance's store");

    asked[0]!();
    browser.flush();
    assert.deepEqual(opened, ["remote-a"], "Discard opens the other instance's entry once");
    assert.equal(browser.path, instanceViewPath("remote-a", { name: "runs" }));
  } finally {
    release();
    browser.window.removeEventListener("popstate", onPopState);
  }
});
