import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  SHORTCUTS,
  SHORTCUT_SEQUENCE_WINDOW_MS,
  advanceShortcutSequence,
  inTypingContext,
  isEditableShortcutTarget,
  matchesShortcut,
  shortcut,
  shortcutBindingDisplay,
  shortcutDisplay,
  shortcutGroupForScope,
  shortcutGroupUnavailableReason,
  shortcutLayerActive,
  shortcutReferenceGroups,
  shortcutUnavailableReason,
  type ShortcutDefinition,
} from "./shortcuts.js";
import { GLOBAL_VIEW_ITEMS } from "./navigation.js";

function key(
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {},
) {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}

test("the shortcut registry has stable unique ids and bindings", () => {
  assert.equal(new Set(SHORTCUTS.map((item) => item.id)).size, SHORTCUTS.length);
  assert.equal(SHORTCUTS.every((item) => item.label && item.binding.key), true);
});

test("shortcut matching accepts either primary modifier and rejects modifier drift", () => {
  assert.equal(matchesShortcut(key("k", { ctrlKey: true }), "search"), true);
  assert.equal(matchesShortcut(key("K", { metaKey: true }), "search"), true);
  assert.equal(matchesShortcut(key("k", { ctrlKey: true, shiftKey: true }), "search"), false);
  assert.equal(matchesShortcut(key("g", { ctrlKey: true, shiftKey: true }), "open-review"), true);
  assert.equal(matchesShortcut(key("g", { ctrlKey: true }), "open-review"), false);
  assert.equal(matchesShortcut(key("?", { shiftKey: true }), "shortcut-reference"), true);
  assert.equal(matchesShortcut(key("?"), "shortcut-reference"), false);
  assert.equal(matchesShortcut(key("Enter", { ctrlKey: true }), "submit-run"), true);
  assert.equal(matchesShortcut(key("Enter", { metaKey: true }), "relay-pod-note"), true);
  assert.equal(matchesShortcut(key("Escape", { ctrlKey: true }), "exit-terminal"), true);
  assert.equal(matchesShortcut(key("Escape", { metaKey: true }), "exit-terminal"), false,
    "terminal focus exits with literal Control, not Command");
  assert.equal(matchesShortcut(key("Escape", { shiftKey: true }), "stop-turn"), true);
  assert.equal(matchesShortcut(key("Escape"), "stop-turn"), false);
  assert.equal(matchesShortcut(key("Escape", { ctrlKey: true, shiftKey: true }), "stop-turn"), false);
  assert.equal(matchesShortcut(key("Enter", { ctrlKey: true }), "steer-turn"), true);
  assert.equal(matchesShortcut(key("Enter", { metaKey: true }), "steer-turn"), false,
    "steering uses literal Control rather than the platform primary modifier");
  assert.equal(matchesShortcut(key("Enter", { ctrlKey: true, shiftKey: true }), "steer-turn"), false);
  assert.equal(matchesShortcut(key("Enter"), "steer-turn"), false);
  assert.equal(matchesShortcut(key("<", { shiftKey: true }), "open-settings"), true);
  assert.equal(matchesShortcut(key(",", { shiftKey: true }), "open-settings"), false,
    "the browser reports Shift+, as the produced '<' key");
});

test("bare Inbox bindings match exact shifted and unshifted keys", () => {
  const window = new Window();
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: window.Element });
  const button = window.document.createElement("button");
  window.document.body.append(button);
  button.focus();

  assert.equal(matchesShortcut(key("j"), "inbox-next", window.document), true);
  assert.equal(matchesShortcut(key("f"), "inbox-fork", window.document), true);
  assert.equal(matchesShortcut(key("j", { ctrlKey: true }), "inbox-next", window.document), false);
  assert.equal(matchesShortcut(key(" "), "inbox-page-down", window.document), true);
  assert.equal(matchesShortcut(key(" ", { shiftKey: true }), "inbox-page-down", window.document), false);
  assert.equal(matchesShortcut(key(" ", { shiftKey: true }), "inbox-page-up", window.document), true);
  assert.equal(matchesShortcut(key("Tab"), "inbox-next-split", window.document), true);
  assert.equal(matchesShortcut(key("Tab", { shiftKey: true }), "inbox-previous-split", window.document), true);
});

