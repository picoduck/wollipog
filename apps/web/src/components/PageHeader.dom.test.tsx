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

async function mount(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
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
    assert.equal(title.nextElementSibling?.className, "pod-status", "the one status badge follows the title");

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
