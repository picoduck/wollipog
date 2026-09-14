import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { WorktreeSetupNotice } from "./WorktreeSetupNotice.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("setup notice uses Title Case actions, an external help link, and no nested controls", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorktreeSetupNotice onGenerate={() => {}} onDismiss={() => {}} />));
    assert.equal(container.querySelector("aside")?.getAttribute("aria-label"), "Set up This Project");
    assert.deepEqual([...container.querySelectorAll("button")].map((button) => button.textContent), ["Generate", "×"]);
    assert.equal(container.querySelector("a")?.textContent, "Learn More");
    assert.equal(container.querySelector("button button, button a, a button"), null);
    assert.match(container.textContent ?? "", /Nothing runs, stages, or commits/u);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
