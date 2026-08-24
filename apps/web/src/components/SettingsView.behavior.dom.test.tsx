import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ENTER_KEY_STORAGE_KEY } from "../enter-key.js";
import { BehaviorPanel } from "./SettingsView.js";

/**
 * The Enter Key row writes the store the composer reads.
 *
 * The composer tests pin how a stored value changes the keydown contract; this pins that the
 * Settings control actually produces that stored value — without it, renaming the storage key on
 * either side leaves both suites green while the setting silently stops doing anything.
 */

const domWindow = new Window();
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorNavigator = globalThis.navigator;
const priorLocalStorage = (globalThis as Record<string, unknown>)["localStorage"];
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];
const priorElementGlobals = {
  HTMLElement: (globalThis as Record<string, unknown>)["HTMLElement"],
  HTMLButtonElement: (globalThis as Record<string, unknown>)["HTMLButtonElement"],
  // The setter announces its change with `new Event(...)`; a Node-global Event never reaches
  // happy-dom's listeners, and the row silently stops tracking the store it just wrote.
  Event: (globalThis as Record<string, unknown>)["Event"],
};

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: domWindow.navigator });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: domWindow.localStorage });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: domWindow.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: domWindow.HTMLButtonElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: domWindow.Event });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: priorNavigator });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: priorLocalStorage });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLButtonElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: priorElementGlobals.Event });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
});

test("the Enter Key row stores the choice and reflects it back", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<BehaviorPanel />));

    const optionByName = (name: string) => {
      const options = [...container.querySelectorAll<HTMLElement>("[role=radio]")];
      const match = options.find((option) =>
        (option.getAttribute("aria-label") ?? option.textContent ?? "").includes(name));
      assert.ok(match, `the Enter Key row must offer "${name}"`);
      return match;
    };

    // No stored value: the row shows this device's derived default. happy-dom reports a fine
    // pointer, so that is "send" — the same derivation the composer uses.
    assert.equal(domWindow.localStorage.getItem(ENTER_KEY_STORAGE_KEY), null,
      "rendering the panel must not write the default");
    assert.equal(optionByName("Send Message").getAttribute("aria-checked"), "true");

    await act(async () => { optionByName("Insert New Line").click(); });
    assert.equal(domWindow.localStorage.getItem(ENTER_KEY_STORAGE_KEY), "newline",
      "choosing an option must store it under the key the composer reads");
    assert.equal(optionByName("Insert New Line").getAttribute("aria-checked"), "true");

    await act(async () => { optionByName("Send Message").click(); });
    assert.equal(domWindow.localStorage.getItem(ENTER_KEY_STORAGE_KEY), "send");
    assert.equal(optionByName("Send Message").getAttribute("aria-checked"), "true");
  } finally {
    domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
    await act(async () => root.unmount());
    container.remove();
  }
});
