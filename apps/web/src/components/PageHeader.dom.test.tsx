import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window();
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorNavigator = globalThis.navigator;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];
const priorElementGlobals = {
  HTMLElement: (globalThis as Record<string, unknown>)["HTMLElement"],
  HTMLButtonElement: (globalThis as Record<string, unknown>)["HTMLButtonElement"],
  MutationObserver: (globalThis as Record<string, unknown>)["MutationObserver"],
};

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: domWindow.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: domWindow.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: domWindow.HTMLButtonElement });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: domWindow.MutationObserver });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: priorNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLButtonElement });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: priorElementGlobals.MutationObserver });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
});

async function mount(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    async rerender(next: React.ReactNode) {
      await act(async () => root.render(next));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const press = async (target: Element, key: string) => {
  await act(async () => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
  });
};

test("the page header owns the page title and orders its actions for priority+ overflow", async () => {
  const calls: string[] = [];
  const action = (label: string) => ({ label, onClick: () => calls.push(label) });
  const view = await mount(
    <PageHeader
      title="Agent Skills"
      description="Write a skill once, then choose which machines and agents get it."
      secondary={[action("Import from Machine"), action("Manage Groups"), action("Import from Git")]}
      primary={action("New Skill")}
    />,
  );
  try {
    const { container } = view;
    const title = container.querySelector("h1")!;
    assert.equal(container.querySelectorAll("h1").length, 1);
    assert.equal(title.id, "page-title");
    assert.equal(title.getAttribute("tabindex"), "-1");
    assert.equal(title.className, "page-title");
    assert.equal(container.querySelector(".page-desc")?.textContent,
      "Write a skill once, then choose which machines and agents get it.");

    // §3.2: [secondaries] [⋯] [primary]. Only the two nearest the primary are buttons; the third
    // lives in ⋯ at every width, which marks ⋯ as always present. No instance switcher: the phone
    // app bar is never reached in the desktop app (#1970).
    const actions = [...container.querySelector(".page-actions")!.children];
    assert.deepEqual(actions.map((element) => element.className), [
      "btn page-action",
      "btn page-action",
      "overflow-menu page-more",
      "btn primary page-primary",
    ]);
    assert.deepEqual(
      [...container.querySelectorAll(".page-action")].map((button) => [button.textContent, button.getAttribute("data-slot")]),
      [["Manage Groups", "2"], ["Import from Git", "1"]],
    );
    assert.equal(container.querySelector(".page-more")!.getAttribute("data-overflow"), "always");
    const primary = container.querySelector<HTMLButtonElement>(".page-primary")!;
    assert.equal(primary.textContent, "New Skill", "the label is the primary's accessible name at every width");
    assert.ok(primary.querySelector("svg"), "a create action leads with the + icon");

    // With both buttons showing, ⋯ lists only the secondary that has no button. The pop is
    // portalled out of the header, which is a query container.
    const more = container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!;
    await act(async () => more.click());
    const menu = domWindow.document.querySelector('[role="menu"]')!;
    assert.equal(container.contains(menu as never), false, "the pop is not inside the header");
    assert.ok(menu.parentElement === domWindow.document.body, "the pop is a child of <body>");
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.textContent), ["Import from Machine"]);
    await act(async () => (items[0] as unknown as HTMLButtonElement).click());
    assert.deepEqual(calls, ["Import from Machine"]);
    assert.ok(domWindow.document.activeElement === (more as never), "choosing an item returns focus to ⋯");
  } finally {
    await view.unmount();
  }
});

