import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TERMINAL_PLACEMENT_STORAGE_KEY,
  setTerminalPlacement,
  terminalPlacement,
} from "./terminal-placement.js";

/**
 * The per-device Terminal Placement (§4.6, #2867), against a synthetic window. An unset or
 * unreadable value means the bottom dock, and the default is never written.
 */

function fakeWin({ stored, broken = false }: { stored?: string; broken?: boolean } = {}) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set(TERMINAL_PLACEMENT_STORAGE_KEY, stored);
  const events: string[] = [];
  const win = {
    localStorage: broken
      ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
      : {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  } as unknown as Window;
  return { win, store, events };
}

test("a missing, empty or unknown value means the bottom dock", () => {
  assert.equal(terminalPlacement(fakeWin().win), "dock");
  assert.equal(terminalPlacement(fakeWin({ stored: "" }).win), "dock");
  assert.equal(terminalPlacement(fakeWin({ stored: "sidebar" }).win), "dock");
  assert.equal(terminalPlacement(fakeWin({ stored: "PANEL" }).win), "dock");
});

test("unreadable storage means the bottom dock", () => {
  assert.equal(terminalPlacement(fakeWin({ broken: true }).win), "dock");
});

test("a stored choice applies in both directions", () => {
  assert.equal(terminalPlacement(fakeWin({ stored: "panel" }).win), "panel");
  assert.equal(terminalPlacement(fakeWin({ stored: "dock" }).win), "dock");
});

test("reading never writes the default", () => {
  const { win, store } = fakeWin();
  terminalPlacement(win);
  assert.equal(store.has(TERMINAL_PLACEMENT_STORAGE_KEY), false);
});

test("the setter stores the choice under the per-device key and announces it", () => {
  const { win, store, events } = fakeWin();
  setTerminalPlacement("panel", win);
  assert.equal(store.get(TERMINAL_PLACEMENT_STORAGE_KEY), "panel");
  assert.equal(terminalPlacement(win), "panel");
  assert.equal(events.length, 1, "a same-tab write announces itself, since `storage` only reaches other tabs");
  setTerminalPlacement("dock", win);
  assert.equal(store.get(TERMINAL_PLACEMENT_STORAGE_KEY), "dock");
  assert.equal(terminalPlacement(win), "dock");
});

test("a choice storage refuses to keep still governs this page", () => {
  const { win, events } = fakeWin({ broken: true });
  setTerminalPlacement("panel", win);
  assert.equal(events.length, 1, "the change is still announced");
  assert.equal(terminalPlacement(win), "panel", "the denied choice must hold for the page's lifetime");
});
