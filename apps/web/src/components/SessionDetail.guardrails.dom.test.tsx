import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionConfig, SessionView } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ComposerPlusMenu } from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  FocusEvent: domWindow.FocusEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

test("the Composer guardrails expose and persist the concurrent live-child limit", async () => {
  const applied: Partial<SessionConfig>[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ComposerPlusMenu
      session={{ costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null,
        maxChildSessions: undefined } as SessionView}
      planActive={false}
      planSupported={false}
      onTogglePlan={() => {}}
      onApply={(patch) => applied.push(patch)}
      disabled={false}
      imageMimeTypes={[]}
      onAttachImages={() => {}}
    />);
  });
  try {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]');
    assert.ok(trigger);
    await act(async () => fireDomEvent.click(trigger));
    const liveChildLabel = [...container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.textContent === "Live Child Limit");
    const input = liveChildLabel?.htmlFor
      ? container.querySelector<HTMLInputElement>(`#${liveChildLabel.htmlFor}`)
      : null;
    assert.ok(input, "the Composer menu includes a labelled live-child control");
    assert.equal(input.value, "");
    assert.equal(input.placeholder, "4");
    assert.equal(input.max, "64");
    assert.match(container.textContent ?? "", /Live Child Limit/);
    assert.doesNotMatch(container.textContent ?? "", /Pauses when spend reaches this amount/,
      "verbose guardrail guidance stays out of the compact menu by default");
    const costHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Recurring Cost Threshold"]');
    assert.ok(costHelp, "each guardrail exposes its guidance through an info control");
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    await act(async () => fireDomEvent.click(costHelp));
    assert.equal(costHelp.getAttribute("aria-expanded"), "true");
    assert.match(container.textContent ?? "", /Pauses when spend reaches this amount/);
    const helpPopover = container.querySelector<HTMLElement>(".plus-budget-help-popover");
    assert.ok(helpPopover);
    assert.equal(costHelp.getAttribute("aria-controls"), helpPopover.id);
    await act(async () => fireDomEvent.keyDown(costHelp, { key: "Escape" }));
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(container.textContent ?? "", /Pauses when spend reaches this amount/);
    await act(async () => {
      input.focus();
    });
    // Opening the menu focuses the first cost input; moving focus here may commit its empty clear.
    // Isolate this assertion to the live-child field's own blur behavior.
    applied.length = 0;
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied, [], "leaving an untouched default field does not pause child admission");
    await act(async () => {
      input.focus();
      fireDomEvent.change(input, { target: { value: "9" } });
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied.at(-1), { maxChildSessions: 9 });
    applied.length = 0;
    await act(async () => {
      input.focus();
      fireDomEvent.change(input, { target: { value: "-5" } });
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied, [], "an underflow typo cannot pause child admission");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
