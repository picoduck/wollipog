import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absoluteViewUrl,
  BrowserNavigation,
  decodeResourceId,
  encodeResourceId,
  isolatedNotificationNavigationHandler,
  legacyViewFromFragment,
  replaceIsolatedShareWithDashboard,
  sameView,
  viewFromPath,
  viewFromNotificationMessage,
  viewPath,
  type View,
  GLOBAL_VIEW_ITEMS,
} from "./navigation.js";

const routes: Array<[View, string]> = [
  [{ name: "inbox" }, "/"],
  [{ name: "board" }, "/board"],
  [{ name: "runners", section: "machines" }, "/connections/machines"],
  [{ name: "runners", section: "instances" }, "/connections/instances"],
  [{ name: "runners", section: "people" }, "/connections/people"],
  [{ name: "runs" }, "/runs"],
  [{ name: "pods" }, "/pods"],
  [{ name: "automations" }, "/automations"],
  [{ name: "usage" }, "/usage"],
  [{ name: "projects" }, "/projects"],
  [{ name: "projects", id: "project / unicode ✅" }, `/projects/~${encodeResourceId("project / unicode ✅")}`],
  ...["space / unicode ✅ %?#", ".", "..", "foo.txt", "a/../foo.txt", "~already-marked"].map(
    (id): [View, string] => [{ name: "session", id }, `/sessions/~${encodeResourceId(id)}`],
  ),
  [{ name: "run", id: "run_abc" }, `/runs/~${encodeResourceId("run_abc")}`],
  [{ name: "pod", id: "pod_abc" }, `/pods/~${encodeResourceId("pod_abc")}`],
];

test("every dashboard view has a canonical round-tripping path", () => {
  for (const [view, path] of routes) {
    assert.equal(viewPath(view), path);
    assert.deepEqual(viewFromPath(path), view);
    assert.deepEqual(viewFromPath(`${path}/`), view);
  }
  assert.deepEqual(viewFromPath("/INDEX.HTML"), { name: "inbox" });
  assert.deepEqual(viewFromPath("/inbox"), { name: "inbox" }, "legacy inbox bookmarks remain valid");
  assert.deepEqual(
    viewFromPath("/runners"),
    { name: "runners", section: "machines" },
    "legacy runner bookmarks remain valid",
  );
});

test("global destinations use the polished Connections vocabulary everywhere", () => {
  assert.deepEqual(GLOBAL_VIEW_ITEMS[0], {
    name: "inbox",
    label: "Inbox",
    title: "Inbox",
    paletteLabel: "Inbox",
  });
  assert.deepEqual(GLOBAL_VIEW_ITEMS[1], {
    name: "projects",
    label: "Projects",
    title: "Projects",
    paletteLabel: "Projects",
  });
  const connections = GLOBAL_VIEW_ITEMS.find((item) => item.name === "runners");
  assert.deepEqual(connections, {
    name: "runners",
    label: "Connections",
    title: "Connections",
    paletteLabel: "Connections",
  });
  assert.equal(GLOBAL_VIEW_ITEMS.some((item) => /runner/i.test(`${item.label} ${item.title} ${item.paletteLabel}`)), false);
});

test("route parser rejects unknown, ambiguous, malformed, empty, and oversized resource paths", () => {
  for (const path of [
    "/unknown", "/sessions", "/sessions/a", "/sessions/~a/b", "/sessions/~%zz", "/sessions/~IA",
    `/sessions/~${encodeResourceId("a".repeat(257))}`, "/api/sessions/~cwBfADEA",
  ]) assert.equal(viewFromPath(path), null, path);
  assert.deepEqual(viewFromPath(`/sessions/~${encodeResourceId("a".repeat(256))}`), { name: "session", id: "a".repeat(256) });
});

test("source deep links round-trip canonical file, line, column, and symbol locations", () => {
  const view: View = {
    name: "session",
    id: "session / unicode ✅",
    location: { path: "src/components/App view.tsx", line: 42, column: 7, symbol: "render App" },
  };
  const path = viewPath(view);
  assert.match(path, /^\/sessions\/~[A-Za-z0-9_-]+\/files\/~[A-Za-z0-9_-]+\?line=42&column=7&symbol=render\+App$/);
  const url = new URL(path, "https://manager.example.test");
  assert.deepEqual(viewFromPath(url.pathname, url.search), view);
  assert.deepEqual(viewFromPath(`${url.pathname}/`, url.search), view);
  assert.equal(
    absoluteViewUrl("https://manager.example.test/old?token=secret", view),
    `https://manager.example.test${path}`,
  );
});

