import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useNewSessionShortcut } from "./useNewSessionShortcut.js";

const domWindow = new Window({ url: "http://localhost/inbox" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function Harness({ onCreate }: { onCreate: () => void }) {
  useNewSessionShortcut(true, onCreate);
  return (
    <div>
      <button type="button">Inbox</button>
      <input aria-label="Search Sessions" />
      <div className="xterm"><textarea aria-label="Terminal" /></div>
    </div>
  );
}

function pressC(target: Element): KeyboardEvent {
  const event = new domWindow.KeyboardEvent("keydown", {
    key: "c",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event as never);
  return event as unknown as KeyboardEvent;
}

test("the global C shortcut opens creation but preserves editor and terminal key ownership", async () => {
  let created = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness onCreate={() => { created += 1; }} />);
  });

  const inbox = container.querySelector<HTMLButtonElement>("button")!;
  inbox.focus();
  assert.equal(pressC(inbox).defaultPrevented, true);
  assert.equal(created, 1);

  const search = container.querySelector<HTMLInputElement>("input")!;
  search.focus();
  assert.equal(pressC(search).defaultPrevented, false);
  const terminal = container.querySelector<HTMLTextAreaElement>("textarea")!;
  terminal.focus();
  assert.equal(pressC(terminal).defaultPrevented, false);
  assert.equal(created, 1);

  await act(async () => { root.unmount(); });
  container.remove();
});
