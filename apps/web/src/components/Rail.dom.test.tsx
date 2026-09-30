import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Rail } from "./Rail.js";
import { saveSessionsViewMode } from "../sessions-view-mode.js";
import {
  RAIL_PREFERENCES_STORAGE_KEY,
  moveRailView,
  resetRailPreferencesForTest,
  setRailViewHidden,
} from "../rail-preferences.js";
import { saveInstanceStorageValue } from "../instance-storage.js";
import { GLOBAL_VIEW_ITEMS, type View } from "../navigation.js";
import { withCapturedAnimationFrames } from "./test-clock-overrides.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

/** The More sheet: the shared portalled menu, so it lives in <body>. */
const MORE_SHEET = '[role="menu"][aria-label="More Destinations"]';

/** The More sheet's Settings row: the sheet is the shared portalled menu, so it lives in <body>. */
function settingsRow(): HTMLAnchorElement | null {
  return [...(domWindow.document as unknown as Document).querySelectorAll<HTMLAnchorElement>('[role="menu"][aria-label="More Destinations"] .menu-item')]
    .find((row) => row.textContent === "Settings") ?? null;
}

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
  // Work, Oversight, Records (§4.1).
  assert.deepEqual(links.map((link) => link.getAttribute("href")), [
    "/", "/automations", "/projects", "/runs", "/pods", "/connections/machines", "/skills", "/archived", "/usage",
  ]);
  // With Board folded into Sessions (#499), all nine destinations carry a digit keycap.
  assert.equal(links[8]!.querySelector(".rail-number")?.textContent, "9",
    "the Records group ends at Usage and Cost with the ninth digit");
  // One name per destination: the accessible name begins with the name the tooltip shows, so a
  // screen-reader user hears the words on screen (label in name).
  assert.deepEqual(links.map((link) => link.getAttribute("title")), [
    "Sessions (1)", "Automations (2)", "Projects (3)", "Multi-Agent Runs (4)", "Pods (5)", "Connections (6)",
    "Agent Skills (7)", "Archived Sessions (8)", "Usage and Cost (9)",
  ]);
  for (const [index, item] of GLOBAL_VIEW_ITEMS.entries()) {
    assert.ok(links[index]!.getAttribute("aria-label")!.startsWith(`${item.name} (${index + 1})`), item.name);
  }
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /^Sessions/);
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /2 Blocked/);
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /1 Stalled/);
  assert.match(links[5]!.getAttribute("aria-label") ?? "", /3 Online/);
  assert.equal(links[0]!.getAttribute("aria-current"), "page", "session detail belongs to Sessions");
  assert.equal(links[0]!.querySelector(".rail-badge.blocked")?.getAttribute("aria-hidden"), "true");
  assert.equal(links[0]!.querySelector(".rail-badge.stalled")?.getAttribute("aria-hidden"), "true");
  const summary = container.querySelector<HTMLElement>('[role="status"]')!;
  assert.equal(summary.getAttribute("aria-live"), "polite");
  assert.match(summary.textContent ?? "", /Sessions: 2 Blocked, 1 Stalled/);

  await render({ name: "run", id: "run-1" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[3]!.getAttribute("aria-current"), "page");
  await render({ name: "pod", id: "pod-1" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[4]!.getAttribute("aria-current"), "page");

  await render({ name: "projects" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[2]!.getAttribute("aria-current"), "page");

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
  // The phone bar carries four labelled destinations plus More. Creation lives in the Inbox toolbar
  // and the instance switcher lives in the top bar.
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
      ["/", "/projects", "/connections/machines", "/automations"],
      "the default bar is Sessions, Projects, Connections and Automations, even with every experiment on (#1959)");
    // Every tab is labelled with its one name, the icon in its pill above it.
    assert.deepEqual(
      [...bar.querySelectorAll(".rail-item")].map((item) => item.querySelector(".rail-tab-label")?.textContent),
      ["Sessions", "Projects", "Connections", "Automations", "More"]);
    for (const item of bar.querySelectorAll(".rail-item")) {
      assert.ok(item.querySelector(".rail-tab-pill > svg"), "the icon sits in the tab's pill");
    }
    const connections = bar.querySelector<HTMLAnchorElement>('a[href="/connections/machines"]')!;
    assert.equal(connections.querySelector(".rail-badge")?.textContent, "1");
    assert.match(connections.getAttribute("aria-label") ?? "", /^Connections, 1 Online$/,
      "the accessible name stays the full name, however the label is clipped");

    // Nothing that owns its own overlay may live in the bar or the sheet.
    assertNoDomNode(container.querySelector(".rail-instance"));
    assertNoDomNode(container.querySelector(".rail-settings"));
    assertNoDomNode(container.querySelector(".rail-action"));
    assertNoDomNode(container.querySelector(".rail-fab"),
      "no floating button: that band is occupied by the shell dock and the toast stack");
    assert.equal(container.querySelectorAll(".rail-number").length, 0);

    const moreTrigger = container.querySelector(".rail-more-trigger")! as unknown as HTMLButtonElement;
    await act(async () => { moreTrigger.click(); });
    const sheet = (domWindow.document as unknown as Document).querySelector(MORE_SHEET)!;
    // More holds every other visible destination in rail order, and Settings trails everything.
    assert.deepEqual([...sheet.querySelectorAll(".menu-item")].map((el) => el.querySelector(".menu-text")?.textContent),
      ["Multi-Agent Runs", "Pods", "Agent Skills", "Archived Sessions", "Usage and Cost",
        "Settings"],
      "Settings is the trailing row, after every destination");
    const sep = sheet.querySelector('[role="separator"]')!;
    assert.equal(sep.nextElementSibling?.querySelector(".menu-text")?.textContent, "Settings",
      "a separator stands between the destinations and Settings");
    // A real sheet: a "More" title with a Close button, which closes it like the scrim.
    assert.equal(sheet.querySelector(".menu-head-title")?.textContent, "More");
    const close = sheet.querySelector<HTMLButtonElement>('button[aria-label="Close More"]')!;
    assert.equal(close.getAttribute("role"), "menuitem", "every element the menu owns keeps a menu role");
    assertNoDomNode(sheet.querySelector(".rail-more-control"),
      "the sheet must contain no nested dialog or menu content");
    // Every child of a role=menu must be a menu item, or roving navigation silently skips it. The
    // sheet's grabber is decorative, its title row is presentational around the Close item, and
    // the separator is not focusable.
    assert.equal(sheet.querySelectorAll(
      ':scope > *:not([role="menuitem"], [role="separator"], [role="presentation"], [aria-hidden="true"])').length, 0);
    await act(async () => { close.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, detail: 1 }) as never); });
    assertNoDomNode((domWindow.document as unknown as Document).querySelector(MORE_SHEET), "Close closes the sheet");
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
    assert.ok((domWindow.document as unknown as Document).querySelector(MORE_SHEET), "sheet opens on a phone");

    phone = false;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize") as never); });
    await render();

    phone = true;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize") as never); });
    await render();

    assertNoDomNode((domWindow.document as unknown as Document).querySelector(MORE_SHEET),
      "returning to phone width must not resurrect the sheet");
    assertNoDomNode(domWindow.document.querySelector(".menu-backdrop"),
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
    assert.match(trigger.getAttribute("aria-label") ?? "", /Usage and Cost selected/);
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
  // "Usage and Cost, current page" inside Primary Navigation.
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
    assert.equal(domWindow.document.querySelectorAll('[aria-current="page"]').length, 1);

    await act(async () => {
      (container.querySelector(".rail-more-trigger") as unknown as HTMLButtonElement).click();
    });
    const current = [...domWindow.document.querySelectorAll('[aria-current="page"]')];
    assert.equal(current.length, 1, "exactly one current-page element while the sheet is open");
    assert.ok(current[0]!.classList.contains("menu-item"),
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
    const row = settingsRow()! as unknown as HTMLAnchorElement;
    assert.equal(row.getAttribute("role"), "menuitem", "roving navigation must not skip it");
    assert.equal(row.getAttribute("aria-current"), "page");
    assert.ok(row.classList.contains("is-active"));
    assert.equal(row.getAttribute("href"), "/settings/appearance",
      "the row is a real link, so it survives middle-click and copy-link");
    assert.equal(domWindow.document.querySelectorAll('[aria-current="page"]').length, 1,
      "the row takes the current-page marker from the trigger while the sheet is open");

    // Space, not click: an <a> never activates on Space natively, and role="menuitem" promises it.
    await act(async () => {
      row.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: " ", bubbles: true }) as never);
    });
    assert.deepEqual(navigated, [{ name: "settings" }]);
    assertNoDomNode((domWindow.document as unknown as Document).querySelector(MORE_SHEET), "activating a row closes the sheet");
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
    const row = settingsRow() as unknown as HTMLAnchorElement;
    await act(async () => { row.focus(); });
    // Identity, never assert.equal: a failed deep-diff of two DOM nodes serialises the whole tree
    // and takes the runner out with it.
    assert.ok(domWindow.document.activeElement === (row as never), "the sheet row owns focus first");

    await withCapturedAnimationFrames(domWindow, async (frames) => {
      phone = false;
      await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize") as never); });
      await render();
      assert.ok(frames.pending() > 0, "the viewport handoff schedules a focus frame");
      const gear = container.querySelector(".rail-settings .settings-trigger");
      assert.ok(gear, "the desktop layout mounts the gear");
      assert.ok(domWindow.document.activeElement !== (gear as never), "focus waits for the frame");
      await act(async () => { frames.flush(); });
      const focused = domWindow.document.activeElement as unknown as Element | null;
      assert.ok(focused === (gear as never),
        `focus must land on the same page, not on the first destination — got ${focused?.className ?? "nothing"}`);
    });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.matchMedia = prior;
  }
});

