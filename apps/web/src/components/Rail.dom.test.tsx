import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Rail } from "./Rail.js";
import { saveSessionsViewMode } from "../sessions-view-mode.js";
import { moveRailView, resetRailPreferencesForTest, setRailViewHidden } from "../rail-preferences.js";
import type { View } from "../navigation.js";

const domWindow = new Window();
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorNavigator = globalThis.navigator;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];

// The menu helpers in interactions.ts narrow with `instanceof HTMLButtonElement`, so the element
// constructors have to be global too — not just window/document.
const priorElementGlobals = {
  HTMLElement: (globalThis as Record<string, unknown>)["HTMLElement"],
  HTMLButtonElement: (globalThis as Record<string, unknown>)["HTMLButtonElement"],
  KeyboardEvent: (globalThis as Record<string, unknown>)["KeyboardEvent"],
};
const priorLocalStorage = (globalThis as Record<string, unknown>)["localStorage"];

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: domWindow.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: domWindow.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: domWindow.HTMLButtonElement });
  Object.defineProperty(globalThis, "KeyboardEvent", { configurable: true, writable: true, value: domWindow.KeyboardEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  // The Sessions item resolves its persisted list/board mode from instance storage at click time.
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: domWindow.localStorage });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: priorNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLButtonElement });
  Object.defineProperty(globalThis, "KeyboardEvent", { configurable: true, writable: true, value: priorElementGlobals.KeyboardEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: priorLocalStorage });
});

test("rail exposes every destination, nested active states, live badges, and persistent actions", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const navigated: View[] = [];
  const render = (view: View, blockedCount = 2, onlineConnections = 3, stalledCount = 1) => act(async () => {
    root.render(
      <Rail
        view={view}
        blockedCount={blockedCount}
        stalledCount={stalledCount}
        onlineConnections={onlineConnections}
        onNavigate={(destination) => navigated.push(destination)}
        instanceControl={<button type="button">Switch Instance</button>}
        settingsControl={<button type="button">Settings</button>}
      />,
    );
  });

  await render({ name: "session", id: "session-1" });
  const links = [...container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")];
  assert.equal(links.length, 9);
  assert.deepEqual(links.map((link) => link.getAttribute("href")), [
    "/", "/automations", "/runs", "/pods", "/connections/machines", "/skills", "/projects", "/archived", "/usage",
  ]);
  // With Board folded into Sessions (#499), all nine destinations carry a digit keycap.
  assert.equal(links[8]!.querySelector(".rail-number")?.textContent, "9",
    "the management tail ends at Usage with the ninth digit");
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /^Sessions/);
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /2 Blocked/);
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /1 Stalled/);
  assert.match(links[4]!.getAttribute("aria-label") ?? "", /3 Online/);
  assert.equal(links[0]!.getAttribute("aria-current"), "page", "session detail belongs to Sessions");
  assert.equal(links[0]!.querySelector(".rail-badge.blocked")?.getAttribute("aria-hidden"), "true");
  assert.equal(links[0]!.querySelector(".rail-badge.stalled")?.getAttribute("aria-hidden"), "true");
  const summary = container.querySelector<HTMLElement>('[role="status"]')!;
  assert.equal(summary.getAttribute("aria-live"), "polite");
  assert.match(summary.textContent ?? "", /Sessions: 2 Blocked, 1 Stalled/);

  await render({ name: "run", id: "run-1" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[2]!.getAttribute("aria-current"), "page");
  await render({ name: "pod", id: "pod-1" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[3]!.getAttribute("aria-current"), "page");

  await render({ name: "projects" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[6]!.getAttribute("aria-current"), "page");

  // Board mode is the Sessions destination: it marks Sessions current, and activating the item
  // reopens whichever mode was last used.
  await render({ name: "board" });
  const sessionsItem = container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[0]!;
  assert.equal(sessionsItem.getAttribute("aria-current"), "page", "board mode belongs to Sessions");
  saveSessionsViewMode("board");
  sessionsItem.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, button: 0 }) as never);
  assert.deepEqual(navigated.at(-1), { name: "board" }, "activation honors the persisted board mode");
  saveSessionsViewMode("list");
  sessionsItem.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, button: 0 }) as never);
  assert.deepEqual(navigated.at(-1), { name: "inbox" }, "and returns to the list when that was last used");
  assert.ok(container.textContent?.includes("Switch Instance"));
  assert.ok(container.textContent?.includes("Settings"));

  await act(async () => root.unmount());
  container.remove();
});

function stubPhoneWidth() {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  return () => { domWindow.matchMedia = prior; };
}