test("⋯ lists exactly the secondaries whose buttons the header hid, plus its own items", async () => {
  const style = domWindow.document.createElement("style");
  // The compact tier: slot 2's button is hidden, slot 1's still shows.
  style.textContent = '.page-actions > .page-action[data-slot="2"] { display: none; }';
  domWindow.document.head.append(style);
  const view = await mount(
    <PageHeader
      title="Agent Skills"
      secondary={[
        { label: "Import from Machine", onClick: () => undefined },
        { label: "Manage Groups", onClick: () => undefined },
        { label: "Import from Git", onClick: () => undefined },
      ]}
      menu={[{ label: "Skill Settings", onClick: () => undefined }]}
    />,
  );
  try {
    const more = view.container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!;
    await act(async () => more.click());
    const menu = domWindow.document.querySelector('[role="menu"]') as unknown as Element;
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
      ["Import from Machine", "Manage Groups", "Skill Settings"],
      "Import from Git still has its button, so it is not repeated in ⋯");
    assert.equal(domWindow.document.activeElement?.textContent, "Import from Machine");
    await press(menu, "ArrowDown");
    assert.equal(domWindow.document.activeElement?.textContent, "Manage Groups");
    await press(menu, "Escape");
    assert.ok(domWindow.document.querySelector('[role="menu"]') === null, "the menu closed");
    // Escape restores focus on the next task (`restoreTriggerFocus`), so let it run. Identity, not
    // assert.equal: a failing diff of two DOM nodes walks the whole happy-dom graph.
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 5)); });
    assert.ok(domWindow.document.activeElement === (more as never), "Escape returns focus to ⋯");
  } finally {
    await view.unmount();
    style.remove();
  }

  const two = await mount(
    <PageHeader title="Connections" secondary={[{ label: "Add Native Runner", onClick: () => undefined }]}
      primary={{ label: "Connect via SSH", onClick: () => undefined }} />,
  );
  try {
    assert.equal(two.container.querySelector(".page-more")!.getAttribute("data-overflow"), "1",
      "with one secondary ⋯ appears only where the stylesheet hides slot 1");
  } finally {
    await two.unmount();
  }

  const none = await mount(<PageHeader title="Settings" />);
  try {
    assertNoDomNode(none.container.querySelector(".page-actions"), "a title-only header has no action row");
  } finally {
    await none.unmount();
  }
});