test("hiding and reordering renumber the surviving destinations", async () => {
  // Position IS the binding (#385): Automations gone means Projects holds digit 2 — the digit
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
    assert.equal(links[1]!.getAttribute("href"), "/projects");
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

test("overflowed destinations keep their status counts and Sessions keeps its saved mode", async () => {
  // Round-1 review findings on #532: a counted destination moved into the sheet takes its count
  // WITH it — and a Sessions row pushed into the sheet must open the persisted list/board mode
  // exactly like the bar item and the digit do.
  resetRailPreferencesForTest();
  const restore = stubPhoneWidth();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const navigated: View[] = [];
  const render = () => act(async () => {
    root.render(
      <Rail
        view={{ name: "projects" }}
        blockedCount={2}
        stalledCount={1}
        onlineConnections={3}
        onNavigate={(destination) => navigated.push(destination)}
      />,
    );
  });
  try {
    // Sessions reaches the sheet only when the user leaves it off a chosen bar.
    saveInstanceStorageValue(RAIL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ v: 1, order: [], hidden: [], phoneBar: ["projects", "automations", "skills", "usage"] }));
    resetRailPreferencesForTest();
    await render();
    await act(async () => {
      (container.querySelector(".rail-more-trigger") as unknown as HTMLButtonElement).click();
    });
    const sheet = (domWindow.document as unknown as Document).querySelector(MORE_SHEET)!;
    const sessionsRow = [...sheet.querySelectorAll<HTMLAnchorElement>(".menu-item")]
      .find((row) => row.querySelector(".menu-text")?.textContent === "Sessions")!;
    assert.equal(sessionsRow.querySelector(".rail-more-count.blocked")?.textContent, "2");
    assert.equal(sessionsRow.querySelector(".rail-more-count.stalled")?.textContent, "1");
    assert.match(sessionsRow.getAttribute("aria-label") ?? "", /2 Blocked/);
    const connectionsRow = [...sheet.querySelectorAll<HTMLElement>(".menu-item")]
      .find((row) => row.querySelector(".menu-text")?.textContent === "Connections")!;
    assert.equal(connectionsRow.querySelector(".rail-more-count")?.textContent, "3");
    assert.match(connectionsRow.getAttribute("aria-label") ?? "", /3 Online/);

    saveSessionsViewMode("board");
    sessionsRow.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, button: 0 }) as never);
    assert.deepEqual(navigated.at(-1), { name: "board" },
      "an overflowed Sessions row honors the persisted board mode");
  } finally {
    saveSessionsViewMode("list");
    await act(async () => { root.unmount(); });
    container.remove();
    restore();
    resetRailPreferencesForTest();
    domWindow.localStorage.clear();
  }
});

