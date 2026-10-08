import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ENTER_KEY_STORAGE_KEY, setEnterKeyBehavior, useEnterKeyBehavior } from "./enter-key.js";
import { TOUCH_PHONE_MEDIA } from "./mobile-viewport.js";

/**
 * The session view renders `useEnterKeyBehavior` and re-renders on every streamed event, so the hook
 * must subscribe once per mounted consumer and evaluate the touch-phone query once (#2797), while
 * still following every source of the setting.
 */
const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorEvent = globalThis.Event;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  // The setter announces its change with a global `Event`, which must be the window's own.
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: domWindow.Event });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: priorEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
});

const WATCHED_WINDOW_EVENTS = ["resize", "storage", "wollipog:enter-key-change"];

/**
 * Stands in for the touch-phone MediaQueryList with one whose answer the test sets, and counts
 * `matchMedia` calls and every listener the hook adds or removes on the list and the window.
 */
function stubTouchPhoneList() {
  const originalMatchMedia = domWindow.matchMedia;
  const originalAddEventListener = domWindow.addEventListener;
  const originalRemoveEventListener = domWindow.removeEventListener;
  const counts = { matchMedia: 0, added: 0, removed: 0 };
  const state = { touchPhone: false };
  const list = new domWindow.EventTarget() as unknown as MediaQueryList;
  Object.defineProperty(list, "matches", { get: () => state.touchPhone });
  const addToList = list.addEventListener.bind(list);
  const removeFromList = list.removeEventListener.bind(list);
  list.addEventListener = ((...args: Parameters<MediaQueryList["addEventListener"]>) => {
    counts.added += 1;
    return addToList(...args);
  }) as MediaQueryList["addEventListener"];
  list.removeEventListener = ((...args: Parameters<MediaQueryList["removeEventListener"]>) => {
    counts.removed += 1;
    return removeFromList(...args);
  }) as MediaQueryList["removeEventListener"];
  const stubbed = domWindow as unknown as { matchMedia: typeof window.matchMedia };
  stubbed.matchMedia = (query: string) => {
    if (query !== TOUCH_PHONE_MEDIA) return originalMatchMedia.call(domWindow, query) as unknown as MediaQueryList;
    counts.matchMedia += 1;
    return list;
  };
  domWindow.addEventListener = ((...args: Parameters<typeof domWindow.addEventListener>) => {
    if (WATCHED_WINDOW_EVENTS.includes(args[0])) counts.added += 1;
    return originalAddEventListener.apply(domWindow, args);
  }) as typeof domWindow.addEventListener;
  domWindow.removeEventListener = ((...args: Parameters<typeof domWindow.removeEventListener>) => {
    if (WATCHED_WINDOW_EVENTS.includes(args[0])) counts.removed += 1;
    return originalRemoveEventListener.apply(domWindow, args);
  }) as typeof domWindow.removeEventListener;
  return {
    counts,
    state,
    list,
    restore() {
      stubbed.matchMedia = originalMatchMedia as unknown as typeof window.matchMedia;
      domWindow.addEventListener = originalAddEventListener;
      domWindow.removeEventListener = originalRemoveEventListener;
    },
  };
}

function Probe() {
  return <output>{useEnterKeyBehavior()}</output>;
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

test("re-rendering an Enter-key consumer neither re-subscribes nor re-evaluates the touch-phone query", async () => {
  domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
  const stub = stubTouchPhoneList();
  const view = await mount();
  try {
    assert.equal(view.container.textContent, "send");
    assert.ok(stub.counts.matchMedia <= 1, `mounting evaluates the query at most once (${stub.counts.matchMedia} calls)`);
    const mounted = { ...stub.counts };
    for (let i = 0; i < 5; i++) await view.rerender();
    assert.deepEqual({ ...stub.counts }, mounted, "re-renders add no listener, remove none and call matchMedia no more");
  } finally {
    await view.unmount();
    stub.restore();
  }
  assert.equal(stub.counts.removed, stub.counts.added, "unmounting removes every listener it added");
});

test("the Enter-key value still follows the stored choice, the setter, other tabs and the breakpoint", async () => {
  domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
  const stub = stubTouchPhoneList();
  const view = await mount();
  try {
    assert.equal(view.container.textContent, "send", "an untouched desktop sends");

    stub.state.touchPhone = true;
    await act(async () => { stub.list.dispatchEvent(new domWindow.Event("change") as unknown as Event); });
    assert.equal(view.container.textContent, "newline", "crossing into a touch phone derives newline");

    await act(async () => setEnterKeyBehavior("send"));
    assert.equal(view.container.textContent, "send", "the setter's change event applies the choice in this tab");

    // Another tab's write reaches this one only as a `storage` event.
    const otherTabStores = async (value: string | null) => {
      if (value === null) domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
      else domWindow.localStorage.setItem(ENTER_KEY_STORAGE_KEY, value);
      await act(async () => { domWindow.dispatchEvent(new domWindow.StorageEvent("storage", { key: ENTER_KEY_STORAGE_KEY })); });
    };
    await otherTabStores(null);
    assert.equal(view.container.textContent, "newline", "a choice cleared by another tab falls back to the device class");
    await otherTabStores("send");
    assert.equal(view.container.textContent, "send", "a choice stored by another tab applies");

    await otherTabStores(null);
    assert.equal(view.container.textContent, "newline");
    stub.state.touchPhone = false;
    await act(async () => { stub.list.dispatchEvent(new domWindow.Event("change") as unknown as Event); });
    assert.equal(view.container.textContent, "send", "back on a desktop, the derived default sends again");
  } finally {
    await view.unmount();
    stub.restore();
    domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
  }
});
