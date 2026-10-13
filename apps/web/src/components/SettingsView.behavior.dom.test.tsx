import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api } from "../api.js";
import { ENTER_KEY_STORAGE_KEY } from "../enter-key.js";
import { SHOW_AGENT_LOGS_STORAGE_KEY } from "../agent-logs.js";
import type { SettingsFocus } from "../navigation.js";
import { SHOW_SHORTCUTS_ID, shortcutDisplay } from "../shortcuts.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { BehaviorPanel } from "./SettingsView.js";
import { SettingsGroup } from "./ui/SettingsRows.js";

/**
 * Settings › Behavior (#3023): six groups in a fixed order, each naming where it is kept; the rows
 * whose sentences follow their value; Keyboard Shortcuts folded into Input and withheld where no
 * hardware keyboard is likely; and the redirect from `/settings/keyboard` landing on it.
 *
 * The Enter Key and Show Agent Logs rows also write the stores the composer and the transcript read:
 * the composer tests pin how a stored value changes the keydown contract, and this pins that the
 * Settings control actually produces that stored value.
 */

/** Which media queries match: a desktop with a mouse, a phone, or a touch-only tablet. */
type Device = "desktop" | "phone" | "touch-tablet";
let device: Device = "desktop";

const domWindow = new Window();
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() {
      if (query === "(max-width: 760px)") return device === "phone";
      if (query === "(hover: none) and (pointer: coarse)") return device !== "desktop";
      return false;
    },
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});
const previous = new Map<string, unknown>();
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  // The setter announces its change with `new Event(...)`; a Node-global Event never reaches
  // happy-dom's listeners, and the row silently stops tracking the store it just wrote.
  Event: domWindow.Event,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const priorArtifactUploadSettings = api.artifactUploadSettings;

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // Evidence reads the account's preference; its own suite covers that row.
  api.artifactUploadSettings = async () => ({ preference: "manual" });
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  api.artifactUploadSettings = priorArtifactUploadSettings;
});

async function renderPanel(options: { on?: Device; focus?: SettingsFocus; opened?: Array<HTMLElement | null> } = {}) {
  device = options.on ?? "desktop";
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = (focus?: SettingsFocus) => root.render(
    <BehaviorPanel
      // The Agent Defaults panel is its own group (#3024), so the shell supplies the whole group.
      agentHarnessDefaults={(
        <SettingsGroup title="Agent Defaults" scope="Your Account"><div className="setting-row">Agent defaults slot</div></SettingsGroup>
      )}
      sessionNaming={<div className="setting-row">Session naming slot</div>}
      onOpenShortcuts={(returnFocus) => options.opened?.push(returnFocus)}
      focus={focus}
    />,
  );
  await act(async () => draw(options.focus));
  return {
    container,
    /** The shell re-rendering the panel, as for a later arrival on the same address. */
    async rerender(focus?: SettingsFocus) {
      await act(async () => draw(focus));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      device = "desktop";
    },
  };
}

const groupHeads = (container: HTMLElement) => [...container.querySelectorAll(".settings-group-head")].map((head) => [
  head.querySelector(".settings-group-title")?.textContent,
  head.querySelector(".settings-group-scope")?.textContent,
]);

test("Behavior is six groups in order, each naming once where it is kept", async () => {
  const view = await renderPanel();
  try {
    assert.deepEqual(groupHeads(view.container), [
      ["Input", "This Device"],
      ["Transcript", "This Device"],
      ["Privacy", "This Device"],
      ["Agent Defaults", "Your Account"],
      ["Session Titles", "Your Account"],
      ["Evidence", "Your Account"],
    ]);
    // The slots hold what the shell supplies: Agent Defaults a whole group, Session Titles rows under
    // the head drawn here.
    const groups = [...view.container.querySelectorAll(".settings-group")];
    assert.match(groups[3]!.querySelector(".settings-group-surface")!.textContent ?? "", /^Agent defaults slot$/);
    assert.match(groups[4]!.querySelector(".settings-group-surface")!.textContent ?? "", /^Session naming slot$/);
    const text = view.container.textContent ?? "";
    assert.doesNotMatch(text, /Stored on this device/, "the scope label says it once per group");
    assert.doesNotMatch(text, /not built yet|Reduce Motion|Confirm Before Deleting/i, "no placeholder rows");
  } finally {
    await view.unmount();
  }
});

