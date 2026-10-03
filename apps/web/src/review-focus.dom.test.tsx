import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { useDiffFileFocus } from "./review-focus.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

test("a request after a cleared one gets a new number, never the cleared one's", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  let handle: ReturnType<typeof useDiffFileFocus> | null = null;
  function Probe() {
    handle = useDiffFileFocus();
    return null;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => handle!.request("src/a.ts"));
  assert.deepEqual(handle!.focus, { path: "src/a.ts", request: 1 });
  await act(async () => handle!.clear());
  assert.equal(handle!.focus, null);
  await act(async () => handle!.request("src/b.ts"));
  assert.deepEqual(handle!.focus, { path: "src/b.ts", request: 2 });
});
