import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { InstanceScopeProvider } from "../instance-scope.js";
import { getRailPreferences, resetRailPreferencesForTest, setRailLabels } from "../rail-preferences.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { Rail } from "./Rail.js";
import { NavigationRailPanel } from "./SettingsView.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function rows(container: HTMLDivElement) {
  return [...container.querySelectorAll<HTMLElement>(".rail-order-row")];
}
function rowTitle(row: HTMLElement): string {
  return row.querySelector(".rail-order-title")?.textContent ?? "";
}
function rowDigit(row: HTMLElement): string | null {
  return row.querySelector("kbd")?.textContent ?? null;
}
function button(row: HTMLElement, label: RegExp): HTMLButtonElement {
  const match = [...row.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => label.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? ""));
  assert.ok(match, `no ${label} control in "${rowTitle(row)}"`);
  return match;
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceScopeProvider instanceScope="rail-panel-test">
        <NavigationRailPanel />
      </InstanceScopeProvider>,
    );
  });
  return { container, root };
}

test("the Navigation group lists every destination with derived digits and a protected Sessions row", async () => {
  domWindow.localStorage.clear();
  resetRailPreferencesForTest();
  const { container, root } = await mount();
  try {
    const list = rows(container);
    assert.equal(list.length, 9, "every rail destination, and only rail destinations");
    assert.equal(container.textContent?.includes("Settings"), false,
      "Settings is not a rail destination and must not be configurable (#458)");
    assert.equal(rowTitle(list[0]!), "Sessions");
    assert.deepEqual(list.map(rowDigit), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

    const sessions = list[0]!;
    assert.match(sessions.querySelector(".rail-order-required")?.textContent ?? "", /Required/);
    assert.equal([...sessions.querySelectorAll("button")].some((b) => /Hide|Show/.test(b.textContent ?? "")), false,
      "the required destination offers no visibility control");

    // Hiding renumbers the survivors immediately — the read-only digit preview is live.
    await act(async () => { button(list[1]!, /^Hide$/).click(); });
    const after = rows(container);
    assert.equal(rowDigit(after[1]!), null, "a hidden destination advertises no digit");
    assert.match(after[1]!.querySelector(".rail-order-note")?.textContent ?? "", /Hidden/);
    assert.equal(rowDigit(after[2]!), "2", "the next visible destination inherits the digit");

    // Restoring returns it to its retained position with its old digit.
    await act(async () => { button(rows(container)[1]!, /^Show$/).click(); });
    assert.deepEqual(rows(container).map(rowDigit), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

    // Reorder via the keyboard-operable move controls; Reset restores the product default.
    await act(async () => { button(rows(container)[8]!, /Move Usage and Cost Up/).click(); });
    assert.equal(rowTitle(rows(container)[7]!), "Usage and Cost");
    const reset = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Reset to Default")!;
    assert.equal(reset.disabled, false);
    await act(async () => { reset.click(); });
    assert.equal(rowTitle(rows(container)[7]!), "Archived Sessions");
    assert.equal(reset.disabled, true, "a default configuration has nothing to reset");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.localStorage.clear();
    resetRailPreferencesForTest();
  }
});

test("Show Labels in Rail, the rail's foot button and the stored preference stay in step", async () => {
  domWindow.localStorage.clear();
  resetRailPreferencesForTest();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceScopeProvider instanceScope="rail-panel-test">
        <Rail
          view={{ name: "settings", section: "appearance" }}
          blockedCount={0}
          stalledCount={0}
          onNavigate={() => undefined}
        />
        <NavigationRailPanel />
      </InstanceScopeProvider>,
    );
  });
  const labelsSwitch = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find((candidate) => candidate.textContent?.includes("Show Labels in Rail"));
  const foot = () => container.querySelector<HTMLButtonElement>(".rail-foot button")!;
  const rail = () => container.querySelector<HTMLElement>(".app-rail")!;
  try {
    assert.ok(labelsSwitch(), "the row is the shared SwitchRow, whose whole row is the target");
    assert.equal(labelsSwitch()!.getAttribute("aria-checked"), "false");
    assert.equal(rail().classList.contains("labelled"), false);
    assert.equal(foot().getAttribute("aria-label"), "Expand Navigation");

    await act(async () => { labelsSwitch()!.click(); });
    assert.equal(rail().classList.contains("labelled"), true, "the rail follows Settings without a reload");
    assert.equal(foot().getAttribute("aria-label"), "Collapse Navigation");
    assert.equal(getRailPreferences("rail-panel-test").labels, true, "written to the scoped instance");
    assert.equal(getRailPreferences().labels, false, "and to no other instance");

    await act(async () => { foot().click(); });
    assert.equal(labelsSwitch()!.getAttribute("aria-checked"), "false", "Settings follows the rail's foot");
    assert.equal(rail().classList.contains("labelled"), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.localStorage.clear();
    resetRailPreferencesForTest();
  }
});

test("a phone offers no Show Labels in Rail row", async () => {
  domWindow.localStorage.clear();
  resetRailPreferencesForTest();
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  setRailLabels(true, "rail-panel-test");
  const { container, root } = await mount();
  try {
    assertNoDomNode(container.querySelector('[role="switch"]'));
    assert.equal(container.textContent?.includes("Show Labels in Rail"), false);
    assert.equal(rows(container).length, 9, "the destination editor is unchanged");
  } finally {
    domWindow.matchMedia = prior;
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.localStorage.clear();
    resetRailPreferencesForTest();
  }
});
