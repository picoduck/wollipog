import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { COMPACT_BREAKPOINT_PX, COMPACT_QUERY, MOBILE_BREAKPOINT_PX, useIsCompact } from "./useIsMobile.js";

/**
 * The compact tier (#1969, docs/design-system.md §2.10) is 761–1099px inclusive. The hook is the one
 * definition components share, so its edges are tested through a real media-query evaluation (happy-dom
 * resolves `min-width`/`max-width` against the window size) rather than against a stub that answers
 * whatever it is told.
 */
const domWindow = new Window({ width: 1440, height: 900 });
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

function Probe() {
  return <output>{useIsCompact() ? "compact" : "not compact"}</output>;
}

test("useIsCompact() is true from 761px through 1099px and false at 760px and 1100px", async () => {
  assert.equal(COMPACT_QUERY, "(min-width: 761px) and (max-width: 1099px)");
  assert.equal(MOBILE_BREAKPOINT_PX, 760);
  assert.equal(COMPACT_BREAKPOINT_PX, 1100);

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const readAt = async (width: number) => {
    // The hook re-reads on `resize` as well as on the query's change event.
    await act(async () => domWindow.happyDOM.setWindowSize({ width, height: 900 }));
    return container.textContent;
  };
  try {
    await act(async () => root.render(<Probe />));
    assert.equal(container.textContent, "not compact", "1440px is the wide tier");
    assert.equal(await readAt(760), "not compact", "760px is a phone");
    assert.equal(await readAt(761), "compact");
    assert.equal(await readAt(940), "compact", "the desktop app's minimum window");
    assert.equal(await readAt(1099), "compact");
    assert.equal(await readAt(1100), "not compact", "1100px is the desktop tier");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


/**
 * Stands in for the compact query's MediaQueryList with one whose answer the test sets, counting the
 * hook's calls. Happy DOM's own list adds a `resize` listener of its own, which would blur the count.
 */
function stubCompactList() {
  const originalMatchMedia = domWindow.matchMedia;
  const originalAddEventListener = domWindow.addEventListener;
  const originalRemoveEventListener = domWindow.removeEventListener;
  const counts = { matchMedia: 0, changeAdded: 0, changeRemoved: 0, resizeAdded: 0, resizeRemoved: 0 };
  const state = { compact: false };
  const list = new domWindow.EventTarget() as unknown as MediaQueryList;
  Object.defineProperty(list, "matches", { get: () => state.compact });
  const addToList = list.addEventListener.bind(list);
  const removeFromList = list.removeEventListener.bind(list);
  list.addEventListener = ((...args: Parameters<MediaQueryList["addEventListener"]>) => {
    if (args[0] === "change") counts.changeAdded += 1;
    return addToList(...args);
  }) as MediaQueryList["addEventListener"];
  list.removeEventListener = ((...args: Parameters<MediaQueryList["removeEventListener"]>) => {
    if (args[0] === "change") counts.changeRemoved += 1;
    return removeFromList(...args);
  }) as MediaQueryList["removeEventListener"];
  const stubbed = domWindow as unknown as { matchMedia: typeof window.matchMedia };
  stubbed.matchMedia = (query: string) => {
    if (query !== COMPACT_QUERY) return originalMatchMedia.call(domWindow, query) as unknown as MediaQueryList;
    counts.matchMedia += 1;
    return list;
  };
  domWindow.addEventListener = ((...args: Parameters<typeof domWindow.addEventListener>) => {
    if (args[0] === "resize") counts.resizeAdded += 1;
    return originalAddEventListener.apply(domWindow, args);
  }) as typeof domWindow.addEventListener;
  domWindow.removeEventListener = ((...args: Parameters<typeof domWindow.removeEventListener>) => {
    if (args[0] === "resize") counts.resizeRemoved += 1;
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

test("unrelated renders reuse a single media query and change listener", async () => {
  const stub = stubCompactList();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  // Several consumers of the same query, as the app has many.
  const Probes = ({ count }: { count: number }) => <>{Array.from({ length: count }, (_, i) => <Probe key={i} />)}</>;
  try {
    await act(async () => root.render(<Probes count={2} />));
    assert.deepEqual(stub.counts, { matchMedia: 1, changeAdded: 1, changeRemoved: 0, resizeAdded: 1, resizeRemoved: 0 },
      "one MediaQueryList and one pair of listeners serve every consumer of a query");
    for (let i = 0; i < 5; i++) await act(async () => root.render(<Probes count={2} />));
    assert.deepEqual(stub.counts, { matchMedia: 1, changeAdded: 1, changeRemoved: 0, resizeAdded: 1, resizeRemoved: 0 },
      "unrelated renders neither re-evaluate the query nor re-subscribe");
    stub.state.compact = true;
    await act(async () => { stub.list.dispatchEvent(new domWindow.Event("change") as unknown as Event); });
    assert.equal(container.textContent, "compactcompact", "one change notification reaches every consumer");
    await act(async () => root.render(<Probes count={1} />));
    assert.equal(stub.counts.changeRemoved, 0, "a consumer that stays keeps the listeners attached");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    stub.restore();
  }
  assert.equal(stub.counts.changeRemoved, 1, "the change listener is removed once the last consumer unmounts");
  assert.equal(stub.counts.resizeRemoved, 1, "the resize listener is removed once the last consumer unmounts");
});

test("a resize that arrives before the query's change event still updates the flag", async () => {
  // An emulated viewport: the list already answers for the new size, and its change event is late.
  const stub = stubCompactList();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    assert.equal(container.textContent, "not compact");
    stub.state.compact = true;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
    assert.equal(container.textContent, "compact");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    stub.restore();
  }
});
