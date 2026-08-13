import assert from "node:assert/strict";
import { test } from "node:test";
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