test("source deep links reject traversal, malformed coordinates, duplicate/unknown query keys, and oversize", () => {
  const session = encodeResourceId("s1");
  const fileRoute = (path: string) => `/sessions/~${session}/files/~${encodeResourceId(path)}`;
  for (const [path, search] of [
    [fileRoute("../secret"), ""],
    [fileRoute("a.ts"), "?line=0"],
    [fileRoute("a.ts"), "?line=01"],
    [fileRoute("a.ts"), "?column=2"],
    [fileRoute("a.ts"), "?line=2&line=3"],
    [fileRoute("a.ts"), "?unknown=1"],
    [fileRoute("a.ts"), "?symbol="],
    [fileRoute("a".repeat(4097)), ""],
  ] as const) assert.equal(viewFromPath(path, search), null, `${path}${search}`);
});

test("source routes normalize backslash wire paths to one canonical slash URL", () => {
  const session = encodeResourceId("s1");
  const raw = `/sessions/~${session}/files/~${encodeResourceId("src\\App.tsx")}`;
  const parsed = viewFromPath(raw);
  assert.deepEqual(parsed, { name: "session", id: "s1", location: { path: "src/App.tsx" } });
  assert.notEqual(viewPath(parsed!), raw);
  assert.deepEqual(viewFromPath(viewPath(parsed!)), parsed);
});

test("view comparison includes resource identity", () => {
  assert.equal(sameView({ name: "board" }, { name: "board" }), true);
  assert.equal(sameView({ name: "session", id: "s1" }, { name: "session", id: "s1" }), true);
  assert.equal(sameView({ name: "session", id: "s1" }, { name: "session", id: "s2" }), false);
  assert.equal(sameView(
    { name: "session", id: "s1", location: { path: "a.ts", line: 1 } },
    { name: "session", id: "s1", location: { path: "a.ts", line: 2 } },
  ), false);
  assert.equal(sameView(
    { name: "session", id: "s1", location: { path: "a.ts", line: 1 } },
    { name: "session", id: "s1", location: { path: "a.ts", line: 1 } },
  ), true);
  assert.equal(sameView({ name: "runs" }, { name: "run", id: "r1" }), false);
});

test("legacy push fragments migrate only known bounded destinations", () => {
  assert.deepEqual(legacyViewFromFragment("#open=s_abc-123"), { name: "session", id: "s_abc-123" });
  assert.deepEqual(legacyViewFromFragment("#open=space%20%2F%20unicode%20%E2%9C%85"), {
    name: "session", id: "space / unicode ✅",
  });
  assert.deepEqual(legacyViewFromFragment("#view=automations"), { name: "automations" });
  assert.equal(legacyViewFromFragment("#open=%zz"), null);
  assert.equal(legacyViewFromFragment(`#open=${"a".repeat(257)}`), null);
  assert.equal(legacyViewFromFragment("#pair=secret"), null);
});

test("notification messages navigate both dashboard and isolated-share windows canonically", () => {
  assert.deepEqual(viewFromNotificationMessage({ type: "mam:open-session", sessionId: "a/../foo.txt" }), {
    name: "session", id: "a/../foo.txt",
  });
  assert.deepEqual(viewFromNotificationMessage({ type: "wollipog:open-session", sessionId: "new/session" }), {
    name: "session", id: "new/session",
  });
  assert.deepEqual(viewFromNotificationMessage({ type: "mam:open-automations" }), { name: "automations" });
  assert.deepEqual(viewFromNotificationMessage({ type: "wollipog:open-automations" }), { name: "automations" });
  assert.equal(viewFromNotificationMessage({ type: "mam:open-session", sessionId: "" }), null);
  assert.equal(viewFromNotificationMessage({ type: "mam:open-session", sessionId: "a".repeat(257) }), null);

  const navigated: string[] = [];
  const handleShareMessage = isolatedNotificationNavigationHandler((path) => navigated.push(path));
  handleShareMessage({ data: { type: "mam:open-session", sessionId: "a/../foo.txt" } });
  handleShareMessage({ data: { type: "wollipog:open-automations" } });
  assert.deepEqual(navigated, [
    `/sessions/~${encodeResourceId("a/../foo.txt")}`,
    "/automations",
  ]);

  const operations: Array<["scrub" | "replace", unknown]> = [];
  replaceIsolatedShareWithDashboard({
    history: {
      replaceState(state: unknown, _unused: string, path?: string | URL | null) {
        operations.push(["scrub", [state, String(path)]]);
      },
    } as History,
    location: {
      pathname: "/", search: "", replace(path: string | URL) { operations.push(["replace", String(path)]); },
    } as Location,
  }, navigated[0]!);
  assert.deepEqual(operations, [
    ["scrub", [null, "/"]],
    ["replace", `/sessions/~${encodeResourceId("a/../foo.txt")}`],
  ], "the isolated capability entry is replaced, so Back cannot BFCache-restore its React tree");
});

