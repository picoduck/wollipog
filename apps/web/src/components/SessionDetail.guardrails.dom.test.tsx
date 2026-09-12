import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ParentControlMode, SessionConfig, SessionView } from "@wollipog/protocol";
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
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
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
    assert.equal(costHelp.getAttribute("aria-describedby"), helpPopover.id);
    const toolHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Tool-Call Threshold"]');
    assert.ok(toolHelp);
    await act(async () => {
      fireDomEvent.pointerDown(toolHelp);
      fireDomEvent.click(toolHelp);
    });
    assert.equal(container.querySelectorAll(".plus-budget-help-popover").length, 1,
      "an outside pointer dismisses the previous disclosure before opening another");
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    assert.equal(toolHelp.getAttribute("aria-expanded"), "true");
    await act(async () => fireDomEvent.keyDown(toolHelp, { key: "Escape" }));
    assert.equal(toolHelp.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelectorAll(".plus-budget-help-popover").length, 0);
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

test("the Composer exposes human-controlled Parent Control only for Orchestrator sessions", async () => {
  const selected: ParentControlMode[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (permissionMode: string) => root.render(<ComposerPlusMenu
    session={{ permissionMode, parentControl: "off", costBudgetUsd: null,
      costCheckpointsUsd: null, maxToolCalls: null } as SessionView}
    planActive={false}
    planSupported={false}
    onTogglePlan={() => {}}
    onApply={() => {}}
    onSetParentControl={(mode) => selected.push(mode)}
    disabled={false}
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />);
  await act(async () => render("default"));
  try {
    await act(async () => fireDomEvent.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!,
    ));
    assert.equal(container.querySelector('[aria-label^="Parent Control:"]'), null);

    await act(async () => render("orchestrator"));
    const select = container.querySelector<HTMLButtonElement>('[aria-label="Parent Control: Off"]');
    assert.ok(select);
    await act(async () => fireDomEvent.click(select));
    const questions = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Questions") && !option.textContent?.includes("Approvals"));
    assert.ok(questions);
    await act(async () => fireDomEvent.click(questions));
    assert.deepEqual(selected, ["questions"]);
    assert.match(container.textContent ?? "", /Only an authenticated human can change/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
