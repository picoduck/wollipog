import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  cycleFocusZone,
  escapeOwner,
  focusZone,
  focusZoneForElement,
  indicateFocusZone,
  shortcutScopeForFocus,
  ZONE_INDICATOR_MS,
  ZONE_TARGETS,
} from "./focus-zones.js";

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

/** The shell as App renders it: the rail, then the page root that every route marks `main`. */
function shell(window: Window, page: string, { current = "skills" }: { current?: string } = {}) {
  window.document.body.innerHTML = `
    <nav class="app-rail" data-focus-zone="rail" tabindex="-1">
      <a class="rail-brand" href="/" aria-label="Wollipog Sessions"></a>
      <div class="rail-destinations">
        ${["inbox", "projects", "skills", "usage"].map((name) =>
          `<a class="rail-item" id="rail-${name}" href="/${name}"${name === current ? ' aria-current="page"' : ""}></a>`).join("")}
      </div>
      <div class="rail-settings">
        <button class="settings-trigger" type="button"${current === "settings" ? ' aria-current="page"' : ""}></button>
      </div>
    </nav>
    <main class="main">
      <div class="main-body" data-focus-zone="main" tabindex="-1">${page}</div>
    </main>`;
  return (selector: string) => window.document.querySelector<HTMLElement>(selector)!;
}

test("focus zones resolve contextual Sessions and session-reading scopes", () => {
  const window = setup();
  const find = shell(window, `
    <div class="page-header"><button id="header" type="button"></button></div>
    <div class="inbox-view" data-focus-zone="list">
      <button id="list-button" type="button"></button>
      <div class="inbox-preview-pane" data-focus-zone="main"><button id="pane-button" type="button"></button></div>
    </div>`);
  const listButton = find("#list-button");
  const paneButton = find("#pane-button");
  const railItem = find("#rail-inbox");

  assert.equal(focusZoneForElement(listButton), "list");
  assert.equal(focusZoneForElement(paneButton), "main");
  assert.equal(focusZoneForElement(find("#header")), "main", "the page header belongs to the shell's page zone");
  assert.equal(shortcutScopeForFocus({ viewName: "inbox", activeElement: listButton }), "Sessions List");
  assert.equal(shortcutScopeForFocus({ viewName: "inbox", activeElement: paneButton }), "Sessions List");
  assert.equal(shortcutScopeForFocus({ viewName: "inbox", activeElement: railItem }), "Global");
  assert.equal(shortcutScopeForFocus({ viewName: "session", activeElement: paneButton, sessionReading: true }), "Session Reading");
  assert.equal(shortcutScopeForFocus({ viewName: "session", activeElement: paneButton }), "Session");
});

test("F6 on Sessions cycles the current rail item, the list and the transcript, skipping inert zones", () => {
  const window = setup();
  const find = shell(window, `
    <div class="inbox-view" data-focus-zone="list">
      <section class="inbox-list-pane">
        <input aria-label="Search Sessions">
        <div class="inbox-list" role="grid" tabindex="0"></div>
      </section>
      <div class="inbox-preview-pane" data-focus-zone="main">
        <button type="button">Back</button>
        <div class="detail-scroll" tabindex="-1"></div>
      </div>
    </div>`, { current: "inbox" });

  assert.equal(cycleFocusZone(window.document, "next"), "rail");
  assert.equal(window.document.activeElement, find("#rail-inbox"));
  assert.equal(cycleFocusZone(window.document, "next"), "list");
  assert.equal(window.document.activeElement, find(".inbox-list"), "the list zone must not land on search");
  assert.equal(cycleFocusZone(window.document, "next"), "main");
  assert.equal(window.document.activeElement, find(".detail-scroll"),
    "the reading pane, not the shell's page root, is the innermost page zone");
  assert.equal(cycleFocusZone(window.document, "next"), "rail");
  assert.equal(cycleFocusZone(window.document, "previous"), "main");
  assert.equal(cycleFocusZone(window.document, "previous"), "list");

  // An open session hides the list pane; the expanded view becomes the page zone.
  find(".inbox-view").dataset.focusZone = "main";
  find(".inbox-list-pane").setAttribute("inert", "");
  find("#rail-inbox").focus();
  assert.equal(cycleFocusZone(window.document, "next"), "main");
  assert.equal(window.document.activeElement, find(".detail-scroll"));
  assert.equal(cycleFocusZone(window.document, "next"), "rail", "with no list mounted, F6 cycles rail and page");
});

test("F6 into the rail lands on the current destination, never the brand", () => {
  const window = setup();
  let find = shell(window, "<div class='page'></div>", { current: "usage" });
  find(".main-body").focus();
  assert.equal(cycleFocusZone(window.document, "next"), "rail");
  assert.equal(window.document.activeElement, find("#rail-usage"),
    "a destination after the first must win over earlier rail items and the brand");

  find = shell(window, "<div class='page'></div>", { current: "settings" });
  assert.equal(focusZone(window.document, "rail"), "rail");
  assert.equal(window.document.activeElement, find(".settings-trigger"), "Settings lands on the Settings control");

  // A route with no rail destination (the recovery screen) falls back to the first destination.
  find = shell(window, "<div class='page'></div>", { current: "none" });
  assert.equal(focusZone(window.document, "rail"), "rail");
  assert.equal(window.document.activeElement, find("#rail-inbox"));
  assert.notEqual(window.document.activeElement, find(".rail-brand"));

  for (const [zone, selectors] of Object.entries(ZONE_TARGETS)) {
    for (const selector of selectors) {
      assert.doesNotMatch(selector, /,/, `${zone} targets are tried one selector at a time`);
    }
  }
});

