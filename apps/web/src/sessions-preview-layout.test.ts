import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { instanceStorageKey } from "./instance-storage.js";
import {
  clampSessionsListWidth,
  getSessionsPreviewLayout,
  loadSessionsListWidth,
  loadSessionsPreviewLayout,
  resetSessionsPreviewLayoutForTest,
  saveSessionsListWidth,
  SESSIONS_LIST_WIDTH_KEY,
  SESSIONS_PREVIEW_LAYOUT_KEY,
  setSessionsPreviewLayout,
  subscribeSessionsPreviewLayout,
} from "./sessions-preview-layout.js";

/** instance-storage reads the bare `localStorage` global; give the suite an isolated one. */
const priorLocalStorage = (globalThis as Record<string, unknown>)["localStorage"];
const backing = new Map<string, string>();
before(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    },
  });
});
after(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: priorLocalStorage });
});
beforeEach(() => {
  backing.clear();
  resetSessionsPreviewLayoutForTest();
});

test("a missing or unknown layout reads as below", () => {
  assert.equal(loadSessionsPreviewLayout(), "below", "an absent preference is the stacked default");
  for (const value of ["side", "Right", "", "null"]) {
    backing.set(instanceStorageKey(SESSIONS_PREVIEW_LAYOUT_KEY), value);
    assert.equal(loadSessionsPreviewLayout(), "below", `"${value}" is not a layout`);
  }
});

test("both layouts round-trip per instance", () => {
  setSessionsPreviewLayout("right");
  assert.equal(backing.get(instanceStorageKey(SESSIONS_PREVIEW_LAYOUT_KEY)), "right");
  assert.equal(loadSessionsPreviewLayout(), "right");
  assert.equal(loadSessionsPreviewLayout("remote-1"), "below", "instances do not share the preference");

  setSessionsPreviewLayout("right", "remote-1");
  setSessionsPreviewLayout("below");
  assert.equal(loadSessionsPreviewLayout(), "below");
  assert.equal(loadSessionsPreviewLayout("remote-1"), "right");
  resetSessionsPreviewLayoutForTest();
  assert.equal(getSessionsPreviewLayout(), "below", "a fresh page reads the stored value");
  assert.equal(getSessionsPreviewLayout("remote-1"), "right");
});

test("subscribers hear a change once, and not a write of the current value", () => {
  let calls = 0;
  const unsubscribe = subscribeSessionsPreviewLayout(() => { calls += 1; });
  setSessionsPreviewLayout("right");
  setSessionsPreviewLayout("right");
  assert.equal(calls, 1);
  assert.equal(getSessionsPreviewLayout(), "right");
  unsubscribe();
  setSessionsPreviewLayout("below");
  assert.equal(calls, 1, "an unsubscribed listener hears nothing");
});

test("the list width defaults to 400px, stays within 280–440px and round-trips per instance", () => {
  assert.equal(loadSessionsListWidth(), 400);
  saveSessionsListWidth(352);
  assert.equal(loadSessionsListWidth(), 352);
  assert.equal(loadSessionsListWidth("remote-1"), 400, "instances do not share the width");
  saveSessionsListWidth(1000);
  assert.equal(loadSessionsListWidth(), 440);
  saveSessionsListWidth(12.4);
  assert.equal(loadSessionsListWidth(), 280);
  backing.set(instanceStorageKey(SESSIONS_LIST_WIDTH_KEY), "wide");
  assert.equal(loadSessionsListWidth(), 400, "an unreadable width is the default");
  assert.equal(clampSessionsListWidth(333.6), 334, "widths are whole pixels");
});