test("shortcut labels follow the current platform without changing definitions", () => {
  assert.equal(shortcutDisplay("search", false), "Ctrl+K");
  assert.equal(shortcutDisplay("open-review", false), "Ctrl+Shift+G");
  assert.equal(shortcutDisplay("search", true), "⌘K");
  assert.equal(shortcutDisplay("open-review", true), "⌘⇧G");
  assert.equal(shortcutDisplay("shortcut-reference", false), "?");
  assert.equal(shortcutDisplay("inbox-page-down", false), "Space");
  assert.equal(shortcutDisplay("inbox-page-up", false), "Shift+Space");
  assert.equal(shortcutDisplay("inbox-follow-latest", false), "Shift+G");
  assert.equal(shortcutDisplay("inbox-grid-next", false), "↓");
  assert.equal(shortcutDisplay("inbox-grid-previous", false), "↑");
  assert.equal(shortcutDisplay("inbox-grid-first", false), "Home");
  assert.equal(shortcutDisplay("inbox-follow-latest-end", false), "End");
  assert.equal(shortcutDisplay("inbox-expand", false), "Enter");
  assert.equal(shortcutDisplay("inbox-fork", false), "F");
  assert.equal(shortcutDisplay("inbox-toggle-thread", false), "T");
  assert.equal(shortcutDisplay("inbox-toggle-all-threads", false), "Shift+T");
  assert.equal(shortcutDisplay("inbox-expand-thread", false), "→");
  assert.equal(shortcutDisplay("inbox-collapse-thread", false), "←");
  assert.equal(shortcutDisplay("exit-terminal", true), "Ctrl+Esc");
  assert.equal(shortcutDisplay("stop-turn", false), "Shift+Esc");
  assert.equal(shortcutDisplay("steer-turn", false), "Ctrl+Enter");
  assert.equal(shortcutDisplay("steer-turn", true), "Ctrl+Enter");
  assert.equal(shortcutDisplay("open-settings", false), "Shift+,");
  assert.equal(shortcutDisplay("open-settings", true), "\u21e7,");
  assert.equal(shortcutDisplay("session-reading-start", false), "G G");
  assert.equal(shortcutDisplay("session-reading-latest", false), "Shift+G");
  assert.equal(shortcutDisplay("session-reading-latest-end", false), "End");
  assert.equal(shortcutDisplay("session-reading-next-session", false), "Alt+↓");
  assert.equal(shortcutDisplay("session-reading-previous-session", false), "Alt+↑");
  assert.equal(shortcutDisplay("session-reading-next-session", true), "⌥↓");
  assert.equal(shortcutDisplay("session-reading-previous-session", true), "⌥↑");
  assert.equal(shortcutDisplay("session-reading-reply", false), "R");
  assert.equal(shortcutBindingDisplay({ key: "g", bare: true, sequence: ["g", "g"] }, false), "G G");
});

test("typing context uses the active element and treats xterm as a hard boundary", () => {
  const window = new Window();
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: window.Element });
  const input = window.document.createElement("input");
  const textarea = window.document.createElement("textarea");
  const select = window.document.createElement("select");
  const editable = window.document.createElement("div");
  editable.setAttribute("contenteditable", "plaintext-only");
  editable.tabIndex = 0;
  const terminal = window.document.createElement("div");
  terminal.className = "xterm";
  const terminalTarget = window.document.createElement("button");
  terminal.append(terminalTarget);
  const button = window.document.createElement("button");
  window.document.body.append(input, textarea, select, editable, terminal, button);

  for (const target of [input, textarea, select, editable, terminalTarget]) {
    target.focus();
    assert.equal(inTypingContext(window.document), true, target.outerHTML);
    assert.equal(matchesShortcut(key("j"), "inbox-next", window.document), false);
  }
  button.focus();
  assert.equal(inTypingContext(window.document), false);
  assert.equal(matchesShortcut(key("j"), "inbox-next", window.document), true);
});

