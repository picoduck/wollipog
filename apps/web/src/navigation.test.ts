import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { titleCaseLabel } from "./format.js";
import { projectArchiveMessage, projectArchiveResultMessage, projectArchiveWithoutUndoMessage } from "./project-actions.js";
import { sessionLifecycleDescription, statusValues } from "./status-meta.js";
import {
  absoluteViewUrl,
  backLabel,
  BrowserNavigation,
  destination,
  viewTitle,
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
  SETTINGS_SECTIONS,
} from "./navigation.js";

const routes: Array<[View, string]> = [
  [{ name: "inbox" }, "/"],
  [{ name: "archived" }, "/archived"],
  [{ name: "board" }, "/board"],
  [{ name: "runners", section: "machines" }, "/connections/machines"],
  [{ name: "runners", section: "instances" }, "/connections/instances"],
  [{ name: "runners", section: "people" }, "/connections/people"],
  [{ name: "runs" }, "/runs"],
  [{ name: "pods" }, "/pods"],
  [{ name: "automations" }, "/automations"],
  [{ name: "skills" }, "/skills"],
  [{ name: "skills", id: "skill_abc" }, `/skills/~${encodeResourceId("skill_abc")}`],
  [{ name: "skills", pane: "orphans" }, "/skills/orphans"],
  [{ name: "skills", pane: "overview" }, "/skills/overview"],
  [{ name: "usage" }, "/usage"],
  [{ name: "projects" }, "/projects"],
  [{ name: "projects", id: "project / unicode ✅" }, `/projects/~${encodeResourceId("project / unicode ✅")}`],
  ...["space / unicode ✅ %?#", ".", "..", "foo.txt", "a/../foo.txt", "~already-marked"].map(
    (id): [View, string] => [{ name: "session", id }, `/sessions/~${encodeResourceId(id)}`],
  ),
  [{ name: "run", id: "run_abc" }, `/runs/~${encodeResourceId("run_abc")}`],
  [{ name: "pod", id: "pod_abc" }, `/pods/~${encodeResourceId("pod_abc")}`],
];

test("attention routes retain exact opaque request identity and epoch through reload", () => {
  for (const requestId of [undefined, "child / ..? # % ✅", "\u0000request"]) {
    const view: View = { name: "session", id: "session / ✅",
      attention: { eventEpoch: 4, ...(requestId === undefined ? {} : { requestId }) } };
    const url = new URL(viewPath(view), "http://localhost");
    assert.deepEqual(viewFromPath(url.pathname, url.search), view);
    assert.equal(sameView(view, { ...view, attention: { eventEpoch: 5, requestId } }), false);
  }
  const path = `/sessions/~${encodeResourceId("s")}/attention/~${encodeResourceId("request")}`;
  for (const query of ["", "?epoch=-1", "?epoch=01", "?epoch=1.5", "?epoch=Infinity",
    "?epoch=9007199254740992", "?epoch=0&epoch=1", "?epoch=0&request=other"]) {
    assert.equal(viewFromPath(path, query), null);
  }
  assert.equal(viewFromPath(`/sessions/~${encodeResourceId("s")}/attention/~!`, "?epoch=0"), null);
});

test("Agent Skills panes have their own routes, and a skill id wins over a pane", () => {
  // Existing links keep their meaning (#1947): the bare route and a skill deep link.
  assert.deepEqual(viewFromPath("/skills"), { name: "skills" });
  assert.deepEqual(viewFromPath(`/skills/~${encodeResourceId("orphans")}`), { name: "skills", id: "orphans" },
    "a skill named like a pane is still a skill");
  assert.equal(viewPath({ name: "skills", id: "skill_abc", pane: "orphans" }), `/skills/~${encodeResourceId("skill_abc")}`);
  assert.equal(viewFromPath("/skills/unknown"), null);
  assert.equal(viewFromPath("/skills/Orphans"), null);
  assert.equal(sameView({ name: "skills", pane: "orphans" }, { name: "skills" }), false, "Back can leave the pane");
});

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

