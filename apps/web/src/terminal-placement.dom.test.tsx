import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { TERMINAL_PLACEMENT_STORAGE_KEY, setTerminalPlacement, useTerminalPlacement } from "./terminal-placement.js";

/**
 * `useTerminalPlacement` follows every source of the per-device placement (#2867): the setter in this
 * tab, and another window's write, which reaches this one only as a `storage` event.
 */
const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorEvent = globalThis.Event;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  // The setter announces its change with a global `Event`, which must be the window's own.
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: domWindow.Event });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: priorEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
  domWindow.close();
});

function Probe() {
  return <output>{useTerminalPlacement()}</output>;
}

async function mount() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the placement follows the setter in this tab and another window's write", async () => {
  domWindow.localStorage.removeItem(TERMINAL_PLACEMENT_STORAGE_KEY);
  const view = await mount();
  try {
    assert.equal(view.container.textContent, "dock", "an untouched device docks the terminal");

    await act(async () => setTerminalPlacement("panel"));
    assert.equal(view.container.textContent, "panel", "the setter's change event applies in this tab");

    // Another window's write reaches this one only as a `storage` event.
    const otherWindowStores = async (value: string | null) => {
      if (value === null) domWindow.localStorage.removeItem(TERMINAL_PLACEMENT_STORAGE_KEY);
      else domWindow.localStorage.setItem(TERMINAL_PLACEMENT_STORAGE_KEY, value);
      await act(async () => {
        domWindow.dispatchEvent(new domWindow.StorageEvent("storage", { key: TERMINAL_PLACEMENT_STORAGE_KEY }));
      });
    };
    await otherWindowStores("dock");
    assert.equal(view.container.textContent, "dock", "a choice stored by another window applies");
    await otherWindowStores("panel");
    assert.equal(view.container.textContent, "panel");
    await otherWindowStores(null);
    assert.equal(view.container.textContent, "dock", "a choice cleared by another window falls back to the dock");
    await otherWindowStores("somewhere");
    assert.equal(view.container.textContent, "dock", "an unknown value another window stored means the dock");
  } finally {
    await view.unmount();
    domWindow.localStorage.removeItem(TERMINAL_PLACEMENT_STORAGE_KEY);
  }
});