test("the Enter Key row stores the choice, reflects it back and describes the value", async () => {
  const view = await renderPanel();
  const { container } = view;
  try {
    const optionByName = (name: string) => {
      const options = [...container.querySelectorAll<HTMLElement>("[role=radio]")];
      const match = options.find((option) => option.textContent?.trim() === name);
      assert.ok(match, `the Enter Key row must offer "${name}"`);
      return match;
    };
    const radios = [...container.querySelectorAll<HTMLElement>("[role=radio]")].map((option) => option.textContent?.trim());
    assert.deepEqual(radios, ["Send Message", "New Line"]);
    const description = () => container.querySelector(".settings-group .setting-row .setting-row-desc")?.textContent;

    // No stored value: the row shows this device's derived default. The fine pointer here makes
    // that "send", the same derivation the composer uses.
    assert.equal(domWindow.localStorage.getItem(ENTER_KEY_STORAGE_KEY), null,
      "rendering the panel must not write the default");
    assert.equal(optionByName("Send Message").getAttribute("aria-checked"), "true");
    assert.equal(description(), "Shift+Enter adds a new line.");

    await act(async () => { optionByName("New Line").click(); });
    assert.equal(domWindow.localStorage.getItem(ENTER_KEY_STORAGE_KEY), "newline",
      "choosing an option must store it under the key the composer reads");
    assert.equal(optionByName("New Line").getAttribute("aria-checked"), "true");
    assert.equal(description(), "Shift+Enter sends the message.");

    await act(async () => { optionByName("Send Message").click(); });
    assert.equal(domWindow.localStorage.getItem(ENTER_KEY_STORAGE_KEY), "send");
    assert.equal(optionByName("Send Message").getAttribute("aria-checked"), "true");
  } finally {
    domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
    await view.unmount();
  }
});

test("the Show Agent Logs switch is off by default, stores the choice and describes the value", async () => {
  const view = await renderPanel();
  const { container } = view;
  try {
    const toggle = () => {
      const match = [...container.querySelectorAll<HTMLElement>("[role=switch]")].find((control) => {
        const title = domWindow.document.getElementById(control.getAttribute("aria-labelledby") ?? "");
        return title?.textContent === "Show Agent Logs";
      });
      assert.ok(match, "Behavior offers a Show Agent Logs switch row");
      return match;
    };
    const description = () => domWindow.document.getElementById(toggle().getAttribute("aria-describedby") ?? "")?.textContent;

    assert.equal(domWindow.localStorage.getItem(SHOW_AGENT_LOGS_STORAGE_KEY), null,
      "rendering the panel must not write the default");
    assert.equal(toggle().getAttribute("aria-checked"), "false", "off by default");
    assert.equal(description(), "Work that only holds agent startup logs stays hidden.");
    await act(async () => { toggle().click(); });
    assert.equal(domWindow.localStorage.getItem(SHOW_AGENT_LOGS_STORAGE_KEY), "true");
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(description(), "Work that only holds agent startup logs is shown.");
    await act(async () => { toggle().click(); });
    assert.equal(domWindow.localStorage.getItem(SHOW_AGENT_LOGS_STORAGE_KEY), "false");
    assert.equal(toggle().getAttribute("aria-checked"), "false");
  } finally {
    domWindow.localStorage.removeItem(SHOW_AGENT_LOGS_STORAGE_KEY);
    await view.unmount();
  }
});

