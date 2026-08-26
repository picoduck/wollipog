import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Rail } from "./Rail.js";
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
};

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: domWindow.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: domWindow.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: domWindow.HTMLButtonElement });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: priorNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLButtonElement });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
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
  assert.equal(links.length, 10);
  assert.deepEqual(links.map((link) => link.getAttribute("href")), [
    "/", "/projects", "/board", "/runs", "/pods", "/automations", "/usage", "/connections/machines", "/archived", "/skills",
  ]);
  // The tenth destination advertises no keycap: the bare digit shortcuts stop at 9.
  assert.equal(links[9]!.querySelector(".rail-number"), null);
  assert.doesNotMatch(links[9]!.getAttribute("aria-label") ?? "", /\(10\)/);
  assert.ok(links[8]!.querySelector(".rail-number"), "numbered destinations keep their keycaps");
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /2 Blocked/);
  assert.match(links[0]!.getAttribute("aria-label") ?? "", /1 Stalled/);
  assert.match(links[7]!.getAttribute("aria-label") ?? "", /3 Online/);
  assert.equal(links[0]!.getAttribute("aria-current"), "page", "session detail belongs to Inbox");
  assert.equal(links[0]!.querySelector(".rail-badge.blocked")?.getAttribute("aria-hidden"), "true");
  assert.equal(links[0]!.querySelector(".rail-badge.stalled")?.getAttribute("aria-hidden"), "true");
  const summary = container.querySelector<HTMLElement>('[role="status"]')!;
  assert.equal(summary.getAttribute("aria-live"), "polite");
  assert.match(summary.textContent ?? "", /Inbox: 2 Blocked, 1 Stalled/);

  await render({ name: "run", id: "run-1" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[3]!.getAttribute("aria-current"), "page");
  await render({ name: "pod", id: "pod-1" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[4]!.getAttribute("aria-current"), "page");

  await render({ name: "projects" });
  assert.equal(container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[1]!.getAttribute("aria-current"), "page");

  const board = container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")[2]!;
  board.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, button: 0 }) as never);
  assert.deepEqual(navigated.at(-1), { name: "board" });
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

test("the phone rail is destinations-only and hosts no nested layers", async () => {
  // The phone bar now carries only destinations. Creation lives in the Inbox toolbar, while
  // Instance and Settings live in the top bar.
  //
  // The bar now carries four destinations plus More, and the sheet holds ONLY destinations. An
  // earlier revision put Instance and Settings inside the sheet; because those render their own
  // menu and dialog, their Tab and Escape events bubbled into the outer roving controller, so one
  // Tab tore down both layers and one Escape peeled two. They live in the topbar instead.
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
    assert.deepEqual([...sheet.querySelectorAll(".rail-more-item")].map((el) => el.textContent),
      ["Multi-Agent Runs", "Collaboration Pods", "Automations", "Usage & Cost", "Archived Sessions", "Agent Skills"]);
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
