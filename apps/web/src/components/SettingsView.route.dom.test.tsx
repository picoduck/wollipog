import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { SETTINGS_SECTIONS, type SettingsSection, type View } from "../navigation.js";
import { SETTINGS_DESCRIPTION, SettingsView, settingsIndexGroups } from "./SettingsView.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * The Settings route frame at each width (#3018): a selected section nav on desktop, link tabs in
 * the page header in the compact tier, and on a phone a section index whose rows open each section
 * under a detail bar with Back.
 */

type Tier = "desktop" | "compact" | "phone";
let tier: Tier = "desktop";

const domWindow = new Window({ url: "http://localhost/settings" });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() {
      if (query === "(max-width: 760px)") return tier === "phone";
      if (query === "(min-width: 761px) and (max-width: 1099px)") return tier === "compact";
      return false;
    },
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

/** A panel with state of its own, like an open editor, so a remount would show as a reset count. */
function Counter({ title }: { title: string }) {
  const [count, setCount] = React.useState(0);
  return <button type="button" className="panel-body" onClick={() => setCount(count + 1)}>{title} content {count}</button>;
}

const panels = Object.fromEntries(SETTINGS_SECTIONS.map(({ id, title }) => [
  id,
  <Counter key={id} title={title} />,
])) as Record<SettingsSection, ReactNode>;

async function render(at: Tier, section?: SettingsSection) {
  tier = at;
  const navigated: View[] = [];
  // The shell's `.main-body` is Settings' one scroller (§4.5).
  const scroller = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  scroller.className = "main-body";
  document.body.append(scroller);
  const root = createRoot(scroller);
  const view = (next?: SettingsSection) => (
    <SettingsView section={next} onNavigate={(target) => navigated.push(target)} onOpenShortcuts={() => undefined} panels={panels} />
  );
  await act(async () => root.render(view(section)));
  return {
    scroller,
    navigated,
    async show(next?: SettingsSection) {
      await act(async () => root.render(view(next)));
    },
    async unmount() {
      await act(async () => root.unmount());
      scroller.remove();
    },
  };
}

function click(element: Element, init: { metaKey?: boolean } = {}) {
  const event = new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  element.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
}

test("desktop: the section nav marks the current section as selected, with an icon per section", async () => {
  const view = await render("desktop", "approvals");
  try {
    const page = view.scroller;
    assert.equal(page.querySelector("#page-title")?.textContent, "Settings");
    assert.equal(page.querySelector(".page-desc")?.textContent, SETTINGS_DESCRIPTION);
    const nav = page.querySelector('nav.settings-nav[aria-label="Settings Sections"]')!;
    const items = [...nav.querySelectorAll("a.settings-nav-item")];
    assert.deepEqual(items.map((item) => item.textContent), SETTINGS_SECTIONS.map((entry) => entry.title));
    assert.deepEqual(items.map((item) => item.getAttribute("href")), SETTINGS_SECTIONS.map((entry) => `/settings/${entry.id}`));
    for (const item of items) {
      assert.equal(item.querySelectorAll(".row-icon > svg").length, 1, `${item.textContent} has its 16px icon`);
    }
    const current = items.filter((item) => item.getAttribute("aria-current") === "page");
    assert.deepEqual(current.map((item) => item.textContent), ["Approvals"]);
    assert.ok(current[0]!.classList.contains("is-selected"), "the §5.2 selected state, not a hover-like wash");
    assert.equal(nav.querySelectorAll(".is-selected").length, 1);
    assertNoDomNode(page.querySelector('[role="tablist"]'), "routes are links, never a tablist");
    assertNoDomNode(page.querySelector(".page-tabs"));
    assert.equal(page.querySelector("#settings-panel-heading")?.textContent, "Approvals");
    assert.equal(page.querySelector(".settings-panel-desc")?.textContent,
      SETTINGS_SECTIONS.find((entry) => entry.id === "approvals")!.description);
    assertNoDomNode(page.querySelector(".settings-panel-scope"), "Approvals' groups are kept in different places");
    assert.equal(page.querySelector(".panel-body")?.textContent, "Approvals content 0");

    assert.equal(click(items[0]!), true, "a plain click navigates in place");
    assert.deepEqual(view.navigated, [{ name: "settings", section: "appearance" }]);
    assert.equal(click(items[1]!, { metaKey: true }), false, "a modified click is the browser's");
    assert.equal(view.navigated.length, 1);
  } finally {
    await view.unmount();
  }
});

test("desktop and compact: /settings opens Appearance, which names where it is kept", async () => {
  for (const at of ["desktop", "compact"] as const) {
    const view = await render(at);
    try {
      assert.equal(view.scroller.querySelector("#settings-panel-heading")?.textContent, "Appearance", at);
      assert.equal(view.scroller.querySelector('[aria-current="page"]')?.textContent, "Appearance", at);
      assert.equal(view.scroller.querySelector(".settings-panel-scope")?.textContent, "This Device", at);
      assertNoDomNode(view.scroller.querySelector(".settings-index"), `${at} has no index`);
    } finally {
      await view.unmount();
    }
  }
});

