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
  assert.equal(button.getAttribute("data-spinner-room"), "", "a .btn without an icon keeps the spinner's room reserved");
  assert.equal(button.style.paddingInline, "", "busy, the stylesheet's own padding applies, not a zeroed one (#2645)");
  assert.equal(button.getAttribute("data-width-locked"), "", "a press from idle locks the width");
  assert.equal(status().textContent, "Installing the update…");

  await act(async () => { reset().click(); });
  assert.equal(button.getAttribute("aria-busy"), null);
  assert.equal(button.style.width, "", "the lock is released once it is idle again");
  assert.equal(button.hasAttribute("data-width-locked"), false);
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

test("a press on a busy button does not reach a clickable row around it", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let rowClicks = 0;
  const row = (busy: boolean) => (
    <div onClick={() => { rowClicks += 1; }}>
      <BusyButton className="btn sm" busy={busy} progress="Removing the skill…"
        onClick={(event) => event.stopPropagation()}>Remove</BusyButton>
    </div>
  );
  await act(async () => { root.render(row(false)); });
  const button = container.querySelector("button")!;
  await act(async () => { button.click(); });
  assert.equal(rowClicks, 0, "the idle button's own handler keeps the click to itself");
  await act(async () => { root.render(row(true)); });
  await act(async () => { button.click(); });
  assert.equal(rowClicks, 0, "a busy button refuses the click the way a disabled one would");
  await act(async () => root.unmount());
  container.remove();
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
  assert.equal(button.hasAttribute("data-spinner-room"), false, "an icon is the spinner's room, so nothing is reserved");
  assert.equal(button.textContent, "Add Skill");
  await act(async () => root.unmount());
  container.remove();
});

test("a button that mounts busy has no idle width to lock, so it keeps its own padding", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<BusyButton className="btn primary" busy progress="Creating the skill…">Create Skill</BusyButton>); });
  const button = container.querySelector("button")!;
  assert.equal(button.getAttribute("data-busy-spinner"), "prepended");
  assert.equal(button.style.width, "", "nothing to lock");
  assert.equal(button.hasAttribute("data-width-locked"), false, "so a dialog footer's padding rule leaves it alone");
  assert.equal(button.style.paddingInline, "");
  await act(async () => root.unmount());
  container.remove();
});

test("only a .btn reserves the spinner's room; any other button still takes it from its padding", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (busy: boolean) => root.render(
    <BusyButton className="icon-btn sm" busy={busy} progress="Dismissing…">Dismiss</BusyButton>,
  );
  await act(async () => { render(false); });
  const button = container.querySelector("button")!;
  assert.equal(button.hasAttribute("data-spinner-room"), false, "`icon-btn` contains `btn` but is not a .btn");
  await act(async () => { render(true); });
  assert.equal(button.getAttribute("data-busy-spinner"), "prepended");
  assert.equal(Number.parseFloat(button.style.paddingInline), 0, "without reserved room the spinner's room comes from the padding");
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
  assert.match(css, /\.btn\.sm\[data-busy-spinner="prepended"\] \{[^}]*gap: var\(--space-0-5\)/);
  // The reserved room is the size's padding plus half the spinner and its busy gap, at rest only
  // (#2645). The real-browser measurement is apps/web/e2e/busy-button.spec.ts.
  for (const [selector, padding, gap] of [
    [".btn", "--space-3", "--space-1"],
    [".btn.sm", "--space-2", "--space-0-5"],
    [".btn.lg", "--space-4", "--space-1"],
  ] as const) {
    const rule = `\n${selector}[data-spinner-room]:not([aria-busy="true"]) {`;
    assert.ok(css.includes(rule), `${selector} reserves the spinner's room`);
    const body = css.slice(css.indexOf(rule) + rule.length).split("}")[0] ?? "";
    assert.match(body, new RegExp(`padding-inline: calc\\(var\\(${padding}\\) \\+ \\(var\\(--icon-sm\\) \\+ var\\(${gap}\\)\\) / 2\\);`));
  }
  // A dialog footer reserves nothing (its three-button row cannot spare the room) except 2px a side
  // on a `.sm`, which a busy `.sm` keeps, so it is never flush.
  assert.match(css, /\n\.modal-foot > \.btn\[data-spinner-room\]:not\(\[aria-busy="true"\]\) \{ padding-inline: var\(--space-3\); \}/);
  assert.match(css, /\n\.modal-foot > \.btn\.sm\[data-spinner-room\]:not\(\[aria-busy="true"\]\) \{ padding-inline: calc\(var\(--space-2\) \+ var\(--space-0-5\)\); \}/);
  // Only a locked width gives its padding up: a button that mounts busy keeps its own.
  assert.match(css, /\n\.modal-foot > \.btn\[data-spinner-room\]\[data-busy-spinner="prepended"\]\[data-width-locked\] \{ padding-inline: 0; \}/);
  assert.match(css, /\n\.modal-foot > \.btn\.sm\[data-spinner-room\]\[data-busy-spinner="prepended"\]\[data-width-locked\] \{ padding-inline: var\(--space-0-5\); \}/);
});