test("with a mouse, Keyboard Shortcuts is an Input row whose Show Shortcuts opens the reference", async () => {
  const opened: Array<HTMLElement | null> = [];
  const view = await renderPanel({ opened });
  try {
    const input = view.container.querySelector(".settings-group")!;
    assert.equal(input.querySelector(".settings-group-title")?.textContent, "Input");
    const titles = [...input.querySelectorAll(".setting-row-title")].map((title) => title.textContent);
    assert.deepEqual(titles, ["Enter Key", "Keyboard Shortcuts"]);
    const button = domWindow.document.getElementById(SHOW_SHORTCUTS_ID) as unknown as HTMLButtonElement;
    assert.ok(button, "the button has the id the reference's focus return looks for");
    assert.equal(button.textContent, "Show Shortcuts");
    assert.ok(button.querySelector("svg"), "with the keyboard icon");
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    const describedBy = domWindow.document.getElementById(button.getAttribute("aria-describedby") ?? "");
    assert.equal(describedBy?.textContent, `Press ${shortcutDisplay("shortcut-reference")} anywhere to see them.`);
    await act(async () => button.click());
    assert.deepEqual(opened, [button], "the reference returns focus to the button that opened it");
  } finally {
    await view.unmount();
  }
});

for (const on of ["phone", "touch-tablet"] as const) {
  test(`on a ${on} the Keyboard Shortcuts row is absent`, async () => {
    const view = await renderPanel({ on });
    try {
      assertNoDomNode(domWindow.document.getElementById(SHOW_SHORTCUTS_ID), "no Show Shortcuts without a keyboard");
      assert.doesNotMatch(view.container.textContent ?? "", /Keyboard Shortcuts/);
      assert.equal(groupHeads(view.container)[0]![0], "Input", "Input keeps Enter Key");
    } finally {
      await view.unmount();
    }
  });
}

test("the /settings/keyboard redirect focuses Show Shortcuts, or the Input group where it is withheld", async () => {
  let view = await renderPanel({ focus: { target: "keyboard-shortcuts" } });
  try {
    assert.equal(domWindow.document.activeElement?.id, SHOW_SHORTCUTS_ID);
  } finally {
    await view.unmount();
  }
  view = await renderPanel({ on: "phone", focus: { target: "keyboard-shortcuts" } });
  try {
    const active = domWindow.document.activeElement as unknown as HTMLElement | null;
    assert.equal(active?.className, "settings-group-title");
    assert.equal(active?.textContent, "Input");
    assert.equal(active?.getAttribute("tabindex"), "-1", "a programmatic target, not a tab stop");
  } finally {
    await view.unmount();
  }
  view = await renderPanel();
  try {
    assert.equal(domWindow.document.activeElement, domWindow.document.body, "an ordinary visit moves nothing");
    // Back onto /settings/keyboard while Behavior is open: the store hands over a new activation.
    const arrival = { target: "keyboard-shortcuts" as const, activationId: 1 };
    await view.rerender(arrival);
    assert.equal(domWindow.document.activeElement?.id, SHOW_SHORTCUTS_ID);
    (domWindow.document.activeElement as unknown as HTMLElement).blur();
    await view.rerender(arrival);
    assert.equal(domWindow.document.activeElement, domWindow.document.body, "a re-render of the same arrival moves nothing");
    await view.rerender({ target: "keyboard-shortcuts", activationId: 2 });
    assert.equal(domWindow.document.activeElement?.id, SHOW_SHORTCUTS_ID, "the next arrival focuses again");
    // An arrival while a dialog holds focus (Back with the reference open) leaves focus in it.
    const dialog = domWindow.document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const filter = domWindow.document.createElement("input");
    dialog.append(filter);
    domWindow.document.body.append(dialog);
    try {
      filter.focus();
      await view.rerender({ target: "keyboard-shortcuts", activationId: 3 });
      assert.equal(domWindow.document.activeElement, filter, "focus stays in the dialog");
    } finally {
      dialog.remove();
    }
  } finally {
    await view.unmount();
  }
});
