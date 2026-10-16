import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { InstanceScopeProvider } from "../instance-scope.js";
import { resetExperimentFlagsForTest, setExperimentFlag } from "../experiments.js";
import { getRailPreferences, phoneBarViews, resetRailPreferencesForTest, setRailLabels } from "../rail-preferences.js";
import { destination } from "../navigation.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { Rail } from "./Rail.js";
import { NavigationRailPanel, RAIL_MOVE_FLASH_MS } from "./SettingsView.js";

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

const SCOPE = "rail-panel-test";

function rows(container: HTMLDivElement) {
  return [...container.querySelectorAll<HTMLElement>(".rail-nav-row")];
}
function row(container: HTMLDivElement, name: string): HTMLElement {
  const match = rows(container).find((candidate) => rowTitle(candidate) === name);
  assert.ok(match, `no row for "${name}"`);
  return match;
}
function rowTitle(row: HTMLElement): string {
  return row.querySelector(".rail-nav-title")?.textContent ?? "";
}
function rowDigit(row: HTMLElement): string | null {
  return row.querySelector(".rail-nav-digit kbd")?.textContent ?? null;
}
function rowNotes(row: HTMLElement): string[] {
  return [...row.querySelectorAll(".rail-nav-note")].map((note) => note.textContent ?? "");
}
function control(container: HTMLDivElement, label: string): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  assert.ok(match, `no control named "${label}"`);
  return match;
}
function reset(container: HTMLDivElement): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === "Reset to Default");
  assert.ok(match, "no Reset to Default");
  return match;
}

/** Every media query matches: a phone, with a touch pointer. */
function phoneMatchMedia() {
  return ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
}

async function mount(withRail = false): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceScopeProvider instanceScope={SCOPE}>
        {withRail && (
          <Rail
            view={{ name: "settings", section: "appearance" }}
            blockedCount={0}
            stalledCount={0}
            onNavigate={() => undefined}
          />
        )}
        <NavigationRailPanel />
      </InstanceScopeProvider>,
    );
  });
  return { container, root };
}

async function unmount({ container, root }: { container: HTMLDivElement; root: Root }) {
  await act(async () => { root.unmount(); });
  container.remove();
}

function clean() {
  domWindow.localStorage.clear();
  resetRailPreferencesForTest();
  resetExperimentFlagsForTest();
}

test("the Navigation group lists every destination on one row shape, with derived digits and the group's sentence", async () => {
  clean();
  const mounted = await mount();
  const { container } = mounted;
  try {
    const list = rows(container);
    assert.equal(list.length, 9, "every rail destination, and only rail destinations");
    assert.equal(container.textContent?.includes("Settings"), false,
      "Settings is not a rail destination and must not be configurable (#458)");
    assert.equal(rowTitle(list[0]!), "Sessions");
    assert.deepEqual(list.map(rowDigit), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const candidate of list) {
      // icon, name, digit, moves, switch: the same five cells on every row, so nothing shifts.
      assert.deepEqual([...candidate.children].map((cell) => cell.getAttribute("role") ?? cell.className),
        ["rail-nav-icon", "rail-nav-name", "rail-nav-digit", "rail-nav-moves", "switch"], rowTitle(candidate));
    }
    assert.equal(container.querySelector(".settings-group-desc")?.textContent,
      "Order sets the number shortcuts. Hidden pages stay reachable from search.");
    assertNoDomNode(container.querySelector(".settings-group-foot"));
    // The one head action is a small ghost button that leads with its icon.
    const action = reset(container);
    assert.ok(action.closest(".settings-group-action"), "Reset to Default is the group's head action");
    assert.equal(action.className, "btn ghost sm");
    assert.ok(action.querySelector("svg"), "with the rotate icon");
    assert.equal(action.disabled, true, "a default configuration has nothing to reset");
    // No old control is left: visibility is a switch, not a button that changes its label.
    assert.equal([...container.querySelectorAll("button")].some((button) => /^(Hide|Show)$/.test(button.textContent ?? "")), false);
  } finally {
    await unmount(mounted);
    clean();
  }
});