test("the phone rail hosts destinations plus routed Settings and no nested layers", async () => {
  // The phone bar carries four destinations plus More. Creation lives in the Inbox toolbar and the
  // instance switcher lives in the top bar.
  //
  // An earlier revision put Instance and Settings inside the sheet; because those rendered their
  // own menu and dialog, their Tab and Escape events bubbled into the outer roving controller, so
  // one Tab tore down both layers and one Escape peeled two. That is a constraint on nesting a
  // LAYER, and only the instance switcher still opens one. Settings is a plain route, so it is a
  // menuitem row here like any destination — what must stay true is that nothing in the sheet
  // owns a dialog or menu of its own.
  const restore = stubPhoneWidth();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const navigated: View[] = [];

  const render = (view: View) => act(async () => {
    root.render(
      <Rail
        view={view}
        blockedCount={0}
        stalledCount={0}
        onlineConnections={1}
        onNavigate={(next) => navigated.push(next)}
      />,
    );
  });

  try {
    await render({ name: "inbox" });

    const bar = container.querySelector(".rail-destinations")!;
    assert.equal(bar.querySelectorAll("a.rail-item, button.rail-item").length, 5,
      "four destinations plus More — five is the platform convention");
    assert.deepEqual(
      [...bar.querySelectorAll<HTMLAnchorElement>("a.rail-item")].map((item) => item.getAttribute("href")),
      ["/", "/automations", "/runs", "/pods"],
      "the bar takes the first four visible destinations in configured order");

    // Nothing that owns its own overlay may live in the bar or the sheet.
    assert.equal(container.querySelector(".rail-instance"), null);
    assert.equal(container.querySelector(".rail-settings"), null);
    assert.equal(container.querySelector(".rail-action"), null);
    assert.equal(container.querySelector(".rail-fab"), null,
      "no floating button: that band is occupied by the shell dock and the toast stack");
    assert.equal(container.querySelectorAll(".rail-number").length, 0);

    const moreTrigger = container.querySelector(".rail-more-trigger")! as unknown as HTMLButtonElement;
    await act(async () => { moreTrigger.click(); });
    const sheet = container.querySelector(".rail-more-sheet")!;
    // The bar takes the first four VISIBLE destinations (#385), so with every experiment on the
    // sheet holds the visible order past them, and Settings still trails everything.
    assert.deepEqual([...sheet.querySelectorAll(".rail-more-item")].map((el) => el.textContent),
      ["Connections", "Agent Skills", "Projects", "Archived Sessions", "Usage & Cost",
        "Settings"],
      "Settings is the trailing row, after every destination");
    assert.equal(sheet.querySelector(".rail-more-control"), null,
      "the sheet must contain no nested dialog or menu content");
    // Every child of a role=menu must be a menu item, or roving navigation silently skips it.
    assert.equal(sheet.querySelectorAll(':scope > *:not([role="menuitem"])').length, 0);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    restore();
  }
});

test("More closes when the viewport leaves the phone breakpoint", async () => {
  // moreOpen survived the breakpoint crossing while overflowItems emptied, so rotating to a
  // landscape width above 760px and back remounted the sheet and its backdrop with focus on
  // <body> — roving keys dead until a pointer dismissal.
  let phone = true;
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: phone,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(
      <Rail
        view={{ name: "inbox" }}
        blockedCount={0}
        stalledCount={0}
        onlineConnections={0}
        onNavigate={() => undefined}
      />,
    );
  });

  try {
    await render();
    await act(async () => {
      (container.querySelector(".rail-more-trigger") as unknown as HTMLButtonElement).click();
    });
    assert.ok(container.querySelector(".rail-more-sheet"), "sheet opens on a phone");

    phone = false;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize") as never); });
    await render();

    phone = true;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize") as never); });
    await render();

    assert.equal(container.querySelector(".rail-more-sheet"), null,
      "returning to phone width must not resurrect the sheet");
    assert.equal(container.querySelector(".menu-backdrop"), null,
      "a stranded backdrop would swallow every tap");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.matchMedia = prior;
  }
});

test("More reports the current page when an overflow destination is selected", async () => {
  // The link carrying aria-current is unmounted while the sheet is closed, so a screen-reader user
  // on Usage previously found no current-page element anywhere in Primary Navigation.
  const restore = stubPhoneWidth();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <Rail
          view={{ name: "usage" }}
          blockedCount={0}
          stalledCount={0}
          onlineConnections={0}
          onNavigate={() => undefined}
        />,
      );
    });
    const trigger = container.querySelector(".rail-more-trigger")!;
    assert.equal(trigger.getAttribute("aria-current"), "page");
    assert.match(trigger.getAttribute("aria-label") ?? "", /Usage & Cost selected/);
    assert.equal(container.querySelector('[aria-current="page"]'), trigger,
      "exactly one element may claim the current page");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    restore();
  }
});

test("only one element claims the current page while More is open", async () => {
  // The trigger stands in for the selected destination only while the sheet is CLOSED. With it
  // open, a screen reader previously met both "More Destinations, current page" and
  // "Usage & Cost, current page" inside Primary Navigation.
  const restore = stubPhoneWidth();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <Rail
          view={{ name: "usage" }}
          blockedCount={0}
          stalledCount={0}
          onlineConnections={0}
          onNavigate={() => undefined}
        />,
      );
    });
    assert.equal(container.querySelectorAll('[aria-current="page"]').length, 1);

    await act(async () => {
      (container.querySelector(".rail-more-trigger") as unknown as HTMLButtonElement).click();
    });
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    assert.equal(current.length, 1, "exactly one current-page element while the sheet is open");
    assert.ok(current[0]!.classList.contains("rail-more-item"),
      "the selected destination owns it once the sheet is open, not the trigger");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    restore();
  }
});

