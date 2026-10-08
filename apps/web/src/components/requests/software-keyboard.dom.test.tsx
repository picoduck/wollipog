import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { SOFTWARE_KEYBOARD_MIN_PX, useSoftwareKeyboardOpen } from "./software-keyboard.js";

/**
 * The session view renders `useSoftwareKeyboardOpen` and re-renders on every streamed event, so the
 * hook must subscribe once per mounted consumer (#2797), while still tracking `window` and
 * `visualViewport` resizes. Happy DOM has no visual viewport, so the test supplies one.
 */
const domWindow = new Window({ width: 390, height: 844 });
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
});

/** A visual viewport whose height the test sets, counting the `resize` listeners on it and on the window. */
function stubViewport() {
  const originalAddEventListener = domWindow.addEventListener;
  const originalRemoveEventListener = domWindow.removeEventListener;
  const counts = { added: 0, removed: 0 };
  const state = { height: domWindow.innerHeight };
  const viewport = new domWindow.EventTarget() as unknown as VisualViewport;
  Object.defineProperty(viewport, "height", { get: () => state.height });
  const addToViewport = viewport.addEventListener.bind(viewport);
  const removeFromViewport = viewport.removeEventListener.bind(viewport);
  viewport.addEventListener = ((...args: Parameters<VisualViewport["addEventListener"]>) => {
    counts.added += 1;
    return addToViewport(...args);
  }) as VisualViewport["addEventListener"];
  viewport.removeEventListener = ((...args: Parameters<VisualViewport["removeEventListener"]>) => {
    counts.removed += 1;
    return removeFromViewport(...args);
  }) as VisualViewport["removeEventListener"];
  Object.defineProperty(domWindow, "visualViewport", { configurable: true, get: () => viewport });
  domWindow.addEventListener = ((...args: Parameters<typeof domWindow.addEventListener>) => {
    if (args[0] === "resize") counts.added += 1;
    return originalAddEventListener.apply(domWindow, args);
  }) as typeof domWindow.addEventListener;
  domWindow.removeEventListener = ((...args: Parameters<typeof domWindow.removeEventListener>) => {
    if (args[0] === "resize") counts.removed += 1;
    return originalRemoveEventListener.apply(domWindow, args);
  }) as typeof domWindow.removeEventListener;
  return {
    counts,
    state,
    viewport,
    restore() {
      Reflect.deleteProperty(domWindow, "visualViewport");
      domWindow.addEventListener = originalAddEventListener;
      domWindow.removeEventListener = originalRemoveEventListener;
    },
  };
}

function Probe() {
  return <output>{useSoftwareKeyboardOpen() ? "open" : "closed"}</output>;
}

async function mount() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  return {
    container,
    // A fresh element each time: React skips re-rendering an identical one.
    rerender: () => act(async () => root.render(<Probe />)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("re-rendering a software-keyboard consumer adds and removes no listeners", async () => {
  const stub = stubViewport();
  const view = await mount();
  try {
    assert.deepEqual({ ...stub.counts }, { added: 2, removed: 0 }, "one `resize` listener each on the window and the visual viewport");
    for (let i = 0; i < 5; i++) await view.rerender();
    assert.deepEqual({ ...stub.counts }, { added: 2, removed: 0 }, "re-renders neither re-subscribe nor unsubscribe");
  } finally {
    await view.unmount();
    stub.restore();
  }
  assert.deepEqual({ ...stub.counts }, { added: 2, removed: 2 }, "unmounting removes both listeners");
});

test("the software-keyboard flag still tracks visual viewport and window resizes", async () => {
  const stub = stubViewport();
  const view = await mount();
  try {
    assert.equal(view.container.textContent, "closed");

    stub.state.height = domWindow.innerHeight - SOFTWARE_KEYBOARD_MIN_PX - 1;
    await act(async () => { stub.viewport.dispatchEvent(new domWindow.Event("resize") as unknown as Event); });
    assert.equal(view.container.textContent, "open", "a keyboard shrinking the visual viewport opens the flag");

    stub.state.height = domWindow.innerHeight;
    await act(async () => { stub.viewport.dispatchEvent(new domWindow.Event("resize") as unknown as Event); });
    assert.equal(view.container.textContent, "closed");

    // A layout viewport that grows past the visual one reports through the window's own resize.
    await act(async () => domWindow.happyDOM.setWindowSize({ width: 390, height: 844 + SOFTWARE_KEYBOARD_MIN_PX + 1 }));
    assert.equal(view.container.textContent, "open", "the window's resize re-reads the flag");
  } finally {
    await view.unmount();
    stub.restore();
    domWindow.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});