test("Sessions' switch is checked and disabled, and says why in visible text rather than a tooltip", async () => {
  clean();
  const mounted = await mount();
  const { container } = mounted;
  try {
    const sessions = row(container, "Sessions");
    const toggle = control(container, "Show Sessions in Navigation");
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(toggle.disabled, true);
    assert.deepEqual(rowNotes(sessions), ["Always Shown"]);
    const note = sessions.querySelector(".rail-nav-note")!;
    assert.equal(toggle.getAttribute("aria-describedby"), note.id, "the switch is described by its reason");
    assertNoDomNode(container.querySelector(".rail-nav-list [title]"));
    // Every other destination's switch is live.
    assert.equal(control(container, "Show Pods in Navigation").disabled, false);
    assert.equal(control(container, "Show Pods in Navigation").getAttribute("aria-describedby"), null);
  } finally {
    await unmount(mounted);
    clean();
  }
});

test("switching off Show Pods in Navigation leaves the rail and renumbers at once, and Reset restores order and visibility", async () => {
  clean();
  const mounted = await mount(true);
  const { container } = mounted;
  const railNames = () => [...container.querySelectorAll<HTMLAnchorElement>(".rail-destinations a.rail-item")]
    .map((item) => item.getAttribute("aria-label"));
  try {
    assert.ok(railNames().includes("Pods"));
    await act(async () => { control(container, "Move Usage and Cost Up").click(); });
    await act(async () => { control(container, "Show Pods in Navigation").click(); });

    assert.equal(control(container, "Show Pods in Navigation").getAttribute("aria-checked"), "false");
    assert.equal(railNames().includes("Pods"), false, "the rail follows the switch without a reload");
    const pods = row(container, "Pods");
    assert.equal(rowDigit(pods), null, "a hidden destination advertises no digit");
    assert.equal(pods.querySelector(".rail-nav-digit")?.textContent, "–");
    assert.ok(pods.classList.contains("is-inactive"));
    assert.deepEqual(rowNotes(pods), [], "the switch says it is hidden; no second word does");
    assert.deepEqual(rows(container).filter((candidate) => rowDigit(candidate) !== null).map(rowDigit),
      ["1", "2", "3", "4", "5", "6", "7", "8"], "the destinations after it move up a digit");
    assert.equal(rowDigit(row(container, "Connections")), "5");
    assert.equal(reset(container).disabled, false, "a customised list can be reset");

    await act(async () => { reset(container).click(); });
    assert.deepEqual(rows(container).map(rowTitle), [
      "Sessions", "Automations", "Projects", "Multi-Agent Runs", "Pods", "Connections", "Agent Skills",
      "Archived Sessions", "Usage and Cost",
    ], "the default order");
    assert.equal(control(container, "Show Pods in Navigation").getAttribute("aria-checked"), "true");
    assert.ok(railNames().includes("Pods"));
    assert.deepEqual(rows(container).map(rowDigit), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.equal(reset(container).disabled, true);
  } finally {
    await unmount(mounted);
    clean();
  }
});

test("a Move button keeps focus through the move, handing it to its sibling when it becomes disabled", async () => {
  clean();
  const mounted = await mount();
  const { container } = mounted;
  try {
    const usage = () => row(container, "Usage and Cost");
    assert.equal(control(container, "Move Usage and Cost Down").disabled, true, "the last row cannot move down");
    assert.equal(control(container, "Move Sessions Up").disabled, true, "the first row cannot move up");

    control(container, "Move Usage and Cost Up").focus();
    await act(async () => { control(container, "Move Usage and Cost Up").click(); });
    assert.equal(rows(container).indexOf(usage()), 7);
    assert.equal(domWindow.document.activeElement, control(container, "Move Usage and Cost Up") as never,
      "focus stays on the button that was pressed");
    assert.ok(usage().classList.contains("is-moved"), "the moved row is lit");

    control(container, "Move Usage and Cost Down").focus();
    await act(async () => { control(container, "Move Usage and Cost Down").click(); });
    assert.equal(rows(container).indexOf(usage()), 8, "Usage and Cost is last again");
    assert.equal(control(container, "Move Usage and Cost Down").disabled, true);
    assert.equal(domWindow.document.activeElement, control(container, "Move Usage and Cost Up") as never,
      "focus moves to Move Up once Move Down is disabled");

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, RAIL_MOVE_FLASH_MS + 50)); });
    assert.equal(usage().classList.contains("is-moved"), false, "and goes out again");
  } finally {
    await unmount(mounted);
    clean();
  }
});