test("compact: the sections are link tabs in the page header, and the side column is gone", async () => {
  const view = await render("compact", "about");
  try {
    const page = view.scroller;
    assertNoDomNode(page.querySelector(".settings-nav"), "the 180px column gives its width to the panel");
    const tabs = page.querySelector('.page-header > .page-tabs > nav.tabs[aria-label="Settings Sections"]')!;
    assert.ok(tabs, "the tabs are the header's last row");
    assert.equal(tabs.getAttribute("role"), null, "a nav of links, not a tablist");
    const links = [...tabs.querySelectorAll("a.tab")];
    assert.deepEqual(links.map((link) => link.textContent), SETTINGS_SECTIONS.map((entry) => entry.title));
    assert.ok(links.every((link) => link.getAttribute("role") === null && link.getAttribute("aria-selected") === null));
    assert.deepEqual(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent), ["About"]);
    assert.equal(click(links[2]!), true);
    assert.deepEqual(view.navigated, [{ name: "settings", section: "keyboard" }]);
  } finally {
    await view.unmount();
  }
});

test("phone: /settings is an index of two-line rows in three groups, none of them selected", async () => {
  const view = await render("phone");
  try {
    const page = view.scroller;
    assert.equal(page.querySelector("#page-title")?.textContent, "Settings");
    assertNoDomNode(page.querySelector(".settings-panel"), "the index is a screen of its own");
    assertNoDomNode(page.querySelector(".detail-bar"));
    const surfaces = [...page.querySelectorAll('nav.settings-index[aria-label="Settings Sections"] > .surface')];
    assert.deepEqual(
      surfaces.map((surface) => [...surface.querySelectorAll(".row-title")].map((title) => title.textContent)),
      settingsIndexGroups().map((group) => group.map((entry) => entry.title)),
    );
    assert.deepEqual(settingsIndexGroups().map((group) => group[0]!.id), ["appearance", "approvals", "network"]);
    const rows = [...page.querySelectorAll(".settings-index a.row.row-2")];
    assert.equal(rows.length, SETTINGS_SECTIONS.length);
    for (const [index, row] of rows.entries()) {
      const entry = SETTINGS_SECTIONS[index]!;
      assert.equal(row.getAttribute("href"), `/settings/${entry.id}`);
      assert.equal(row.querySelectorAll(".row-icon > svg").length, 1, `${entry.title} has an icon`);
      assert.equal(row.querySelector(".row-sub")?.textContent, entry.description);
      assert.equal(row.querySelectorAll(".settings-index-chevron > svg").length, 1, `${entry.title} has a chevron`);
      assert.equal(row.getAttribute("aria-current"), null, "no row is ever current on the index");
      assert.ok(!row.classList.contains("is-selected"));
    }
    assert.equal(click(rows.find((row) => row.textContent?.startsWith("Approvals"))!), true);
    assert.deepEqual(view.navigated, [{ name: "settings", section: "approvals" }]);
  } finally {
    await view.unmount();
  }
});

test("phone: a section opens under a detail bar whose Back returns to the index", async () => {
  const view = await render("phone", "approvals");
  try {
    const page = view.scroller;
    const bar = page.querySelector(".detail-bar")!;
    assert.equal(bar.querySelector("h1#page-title")?.textContent, "Approvals");
    const back = bar.querySelector<HTMLButtonElement>(".detail-bar-back")!;
    assert.equal(back.getAttribute("aria-label"), "Back to Settings");
    assertNoDomNode(page.querySelector(".page-header"), "the detail bar is the app bar");
    assertNoDomNode(page.querySelector(".settings-nav, .settings-index, .tabs"));
    assert.equal(page.querySelector(".settings-detail > .settings-view .panel-body")?.textContent, "Approvals content 0");
    await act(async () => { back.click(); });
    assert.deepEqual(view.navigated, [{ name: "settings" }]);
  } finally {
    await view.unmount();
  }
});

test("phone: a section opens at its top, and Back puts the index where it was left", async () => {
  const view = await render("phone");
  try {
    view.scroller.scrollTop = 320;
    view.scroller.dispatchEvent(new domWindow.Event("scroll") as unknown as Event);
    await view.show("approvals");
    assert.equal(view.scroller.scrollTop, 0, "the section starts at its top");
    view.scroller.scrollTop = 90;
    await view.show(undefined);
    assert.equal(view.scroller.scrollTop, 320, "the index comes back where it was");
  } finally {
    await view.unmount();
  }
});

test("a panel keeps its state when the width crosses a breakpoint", async () => {
  const view = await render("desktop", "behavior");
  try {
    const body = () => view.scroller.querySelector<HTMLButtonElement>(".panel-body")!;
    await act(async () => { body().click(); });
    await act(async () => { body().click(); });
    assert.equal(body().textContent, "Behavior content 2");
    for (const at of ["phone", "compact", "desktop"] as const) {
      tier = at;
      await view.show("behavior");
      assert.equal(body().textContent, "Behavior content 2", `still open after crossing to ${at}`);
    }
    assert.ok(view.scroller.querySelector(".settings-nav"), "and the layout did change");
  } finally {
    await view.unmount();
  }
});