test("pages without a list cycle rail and page; master-detail pages land on their pane roots", () => {
  const window = setup();
  let find = shell(window, "<div class='page'><button type='button'>New Automation</button></div>", { current: "automations" });
  assert.equal(cycleFocusZone(window.document, "next"), "rail");
  assert.equal(cycleFocusZone(window.document, "next"), "main");
  assert.equal(window.document.activeElement, find(".main-body"),
    "the page zone lands on its root so the next Tab continues into the page");
  assert.equal(cycleFocusZone(window.document, "next"), "rail", "the mounted-zone filter skips the absent list");
  assert.equal(cycleFocusZone(window.document, "previous"), "main");

  find = shell(window, `
    <div class="page">
      <div class="skills-layout">
        <aside class="skills-list" data-focus-zone="list" tabindex="-1"><button class="row" type="button"></button></aside>
        <div class="skills-detail" data-focus-zone="main" tabindex="-1"><button type="button"></button></div>
      </div>
    </div>`);
  assert.equal(cycleFocusZone(window.document, "next"), "rail");
  assert.equal(window.document.activeElement, find("#rail-skills"));
  assert.equal(cycleFocusZone(window.document, "next"), "list");
  assert.equal(window.document.activeElement, find(".skills-list"));
  assert.equal(cycleFocusZone(window.document, "next"), "main");
  assert.equal(window.document.activeElement, find(".skills-detail"), "the detail pane wins over the shell's page root");

  find(".skills-list").hidden = true;
  find(".skills-detail").setAttribute("aria-hidden", "true");
  assert.equal(focusZone(window.document, "list"), null, "a hidden pane is not a mounted zone");
  assert.equal(focusZone(window.document, "main"), "main");
  assert.equal(window.document.activeElement, find(".main-body"), "a hidden detail pane falls back to the page root");
});

test("the F6 zone line lights only the entered zone and goes out after 1.5s, a press, or focus leaving", () => {
  const window = setup();
  const find = shell(window, `
    <aside class="skills-list" data-focus-zone="list" tabindex="-1"><button class="row" type="button"></button></aside>
    <div class="skills-detail" data-focus-zone="main" tabindex="-1"><button type="button"></button></div>`);
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  (window as unknown as { setTimeout: (callback: () => void, delay: number) => number }).setTimeout = (callback, delay) => {
    timers.push(callback);
    delays.push(delay);
    return timers.length;
  };
  const list = find(".skills-list");
  const detail = find(".skills-detail");
  const lit = () => [...window.document.querySelectorAll(".zone-lit")];

  assert.equal(focusZone(window.document, "list"), "list");
  assert.deepEqual(lit(), [], "focusing a zone without F6 draws no line");

  assert.equal(indicateFocusZone(window.document, "list"), list);
  assert.deepEqual(lit(), [list]);
  assert.deepEqual(delays, [ZONE_INDICATOR_MS]);
  assert.equal(ZONE_INDICATOR_MS, 1500);
  assert.match(list.style.getPropertyValue("--zone-line-width"), /px$/);
  timers[0]!();
  assert.deepEqual(lit(), []);
  assert.equal(list.style.getPropertyValue("--zone-line-top"), "", "the measured edge is cleared with the class");

  indicateFocusZone(window.document, "list");
  indicateFocusZone(window.document, "main");
  assert.deepEqual(lit(), [detail], "only the zone F6 entered last is lit");
  detail.querySelector("button")!.focus();
  assert.deepEqual(lit(), [detail], "moving within the zone keeps the line");
  list.querySelector("button")!.focus();
  assert.deepEqual(lit(), [], "focus leaving the zone puts the line out");

  indicateFocusZone(window.document, "main");
  detail.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.deepEqual(lit(), [], "a click puts the line out");

  indicateFocusZone(window.document, "main");
  detail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F6", bubbles: true }));
  detail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
  assert.deepEqual(lit(), [detail], "F6 and Shift+F6 leave relighting to the shortcut handler");
  detail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "3", bubbles: true }));
  assert.deepEqual(lit(), [], "a digit changes the route while the page root keeps focus, so any key puts the line out");

  indicateFocusZone(window.document, "main");
  detail.dispatchEvent(new window.Event("scroll"));
  assert.deepEqual(lit(), [detail], "the zone scrolling its own content leaves its edge in place");
  find(".main-body").dispatchEvent(new window.Event("scroll"));
  assert.deepEqual(lit(), [], "an ancestor scrolling moves the zone under the measured edge");

  indicateFocusZone(window.document, "main");
  window.dispatchEvent(new window.Event("resize"));
  assert.deepEqual(lit(), [], "a resize moves the zone under the measured edge");
});

test("direct zone focus uses the list, empty-state, and board target chain", () => {
  const window = setup();
  const listZone = window.document.createElement("section");
  listZone.dataset.focusZone = "list";
  const list = window.document.createElement("div");
  list.className = "inbox-list";
  list.tabIndex = 0;
  listZone.append(list);
  window.document.body.append(listZone);

  assert.equal(focusZone(window.document, "list"), "list");
  assert.equal(window.document.activeElement, list);

  const empty = window.document.createElement("div");
  empty.className = "inbox-zero";
  empty.tabIndex = -1;
  list.replaceWith(empty);
  assert.equal(focusZone(window.document, "list"), "list");
  assert.equal(window.document.activeElement, empty);

  const board = window.document.createElement("div");
  board.className = "board-wrap";
  board.tabIndex = -1;
  empty.replaceWith(board);
  assert.equal(focusZone(window.document, "list"), "list");
  assert.equal(window.document.activeElement, board);
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