test("an experiment that is off shows Off in Experimental, a disabled switch and no digit", async () => {
  clean();
  setExperimentFlag("pods", false, SCOPE);
  const mounted = await mount();
  const { container } = mounted;
  try {
    const pods = row(container, "Pods");
    const toggle = control(container, "Show Pods in Navigation");
    assert.deepEqual(rowNotes(pods), ["Off in Experimental"]);
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.getAttribute("aria-describedby"), pods.querySelector(".rail-nav-note")!.id);
    assert.equal(rowDigit(pods), null);
    assert.equal(rowDigit(row(container, "Connections")), "5", "an experiment that is off takes no digit");
    // It still moves, so its place is kept for when the experiment comes back.
    assert.equal(control(container, "Move Pods Up").disabled, false);
    assert.equal(reset(container).disabled, true, "an experiment is not a navigation preference");
  } finally {
    await unmount(mounted);
    clean();
  }
});

test("a phone shows no digits and no Show Labels in Rail, and marks exactly the tab bar's destinations", async () => {
  clean();
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = phoneMatchMedia();
  setRailLabels(true, SCOPE);
  const mounted = await mount();
  const { container } = mounted;
  try {
    assertNoDomNode(container.querySelector(".setting-row"));
    assert.equal(container.textContent?.includes("Show Labels in Rail"), false);
    assert.equal(rows(container).length, 9, "every destination is still listed");
    assertNoDomNode(container.querySelector(".rail-nav-digit"));
    assertNoDomNode(container.querySelector(".rail-nav-list kbd"));
    assert.ok(container.querySelector(".rail-nav-list.no-digits"));
    assert.equal(container.querySelector(".settings-group-desc")?.textContent,
      "Order sets the More sheet. Tab Bar marks the four pages in the bar.");

    const bar = phoneBarViews(getRailPreferences(SCOPE), { multiAgent: true, pods: true }).map((name) => destination(name).name);
    assert.equal(bar.length, 4);
    const marked = () => rows(container).filter((candidate) => rowNotes(candidate).includes("Tab Bar")).map(rowTitle);
    assert.deepEqual(new Set(marked()), new Set(bar));
    assert.deepEqual(rowNotes(row(container, "Sessions")), ["Always Shown", "Tab Bar"]);

    // Hiding a bar destination moves the mark to the destination that fills its slot.
    await act(async () => { control(container, "Show Projects in Navigation").click(); });
    const after = phoneBarViews(getRailPreferences(SCOPE), { multiAgent: true, pods: true }).map((name) => destination(name).name);
    assert.equal(after.includes("Projects"), false);
    assert.deepEqual(new Set(marked()), new Set(after));
  } finally {
    domWindow.matchMedia = prior;
    await unmount(mounted);
    clean();
  }
});

test("Show Labels in Rail, the rail's foot button and the stored preference stay in step", async () => {
  clean();
  const mounted = await mount(true);
  const { container } = mounted;
  const labelsSwitch = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find((candidate) => candidate.textContent?.includes("Show Labels in Rail"));
  const foot = () => container.querySelector<HTMLButtonElement>(".rail-foot button")!;
  const rail = () => container.querySelector<HTMLElement>(".app-rail")!;
  try {
    assert.ok(labelsSwitch(), "the row is the shared SwitchRow, whose whole row is the target");
    assert.ok(labelsSwitch()!.closest(".settings-group-surface")!.firstElementChild === labelsSwitch(),
      "and the first row of the group");
    assert.equal(labelsSwitch()!.getAttribute("aria-checked"), "false");
    assert.equal(rail().classList.contains("labelled"), false);
    assert.equal(foot().getAttribute("aria-label"), "Expand Navigation");

    await act(async () => { labelsSwitch()!.click(); });
    assert.equal(rail().classList.contains("labelled"), true, "the rail follows Settings without a reload");
    assert.equal(foot().getAttribute("aria-label"), "Collapse Navigation");
    assert.equal(getRailPreferences(SCOPE).labels, true, "written to the scoped instance");
    assert.equal(getRailPreferences().labels, false, "and to no other instance");
    assert.equal(reset(container).disabled, true, "labels are a separate switch, not part of what Reset restores");

    await act(async () => { foot().click(); });
    assert.equal(labelsSwitch()!.getAttribute("aria-checked"), "false", "Settings follows the rail's foot");
    assert.equal(rail().classList.contains("labelled"), false);
  } finally {
    await unmount(mounted);
    clean();
  }
});
