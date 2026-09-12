import assert from "node:assert/strict";
import test from "node:test";
import "../test-dom-events.js";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { fireDomEvent } from "../test-dom-events.js";
import { SearchableCombobox } from "./ChoiceControls.js";

const domWindow = new Window({ url: "http://localhost/choices" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const OPTIONS = [
  { value: "alpha", label: "Dashboard", description: "Local · ~/dev/alpha" },
  {
    value: "review",
    label: "Review Agent",
    description: "Advanced Agent",
    disabled: true,
    disabledReason: "Setup Required",
  },
  { value: "beta", label: "Dashboard", description: "Remote · /srv/beta" },
  { value: "legacy", label: "Legacy Agent", disabled: true, disabledReason: "Runner Too Old" },
] as const;

function mount(onChange: (value: string) => void = () => undefined, disabled = false) {
  const host = document.createElement("div");
  const after = document.createElement("button");
  after.textContent = "After";
  document.body.append(host, after);
  const root = createRoot(host as unknown as Element);
  const bubbledKeys: string[] = [];
  act(() => root.render(
    <div onKeyDown={(event) => bubbledKeys.push(event.key)}>
      <SearchableCombobox
        label="Agent"
        options={OPTIONS}
        value="alpha"
        onChange={onChange}
        placeholder="Choose an Agent"
        disabled={disabled}
      />
    </div>,
  ));
  return {
    host,
    after,
    input: host.querySelector<HTMLInputElement>('[role="combobox"]')!,
    bubbledKeys,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
      after.remove();
    },
  };
}

function press(element: Element, key: string, init: KeyboardEventInit = {}) {
  let allowed = true;
  act(() => {
    allowed = element.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    } as never) as never);
  });
  return allowed;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    fireDomEvent.change(input, { target: { value } });
  });
}

test("typing filters the InlineListbox and exposes the active option", () => {
  const { host, input, unmount } = mount();
  try {
    act(() => input.focus());
    assert.equal(input.getAttribute("aria-expanded"), "true");
    const popup = host.querySelector<HTMLElement>('[role="listbox"]')!;
    assert.ok(popup, "the popup uses the shared listbox primitive");
    assert.equal(popup.style.position, "fixed", "the anchored placement reaches InlineListbox");
    assert.notEqual(popup.style.maxHeight, "", "the line-count height budget reaches the popup");
    assert.notEqual(popup.style.width, "", "the popup is sized from its input anchor");

    type(input, "remote beta");
    const results = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(results.length, 1);
    assert.match(results[0]?.textContent ?? "", /Remote · \/srv\/beta/);
    assert.equal(input.getAttribute("aria-activedescendant"), results[0]?.id);
    assert.equal(results[0]?.getAttribute("aria-selected"), "true");
  } finally {
    unmount();
  }
});

test("Home and End use the same enabled boundaries as Select", () => {
  const { host, input, unmount } = mount();
  try {
    act(() => input.focus());
    press(input, "End");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(input.getAttribute("aria-activedescendant"), options[2]?.id,
      "End skips the trailing unavailable result while arrows can still inspect it");
    press(input, "Home");
    assert.equal(input.getAttribute("aria-activedescendant"), options[0]?.id);
  } finally {
    unmount();
  }
});

test("arrows inspect unavailable options, while Enter only commits an available option", () => {
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    press(input, "ArrowDown");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(input.getAttribute("aria-activedescendant"), options[1]?.id);
    assert.equal(options[1]?.getAttribute("aria-disabled"), "true");
    assert.match(options[1]?.textContent ?? "", /Setup Required/);

    assert.equal(press(input, "Enter"), false, "an open popup owns Enter");
    assert.deepEqual(chosen, [], "an unavailable option cannot be committed");
    assert.equal(input.getAttribute("aria-expanded"), "true", "its explanation stays open");

    press(input, "ArrowDown");
    press(input, "Enter");
    assert.deepEqual(chosen, ["beta"]);
    assert.equal(input.value, "Dashboard");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement === input, true, "selection keeps focus on the combobox");
  } finally {
    unmount();
  }
});

test("Escape closes one layer, and Tab closes without taking over traversal", () => {
  const { input, bubbledKeys, unmount } = mount();
  try {
    act(() => input.focus());
    type(input, "remote");
    assert.equal(press(input, "Escape"), false);
    assert.deepEqual(bubbledKeys, [], "Escape must not reach the dialog while the popup is open");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(input.value, "Dashboard", "dismissal restores the committed label");
    assert.equal(press(input, "Enter"), true, "closed Enter belongs to the enclosing form");
    assert.deepEqual(bubbledKeys, ["Enter"]);

    act(() => { input.blur(); input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(press(input, "Tab"), true, "native Tab traversal must remain available");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(bubbledKeys, ["Enter", "Tab"]);

    act(() => { input.blur(); input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(press(input, "Tab", { shiftKey: true }), true,
      "native reverse traversal must remain available");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(bubbledKeys, ["Enter", "Tab", "Tab"]);
  } finally {
    unmount();
  }
});

test("an empty search keeps Enter inside the popup without inventing a choice", () => {
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    type(input, "no such agent");
    assert.equal(host.querySelectorAll('[role="option"]').length, 0);
    assert.match(host.querySelector('[role="listbox"]')?.textContent ?? "", /No Matches/);
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
    assert.equal(press(input, "Enter"), false, "open autocomplete Enter must not submit its form");
    assert.deepEqual(chosen, []);
    assert.equal(input.getAttribute("aria-expanded"), "true");
  } finally {
    unmount();
  }
});

test("pointer activation uses InlineListbox selection and keeps focus on the owner", () => {
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    act(() => fireDomEvent.click(options[1]!));
    assert.deepEqual(chosen, [], "pointer activation also refuses an unavailable option");
    assert.equal(input.getAttribute("aria-expanded"), "true");

    act(() => fireDomEvent.click(options[2]!));
    assert.deepEqual(chosen, ["beta"]);
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement === input, true);
  } finally {
    unmount();
  }
});

test("IME Enter neither selects an option nor closes the popup", () => {
  const chosen: string[] = [];
  const { input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    assert.equal(press(input, "Enter", { isComposing: true }), true,
      "the browser or IME keeps ownership of composed Enter");
    assert.deepEqual(chosen, []);
    assert.equal(input.getAttribute("aria-expanded"), "true");
  } finally {
    unmount();
  }
});

test("a disabled combobox stays readable without accepting edits", () => {
  const chosen: string[] = [];
  const { input, unmount } = mount((value) => chosen.push(value), true);
  try {
    assert.equal(input.readOnly, true, "native read-only behavior refuses text edits without eating them");
    assert.equal(input.getAttribute("aria-disabled"), "true");
    act(() => input.focus());
    assert.equal(input.getAttribute("aria-expanded"), "false");
    type(input, "changed");
    assert.equal(input.value, "Dashboard");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(chosen, []);
  } finally {
    unmount();
  }
});
