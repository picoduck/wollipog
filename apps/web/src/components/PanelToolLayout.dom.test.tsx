import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useState } from "react";
import "./test-dom-events.js";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { PanelToolLayout } from "./PanelToolLayout.js";

/**
 * The foot yields to a text field in the scroller (#2907): while one has focus the foot is marked
 * `is-yielded` (which a coarse pointer's stylesheet collapses), it stays mounted with its state, and
 * focus in the foot's own field, on a checkbox or in a field portalled out of the scroller never
 * marks it.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
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
  domWindow.close();
});

/** A foot with its own message field, over a scroller with an editor that can be closed. */
function Harness() {
  const [editing, setEditing] = useState(true);
  const [message, setMessage] = useState("Fix the total");
  return (
    <PanelToolLayout
      foot={<input aria-label="Commit Message" value={message} onChange={(event) => setMessage(event.target.value)} />}
    >
      {editing && <textarea aria-label="Finding" />}
      <textarea aria-label="Second Finding" />
      <textarea aria-label="Read Only" readOnly />
      <input type="checkbox" aria-label="Required" />
      <button type="button" onClick={() => setEditing(false)}>Close</button>
      {createPortal(<input aria-label="Dialog Field" />, document.body)}
    </PanelToolLayout>
  );
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  const get = <T extends Element>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)!;
  const foot = () => container.querySelector(".rpanel-foot")!;
  const focus = async (element: HTMLElement) => act(async () => element.focus());
  return { container, root, get, foot, focus };
}

test("a focused text field in the scroller yields the foot, and blur brings it back intact", async () => {
  const { root, get, foot, focus } = await render();
  const footBefore = foot();
  assert.equal(footBefore.classList.contains("is-yielded"), false);

  await focus(get<HTMLTextAreaElement>("Finding"));
  assert.equal(foot().classList.contains("is-yielded"), true);
  assert.equal(foot(), footBefore, "the foot stays mounted");
  assert.equal(get<HTMLInputElement>("Commit Message").value, "Fix the total");

  // Straight from one field to another: still yielded.
  await focus(get<HTMLTextAreaElement>("Second Finding"));
  assert.equal(foot().classList.contains("is-yielded"), true);

  await act(async () => get<HTMLTextAreaElement>("Second Finding").blur());
  assert.equal(foot().classList.contains("is-yielded"), false);
  assert.equal(get<HTMLInputElement>("Commit Message").value, "Fix the total");
  await act(async () => root.unmount());
});

test("the foot's own field, a read-only field, a checkbox and a portalled field never yield it", async () => {
  const { root, get, foot, focus } = await render();
  // "Dialog Field" is portalled out of the scroller: React bubbles its focus here, the DOM doesn't.
  for (const label of ["Commit Message", "Read Only", "Required", "Dialog Field"]) {
    await focus(get<HTMLElement>(label));
    assert.equal(foot().classList.contains("is-yielded"), false, label);
  }
  await focus(get<HTMLTextAreaElement>("Finding"));
  assert.equal(foot().classList.contains("is-yielded"), true);
  await focus(get<HTMLElement>("Required"));
  assert.equal(foot().classList.contains("is-yielded"), false, "a checkbox opens no keyboard");
  await act(async () => root.unmount());
});

test("removing the focused field brings the foot back", async () => {
  const { container, root, get, foot, focus } = await render();
  const field = get<HTMLTextAreaElement>("Finding");
  await focus(field);
  assert.equal(foot().classList.contains("is-yielded"), true);
  // Close the editor without moving focus first, as Add Finding does when the card goes away.
  const close = [...container.querySelectorAll("button")].find((button) => button.textContent === "Close")!;
  await act(async () => close.click());
  assert.equal(field.isConnected, false);
  assert.equal(foot().classList.contains("is-yielded"), false);
  await act(async () => root.unmount());
});

/** An editor that closes itself, as the diff viewer's Cancel does: the layout above never rerenders. */
function SelfClosingEditor() {
  const [open, setOpen] = useState(true);
  return open ? (
    <div>
      <textarea aria-label="Own Finding" />
      <button type="button" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  ) : null;
}

test("an editor removing itself with focus still brings the foot back", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <PanelToolLayout foot={<input aria-label="Commit Message" />}><SelfClosingEditor /></PanelToolLayout>,
  ));
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Own Finding"]')!;
  await act(async () => field.focus());
  const foot = () => container.querySelector(".rpanel-foot")!;
  assert.equal(foot().classList.contains("is-yielded"), true);
  // A tap on Cancel moves no focus on iOS: the textarea is still focused when its card goes.
  const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  await act(async () => cancel.click());
  assert.equal(field.isConnected, false);
  assert.equal(foot().classList.contains("is-yielded"), false);
  await act(async () => root.unmount());
});