test("a menu-button secondary opens its own menu, and folds into ⋯ as its items, in order", async () => {
  const calls: string[] = [];
  const secondary = [
    { label: "Manage Groups…", variant: "ghost" as const, onClick: () => calls.push("groups") },
    {
      label: "Import",
      items: [
        { label: "Import from Git…", description: "From a repository.", onClick: () => calls.push("git") },
        { label: "Import from Machine…", description: "From a machine.", onClick: () => calls.push("machine") },
      ],
    },
  ];
  const view = await mount(<PageHeader title="Agent Skills" secondary={secondary} primary={{ label: "New Skill", onClick: () => undefined }} />);
  try {
    const { container } = view;
    const [groups, importButton] = [...container.querySelectorAll<HTMLButtonElement>(".page-action")];
    assert.equal(groups!.className, "btn ghost page-action", "a ghost secondary keeps the slot recipe");
    assert.equal(importButton!.className, "btn page-action");
    assert.equal(importButton!.textContent, "Import", "the caret is decorative, so the name is the label");
    assert.ok(importButton!.querySelector('svg[aria-hidden="true"]'), "the caret marks a menu button");
    assert.equal(importButton!.getAttribute("aria-haspopup"), "menu");
    assert.equal(importButton!.getAttribute("aria-expanded"), "false");

    await act(async () => importButton!.click());
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="Import"]') as unknown as Element;
    assert.ok(menu, "the menu is named by its button");
    assert.equal(importButton!.getAttribute("aria-expanded"), "true");
    assert.equal(importButton!.getAttribute("aria-controls"), menu.id);
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => [item.querySelector(".menu-text")?.textContent, item.querySelector(".menu-desc")?.textContent]), [
      ["Import from Git…", "From a repository."],
      ["Import from Machine…", "From a machine."],
    ]);
    assert.equal(domWindow.document.activeElement?.querySelector(".menu-text")?.textContent, "Import from Git…");
    await press(menu, "ArrowDown");
    assert.equal(domWindow.document.activeElement?.querySelector(".menu-text")?.textContent, "Import from Machine…");
    await press(menu, "Escape");
    assert.ok(domWindow.document.querySelector('[role="menu"]') === null, "Escape closes the menu");
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 5)); });
    assert.ok(domWindow.document.activeElement === (importButton as never), "Escape returns focus to Import");

    await act(async () => importButton!.click());
    const again = domWindow.document.querySelector('[role="menu"][aria-label="Import"]') as unknown as Element;
    await act(async () => (again.querySelectorAll('[role="menuitem"]')[1] as unknown as HTMLButtonElement).click());
    assert.deepEqual(calls, ["machine"]);
    assert.ok(domWindow.document.activeElement === (importButton as never), "choosing an item returns focus to Import");

    // Both buttons showing: ⋯ has nothing to add, so the stylesheet keeps it hidden.
    assert.equal(container.querySelector(".page-more")!.getAttribute("data-overflow"), "2");
  } finally {
    await view.unmount();
  }

  // A phone (or a header under 440px): every secondary button is hidden, and ⋯ lists Manage Groups…
  // and then each import individually, never a nested Import menu.
  const style = domWindow.document.createElement("style");
  style.textContent = ".page-actions > .page-action { display: none; }";
  domWindow.document.head.append(style);
  const folded = await mount(<PageHeader title="Agent Skills" secondary={secondary} primary={{ label: "New Skill", onClick: () => undefined }} />);
  try {
    const more = folded.container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!;
    await act(async () => more.click());
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="More Actions"]') as unknown as Element;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.querySelector(".menu-text")?.textContent),
      ["Manage Groups…", "Import from Git…", "Import from Machine…"]);
    assert.equal(items[1]!.querySelector(".menu-desc")?.textContent, "From a repository.", "a folded item keeps its description");
    assert.deepEqual(items.map((item) => item.getAttribute("data-slot")), ["2", "1", "1"]);
    assertNoDomNode(menu.querySelector('[aria-haspopup="menu"]'), "⋯ never nests a menu");
    await act(async () => items[1]!.click());
    assert.deepEqual(calls, ["machine", "git"]);
  } finally {
    await folded.unmount();
  }

  // The compact tier: slot 2 (Manage Groups…) is hidden, so ⋯ lists only it; Import stays a button.
  style.textContent = '.page-actions > .page-action[data-slot="2"] { display: none; }';
  const compact = await mount(<PageHeader title="Agent Skills" secondary={secondary} primary={{ label: "New Skill", onClick: () => undefined }} />);
  try {
    const more = compact.container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!;
    await act(async () => more.click());
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="More Actions"]') as unknown as Element;
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.querySelector(".menu-text")?.textContent),
      ["Manage Groups…"]);
  } finally {
    await compact.unmount();
    style.remove();
  }
});