test("every destination has one name, in the §4.1 order", () => {
  // The internal id stays "inbox" (and "runners") so saved preferences and the "/" route survive
  // the visible renames to Sessions (#499) and Connections.
  assert.deepEqual(GLOBAL_VIEW_ITEMS.map((item) => [item.id, item.name, item.group]), [
    ["inbox", "Sessions", "work"],
    ["automations", "Automations", "work"],
    ["projects", "Projects", "work"],
    ["runs", "Multi-Agent Runs", "oversight"],
    ["pods", "Pods", "oversight"],
    ["runners", "Connections", "oversight"],
    ["skills", "Agent Skills", "oversight"],
    ["archived", "Archived Sessions", "records"],
    ["usage", "Usage and Cost", "records"],
  ]);
  for (const item of GLOBAL_VIEW_ITEMS) {
    // One field, not a short label, a long title and a palette label that drift apart.
    assert.deepEqual(Object.keys(item).filter((key) => !["id", "name", "description", "group"].includes(key)), [], item.id);
    assert.doesNotMatch(item.name, /&/, `${item.id} spells "and" out`);
    assert.doesNotMatch(item.name, /runner|inbox/i, item.id);
    assert.equal(item.name, titleCaseLabel(item.name), `${item.name} is Title Case`);
  }
  assert.equal(destination("pods").name, "Pods");
  assert.equal(backLabel("runs"), "Back to Multi-Agent Runs");
  assert.equal(backLabel("inbox"), "Back to Sessions");
});

/** docs/design-system.md §17.2: system nouns the UI no longer uses. */
const RETIRED_TERMS = [
  "control plane",
  "control-plane",
  "runtime capacity",
  "durable",
  "snapshot",
  "projection",
  "runner protocol",
  "reminder parser",
  "pnpm dev",
  "content-free",
];

test("page descriptions are one short sentence in user terms", () => {
  assert.deepEqual(
    Object.fromEntries(GLOBAL_VIEW_ITEMS.map((item) => [item.id, item.description])),
    {
      inbox: undefined,
      automations: "Run a prompt on a schedule, from a webhook, or from a chat message.",
      projects: "Group related sessions and choose the folders where they run.",
      runs: "Give one task to several agents and compare what each one does.",
      pods: "Agents that share notes and a worktree while they work toward one objective.",
      runners: undefined,
      skills: "Write a skill once, then choose which machines and agents get it.",
      archived: undefined,
      usage: "What your agents spent, by day, agent and project.",
    },
  );
  for (const item of GLOBAL_VIEW_ITEMS) {
    if (item.description === undefined) continue;
    assert.ok(item.description.length <= 80, `${item.name}: ${item.description.length} characters`);
    // Sentence case: one capital to start, a full stop to end, and no Title Case run after it.
    assert.match(item.description, /^[A-Z][^A-Z]*\.$/u, `${item.name} is one sentence-case line`);
    for (const term of RETIRED_TERMS) {
      assert.ok(!item.description.toLowerCase().includes(term), `${item.name} uses the retired term "${term}"`);
    }
  }
});

test("an entity page is titled by its entity once it has loaded", () => {
  assert.equal(viewTitle({ name: "run", id: "run-1" }, "Compare Retry Strategies"), "Compare Retry Strategies");
  assert.equal(viewTitle({ name: "pod", id: "pod-1" }, "Release Train"), "Release Train");
  // The generic noun is only the loading fallback.
  assert.equal(viewTitle({ name: "run", id: "run-1" }), "Multi-Agent Run");
  assert.equal(viewTitle({ name: "pod", id: "pod-1" }), "Pod");
  assert.equal(viewTitle({ name: "pod", id: "pod-1" }, ""), "Pod");
  assert.equal(viewTitle({ name: "session", id: "s-1" }), "Session");
});

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("a Project's bulk-archive confirmations and results use no retired terms (#2279)", () => {
  const confirmations = [1, 3].flatMap((count) => [true, false].flatMap((stops) => [true, false].map((onProjectPage) =>
    ({ stops, text: projectArchiveMessage({ projectName: "Payments Service", count, stops, onProjectPage }) }))));
  const outcomes: Array<[number, number, number]> = [[0, 0, 0], [1, 0, 0], [3, 0, 0], [1, 1, 0], [1, 3, 0], [1, 0, 1], [0, 0, 3], [1, 2, 2]];
  const results = outcomes.map(
    ([archived, pending, failed]) => projectArchiveResultMessage("Payments Service", { archived, pending, failed }));
  const texts = [...confirmations.map(({ text }) => text), ...results, projectArchiveWithoutUndoMessage("Payments Service")];
  for (const text of texts) {
    for (const term of RETIRED_TERMS) assert.ok(!text.toLowerCase().includes(term), `"${text}" uses the retired term "${term}"`);
    // Snooze is the single-session confirmation's secondary action, never a sentence (#2162).
    assert.doesNotMatch(text, /snooze/i);
  }
  for (const { stops, text } of confirmations) {
    if (stops) assert.match(text, /queued messages are canceled/);
    assert.doesNotMatch(text, /queued work/);
  }
  // The copy lives in those helpers only: neither surface keeps a copy of its own.
  for (const path of ["./components/ProjectSplitMenu.tsx", "./components/ProjectsView.tsx", "./project-actions.ts"]) {
    assert.doesNotMatch(source(path), /runtime capacity|queued work|Snooze instead|Exact undo/i, path);
  }
});