test("sequence matching completes inside 600ms and cancels on mismatch, timeout, or typing", () => {
  const window = new Window();
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: window.Element });
  const button = window.document.createElement("button");
  const input = window.document.createElement("input");
  window.document.body.append(button, input);
  button.focus();

  const first = advanceShortcutSequence(key("g"), ["g", "g"], null, 1_000, window.document);
  assert.equal(first.matched, false);
  assert.deepEqual(first.state, { index: 1, expiresAt: 1_000 + SHORTCUT_SEQUENCE_WINDOW_MS });
  assert.deepEqual(
    advanceShortcutSequence(key("g"), ["g", "g"], first.state, 1_599, window.document),
    { matched: true, state: null },
  );
  assert.deepEqual(
    advanceShortcutSequence(key("x"), ["g", "g"], first.state, 1_100, window.document),
    { matched: false, state: null },
  );
  assert.deepEqual(
    advanceShortcutSequence(key("g"), ["g", "g"], first.state, 1_601, window.document),
    { matched: false, state: { index: 1, expiresAt: 2_201 } },
    "an expired chord starts a fresh sequence from the current key",
  );
  input.focus();
  assert.deepEqual(
    advanceShortcutSequence(key("g"), ["g", "g"], first.state, 1_100, window.document),
    { matched: false, state: null },
  );
});

test("PR2 Inbox shortcuts are registered under the Inbox scope", () => {
  const expected = [
    "inbox-next", "inbox-previous", "inbox-grid-next", "inbox-grid-previous", "inbox-grid-first",
    "inbox-expand", "inbox-open-top-request", "inbox-toggle-thread",
    "inbox-toggle-all-threads", "inbox-go-to-parent", "inbox-expand-thread", "inbox-collapse-thread",
    "inbox-fork", "inbox-next-split", "inbox-previous-split",
    "inbox-approve", "inbox-deny", "inbox-archive", "inbox-snooze", "inbox-pin", "inbox-unread",
    "inbox-reply", "inbox-page-down", "inbox-page-up", "inbox-follow-latest", "inbox-follow-latest-end",
  ];
  assert.deepEqual(SHORTCUTS.filter((item) => item.scope === "Sessions List").map((item) => item.id), expected);
  assert.equal(SHORTCUTS.filter((item) => expected.includes(item.id)).every((item) => item.group === "Sessions List"), true);
  assert.equal(shortcut("inbox-page-down").label, "Page Down");
  assert.equal(shortcut("inbox-page-up").label, "Page Up");
  assert.equal(shortcut("inbox-grid-next").label, "Next Session (Grid)");
  assert.equal(shortcut("inbox-grid-previous").label, "Previous Session (Grid)");
  assert.equal(shortcut("inbox-grid-first").label, "First Session (Grid)");
  assert.equal(shortcut("inbox-follow-latest").label, "Jump to Latest");
  assert.equal(shortcut("inbox-follow-latest-end").label, "Last Session / Jump to Latest");
});