test("a view switch leads the actions, and a toggle secondary folds into ⋯ as a checked item", async () => {
  const calls: string[] = [];
  const header = (pressed: boolean, count: number) => (
    <PageHeader
      title="Sessions"
      controls={<div role="radiogroup" aria-label="Sessions View" />}
      secondary={[{ label: "Snoozed", menuLabel: "Show Snoozed Sessions", pressed, count, onClick: () => calls.push("snoozed") }]}
      menu={[{ label: "Keyboard Shortcuts", onClick: () => calls.push("shortcuts") }]}
      primary={{ label: "New Session", shortcut: "C", onClick: () => calls.push("new") }}
    />
  );
  const view = await mount(header(false, 0));
  try {
    const { container } = view;
    // §3.2 with the view switch first: [controls] [secondary] [⋯] [primary].
    assert.deepEqual([...container.querySelector(".page-actions")!.children].map((element) => element.className), [
      "page-controls",
      "btn ghost page-action",
      "overflow-menu page-more",
      "btn primary page-primary",
    ]);
    const snoozed = container.querySelector<HTMLButtonElement>(".page-action")!;
    // The view switch takes slot 1's budget, so the toggle is slot 2: the compact tier folds it.
    assert.equal(snoozed.getAttribute("data-slot"), "2");
    assert.equal(snoozed.getAttribute("aria-pressed"), "false");
    assert.equal(snoozed.textContent, "Snoozed", "no count at zero");
    await act(async () => snoozed.click());
    assert.deepEqual(calls, ["snoozed"]);

    await view.rerender(header(true, 2));
    assert.equal(snoozed.getAttribute("aria-pressed"), "true");
    assert.equal(snoozed.querySelector(".count")?.textContent, "2");
    assert.equal(snoozed.getAttribute("aria-label"), "Snoozed, 2", "the count is in the name, in words");

    const primary = container.querySelector<HTMLButtonElement>(".page-primary")!;
    assert.equal(primary.querySelector(".page-primary-label")?.textContent, "New Session");
    assert.equal(primary.querySelector("kbd")?.getAttribute("aria-hidden"), "true", "the keycap is not part of the name");
    assert.equal(primary.getAttribute("aria-keyshortcuts"), "C");
  } finally {
    await view.unmount();
  }

  // The compact tier hides slot 2: ⋯ lists Show Snoozed Sessions as a checked item with its count.
  const style = domWindow.document.createElement("style");
  style.textContent = '.page-actions > .page-action[data-slot="2"] { display: none; }';
  domWindow.document.head.append(style);
  const compact = await mount(header(true, 2));
  try {
    const more = compact.container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!;
    await act(async () => more.click());
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="More Actions"]') as unknown as Element;
    const toggle = menu.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    assert.equal(toggle.querySelector(".menu-text")?.textContent, "Show Snoozed Sessions");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(toggle.querySelector(".menu-trail .count")?.textContent, "2");
    assert.equal(toggle.getAttribute("aria-label"), "Show Snoozed Sessions, 2", "the count is in the name, in words");
    assert.ok(domWindow.document.activeElement === (toggle as never), "a checkbox item takes the menu's first focus");
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent), ["Keyboard Shortcuts"]);
    await act(async () => toggle.click());
    assert.deepEqual(calls, ["snoozed", "snoozed"]);
  } finally {
    await compact.unmount();
    style.remove();
  }
});

test("the detail bar names Back for its destination and keeps destructive actions last in ⋯", async () => {
  const calls: string[] = [];
  const view = await mount(
    <DetailBar
      title="Active Collaboration Pod"
      backLabel="Back to Collaboration Pods"
      onBack={() => calls.push("back")}
      status={<span className="pod-status">Active</span>}
      menu={[
        { label: "Close Pod", danger: true, onClick: () => calls.push("close") },
        { label: "Rename…", onClick: () => calls.push("rename") },
      ]}
    />,
  );
  try {
    const { container } = view;
    const back = container.querySelector<HTMLButtonElement>(".detail-bar-back")!;
    assert.equal(back.getAttribute("aria-label"), "Back to Collaboration Pods");
    assert.equal(back.textContent, "", "Back is an icon button, never a ← glyph");
    assert.ok(back.querySelector("svg"));
    const title = container.querySelector("h1")!;
    assert.equal(title.id, "page-title");
    assert.equal(title.getAttribute("tabindex"), "-1");
    assert.equal(title.textContent, "Active Collaboration Pod");
    assert.equal(title.nextElementSibling?.firstElementChild?.className, "pod-status", "the one status badge follows the title");

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!.click());
    const items = [...domWindow.document.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => [item.textContent, item.className]), [
      ["Rename…", "menu-item"],
      ["Close Pod", "menu-item danger"],
    ]);
    assert.equal(items[1]!.previousElementSibling?.getAttribute("role"), "separator",
      "a separator sets the destructive item apart (§9.1)");
    await act(async () => back.click());
    assert.deepEqual(calls, ["back"]);
  } finally {
    await view.unmount();
  }
});

