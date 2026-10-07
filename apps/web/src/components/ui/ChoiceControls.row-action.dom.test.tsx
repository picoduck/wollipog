import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import { ChoiceRows, type ChoiceRowOption } from "./ChoiceControls.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  FocusEvent: domWindow.FocusEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** What has focus, as a short description: comparing DOM nodes directly makes a failure unreadable. */
function focused(): string {
  const active = domWindow.document.activeElement as unknown as HTMLElement | null;
  if (active?.tagName === "INPUT") {
    return `radio ${active.closest(".choice-row")?.querySelector(".choice-row-title")?.textContent}`;
  }
  return `${active?.tagName.toLowerCase()} ${active?.textContent?.trim() ?? ""}`.trim();
}

async function renderRows() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = async (withAction: boolean) => {
    const options: ChoiceRowOption<string>[] = [
      { value: "a", title: "Alpha", ...(withAction ? { action: <button type="button">Sign In</button> } : {}) },
      { value: "b", title: "Beta" },
    ];
    await act(async () => {
      root.render(
        <>
          <ChoiceRows label="Accounts" value="a" onChange={() => undefined} options={options} />
          <button type="button" className="elsewhere">Cancel</button>
        </>,
      );
    });
  };
  await draw(false);
  return {
    container,
    draw,
    radio: (title: string) => [...container.querySelectorAll<HTMLInputElement>("input")]
      .find((input) => input.closest(".choice-row")?.querySelector(".choice-row-title")?.textContent === title)!,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a focused row keeps focus when it gains or loses its action, which replaces its input", async () => {
  const view = await renderRows();
  try {
    view.radio("Alpha").focus();
    await view.draw(true);
    assert.ok(view.container.querySelector(".choice-row.has-action .choice-row-main input"), "the row's root changed");
    assert.equal(focused(), "radio Alpha");
    await view.draw(false);
    assertNoAction(view.container);
    assert.equal(focused(), "radio Alpha");
  } finally {
    await view.unmount();
  }
});

test("a row that gains its action takes no focus that was elsewhere", async () => {
  const view = await renderRows();
  try {
    view.container.querySelector<HTMLButtonElement>(".elsewhere")!.focus();
    await view.draw(true);
    assert.equal(focused(), "button Cancel");
    view.radio("Beta").focus();
    await view.draw(false);
    assert.equal(focused(), "radio Beta", "another row's focus is left where it is");
  } finally {
    await view.unmount();
  }
});

function assertNoAction(container: HTMLElement) {
  assert.equal(container.querySelectorAll(".choice-row.has-action").length, 0);
}