test("Session Reading shortcuts are registered in their contextual reference group", () => {
  const expected = [
    "session-reading-line-down", "session-reading-line-up",
    "session-reading-page-down", "session-reading-page-up",
    "session-reading-start", "session-reading-latest", "session-reading-latest-end",
    "session-reading-next-session", "session-reading-previous-session",
    "session-reading-approve", "session-reading-deny", "session-reading-archive",
    "session-reading-snooze", "session-reading-fork", "session-reading-reply",
  ];
  const reading = SHORTCUTS.filter((item) => item.scope === "Session Reading");
  assert.deepEqual(reading.map((item) => item.id), expected);
  assert.equal(reading.every((item) => item.group === "Session Reading"), true);
  assert.deepEqual(shortcut("session-reading-start").binding.sequence, ["g", "g"]);
  assert.equal(shortcut("session-reading-latest").label, "Jump to Latest");
  assert.equal(shortcut("session-reading-latest-end").label, "Jump to Latest (End)");
  // F forks from the session page as it does from the Sessions list, whose entry stays (#2272).
  assert.equal(shortcut("session-reading-fork").label, shortcut("inbox-fork").label);
  assert.equal(shortcutDisplay("session-reading-fork", false), "F");
  assert.equal(shortcutDisplay("session-reading-fork", true), "F");
  assert.equal(matchesShortcut(key("f"), "session-reading-fork"), true);
  assert.equal(matchesShortcut(key("f", { shiftKey: true }), "session-reading-fork"), false);
  assert.equal(matchesShortcut(key("f", { ctrlKey: true }), "session-reading-fork"), false);
  assert.equal(matchesShortcut(key("ArrowDown", { altKey: true }), "session-reading-next-session"), true);
  assert.equal(matchesShortcut(key("ArrowUp", { altKey: true }), "session-reading-previous-session"), true);
  assert.equal(matchesShortcut(key("ArrowUp"), "session-reading-previous-session"), false);
  assert.equal(matchesShortcut(key("k", { ctrlKey: true }), "session-reading-previous-session"), false,
    "Ctrl+K belongs to Search on every platform");
});

/** Scopes that are live together besides Global, which is live with every scope. The Session
 * panel keys work while Session Reading owns the transcript, and Sessions sits over its list. */
const CO_ACTIVE_SCOPES: ReadonlyArray<readonly [ShortcutDefinition["scope"], ShortcutDefinition["scope"]]> = [
  ["Session", "Session Reading"],
  ["Sessions", "Sessions List"],
];

function coActive(a: ShortcutDefinition["scope"], b: ShortcutDefinition["scope"]): boolean {
  return a === b || a === "Global" || b === "Global" ||
    CO_ACTIVE_SCOPES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function coActiveCollisions(definitions: readonly ShortcutDefinition[], mac: boolean): string[] {
  const collisions: string[] = [];
  for (const [index, first] of definitions.entries()) {
    for (const second of definitions.slice(index + 1)) {
      if (!coActive(first.scope, second.scope)) continue;
      const keys = shortcutBindingDisplay(first.binding, mac);
      if (keys === shortcutBindingDisplay(second.binding, mac)) collisions.push(`${first.id} / ${second.id}: ${keys}`);
    }
  }
  return collisions;
}

test("no two bindings that can be active together show the same keys on either platform", () => {
  assert.deepEqual(coActiveCollisions(SHORTCUTS, false), [], "Windows and Linux");
  assert.deepEqual(coActiveCollisions(SHORTCUTS, true), [], "macOS");
});

test("the collision check reports a contextual binding that shadows Search on one platform only", () => {
  // Previous Session's binding before #2080: literal Control, so Ctrl+K beside Search off macOS.
  const before = SHORTCUTS.map((definition): ShortcutDefinition => definition.id === "session-reading-previous-session"
    ? { ...definition, binding: { key: "k", ctrl: true } }
    : definition);
  assert.deepEqual(coActiveCollisions(before, false), ["search / session-reading-previous-session: Ctrl+K"]);
  assert.deepEqual(coActiveCollisions(before, true), []);
  // Scopes that are never live together may reuse keys: the Run dialog and Pod detail both submit.
  assert.equal(shortcutDisplay("submit-run", false), shortcutDisplay("relay-pod-note", false));
});

test("PR4 rail, search, create, and focus-zone shortcuts replace the retired sidebar binding", () => {
  const expected = [
    ["navigate-inbox", "1"],
    ["navigate-automations", "2"],
    ["navigate-projects", "3"],
    ["navigate-runs", "4"],
    ["navigate-pods", "5"],
    ["navigate-connections", "6"],
    ["navigate-skills", "7"],
    ["navigate-archived", "8"],
    ["navigate-usage", "9"],
    ["toggle-sessions-view", "b"],
    ["focus-inbox-search", "/"],
    ["new-session", "c"],
    ["focus-next-zone", "F6"],
  ] as const;
  for (const [id, key] of expected) assert.equal(shortcut(id).binding.key, key);
  assert.equal(SHORTCUTS.some((definition) => definition.id.includes("sidebar")), false);
});

test("global rail numbering stays aligned with its navigation shortcuts", () => {
  // null = past the nine bare digit keys: the destination exists but no number is advertised.
  // The rail's RAIL_SHORTCUT_DIGITS gate keeps its keycaps aligned with this same boundary.
  const shortcutIdByView = {
    inbox: "navigate-inbox",
    projects: "navigate-projects",
    runs: "navigate-runs",
    pods: "navigate-pods",
    automations: "navigate-automations",
    usage: "navigate-usage",
    runners: "navigate-connections",
    archived: "navigate-archived",
    skills: "navigate-skills",
  } as const;
  for (const [index, item] of GLOBAL_VIEW_ITEMS.entries()) {
    const id = shortcutIdByView[item.id];
    if (id === null) {
      assert.ok(index >= 9, `${item.name} has no digit shortcut, so it must sit past the numbered nine`);
      continue;
    }
    assert.equal(shortcut(id).binding.key, String(index + 1), item.name);
    // The shortcut reference labels each destination with the name the rail and page use.
    assert.equal(shortcut(id).label, item.name);
  }
});

test("Open Settings is a discoverable global navigation shortcut", () => {
  const definition = shortcut("open-settings");
  assert.equal(definition.group, "Navigation");
  assert.equal(definition.scope, "Global");
  assert.deepEqual(definition.binding, { key: "<", shift: true, displayKey: "," });
});

test("editable targets include inherited, empty, and plaintext-only contenteditable regions", () => {
  const window = new Window();
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: window.Element });
  const inherited = window.document.createElement("div");
  inherited.setAttribute("contenteditable", "");
  const child = window.document.createElement("span");
  inherited.append(child);
  assert.equal(isEditableShortcutTarget(child), true);
  inherited.setAttribute("contenteditable", "plaintext-only");
  assert.equal(isEditableShortcutTarget(child), true);
  inherited.setAttribute("contenteditable", "false");
  assert.equal(isEditableShortcutTarget(child), false);
});

