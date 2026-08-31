import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { cycleFocusZone, escapeOwner, focusZoneForElement, shortcutScopeForFocus } from "./focus-zones.js";

function escape(modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented">> = {}) {
  return {
    key: "Escape",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...modifiers,
  };
}

function setup() {
  const window = new Window();
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: window.Element });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: window.HTMLElement });
  return window;
}

test("focus zones resolve contextual Inbox and session-reading scopes", () => {
  const window = setup();
  const list = window.document.createElement("section");
  list.dataset.focusZone = "list";
  const listButton = window.document.createElement("button");
  list.append(listButton);
  const detail = window.document.createElement("section");
  detail.dataset.focusZone = "detail";
  const detailButton = window.document.createElement("button");
  detail.append(detailButton);
  const rail = window.document.createElement("nav");
  rail.dataset.focusZone = "rail";
  const railButton = window.document.createElement("button");
  rail.append(railButton);
  window.document.body.append(list, detail, rail);

  assert.equal(focusZoneForElement(listButton), "list");
  assert.equal(focusZoneForElement(detailButton), "detail");
  assert.equal(shortcutScopeForFocus({ viewName: "inbox", activeElement: listButton }), "Sessions List");
  assert.equal(shortcutScopeForFocus({ viewName: "inbox", activeElement: detailButton }), "Sessions List");
  assert.equal(shortcutScopeForFocus({ viewName: "inbox", activeElement: railButton }), "Global");
  assert.equal(shortcutScopeForFocus({ viewName: "session", activeElement: detailButton, sessionReading: true }), "Session Reading");
  assert.equal(shortcutScopeForFocus({ viewName: "session", activeElement: detailButton }), "Session");
});

test("F6 cycling targets the active rail item, Inbox list, and transcript while skipping inert zones", () => {
  const window = setup();
  const rail = window.document.createElement("nav");
  rail.dataset.focusZone = "rail";
  const railItem = window.document.createElement("a");
  railItem.href = "/";
  railItem.setAttribute("aria-current", "page");
  rail.append(railItem);
  const listZone = window.document.createElement("section");
  listZone.dataset.focusZone = "list";
  const search = window.document.createElement("input");
  const list = window.document.createElement("div");
  list.className = "inbox-list";
  list.tabIndex = 0;
  listZone.append(search, list);
  const detailZone = window.document.createElement("section");
  detailZone.dataset.focusZone = "detail";
  const back = window.document.createElement("button");
  const transcript = window.document.createElement("div");
  transcript.className = "detail-scroll";
  transcript.tabIndex = 0;
  detailZone.append(back, transcript);
  window.document.body.append(rail, listZone, detailZone);

  assert.equal(cycleFocusZone(window.document, "next"), "rail");
  assert.equal(window.document.activeElement, railItem);
  assert.equal(cycleFocusZone(window.document, "next"), "list");
  assert.equal(window.document.activeElement, list, "list zone must not land on search");
  assert.equal(cycleFocusZone(window.document, "next"), "detail");
  assert.equal(window.document.activeElement, transcript, "detail zone must land on the transcript");
  assert.equal(cycleFocusZone(window.document, "next"), "rail");

  listZone.setAttribute("inert", "");
  railItem.focus();
  assert.equal(cycleFocusZone(window.document, "next"), "detail");
});

test("Escape ownership follows one ordered rung and preserves the terminal boundary", () => {
  const window = setup();
  const composer = window.document.createElement("div");
  composer.className = "composer";
  const composerInput = window.document.createElement("textarea");
  composer.append(composerInput);
  const terminal = window.document.createElement("div");
  terminal.className = "xterm";
  const terminalInput = window.document.createElement("textarea");
  terminal.append(terminalInput);
  window.document.body.append(composer, terminal);

  terminalInput.focus();
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "session" }), "terminal");
  assert.equal(escapeOwner(escape({ ctrlKey: true }), { document: window.document, viewName: "session" }), "terminal-exit");
  assert.equal(escapeOwner(escape({ metaKey: true }), { document: window.document, viewName: "session" }), "terminal");

  composerInput.focus();
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "session" }), "composer");
  assert.equal(escapeOwner(escape({ ctrlKey: true }), { document: window.document, viewName: "session" }), null);

  composerInput.blur();
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "session" }), "session-reading");
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "inbox", inboxFilterActive: true }), "inbox-filter");
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "board", inboxFilterActive: true }), "inbox-filter",
    "board mode shares the Sessions search box, so Escape clears its query too");
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "inbox" }), null);
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "board" }), null);

  const settingsInput = window.document.createElement("input");
  const settingsButton = window.document.createElement("button");
  window.document.body.append(settingsInput, settingsButton);
  settingsInput.focus();
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "settings" }), "settings-input");
  settingsButton.focus();
  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "settings" }), "settings");
});

test("an active layer owns Escape before lower focus rungs", () => {
  const window = setup();
  const composer = window.document.createElement("div");
  composer.className = "composer";
  const composerInput = window.document.createElement("textarea");
  composer.append(composerInput);
  const dialog = window.document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  window.document.body.append(composer, dialog);
  composerInput.focus();

  assert.equal(escapeOwner(escape(), { document: window.document, viewName: "session" }), "layer");
  assert.equal(escapeOwner(escape({ defaultPrevented: true }), { document: window.document, viewName: "session" }), null);
});
