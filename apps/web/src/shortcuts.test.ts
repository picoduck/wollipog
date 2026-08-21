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
  shortcutLayerActive,
  shortcutUnavailableReason,
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
  assert.equal(SHORTCUTS.every((item) => item.label && item.description && item.binding.key), true);
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
  assert.equal(shortcutDisplay("inbox-follow-latest-end", false), "End");
  assert.equal(shortcutDisplay("inbox-expand", false), "Enter");
  assert.equal(shortcutDisplay("exit-terminal", true), "Ctrl+Esc");
  assert.equal(shortcutDisplay("stop-turn", false), "Shift+Esc");
  assert.equal(shortcutDisplay("steer-turn", false), "Ctrl+Enter");
  assert.equal(shortcutDisplay("steer-turn", true), "Ctrl+Enter");
  assert.equal(shortcutDisplay("open-settings", false), "Shift+,");
  assert.equal(shortcutDisplay("open-settings", true), "\u21e7,");
  assert.equal(shortcutDisplay("session-reading-start", false), "G G");
  assert.equal(shortcutDisplay("session-reading-latest", false), "Shift+G");
  assert.equal(shortcutDisplay("session-reading-latest-end", false), "End");
  assert.equal(shortcutDisplay("session-reading-next-session", true), "Ctrl+J");
  assert.equal(shortcutDisplay("session-reading-previous-session", false), "Ctrl+K");
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
    "inbox-next", "inbox-previous", "inbox-expand", "inbox-next-split", "inbox-previous-split",
    "inbox-approve", "inbox-deny", "inbox-archive", "inbox-pin", "inbox-unread", "inbox-reply",
    "inbox-page-down", "inbox-page-up", "inbox-follow-latest", "inbox-follow-latest-end",
  ];
  assert.deepEqual(SHORTCUTS.filter((item) => item.scope === "Inbox").map((item) => item.id), expected);
  assert.equal(SHORTCUTS.filter((item) => expected.includes(item.id)).every((item) => item.group === "Inbox"), true);
  assert.equal(shortcut("inbox-page-down").label, "Page Down");
  assert.equal(shortcut("inbox-page-up").label, "Page Up");
  assert.equal(shortcut("inbox-follow-latest").label, "Follow Live Output");
  assert.equal(shortcut("inbox-follow-latest-end").label, "Follow Live Output (End)");
});

test("Session Reading shortcuts are registered in their contextual reference group", () => {
  const expected = [
    "session-reading-line-down", "session-reading-line-up",
    "session-reading-page-down", "session-reading-page-up",
    "session-reading-start", "session-reading-latest", "session-reading-latest-end",
    "session-reading-next-session", "session-reading-previous-session",
    "session-reading-approve", "session-reading-deny", "session-reading-archive", "session-reading-reply",
  ];
  const reading = SHORTCUTS.filter((item) => item.scope === "Session Reading");
  assert.deepEqual(reading.map((item) => item.id), expected);
  assert.equal(reading.every((item) => item.group === "Session Reading"), true);
  assert.deepEqual(shortcut("session-reading-start").binding.sequence, ["g", "g"]);
  assert.equal(shortcut("session-reading-latest").label, "Follow Live Output");
  assert.equal(shortcut("session-reading-latest-end").label, "Follow Live Output (End)");
  assert.equal(shortcut("session-reading-next-session").binding.ctrl, true);
  assert.equal(shortcut("session-reading-previous-session").binding.ctrl, true,
    "Session Reading intentionally shadows global Ctrl+K search with a literal Control binding");
});

test("PR4 rail, search, create, and focus-zone shortcuts replace the retired sidebar binding", () => {
  const expected = [
    ["navigate-inbox", "1"],
    ["navigate-projects", "2"],
    ["navigate-board", "3"],
    ["navigate-runs", "4"],
    ["navigate-pods", "5"],
    ["navigate-automations", "6"],
    ["navigate-usage", "7"],
    ["navigate-connections", "8"],
    ["navigate-archived", "9"],
    ["focus-inbox-search", "/"],
    ["new-session", "c"],
    ["focus-next-zone", "F6"],
  ] as const;
  for (const [id, key] of expected) assert.equal(shortcut(id).binding.key, key);
  assert.equal(SHORTCUTS.some((definition) => definition.id.includes("sidebar")), false);
});

test("global rail numbering stays aligned with its navigation shortcuts", () => {
  const shortcutIdByView = {
    inbox: "navigate-inbox",
    projects: "navigate-projects",
    board: "navigate-board",
    runs: "navigate-runs",
    pods: "navigate-pods",
    automations: "navigate-automations",
    usage: "navigate-usage",
    runners: "navigate-connections",
    archived: "navigate-archived",
  } as const;
  for (const [index, item] of GLOBAL_VIEW_ITEMS.entries()) {
    assert.equal(shortcut(shortcutIdByView[item.name]).binding.key, String(index + 1), item.name);
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
  assert.equal(
    shortcutUnavailableReason(shortcut("toggle-terminal"), { sessionOpen: false, terminalSupported: false, filesSupported: false }),
    "Open a session to use this binding",
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("toggle-terminal"), { sessionOpen: true, terminalSupported: false, filesSupported: true }),
    "Unavailable until this runner supports session shells",
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("open-files"), { sessionOpen: true, terminalSupported: true, filesSupported: false }),
    "Unavailable until this runner supports session files",
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("open-files"), { sessionOpen: true, terminalSupported: false, filesSupported: true }),
    null,
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("steer-turn"), {
      sessionOpen: true,
      terminalSupported: true,
      filesSupported: true,
      conversationSteeringSupported: false,
    }),
    "Unavailable until this runner supports conversation steering",
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("steer-turn"), {
      sessionOpen: true,
      terminalSupported: true,
      filesSupported: true,
      conversationSteeringSupported: true,
    }),
    null,
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("stop-turn"), {
      sessionOpen: true,
      terminalSupported: true,
      filesSupported: true,
      turnInterruptionSupported: false,
    }),
    "Unavailable until this runner supports stopping an active turn",
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("stop-turn"), {
      sessionOpen: true,
      terminalSupported: true,
      filesSupported: true,
      turnInterruptionSupported: true,
    }),
    null,
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("session-reading-line-down"), {
      sessionOpen: false,
      terminalSupported: true,
      filesSupported: true,
    }),
    "Open a session to use this binding",
  );
  assert.equal(
    shortcutUnavailableReason(shortcut("inbox-follow-latest"), {
      sessionOpen: false,
      terminalSupported: true,
      filesSupported: true,
    }),
    null,
    "the Inbox shortcut reference must advertise preview resume keys on the Inbox surface",
  );
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
