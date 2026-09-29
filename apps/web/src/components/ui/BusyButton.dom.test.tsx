import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { assertNoDomNode } from "../../dom-test-assertions.js";
import { BusyButton } from "./BusyButton.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/**
 * happy-dom has no layout, so width comes from a stand-in: a button is as wide as its padding, its
 * label and, when there is one, its spinner and gap, unless an inline width says otherwise. That is
 * the one layout fact a busy button can get wrong: prepending a spinner makes a button wider.
 * The real-browser measurement of every variant and size is apps/web/e2e/busy-button.spec.ts.
 */
const layoutWidth = (element: Element): number => {
  const inline = (element as HTMLElement).style?.width;
  if (inline) return Number.parseFloat(inline);
  if (element.tagName !== "BUTTON") return 0;
  const spinner = element.querySelector(".spinner") ? 14 + 8 : 0;
  return 2 + 24 + spinner + (element.textContent ?? "").length * 7;
};
Object.defineProperty(domWindow, "getComputedStyle", {
  configurable: true,
  writable: true,
  value: (element: Element) => ({ width: `${layoutWidth(element)}px` }),
});

function Fixture({ onRun }: { onRun: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={(event) => { event.preventDefault(); onRun(); }}>
      <BusyButton className="btn primary" type="submit" busy={busy} progress="Installing the update…"
        onClick={() => setBusy(true)}>
        Install and Restart
      </BusyButton>
      <button type="button" data-testid="idle" onClick={() => setBusy(false)}>Reset</button>
    </form>
  );
}

async function render(onRun: () => void = () => undefined) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<Fixture onRun={onRun} />); });
  const button = container.querySelector<HTMLButtonElement>("button.btn")!;
  return {
    button,
    status: () => container.querySelector('.sr-only[role="status"]')!,
    reset: () => container.querySelector<HTMLButtonElement>('[data-testid="idle"]')!,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a busy button keeps its label and width, puts a spinner before the label and sets aria-busy", async () => {
  const { button, status, reset, cleanup } = await render();
  const idleWidth = domWindow.getComputedStyle(button as never).width;
  assert.equal(button.getAttribute("aria-busy"), null);
  assertNoDomNode(button.querySelector(".spinner"));
  assert.equal(status().textContent, "", "the live line exists before it has anything to say");

  await act(async () => { button.click(); });
  assert.equal(button.textContent, "Install and Restart");
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  const spinner = button.firstElementChild!;
  assert.equal(spinner.className, "spinner", "the spinner comes before the label");
  assert.equal(spinner.getAttribute("aria-hidden"), "true", "decorative: the label already names the action");
  assert.equal(domWindow.getComputedStyle(button as never).width, idleWidth, "the width does not change");
  assert.equal(button.style.minWidth, idleWidth);
  assert.equal(button.getAttribute("data-busy-spinner"), "prepended");
  assert.equal(status().textContent, "Installing the update…");

  await act(async () => { reset().click(); });
  assert.equal(button.getAttribute("aria-busy"), null);
  assert.equal(button.style.width, "", "the lock is released once it is idle again");
  assertNoDomNode(button.querySelector(".spinner"));
  assert.equal(status().textContent, "");
  await cleanup();
});

test("a busy button refuses a second press without submitting its form", async () => {
  let submits = 0;
  const { button, cleanup } = await render(() => { submits += 1; });
  await act(async () => { button.click(); });
  assert.equal(submits, 1);
  await act(async () => { button.click(); });
  assert.equal(submits, 1, "a busy submit button does not submit again");
  await cleanup();
});

test("a spinner takes a leading icon's place", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const icon = <svg data-testid="icon" />;
  await act(async () => { root.render(<BusyButton className="btn" busy={false} progress="Adding the skill…" icon={icon}>Add Skill</BusyButton>); });
  const button = container.querySelector("button")!;
  assert.ok(button.querySelector('[data-testid="icon"]'));
  await act(async () => { root.render(<BusyButton className="btn" busy progress="Adding the skill…" icon={icon}>Add Skill</BusyButton>); });
  assertNoDomNode(button.querySelector('[data-testid="icon"]'));
  assert.equal(button.firstElementChild?.className, "spinner");
  assert.equal(button.getAttribute("data-busy-spinner"), "replaced");
  assert.equal(button.textContent, "Add Skill");
  await act(async () => root.unmount());
  container.remove();
});

test("the stylesheet draws the spinner at 14px and keeps a busy button's variant", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const spinner = css.match(/\n\.spinner \{([^}]*)\}/)?.[1] ?? "";
  assert.match(spinner, /width: 14px;/);
  assert.match(spinner, /height: 14px;/);
  // A busy primary keeps its fill: the disabled rule would otherwise grey it out while it runs.
  assert.match(css, /\.btn\.primary\[aria-busy="true"\]\[aria-disabled="true"\] \{[^}]*background: var\(--primary-bg\)/);
  assert.match(css, /\.btn\[data-busy-spinner="prepended"\] \{[^}]*padding-inline: 0/);
});