test("a detail bar renders no instance control, and Tab leaves ⋯ from its trigger", async () => {
  const view = await mount(
    <DetailBar
      title="Final QA Run"
      backLabel="Back to Multi-Agent Runs"
      onBack={() => undefined}
      menu={[{ label: "Rename…", onClick: () => undefined }]}
    />,
  );
  try {
    const actions = view.container.querySelector(".detail-bar-actions")!;
    assert.equal(actions.firstElementChild?.className, "overflow-menu",
      "the instance tile lives only in the desktop rail (#1970)");

    const more = view.container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!;
    await act(async () => more.click());
    const menu = domWindow.document.querySelector('[role="menu"]') as unknown as Element;
    assert.equal(domWindow.document.activeElement?.textContent, "Rename…");
    await press(menu, "Tab");
    assert.ok(domWindow.document.querySelector('[role="menu"]') === null, "the menu closed");
    assert.ok(domWindow.document.activeElement === (more as never),
      "the browser's Tab continues from ⋯, not from the end of <body> where the pop lived");
  } finally {
    await view.unmount();
  }
});

/**
 * Stands in for ResizeObserver, counting constructions and recording what each observes. A test fires
 * the notification the browser would send when an observed element changes size; happy-dom has no
 * layout, so nothing fires on its own.
 */
function installResizeObserver() {
  const previous = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const live = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();
  const stats = { created: 0, observed: [] as Element[] };
  class TrackingResizeObserver {
    #entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      stats.created += 1;
      this.#entry = { callback, targets: new Set() };
      live.add(this.#entry);
    }
    observe(target: Element) {
      stats.observed.push(target);
      this.#entry.targets.add(target);
    }
    unobserve(target: Element) { this.#entry.targets.delete(target); }
    disconnect() { live.delete(this.#entry); }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: TrackingResizeObserver });
  return {
    stats,
    /** Notifies every live observer watching `target`, as a resize of it would. */
    resize: (target: Element) => act(async () => {
      for (const entry of [...live]) {
        if (entry.targets.has(target)) entry.callback([{ target } as ResizeObserverEntry], entry as unknown as ResizeObserver);
      }
    }),
    restore() {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
      else Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: previous });
    },
  };
}

const setCompactWidth = (width: number) => act(async () => domWindow.happyDOM.setWindowSize({ width, height: 800 }));

/**
 * The compact tier (#1969, §15.2). happy-dom has no layout, so the title's widths are given; what is
 * under test is the decision and what each state leaves for the reader and the accessibility tree.
 */
test("in the compact tier a detail bar trades the badge's label for the title's room, and shows icon actions", async () => {
  const observers = installResizeObserver();
  const bar = (
    <DetailBar
      title="Docs Overhaul Bake-Off With Four Agents and a Very Long Objective"
      backLabel="Back to Pods"
      onBack={() => undefined}
      status={<span className="status sm t-info">Active</span>}
      secondary={{ label: "Open Worktree", icon: <svg data-icon="folder" />, onClick: () => undefined }}
      primary={{ label: "Resume", onClick: () => undefined }}
    />
  );
  await setCompactWidth(940);
  const view = await mount(bar);
  try {
    const title = view.container.querySelector<HTMLElement>("h1")!;
    const heading = view.container.querySelector<HTMLElement>(".detail-bar-heading")!;
    const badge = () => view.container.querySelector<HTMLElement>(".detail-bar-status")!;
    let visible = 150;
    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 480 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => visible });
    // The title's room changes when the bar's does, which resizes the heading.
    await observers.resize(heading);
    assert.ok(badge().hasAttribute("data-dot"), "a title truncated to 150px is below a readable width");
    assert.equal(badge().title, "Active", "the label moves to the tooltip");
    assert.equal(badge().textContent, "Active", "and stays in the text, so the accessible name is unchanged");

    visible = 260;
    await observers.resize(heading);
    assert.ok(!badge().hasAttribute("data-dot"), "truncated at 260px is still readable, so the label stays");
    assert.equal(badge().getAttribute("title"), null);

    const [secondary, primary] = [...view.container.querySelectorAll<HTMLButtonElement>(".detail-bar-action")];
    assert.match(secondary!.className, /\bicon-only\b/, "a text action with an icon becomes an icon button");
    assert.equal(secondary!.title, "Open Worktree", "whose label is its tooltip");
    assert.equal(secondary!.textContent, "Open Worktree", "and its accessible name");
    assert.doesNotMatch(primary!.className, /\bicon-only\b/, "an action with no icon keeps its text");

    // Wider than the tier, the same bar keeps its full badge and its text buttons.
    visible = 150;
    await observers.resize(heading);
    assert.ok(badge().hasAttribute("data-dot"));
    await setCompactWidth(1440);
    assert.ok(!badge().hasAttribute("data-dot"), "the dot is a compact-tier treatment only");
    assert.equal(badge().getAttribute("title"), null);
    assert.doesNotMatch(view.container.querySelector(".detail-bar-action")!.className, /\bicon-only\b/);
    assert.equal(view.container.querySelector<HTMLButtonElement>(".detail-bar-action")!.getAttribute("title"), null);
  } finally {
    await setCompactWidth(1024);
    await view.unmount();
    observers.restore();
  }
});