/** A phone of the given height class: every width query matches, and max-height only when short. */
function stubPhone({ short }: { short: boolean }) {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-height") ? short : true,
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

async function mountPhoneRail(view: View, navigated: View[] = []) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(
      <Rail
        view={view}
        blockedCount={0}
        stalledCount={0}
        onlineConnections={0}
        onNavigate={(destination) => navigated.push(destination)}
      />,
    );
  });
  await render();
  return {
    container,
    render,
    trigger: () => container.querySelector(".rail-more-trigger") as unknown as HTMLButtonElement,
    sheet: () => (domWindow.document as unknown as Document).querySelector<HTMLElement>(MORE_SHEET),
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const flushFocusRestore = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const focused = () => domWindow.document.activeElement as unknown;

test("a hidden default tab is replaced in place by the next non-experimental destination", async () => {
  resetRailPreferencesForTest();
  const restore = stubPhone({ short: false });
  const rail = await mountPhoneRail({ name: "inbox" });
  try {
    setRailViewHidden("projects", true);
    await rail.render();
    assert.deepEqual(
      [...rail.container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a.rail-item")]
        .map((item) => item.getAttribute("href")),
      ["/", "/skills", "/connections/machines", "/automations"],
      "Multi-Agent Runs and Pods come first in rail order, but an experiment never fills a slot");
    await act(async () => { rail.trigger().click(); });
    assert.deepEqual(
      [...rail.sheet()!.querySelectorAll(".menu-item .menu-text")].map((text) => text.textContent),
      ["Multi-Agent Runs", "Pods", "Archived Sessions", "Usage and Cost", "Settings"],
      "the hidden destination is in neither the bar nor the sheet");
  } finally {
    await rail.unmount();
    restore();
    resetRailPreferencesForTest();
    domWindow.localStorage.clear();
  }
});

test("More opens focused on the sheet and hands focus back only after a keyboard close", async () => {
  // A tap that closed the sheet used to return focus to More, so the next page showed More ringed
  // or filled next to the real current tab (#1959).
  const restore = stubPhone({ short: false });
  const navigated: View[] = [];
  const rail = await mountPhoneRail({ name: "inbox" }, navigated);
  const doc = domWindow.document as unknown as Document;
  const row = (name: string) => [...rail.sheet()!.querySelectorAll<HTMLElement>(".menu-item")]
    .find((item) => item.querySelector(".menu-text")?.textContent === name)!;
  const tap = (element: HTMLElement) => act(async () => {
    element.dispatchEvent(
      new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }) as never);
  });
  const press = (element: HTMLElement, key: string) => act(async () => {
    element.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }) as never);
  });
  try {
    // Open with a tap: the sheet itself takes focus, so no row is ringed or filled.
    await act(async () => { rail.trigger().focus(); rail.trigger().click(); });
    assert.equal(rail.sheet()!.getAttribute("tabindex"), "-1");
    assert.ok(focused() === rail.sheet(), "the sheet, not a row, holds focus on open");

    // The arrow keys still rove from there.
    await press(rail.sheet()!, "End");
    assert.ok(focused() === row("Settings"), "End reaches the last row");
    await press(rail.sheet()!, "Home");
    assert.ok(focused() === doc.querySelector('[aria-label="Close More"]'), "Home reaches the first item");
    await press(rail.sheet()!, "ArrowDown");
    assert.ok(focused() === row("Multi-Agent Runs"), "ArrowDown moves to the first destination row");

    // A tapped row navigates and leaves focus off More.
    await tap(row("Usage and Cost"));
    await flushFocusRestore();
    assert.deepEqual(navigated.at(-1), { name: "usage" });
    assertNoDomNode(rail.sheet());
    assert.ok(focused() !== rail.trigger(), "a tap never hands focus back to More");

    // A scrim tap closes without restoring either.
    await act(async () => { rail.trigger().click(); });
    await tap(doc.querySelector<HTMLElement>(".menu-backdrop")!);
    await flushFocusRestore();
    assertNoDomNode(rail.sheet());
    assert.ok(focused() !== rail.trigger(), "the scrim never hands focus back to More");

    // Nor does a tapped Close.
    await act(async () => { rail.trigger().click(); });
    await tap(doc.querySelector<HTMLElement>('[aria-label="Close More"]')!);
    await flushFocusRestore();
    assertNoDomNode(rail.sheet());
    assert.ok(focused() !== rail.trigger(), "a tapped Close never hands focus back to More");

    // Escape is a keyboard close: focus returns to More, where the keyboard user left it.
    await act(async () => { rail.trigger().click(); });
    await press(rail.sheet()!, "Escape");
    await flushFocusRestore();
    assertNoDomNode(rail.sheet());
    assert.ok(focused() === rail.trigger(), "Escape returns focus to More");

    // Enter on a row dispatches a click with no pointer press behind it (detail 0): also a
    // keyboard close.
    await act(async () => { rail.trigger().click(); });
    await act(async () => {
      row("Pods").dispatchEvent(
        new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 }) as never);
    });
    await flushFocusRestore();
    assert.deepEqual(navigated.at(-1), { name: "pods" });
    assert.ok(focused() === rail.trigger(), "a keyboard activation keeps the user's place on More");

    // Opening from the keyboard with an arrow key still lands on a row.
    await press(rail.trigger(), "ArrowUp");
    assert.ok(focused() === row("Settings"), "ArrowUp on More opens onto the last row");
  } finally {
    await rail.unmount();
    restore();
  }
});