test("internal links retain the current trusted origin without credentials", () => {
  assert.equal(
    absoluteViewUrl("https://manager.example.test:4317/old?token=bad#fragment", { name: "session", id: "s_1" }),
    "https://manager.example.test:4317/sessions/~cwBfADEA",
  );
});

test("browser history canonicalizes once, preserves state, and never pushes during popstate", () => {
  const listeners = new Set<() => void>();
  const writes: Array<{ kind: "push" | "replace"; state: unknown; path: string }> = [];
  const location = { pathname: `/sessions/~${encodeResourceId("space id")}/`, search: "?stale=1", hash: "#old" };
  const history = {
    state: { retained: true },
    pushState(state: unknown, _unused: string, path: string | URL | null) {
      writes.push({ kind: "push", state, path: String(path) });
      const url = new URL(String(path), "https://manager.example.test");
      location.pathname = url.pathname;
      location.search = url.search; location.hash = "";
    },
    replaceState(state: unknown, _unused: string, path: string | URL | null) {
      writes.push({ kind: "replace", state, path: String(path) });
      const url = new URL(String(path), "https://manager.example.test");
      location.pathname = url.pathname;
      location.search = url.search; location.hash = "";
    },
  };
  const target = {
    location,
    history,
    addEventListener(_type: "popstate", listener: () => void) { listeners.add(listener); },
    removeEventListener(_type: "popstate", listener: () => void) { listeners.delete(listener); },
  };
  const navigation = new BrowserNavigation(target);
  assert.deepEqual(navigation.current(), { name: "session", id: "space id" });
  assert.deepEqual(writes, [{ kind: "replace", state: { retained: true }, path: `/sessions/~${encodeResourceId("space id")}` }]);

  navigation.push({ name: "automations" });
  assert.deepEqual(writes.at(-1), { kind: "push", state: { retained: true }, path: "/automations" });
  navigation.push({ name: "automations" });
  assert.equal(writes.length, 2, "same-target navigation is inert");

  const sourceView: View = { name: "session", id: "space id", location: { path: "src/a.ts", line: 9 } };
  navigation.push(sourceView);
  assert.deepEqual(writes.at(-1), { kind: "push", state: { retained: true }, path: viewPath(sourceView) });
  assert.equal(location.search, "?line=9");

  const seen: View[] = [];
  const stop = navigation.listen((view) => seen.push(view));
  location.pathname = `/pods/~${encodeResourceId("pod_1")}`;
  location.search = "";
  for (const listener of listeners) listener();
  assert.deepEqual(seen, [{ name: "pod", id: "pod_1" }]);
  assert.equal(writes.length, 3, "popstate parsing does not push a new entry");
  stop();
  assert.equal(listeners.size, 0);
});

test("unknown browser routes fall back to the canonical Inbox home", () => {
  const writes: string[] = [];
  const target = {
    location: { pathname: "/not-a-route", search: "", hash: "" },
    history: {
      state: null,
      pushState() {},
      replaceState(_state: unknown, _unused: string, path: string | URL | null) { writes.push(String(path)); },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  assert.deepEqual(new BrowserNavigation(target).current(), { name: "inbox" });
  assert.deepEqual(writes, ["/"]);
});

test("resource codec is canonical exact UTF-16LE base64url and rejects invalid encodings", () => {
  assert.equal(encodeResourceId("abc"), "YQBiAGMA");
  assert.equal(encodeResourceId("."), "LgA");
  assert.equal(encodeResourceId(".."), "LgAuAA");
  assert.equal(encodeResourceId("foo.txt"), "ZgBvAG8ALgB0AHgAdAA");
  for (const id of ["a/../foo.txt", "space / unicode ✅ %?#", "~already-marked"]) {
    assert.equal(decodeResourceId(encodeResourceId(id)), id);
  }
  assert.equal(decodeResourceId(encodeResourceId("\ud800")), "\ud800");
  for (const encoded of ["", "=", "YQ==", "YQ", "IA", "_w", "YWJj."]) assert.equal(decodeResourceId(encoded), null);
});
