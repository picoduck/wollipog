import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EarlierActivityControl } from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/session/test" });
installDomTestCleanup(domWindow);
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

type ControlState = { available: boolean; loading: boolean; error: string | null };

async function fixture() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const reader = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  reader.tabIndex = 0;
  domWindow.document.body.append(container as never, reader as never);
  const root = createRoot(container);
  const fallbackFocusRef = { current: reader };
  const loads: string[] = [];
  const render = async (state: ControlState) => {
    await act(async () => root.render(
      <EarlierActivityControl
        {...state}
        onLoad={() => loads.push("load")}
        fallbackFocusRef={fallbackFocusRef}
      />,
    ));
  };
  const action = (name: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent) === name);
    assert.ok(button, `expected ${name} button`);
    return button;
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    reader.remove();
  };
  return { container, reader, loads, render, action, cleanup };
}

async function keyboardActivate(button: HTMLButtonElement): Promise<void> {
  button.focus();
  await act(async () => button.click());
}

test("keyboard pagination keeps logical focus through fallback, Retry, and exhaustion", async () => {
  const view = await fixture();
  try {
    await view.render({ available: true, loading: false, error: null });
    await keyboardActivate(view.action("Load Earlier Activity"));
    await view.render({ available: true, loading: true, error: null });
    const loading = view.container.querySelector<HTMLElement>("[data-state='loading']");
    assert.equal(domWindow.document.activeElement, loading);

    await view.render({ available: true, loading: false, error: "Could not load earlier activity." });
    assert.equal(domWindow.document.activeElement, view.action("Retry"));

    await keyboardActivate(view.action("Retry"));
    await view.render({ available: true, loading: true, error: null });
    assert.equal(domWindow.document.activeElement, view.container.querySelector("[data-state='loading']"));
    await view.render({ available: true, loading: false, error: "Could not load earlier activity." });
    assert.equal(domWindow.document.activeElement, view.action("Retry"));

    await keyboardActivate(view.action("Retry"));
    await view.render({ available: true, loading: true, error: null });
    await view.render({ available: true, loading: false, error: null });
    assert.equal(domWindow.document.activeElement, view.action("Load Earlier Activity"));

    await keyboardActivate(view.action("Load Earlier Activity"));
    await view.render({ available: true, loading: true, error: null });
    await view.render({ available: false, loading: false, error: null });
    assert.equal(domWindow.document.activeElement, view.reader);
    assert.equal(view.loads.length, 4);
  } finally {
    await view.cleanup();
  }
});

test("pointer pagination does not restore focus after the control changes", async () => {
  const view = await fixture();
  try {
    await view.render({ available: true, loading: false, error: null });
    const fallback = view.action("Load Earlier Activity");
    fallback.focus();
    await act(async () => fallback.dispatchEvent(new domWindow.MouseEvent("click", {
      bubbles: true,
      detail: 1,
    }) as unknown as Event));
    await view.render({ available: true, loading: true, error: null });
    assert.notEqual(domWindow.document.activeElement, view.container.querySelector("[data-state='loading']"));
    await view.render({ available: true, loading: false, error: null });
    assert.notEqual(domWindow.document.activeElement, view.action("Load Earlier Activity"));
    assert.equal(view.loads.length, 1);
  } finally {
    await view.cleanup();
  }
});