test("session shortcut availability reflects the active runner capability", () => {
  const supported = { sessionOpen: true, terminalSupported: true, filesSupported: true, conversationSteeringSupported: true, turnInterruptionSupported: true };
  for (const [id, capability] of [
    ["toggle-terminal", "terminalSupported"],
    ["open-files", "filesSupported"],
    ["steer-turn", "conversationSteeringSupported"],
    ["stop-turn", "turnInterruptionSupported"],
  ] as const) {
    assert.equal(shortcutUnavailableReason(shortcut(id), supported), null, id);
    assert.equal(shortcutUnavailableReason(shortcut(id), { ...supported, [capability]: false }), "Not supported by this runner", id);
  }
  // Whether a session is open is the group's reason, said once under its heading, never per row.
  assert.equal(shortcutUnavailableReason(shortcut("session-reading-line-down"), { ...supported, sessionOpen: false }), null);
  assert.equal(shortcutGroupUnavailableReason("Session", { sessionOpen: false }), "Open a session to use these.");
  assert.equal(shortcutGroupUnavailableReason("Session Reading", { sessionOpen: false }), "Open a session to use these.");
  assert.equal(shortcutGroupUnavailableReason("Session", { sessionOpen: true }), null);
  assert.equal(shortcutGroupUnavailableReason("Sessions List", { sessionOpen: false }), null,
    "the reference must advertise the preview's resume keys on the Sessions page");
});

const AVAILABLE = { sessionOpen: true, terminalSupported: true, filesSupported: true, conversationSteeringSupported: true, turnInterruptionSupported: true };
const referenceKeys = (definition: ShortcutDefinition) => shortcutBindingDisplay(definition.binding, false);

