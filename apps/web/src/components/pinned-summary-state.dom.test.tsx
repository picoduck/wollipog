import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PINNED_SUMMARY_DOCK_MIN_PX,
  PINNED_SUMMARY_READER_MIN_PX,
  PINNED_SUMMARY_WIDTH_PX,
  pinnedSummaryPresentation,
  usePinnedSummaryState,
  type PinnedSummaryState,
} from "./pinned-summary-state.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
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
beforeEach(() => domWindow.localStorage.clear());

/** Mounts the hook and hands back the live state plus a way to change the phone flag. */
async function mount(phone: boolean, onOverlayOpen?: () => void) {
  const state: { current: PinnedSummaryState | null } = { current: null };
  let setPhone: (value: boolean) => void = () => undefined;
  function Probe() {
    const [isPhone, setIsPhone] = React.useState(phone);
    setPhone = setIsPhone;
    state.current = usePinnedSummaryState(isPhone, { onOverlayOpen });
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  const run = (fn: (value: PinnedSummaryState) => void) => act(async () => fn(state.current!));
  return {
    get: () => state.current!,
    run,
    phone: (value: boolean) => act(async () => setPhone(value)),
    unmount: () => act(async () => root.unmount()),
  };
}

test("the dock threshold keeps 560px of reader beside a 280px summary", () => {
  assert.equal(PINNED_SUMMARY_WIDTH_PX, 280);
  assert.equal(PINNED_SUMMARY_READER_MIN_PX, 560);
  assert.equal(PINNED_SUMMARY_DOCK_MIN_PX, 840);
  assert.equal(pinnedSummaryPresentation(false, null), "docked", "an unmeasured body docks");
  assert.equal(pinnedSummaryPresentation(false, true), "docked");
  assert.equal(pinnedSummaryPresentation(false, false), "drawer");
  assert.equal(pinnedSummaryPresentation(true, true), "sheet", "a phone always uses the sheet");
});

test("docked, the toggle flips and persists the preference; the default is open", async () => {
  const hook = await mount(false);
  try {
    await hook.run((state) => state.reportBodyWidth(1100));
    assert.equal(hook.get().presentation, "docked");
    assert.equal(hook.get().open, true);
    await hook.run((state) => state.toggle());
    assert.equal(hook.get().open, false);
    assert.equal(domWindow.localStorage.getItem("wollipog.pinned.open"), "0");
    await hook.run((state) => state.closeOverlay());
    assert.equal(hook.get().open, false, "closing an overlay never touches the preference");
  } finally {
    await hook.unmount();
  }
});

test("a stored closed preference loads closed", async () => {
  domWindow.localStorage.setItem("wollipog.pinned.open", "0");
  const hook = await mount(false);
  try {
    assert.equal(hook.get().open, false);
  } finally {
    await hook.unmount();
  }
});

test("the drawer starts closed, is never persisted, and closes when the body crosses the threshold", async () => {
  domWindow.localStorage.setItem("wollipog.pinned.open", "1");
  const hook = await mount(false);
  try {
    await hook.run((state) => state.reportBodyWidth(PINNED_SUMMARY_DOCK_MIN_PX - 0.5));
    assert.equal(hook.get().presentation, "drawer");
    assert.equal(hook.get().open, false, "the preference does not open the drawer");
    await hook.run((state) => state.toggle());
    assert.equal(hook.get().open, true);
    assert.equal(domWindow.localStorage.getItem("wollipog.pinned.open"), "1", "the drawer is not persisted");

    await hook.run((state) => state.reportBodyWidth(PINNED_SUMMARY_DOCK_MIN_PX));
    assert.equal(hook.get().presentation, "docked", "exactly 840px docks");
    assert.equal(hook.get().open, true, "widening docks it by the preference");
    await hook.run((state) => state.reportBodyWidth(700));
    assert.equal(hook.get().open, false, "narrowing closes it; the old drawer does not come back");

    await hook.run((state) => state.toggle());
    assert.equal(hook.get().open, true);
    await hook.run((state) => state.closeOverlay());
    assert.equal(hook.get().open, false);
  } finally {
    await hook.unmount();
  }
});

test("a phone sheet starts closed whatever the preference, and an overlay does not survive a crossing", async () => {
  domWindow.localStorage.setItem("wollipog.pinned.open", "1");
  let overlayOpens = 0;
  const hook = await mount(true, () => { overlayOpens += 1; });
  try {
    assert.equal(hook.get().presentation, "sheet");
    assert.equal(hook.get().open, false);
    await hook.run((state) => state.toggle());
    assert.equal(hook.get().open, true);
    assert.equal(overlayOpens, 1, "opening an overlay lets the shell close the other overlay");
    await hook.run((state) => state.toggle());
    assert.equal(hook.get().open, false);
    assert.equal(overlayOpens, 1, "closing is not an opening");

    // Drawer open → phone → back: closed each time.
    await hook.phone(false);
    await hook.run((state) => state.reportBodyWidth(800));
    await hook.run((state) => state.toggle());
    assert.equal(hook.get().open, true);
    await hook.phone(true);
    assert.equal(hook.get().open, false);
    await hook.phone(false);
    assert.equal(hook.get().presentation, "drawer");
    assert.equal(hook.get().open, false);
    assert.equal(domWindow.localStorage.getItem("wollipog.pinned.open"), "1");
  } finally {
    await hook.unmount();
  }
});
