import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ShortcutReference } from "./ShortcutReference.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
/** The media queries the stub answers `true` for; `(pointer: fine)` lets the filter take focus. */
let matchingMedia = new Set<string>(["(pointer: fine)"]);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: matchingMedia.has(query),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const document = domWindow.document as unknown as Document;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  matchingMedia = new Set(["(pointer: fine)"]);
});

async function open(onClose: () => void = () => undefined) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ShortcutReference
        onClose={onClose}
        sessionOpen
        terminalSupported
        filesSupported
        conversationSteeringSupported
        turnInterruptionSupported
      />,
    );
  });
  cleanups.push(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const filter = dialog.querySelector<HTMLInputElement>('input[aria-label="Filter Shortcuts"]')!;
  return { dialog, filter };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => { fireDomEvent.change(input, { target: { value } }); });
}

const headings = (dialog: HTMLElement) => [...dialog.querySelectorAll("h3")].map((heading) => heading.textContent);
const labels = (dialog: HTMLElement) => [...dialog.querySelectorAll(".shortcut-row dt")].map((label) => label.textContent);

test("the filter keeps only matching rows and their headings, and says when nothing matches", async () => {
  const { dialog, filter } = await open();
  assert.equal(document.activeElement, filter, "a fine pointer starts in the filter");
  assert.equal(dialog.querySelectorAll(".shortcut-column").length, 2, "two columns above the tablet breakpoint");

  await type(filter, "term");
  assert.deepEqual(headings(dialog), ["Session"]);
  assert.deepEqual(labels(dialog), ["Toggle Terminal", "Exit Terminal Focus"]);

  await type(filter, "nothing like this");
  assertNoDomNode(dialog.querySelector(".shortcut-columns"), "no columns without a match");
  assert.equal(dialog.querySelector('.state.no-results[role="status"]')?.textContent?.startsWith("No shortcuts match “nothing like this”."), true);

  const clear = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Clear Filter")!;
  await act(async () => { clear.click(); });
  assert.equal(filter.value, "");
  assert.equal(document.activeElement, filter, "clearing returns focus to the field it cleared");
  assert.ok(labels(dialog).length > 40);
});

test("Done closes the reference", async () => {
  let closed = 0;
  const { dialog } = await open(() => { closed += 1; });
  const buttons = [...dialog.querySelectorAll(".modal-foot button")];
  assert.deepEqual(buttons.map((button) => button.textContent), ["Done"]);
  await act(async () => { (buttons[0] as HTMLButtonElement).click(); });
  assert.equal(closed, 1);
});

test("at or below the tablet breakpoint the groups are one column, and a phone leads with the hardware keyboard", async () => {
  matchingMedia = new Set(["(max-width: 900px)", "(max-width: 760px)"]);
  const { dialog } = await open();
  assert.equal(dialog.querySelectorAll(".shortcut-column").length, 1);
  assert.deepEqual(headings(dialog).slice(0, 2), ["Navigation", "Actions"]);
  assert.equal(dialog.querySelector(".modal-desc")?.textContent,
    "These shortcuts need a hardware keyboard. Shortcuts pause while a terminal has focus.");
});