/**
 * Every string a source file could show: string and template literals and JSX text. Comments and
 * identifiers are not nodes here, so they are never read, and neither are module specifiers. The
 * rest is read whole, a superset of the visible copy, so a retired term in a value that is never
 * shown fails as well.
 */
function sourceStrings(fileName: string, text: string): string[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const strings: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isImportDeclaration(node) && node.importClause) visit(node.importClause);
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      strings.push(node.text);
    } else if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
      strings.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return strings;
}

function retiredTermsIn(text: string): string[] {
  return RETIRED_TERMS.filter((term) => text.toLowerCase().includes(term));
}

test("the source-string scan reads literals and JSX text, not comments, identifiers or imports", () => {
  const strings = sourceStrings("fixture.tsx", `
    import { snapshotLoaded } from "./durable-snapshot.js";
    // The control plane holds runtime capacity.
    const durable = snapshotLoaded ? "Saved" : \`Runtime capacity: \${count}\`;
    export const Note = () => <p title="Projection">Update the control plane.</p>;
  `);
  assert.deepEqual(strings.flatMap(retiredTermsIn), ["runtime capacity", "projection", "control plane"]);
});

test("session status details and the Projects page use no retired terms (#2334)", () => {
  for (const value of statusValues("session")) {
    const description = sessionLifecycleDescription(value);
    assert.deepEqual(retiredTermsIn(description), [], `${value}: "${description}"`);
  }
  // A Stop that has not landed leaves the session as it was: say so in the person's terms.
  for (const value of ["stop_waiting_for_runner", "stop_failed"] as const) {
    assert.match(sessionLifecycleDescription(value), /, so the session may still be running\.$/, value);
  }
  for (const path of ["./status-meta.ts", "./components/ProjectsView.tsx"]) {
    const failures = sourceStrings(path, source(path)).flatMap((text) =>
      retiredTermsIn(text).map((term) => `"${text.trim()}" uses the retired term "${term}"`));
    assert.deepEqual(failures, [], path);
  }
});

test("the composer's refusals, action errors and queued rows never say control plane (#2511)", () => {
  for (const path of [
    "./conversation-steering.ts",
    "./composer-action-errors.ts",
    "./components/QueuedMessages.tsx",
    "./components/PendingPromptBubbles.tsx",
    "./components/SteeringReceipts.tsx",
  ]) {
    const failures = sourceStrings(path, source(path)).filter((text) => /control.plane/iu.test(text));
    assert.deepEqual(failures, [], path);
  }
});

test("every surface that names a destination reads the registry's one name", () => {
  // The rail's accessible name and tooltip, its More sheet, the palette, the shortcut reference
  // and the Settings › Navigation rows each render `name`. A second field would let them drift
  // apart again, which is what put "Multi-Agent" in the rail and "Multi-Agent Runs" in the title.
  const consumers: ReadonlyArray<[string, RegExp[]]> = [
    ["./components/Rail.tsx", [
      /aria-label=\{item\.name\}\s*aria-describedby=\{attention \? descriptionId : undefined\}\s*aria-keyshortcuts/,
      /data-rail-tip=\{isMobile \? undefined : item\.name\}/,
      /className=\{`menu-item\$\{selected === item\.id \? " is-active" : ""\}`\}\s*aria-label=\{item\.name\}/,
      /<span className="menu-text">\{item\.name\}<\/span>/,
    ]],
    ["./components/CommandPalette.tsx", [/label: item\.name,/]],
    ["./components/SettingsView.tsx", [/const item = destination\(name\);/, /\{item\.name\}/]],
    ["./shortcuts.ts", [/label: item\.name,/]],
    ["./experiments.ts", [/const multiAgentName = destination\("runs"\)\.name;/, /const podsName = destination\("pods"\)\.name;/]],
  ];
  for (const [path, patterns] of consumers) {
    const text = source(path);
    for (const pattern of patterns) assert.match(text, pattern, `${path} must read the destination name`);
    assert.doesNotMatch(text, /\bitem\.(label|title|paletteLabel)\b/, `${path} reads a retired field`);
  }
  // Each destination's own page header reads its title (and description) from the registry.
  const headers: ReadonlyArray<[string, string]> = [
    ["./components/AutomationsView.tsx", "automations"],
    ["./components/ProjectsView.tsx", "projects"],
    ["./components/RunsView.tsx", "runs"],
    ["./components/PodsView.tsx", "pods"],
    ["./components/RunnersView.tsx", "runners"],
    ["./components/SkillsView.tsx", "skills"],
    ["./components/ArchivedSessionsView.tsx", "archived"],
    ["./components/UsageView.tsx", "usage"],
  ];
  for (const [path, id] of headers) {
    const text = source(path);
    // The registry entry, called directly or through a local bound to it (`const PROJECTS = …`).
    const aliases = [...text.matchAll(new RegExp(`const (\\w+) = destination\\("${id}"\\);`, "g"))].map((match) => match[1]!);
    const entry = `(?:destination\\("${id}"\\)|${[...aliases, "__none__"].join("|")})`;
    const headerTags = [...text.matchAll(/<PageHeader\b[\s\S]*?\/?>(?=\s*[\n{<)])/g)].map((match) => match[0]);
    assert.ok(headerTags.length > 0, `${path} renders a page header`);
    for (const tag of headerTags) {
      assert.match(tag, new RegExp(`\\stitle=\\{${entry}\\.name\\}`), `${path}: the page title is the registry name\n${tag}`);
      const description = /\sdescription=(\{[^}]*\}|"[^"]*")/.exec(tag)?.[1];
      if (description !== undefined) {
        assert.match(description, new RegExp(`^\\{${entry}\\.description\\}$`), `${path}: the description is the registry's`);
      }
    }
    if (destination(id as never).description !== undefined) {
      assert.ok(headerTags.some((tag) => new RegExp(`\\sdescription=\\{${entry}\\.description\\}`).test(tag)),
        `${path} shows its registry description`);
    }
  }
});