test("a detail bar keeps one resize observer, on its heading, across unrelated re-renders", async () => {
  const observers = installResizeObserver();
  const bar = (
    <DetailBar
      title="Active Collaboration Pod"
      backLabel="Back to Pods"
      onBack={() => undefined}
      status={<span className="status sm t-info">Active</span>}
      primary={{ label: "Resume", onClick: () => undefined }}
    />
  );
  await setCompactWidth(940);
  const view = await mount(bar);
  try {
    assert.equal(observers.stats.created, 1, "the mounted bar installs one resize observer");
    const heading = view.container.querySelector(".detail-bar-heading")!;
    assert.ok(observers.stats.observed.includes(heading), "the heading is observed");
    // A collapse resizes the title and the badge, so observing either would re-trigger itself; the
    // heading takes the bar's free space (flex: 1), so its width never depends on the badge.
    assert.ok(!observers.stats.observed.includes(view.container.querySelector("h1")!), "the title is not observed");
    assert.ok(!observers.stats.observed.includes(view.container.querySelector(".detail-bar-status")!), "the badge is not observed");
    const observedOnMount = observers.stats.observed.length;
    // A fresh element each time: React skips re-rendering an identical one.
    for (let i = 0; i < 3; i++) await view.rerender(React.cloneElement(bar));
    assert.equal(observers.stats.created, 1, "unrelated renders must not construct another observer");
    assert.equal(observers.stats.observed.length, observedOnMount, "or observe anything again");
  } finally {
    await setCompactWidth(1024);
    await view.unmount();
    observers.restore();
  }
});

/** A compact-tier bar whose title has `room()` px and needs 10px per character. */
async function mountMeasuredBar(props: Partial<React.ComponentProps<typeof DetailBar>>, room: (view: { container: HTMLDivElement }) => number) {
  const observers = installResizeObserver();
  const render = (next: Partial<React.ComponentProps<typeof DetailBar>>) => (
    <DetailBar title="Fix it" backLabel="Back to Projects" onBack={() => undefined} {...props} {...next} />
  );
  await setCompactWidth(940);
  const view = await mount(render({}));
  const title = view.container.querySelector<HTMLElement>("h1")!;
  Object.defineProperty(title, "clientWidth", { configurable: true, get: () => room(view) });
  Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => (title.textContent ?? "").length * 10 });
  return {
    view,
    observers,
    badge: () => view.container.querySelector<HTMLElement>(".detail-bar-status"),
    rerender: (next: Partial<React.ComponentProps<typeof DetailBar>>) => view.rerender(render(next)),
    async cleanUp() {
      await setCompactWidth(1024);
      await view.unmount();
      observers.restore();
    },
  };
}

const LONG_TITLE = "Fix the flaky merge queue retry in the scheduler";
const activeBadge = <span className="status sm t-info">Active</span>;

