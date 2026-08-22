import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { InboxCreateMenu } from "./InboxCreateMenu.js";

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

test("Inbox creation offers both workflows with menu-button keyboard and focus behavior", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let sessions = 0;
  let projects = 0;

  try {
    await act(async () => {
      root.render(
        <InboxCreateMenu
          onNewSession={() => { sessions += 1; }}
          onNewProject={() => { projects += 1; }}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(".inbox-create-control")!;
    assert.equal(trigger.getAttribute("aria-label"), "Create");
    assert.equal(trigger.title, "Create");
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");

    await act(async () => { trigger.click(); });
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.textContent?.trim()), ["New Session", "New Project"]);
    assert.equal(domWindow.document.activeElement, items[0], "opening by click focuses the first choice");

    await act(async () => { items[0]!.click(); });
    assert.equal(sessions, 1);
    assert.equal(projects, 0);
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(domWindow.document.activeElement, trigger, "choosing a workflow restores focus before opening its layer");

    await act(async () => {
      trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }) as never);
    });
    const projectItem = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][1]!;
    assert.equal(domWindow.document.activeElement, projectItem, "Arrow Up opens on the last choice");
    await act(async () => { projectItem.click(); });
    assert.equal(projects, 1);
    assert.equal(domWindow.document.activeElement, trigger);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
