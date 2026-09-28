import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { TabList } from "./Tabs.js";

/**
 * The tab row (docs/design-system.md §10.1) keeps the selected tab in view: on mount, and whenever
 * the owner selects another tab later, as the Sessions tabs do when a link or Back names one.
 */

const domWindow = new Window({ url: "http://localhost/" });
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const GLOBALS: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(GLOBALS)) {
    priorGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(async () => {
  for (const [name, descriptor] of priorGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await domWindow.happyDOM.abort();
  domWindow.close();
});

function Row({ selected, other = 0 }: { selected: string; other?: number }) {
  return (
    <TabList label="Groups" data-other={other}>
      {["All", "Alpha", "Beta", "Gamma"].map((name) => (
        <button key={name} type="button" role="tab" className="tab" aria-selected={name === selected}>{name}</button>
      ))}
    </TabList>
  );
}

test("the selected tab scrolls into view on mount and whenever the selection changes, and only then", async () => {
  const scrolled: string[] = [];
  const prototype = domWindow.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  const original = prototype.scrollIntoView;
  prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { scrolled.push(this.textContent ?? ""); };
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<Row selected="All" />); });
    assert.deepEqual(scrolled, ["All"], "the mounted selection is shown");

    // A later selection, as a link or Back applies after mount.
    await act(async () => { root.render(<Row selected="Gamma" />); });
    assert.deepEqual(scrolled, ["All", "Gamma"], "a tab selected after mount is scrolled into view");

    // A re-render that keeps the selection leaves the row where the user scrolled it.
    await act(async () => { root.render(<Row selected="Gamma" other={1} />); });
    assert.deepEqual(scrolled, ["All", "Gamma"], "an unrelated re-render does not scroll");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    prototype.scrollIntoView = original;
  }
});
