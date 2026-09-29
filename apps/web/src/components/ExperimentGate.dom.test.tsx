import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ExperimentGate } from "./ExperimentGate.js";
import { Rail } from "./Rail.js";
import {
  EXPERIMENT_COPY,
  getExperimentFlags,
  resetExperimentFlagsForTest,
  setExperimentFlag,
  type ExperimentId,
} from "../experiments.js";
import { resetRailPreferencesForTest } from "../rail-preferences.js";
import type { View } from "../navigation.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window();
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorNavigator = globalThis.navigator;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];
const priorElementGlobals = {
  HTMLElement: (globalThis as Record<string, unknown>)["HTMLElement"],
  HTMLButtonElement: (globalThis as Record<string, unknown>)["HTMLButtonElement"],
  KeyboardEvent: (globalThis as Record<string, unknown>)["KeyboardEvent"],
};
const priorLocalStorage = (globalThis as Record<string, unknown>)["localStorage"];

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: domWindow.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: domWindow.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: domWindow.HTMLButtonElement });
  Object.defineProperty(globalThis, "KeyboardEvent", { configurable: true, writable: true, value: domWindow.KeyboardEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: domWindow.localStorage });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: priorNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLButtonElement });
  Object.defineProperty(globalThis, "KeyboardEvent", { configurable: true, writable: true, value: priorElementGlobals.KeyboardEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: priorLocalStorage });
});

beforeEach(() => {
  domWindow.localStorage.clear();
  resetExperimentFlagsForTest();
  resetRailPreferencesForTest();
});

const cases: ReadonlyArray<{ experiment: ExperimentId; view: View; path: string; content: string }> = [
  { experiment: "multiAgent", view: { name: "runs" }, path: "/runs", content: "Runs List" },
  { experiment: "pods", view: { name: "pods" }, path: "/pods", content: "Pods List" },
];

for (const { experiment, view, path, content } of cases) {
  const { name, offTitle } = EXPERIMENT_COPY[experiment];

  test(`with ${name} turned off, its route keeps the page header and Turn On mounts it in place`, async () => {
    setExperimentFlag(experiment, false);
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    const navigated: View[] = [];
    let openedSettings = 0;
    await act(async () => root.render(
      <>
        <Rail
          view={view}
          blockedCount={0}
          stalledCount={0}
          onlineConnections={1}
          onNavigate={(destination) => navigated.push(destination)}
          instanceControl={<button type="button">Switch Instance</button>}
          settingsControl={<button type="button">Settings</button>}
        />
        <main>
          <ExperimentGate experiment={experiment} pageTitle={name} onOpenSettings={() => { openedSettings += 1; }}>
            <h1 id="page-title" tabIndex={-1}>{name}</h1>
            <p className="gated-content">{content}</p>
          </ExperimentGate>
        </main>
      </>,
    ));
    const railHrefs = () => [...container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a")]
      .map((link) => link.getAttribute("href"));
    const page = () => container.querySelector("main")!;
    try {
      assert.ok(!railHrefs().includes(path), "a turned-off destination is not in the rail");
      assertNoDomNode(page().querySelector(".gated-content"), "the feature stays unmounted");

      // The page header first, then the state under it.
      const header = page().querySelector(".page > header.page-header");
      assert.ok(header, "the page keeps its header");
      assert.equal(page().querySelector("h1#page-title")?.textContent, name);
      const state = page().querySelector(".state.experiment-off")!;
      assert.ok(state, "the turned-off state");
      assert.ok(header!.compareDocumentPosition(state as never) & 4, "the state sits below the header");
      assert.ok(state.querySelector(".state-icon svg"), "a flask icon");
      assert.equal(state.querySelector("h2.state-title")?.textContent, offTitle);
      assert.doesNotMatch(offTitle, /Is Turned Off/);
      assert.equal(state.querySelector(".state-body")?.textContent,
        `This experiment is off on this device. Turning it on adds ${name} to the navigation.`);
      const buttons = [...state.querySelectorAll<HTMLButtonElement>(".actions button")];
      assert.deepEqual(buttons.map((button) => button.textContent), ["Turn On", "Open Experimental Settings"]);
      assert.ok(buttons[0]!.classList.contains("primary"));
      assert.ok(!buttons[1]!.classList.contains("primary"));

      await act(async () => { buttons[1]!.click(); });
      assert.equal(openedSettings, 1, "Open Experimental Settings still leads to the other switches");

      buttons[0]!.focus();
      await act(async () => { buttons[0]!.click(); });
      assert.equal(getExperimentFlags()[experiment], true, "Turn On sets the device's flag through the shared setter");
      assert.equal(page().querySelector(".gated-content")?.textContent, content, "the feature renders in place");
      assertNoDomNode(page().querySelector(".state.experiment-off"));
      assert.ok(railHrefs().includes(path), "the destination appears in the rail");
      assert.deepEqual(navigated, [], "turning it on is not a navigation");
      assert.ok(domWindow.document.activeElement === (page().querySelector("h1#page-title") as never),
        "focus moves from the vanished Turn On to the feature's page title, not to the body");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