test("the phone More trigger reads as current on the Settings route and the row navigates", async () => {
  // Settings is not a GLOBAL_VIEW_ITEMS entry, so neither selectedRailView nor the trigger's
  // "<title> selected" lookup covers it. Untracked, a user standing in Settings saw a bar with
  // nothing selected, and a screen reader heard a collapsed "More Destinations" naming no page.
  const restore = stubPhoneWidth();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const navigated: View[] = [];
  try {
    await act(async () => {
      root.render(
        <Rail
          view={{ name: "settings", section: "appearance" }}
          blockedCount={0}
          stalledCount={0}
          onlineConnections={0}
          onNavigate={(destination) => navigated.push(destination)}
        />,
      );
    });

    const trigger = container.querySelector(".rail-more-trigger")! as unknown as HTMLButtonElement;
    assert.ok(trigger.classList.contains("active"), "the closed trigger carries the selected state");
    assert.equal(trigger.getAttribute("aria-current"), "page");
    assert.equal(trigger.getAttribute("aria-label"), "More Destinations, Settings selected");

    await act(async () => { trigger.click(); });
    const row = container.querySelector(".rail-more-settings")! as unknown as HTMLAnchorElement;
    assert.equal(row.getAttribute("role"), "menuitem", "roving navigation must not skip it");
    assert.equal(row.getAttribute("aria-current"), "page");
    assert.ok(row.classList.contains("active"));
    assert.equal(row.getAttribute("href"), "/settings/appearance",
      "the row is a real link, so it survives middle-click and copy-link");
    assert.equal(container.querySelectorAll('[aria-current="page"]').length, 1,
      "the row takes the current-page marker from the trigger while the sheet is open");

    // Space, not click: an <a> never activates on Space natively, and role="menuitem" promises it.
    await act(async () => {
      row.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: " ", bubbles: true }) as never);
    });
    assert.deepEqual(navigated, [{ name: "settings" }]);
    assert.equal(container.querySelector(".rail-more-sheet"), null, "activating a row closes the sheet");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    restore();
  }
});


test("crossing to desktop from the Settings row hands focus to the desktop gear", async () => {
  // Settings has no rail-item on either side of the crossing, so the destination selector had
  // nothing active to match and dropped focus on Inbox — rotating a phone into landscape while
  // standing in Settings landed the user on a page they had not opened.
  let phone = true;
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: phone,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(
      <Rail
        view={{ name: "settings", section: "network" }}
        blockedCount={0}
        stalledCount={0}
        onlineConnections={0}
        onNavigate={() => undefined}
        settingsControl={<button type="button" className="settings-trigger">Settings</button>}
      />,
    );
  });

  try {
    await render();
    await act(async () => {
      (container.querySelector(".rail-more-trigger") as unknown as HTMLButtonElement).click();
    });
    const row = container.querySelector(".rail-more-settings") as unknown as HTMLAnchorElement;
    await act(async () => { row.focus(); });
    // Identity, never assert.equal: a failed deep-diff of two DOM nodes serialises the whole tree
    // and takes the runner out with it.
    assert.ok(domWindow.document.activeElement === (row as never), "the sheet row owns focus first");

    phone = false;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize") as never); });
    await render();
    // The handoff is deferred to a frame, so let one elapse before reading focus.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    const gear = container.querySelector(".rail-settings .settings-trigger");
    assert.ok(gear, "the desktop layout mounts the gear");
    const focused = domWindow.document.activeElement as unknown as Element | null;
    assert.ok(focused === (gear as never),
      `focus must land on the same page, not on the first destination — got ${focused?.className ?? "nothing"}`);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.matchMedia = prior;
  }
});

test("hiding and reordering renumber the surviving destinations", async () => {
  // Position IS the binding (#385): Automations gone means Multi-Agent holds digit 2 — the digit
  // never goes dead the way the pre-#385 canonical anchoring left it.
  resetRailPreferencesForTest();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(
      <Rail
        view={{ name: "inbox" }}
        blockedCount={0}
        stalledCount={0}
        onlineConnections={0}
        onNavigate={() => undefined}
      />,
    );
  });
  try {
    await render();
    setRailViewHidden("automations", true);
    await render();
    let links = [...container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")];
    assert.equal(links.length, 8, "a hidden destination leaves the rail");
    assert.equal(links[1]!.getAttribute("href"), "/runs");
    assert.equal(links[1]!.querySelector(".rail-number")?.textContent, "2",
      "the survivor inherits the digit; nothing goes dead");
    assert.match(links[1]!.getAttribute("aria-label") ?? "", /\(2\)/);

    setRailViewHidden("automations", false);
    moveRailView("usage", "up");
    await render();
    links = [...container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")];
    assert.equal(links[7]!.getAttribute("href"), "/usage");
    assert.equal(links[7]!.querySelector(".rail-number")?.textContent, "8");
    assert.equal(links[8]!.getAttribute("href"), "/archived");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    resetRailPreferencesForTest();
    domWindow.localStorage.clear();
  }
});