test("the current More row carries the selected state, and More stands in for it on the bar", async () => {
  const restore = stubPhone({ short: false });
  const rail = await mountPhoneRail({ name: "usage" });
  try {
    const trigger = rail.trigger();
    assert.ok(trigger.classList.contains("active"), "More is the current tab on an overflow page");
    assert.equal(trigger.getAttribute("aria-current"), "page");
    assert.equal(trigger.querySelector(".rail-tab-label")?.textContent, "More");
    await act(async () => { trigger.click(); });
    const current = [...rail.sheet()!.querySelectorAll('[aria-current="page"]')];
    assert.equal(current.length, 1);
    assert.equal(current[0]!.querySelector(".menu-text")?.textContent, "Usage and Cost");
  } finally {
    await rail.unmount();
    restore();
  }
});

test("on a short screen the More sheet lays its rows out in two columns", async () => {
  // At 568x320 a single column pushed Settings out of view with no affordance (#1959).
  for (const short of [false, true]) {
    const restore = stubPhone({ short });
    const rail = await mountPhoneRail({ name: "inbox" });
    try {
      await act(async () => { rail.trigger().click(); });
      assert.ok(rail.sheet()!.classList.contains("rail-more-sheet"));
      assert.equal(rail.sheet()!.classList.contains("two-column"), short,
        short ? "a short viewport gets the two-column layout" : "a tall one keeps a single column");
    } finally {
      await rail.unmount();
      restore();
    }
  }
});