test("in the compact tier a renamed title re-measures the dot without a resize", async () => {
  const bar = await mountMeasuredBar({ status: activeBadge }, () => 150);
  try {
    assert.equal(bar.badge()!.hasAttribute("data-dot"), false, "a title that fits keeps the label");
    // Neither the bar nor the badge changes size, and no resize is reported.
    await bar.rerender({ title: LONG_TITLE });
    assert.equal(bar.badge()!.hasAttribute("data-dot"), true, "a title truncated under 200px takes the dot");
    assert.equal(bar.badge()!.title, "Active");
    await bar.rerender({ title: "Fix it" });
    assert.equal(bar.badge()!.hasAttribute("data-dot"), false, "a title that fits again gives the label back");
    assert.equal(bar.badge()!.hasAttribute("title"), false);
  } finally {
    await bar.cleanUp();
  }
});

test("in the compact tier a sibling action that changes width re-measures the dot through the heading", async () => {
  // The heading takes the bar's free space, so a wider action narrows it, and the title with it.
  const bar = await mountMeasuredBar(
    { title: LONG_TITLE, status: activeBadge, secondary: { label: "Run", onClick: () => undefined } },
    ({ container }) => 240 - (container.querySelector(".detail-bar-actions")?.textContent ?? "").length * 10,
  );
  try {
    assert.equal(bar.badge()!.hasAttribute("data-dot"), false, "with a short action the title keeps 210px");
    await bar.rerender({ title: LONG_TITLE, secondary: { label: "Open Worktree", onClick: () => undefined } });
    const heading = bar.view.container.querySelector(".detail-bar-heading")!;
    await bar.observers.resize(heading);
    assert.equal(bar.badge()!.hasAttribute("data-dot"), true, "a wider action takes the title under 200px");
    await bar.rerender({ title: LONG_TITLE, secondary: { label: "Run", onClick: () => undefined } });
    await bar.observers.resize(heading);
    assert.equal(bar.badge()!.hasAttribute("data-dot"), false, "the narrower action gives the room back");
  } finally {
    await bar.cleanUp();
  }
});

test("in the compact tier a badge whose label or count changes re-measures the dot without a resize", async () => {
  // The badge sits beside the title, so every character it shows takes 10px from the title's room.
  const bar = await mountMeasuredBar(
    { title: LONG_TITLE },
    ({ container }) => 270 - (container.querySelector(".detail-bar-status")?.textContent ?? "").length * 10,
  );
  try {
    assertNoDomNode(bar.badge(), "a bar without a status has no badge");
    await bar.rerender({ title: LONG_TITLE, status: activeBadge });
    assert.equal(bar.badge()!.hasAttribute("data-dot"), false, "a badge that arrives with a short label leaves 210px");

    await bar.rerender({ title: LONG_TITLE, status: <span className="status sm t-warn">Active<span className="status-count">12</span></span> });
    assert.equal(bar.badge()!.hasAttribute("data-dot"), true, "a count takes the title under 200px");
    assert.equal(bar.badge()!.title, "Active12");

    await bar.rerender({ title: LONG_TITLE, status: <span className="status sm t-warn">Waiting on Review</span> });
    assert.equal(bar.badge()!.hasAttribute("data-dot"), true);
    assert.equal(bar.badge()!.title, "Waiting on Review", "the tooltip follows the new label");

    await bar.rerender({ title: LONG_TITLE, status: <span className="status sm t-info">Idle</span> });
    assert.equal(bar.badge()!.hasAttribute("data-dot"), false, "a short label fits again");
    assert.equal(bar.badge()!.hasAttribute("title"), false);
  } finally {
    await bar.cleanUp();
  }
});

test("a crashed route keeps its page title above the error notice", async () => {
  function Broken(): React.ReactNode {
    throw new Error("render failed");
  }
  const priorError = console.error;
  console.error = () => undefined;
  const view = await mount(<ErrorBoundary name="Automations" pageTitle="Automations"><Broken /></ErrorBoundary>);
  try {
    const title = view.container.querySelector("h1");
    assert.equal(title?.id, "page-title");
    assert.equal(title?.textContent, "Automations");
    assert.equal(view.container.querySelector('[role="alert"] .notice-title')?.textContent, "Automations Couldn't Be Shown");
  } finally {
    await view.unmount();
    console.error = priorError;
  }
});