test("empty states that name a destination read its name", () => {
  const empties: ReadonlyArray<[string, RegExp]> = [
    ["./components/AutomationsView.tsx", /title=\{`No \$\{destination\("automations"\)\.name\} Yet`\}/],
    ["./components/SkillsView.tsx", /title=\{`No \$\{destination\("skills"\)\.name\} Yet`\}/],
    ["./sessions-states.ts", /return `No \$\{destination\("inbox"\)\.name\} Yet`;/],
    ["./components/Board.tsx", /title=\{`No \$\{destination\("inbox"\)\.name\} Yet`\}/],
    ["./components/ArchivedSessionsView.tsx", /`No \$\{destination\("archived"\)\.name\}`/],
    ["./components/ProjectsView.tsx", /`No \$\{PROJECTS\.name\} Found`/],
    ["./components/RunsView.tsx", /title=\{`No \$\{runsDestination\.name\} Yet`\}/],
    ["./components/PodsView.tsx", /title=\{`No \$\{podsDestination\.name\} Yet`\}/],
    ["./detail-placeholder.ts", /const resource = destination\(list\)\.name;/],
  ];
  for (const [path, pattern] of empties) assert.match(source(path), pattern, path);
});

test("Session Naming is no longer a primary Settings destination and its legacy link reaches Behavior", () => {
  assert.equal(SETTINGS_SECTIONS.some((section) => section.id === ("session-naming" as never)), false);
  assert.deepEqual(viewFromPath("/settings/session-naming"), { name: "settings", section: "behavior" });
  assert.equal(viewPath(viewFromPath("/settings/session-naming")!), "/settings/behavior");
});

test("a Sessions tab is part of the URL and survives a reload (§10.1)", () => {
  for (const name of ["inbox", "board"] as const) {
    for (const split of [null, "project:p_1", "path:/work/alpha beta", " no-project"]) {
      const view: View = { name, split };
      const url = new URL(viewPath(view), "http://localhost");
      assert.deepEqual(viewFromPath(url.pathname, url.search), view, `${name} ${String(split)}`);
    }
  }
  assert.equal(viewPath({ name: "inbox", split: null }), "/?tab=all", "All is named, so it is not the remembered tab");
  assert.equal(viewPath({ name: "inbox" }), "/", "a link without a tab stays the plain route");
  // A query that is not exactly one usable tab keeps the plain view rather than failing the route.
  for (const search of ["", "?tab=", "?other=1", "?tab=a&tab=b", "?tab=a&other=1", `?tab=${"a".repeat(513)}`]) {
    assert.deepEqual(viewFromPath("/", search), { name: "inbox" }, search);
  }
  assert.equal(sameView({ name: "inbox", split: "project:p_1" }, { name: "inbox", split: "project:p_2" }), false,
    "switching tabs is a navigation");
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
  assert.deepEqual(viewFromNotificationMessage({ type: "wollipog:open-session", sessionId: "new/session",
    eventEpoch: 3, requestId: "ask / ✅" }), {
    name: "session", id: "new/session", attention: { eventEpoch: 3, requestId: "ask / ✅" },
  });
  assert.deepEqual(viewFromNotificationMessage({ type: "wollipog:open-session", sessionId: "new/session",
    eventEpoch: 3 }), {
    name: "session", id: "new/session", attention: { eventEpoch: 3 },
  });
  for (const invalid of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(viewFromNotificationMessage({ type: "wollipog:open-session", sessionId: "new/session",
      eventEpoch: invalid, requestId: "ask" }), null);
  }
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
