import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import type { View } from "./navigation.js";
import { handleSettingsNavigationKey, settingsShortcutShouldOpen } from "./settings-navigation.js";

function setup() {
  const window = new Window();
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: window.Element });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: window.HTMLElement });
  return window;
}

test("Shift+, opens Settings only outside typing, IME, terminal, and layer ownership", () => {
  const window = setup();
  const button = window.document.createElement("button");
  const input = window.document.createElement("input");
  const terminal = window.document.createElement("div");
  terminal.className = "xterm";
  const terminalInput = window.document.createElement("textarea");
  terminal.append(terminalInput);
  window.document.body.append(button, input, terminal);

  button.focus();
  assert.equal(settingsShortcutShouldOpen(
    new window.KeyboardEvent("keydown", { key: "<", shiftKey: true, bubbles: true }) as never,
    window.document as never,
  ), true);

  input.focus();
  assert.equal(settingsShortcutShouldOpen(
    new window.KeyboardEvent("keydown", { key: "<", shiftKey: true, bubbles: true }) as never,
    window.document as never,
  ), false);
  terminalInput.focus();
  assert.equal(settingsShortcutShouldOpen(
    new window.KeyboardEvent("keydown", { key: "<", shiftKey: true, bubbles: true }) as never,
    window.document as never,
  ), false);

  button.focus();
  assert.equal(settingsShortcutShouldOpen(
    new window.KeyboardEvent("keydown", { key: "<", shiftKey: true, isComposing: true, bubbles: true }) as never,
    window.document as never,
  ), false);

  const dialog = window.document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  window.document.body.append(dialog);
  assert.equal(settingsShortcutShouldOpen(
    new window.KeyboardEvent("keydown", { key: "<", shiftKey: true, bubbles: true }) as never,
    window.document as never,
  ), false);
});

test("Shift+, is a no-op while Settings is already open", () => {
  const window = setup();
  const button = window.document.createElement("button");
  window.document.body.append(button);
  button.focus();
  const navigated: View[] = [];
  const event = new window.KeyboardEvent("keydown", {
    key: "<",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });

  assert.equal(handleSettingsNavigationKey(event as never, {
    document: window.document as never,
    viewName: "settings",
    settingsReturnView: { name: "usage" },
    navigate: (view) => navigated.push(view),
  }), false);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(navigated, []);
});

test("Settings Escape first blurs an editor, then pushes the exact return view", () => {
  const window = setup();
  const input = window.document.createElement("input");
  const button = window.document.createElement("button");
  window.document.body.append(input, button);
  const navigated: View[] = [];
  const origin: View = { name: "projects", id: "project-alpha" };

  input.focus();
  const editingEscape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  assert.equal(handleSettingsNavigationKey(editingEscape as never, {
    document: window.document as never,
    viewName: "settings",
    settingsReturnView: origin,
    navigate: (view) => navigated.push(view),
  }), true);
  assert.equal(editingEscape.defaultPrevented, true);
  assert.notEqual(window.document.activeElement, input);
  assert.deepEqual(navigated, []);

  button.focus();
  const pageEscape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  assert.equal(handleSettingsNavigationKey(pageEscape as never, {
    document: window.document as never,
    viewName: "settings",
    settingsReturnView: origin,
    navigate: (view) => navigated.push(view),
  }), true);
  assert.deepEqual(navigated, [origin]);
});

test("a nested layer keeps Escape and direct Settings entry falls back to Inbox", () => {
  const window = setup();
  const dialog = window.document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  window.document.body.append(dialog);
  const navigated: View[] = [];
  assert.equal(handleSettingsNavigationKey(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never,
    {
      document: window.document as never,
      viewName: "settings",
      settingsReturnView: null,
      navigate: (view) => navigated.push(view),
    },
  ), false);
  assert.deepEqual(navigated, []);

  dialog.remove();
  assert.equal(handleSettingsNavigationKey(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never,
    {
      document: window.document as never,
      viewName: "settings",
      settingsReturnView: null,
      navigate: (view) => navigated.push(view),
    },
  ), true);
  assert.deepEqual(navigated, [{ name: "inbox" }]);
});