test("the reference puts the current page's group first and marks only that one", () => {
  const global = shortcutReferenceGroups({ scope: "Global", availability: { ...AVAILABLE, sessionOpen: false }, keys: referenceKeys });
  assert.deepEqual(global.map((group) => group.group), ["Navigation", "Actions", "Sessions List", "Session Reading", "Session", "Help"]);
  assert.equal(global.some((group) => group.current), false, "a page with no group of its own marks none");

  for (const scope of ["Sessions List", "Session Reading", "Session"] as const) {
    const groups = shortcutReferenceGroups({ scope, availability: AVAILABLE, keys: referenceKeys });
    assert.equal(groups[0]!.group, scope);
    assert.deepEqual(groups.filter((group) => group.current).map((group) => group.group), [scope]);
  }
  assert.equal(shortcutGroupForScope("Sessions"), null);
  assert.equal(shortcutGroupForScope("Run dialog"), null);
});

test("without a session the Session groups carry one note and no per-row session reason", () => {
  const groups = shortcutReferenceGroups({
    scope: "Global",
    availability: { sessionOpen: false, terminalSupported: false, filesSupported: false },
    keys: referenceKeys,
  });
  for (const name of ["Session", "Session Reading"] as const) {
    const group = groups.find((candidate) => candidate.group === name)!;
    assert.equal(group.note, "Open a session to use these.");
    // No runner is chosen before a session is, so no runner reason repeats the note.
    assert.deepEqual(group.rows.filter((row) => row.reason !== null), [], name);
  }
  assert.equal(groups.find((group) => group.group === "Sessions List")!.note, null);
});

test("shared Session actions are listed once, in the first of the two groups, only when their keys match", () => {
  const labelsOf = (groups: ReturnType<typeof shortcutReferenceGroups>, name: string) =>
    groups.find((group) => group.group === name)!.rows.map((row) => row.label);
  const shared = ["Approve Request", "Deny Request", "Snooze Session", "Fork Conversation", "Reply to Session", "Page Down", "Page Up",
    "Jump to Latest"];

  const onSessions = shortcutReferenceGroups({ scope: "Sessions List", availability: AVAILABLE, keys: referenceKeys });
  const inSession = shortcutReferenceGroups({ scope: "Session Reading", availability: AVAILABLE, keys: referenceKeys });
  for (const label of shared) {
    assert.ok(labelsOf(onSessions, "Sessions List").includes(label), label);
    assert.ok(!labelsOf(onSessions, "Session Reading").includes(label), label);
    assert.ok(labelsOf(inSession, "Session Reading").includes(label), label);
    assert.ok(!labelsOf(inSession, "Sessions List").includes(label), label);
  }
  // Same label, different keys (J in the list, Alt+↓ while reading): both stay under their headings.
  assert.ok(labelsOf(onSessions, "Sessions List").includes("Next Session"));
  assert.ok(labelsOf(onSessions, "Session Reading").includes("Next Session"));
  // The same key under different labels is a different action and is never merged.
  assert.ok(labelsOf(onSessions, "Sessions List").includes("Archive Session"));
  assert.ok(labelsOf(onSessions, "Session Reading").includes("Archive and Advance"));
});

test("the reference filter keeps rows whose label or keys match and drops empty groups", () => {
  const filter = (query: string) => shortcutReferenceGroups({ scope: "Global", availability: AVAILABLE, keys: referenceKeys, query });
  assert.deepEqual(filter("term").map((group) => [group.group, group.rows.map((row) => row.label)]), [
    ["Session", ["Toggle Terminal", "Exit Terminal Focus"]],
  ]);
  assert.deepEqual(filter("  TERMINAL ").flatMap((group) => group.rows.map((row) => row.label)), ["Toggle Terminal", "Exit Terminal Focus"]);
  assert.deepEqual(filter("ctrl k").flatMap((group) => group.rows.map((row) => `${row.label} ${row.keys}`)),
    ["Search Ctrl+K"]);
  assert.deepEqual(filter("alt").flatMap((group) => group.rows.map((row) => `${row.label} ${row.keys}`)),
    ["Next Session Alt+↓", "Previous Session Alt+↑"]);
  assert.deepEqual(filter("zzz"), []);
});

test("modal and popover layers isolate background application chords", () => {
  const window = new Window();
  const palette = window.document.createElement("div");
  palette.className = "palette";
  palette.setAttribute("aria-modal", "true");
  window.document.body.append(palette);
  assert.equal(shortcutLayerActive(window.document), true);
  assert.equal(shortcutLayerActive(window.document, true), false);
  palette.remove();

  const menu = window.document.createElement("div");
  menu.setAttribute("role", "menu");
  window.document.body.append(menu);
  assert.equal(shortcutLayerActive(window.document, true), false);
});

test("every listener of one keydown shares a single layer query (#2840)", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  let queries = 0;
  const query = document.querySelector.bind(document);
  document.querySelector = ((selectors: string) => {
    queries += 1;
    return query(selectors);
  }) as typeof document.querySelector;
  const answers: boolean[] = [];
  for (let listener = 0; listener < 6; listener += 1) {
    window.addEventListener("keydown", (event) => answers.push(shortcutLayerActive(document, false, event as unknown as Event)));
  }
  window.addEventListener("keydown", (event) => answers.push(shortcutLayerActive(document, true, event as unknown as Event)));

  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  assert.deepEqual(answers, [false, false, false, false, false, false, false]);
  assert.equal(queries, 2, "one query per kind of layer for the whole keydown");

  // The next keydown asks afresh, and so does a check outside any event.
  const menu = window.document.createElement("div");
  menu.setAttribute("role", "menu");
  window.document.body.append(menu);
  answers.length = 0;
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", bubbles: true }));
  assert.deepEqual(answers, [true, true, true, true, true, true, false]);
  assert.equal(queries, 4);
  menu.remove();
  assert.equal(shortcutLayerActive(document), false);
  assert.equal(queries, 5);
});

/** Chords a browser acts on itself in Chrome, Edge, Firefox or Safari, on either platform. */
const BROWSER_RESERVED = new Set([
  "Ctrl+B", "Ctrl+Shift+B", "Ctrl+Alt+B", "Ctrl+D", "Ctrl+H", "Ctrl+J", "Ctrl+L", "Ctrl+N", "Ctrl+Shift+N",
  "Ctrl+O", "Ctrl+S", "Ctrl+T", "Ctrl+Shift+T", "Ctrl+U", "Ctrl+W", "Ctrl+Shift+W", "Ctrl+Shift+I",
  "Ctrl+Shift+J", "Ctrl+Shift+E", "Ctrl+Shift+Delete", "Ctrl+Shift+O", "Ctrl+Shift+A",
  "⌘B", "⌘⇧B", "⌘⌥B", "⌘D", "⌘J", "⌘L", "⌘N", "⌘⇧N", "⌘O", "⌘S", "⌘T", "⌘⇧T", "⌘W", "⌘⇧W", "⌘⌥I",
  "⌘⌥J", "⌘⌥L", "⌘⇧\\", "⌘Y", "⌘⇧L", "⌘.",
]);

test("the Side Panel chord toggles from a session, is in the reference, and no browser claims it (#2843)", () => {
  const definition = shortcut("toggle-side-panel");
  assert.equal(definition.label, "Side Panel");
  assert.equal(definition.scope, "Session");
  for (const mac of [false, true]) {
    const keys = shortcutDisplay("toggle-side-panel", mac);
    assert.equal(BROWSER_RESERVED.has(keys), false, `${keys} is a browser's own chord`);
  }
  assert.equal(shortcutDisplay("toggle-side-panel", false), "Ctrl+\\");
  assert.equal(shortcutDisplay("toggle-side-panel", true), "⌘\\");
  const press = { key: "\\", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(matchesShortcut(press, "toggle-side-panel"), true);
  assert.equal(matchesShortcut({ ...press, ctrlKey: false }, "toggle-side-panel"), false);
  const session = shortcutReferenceGroups({ scope: "Session", availability: AVAILABLE, keys: referenceKeys })
    .find((group) => group.group === "Session")!;
  assert.deepEqual(session.rows.filter((row) => row.id === "toggle-side-panel").map((row) => [row.label, row.keys, row.reason]),
    [["Side Panel", "Ctrl+\\", null]]);
});
