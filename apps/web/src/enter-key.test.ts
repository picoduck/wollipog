import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENTER_KEY_STORAGE_KEY,
  enterKeyBehavior,
  enterKeystrokeSends,
  setEnterKeyBehavior,
  storedEnterKeyBehavior,
} from "./enter-key.js";

/**
 * The resolution and the swap, against a synthetic window.
 *
 * The device-class default is the part a fixture-driven DOM test keeps constant, so it is pinned
 * here: an untouched phone must get newline and an untouched desktop send WITHOUT anything ever
 * being written — storing the default would freeze a first-visit device class into every later
 * read, and a stored value must beat the device class in both directions.
 */

function fakeWin({ stored, touchPhone = false, broken = false }: {
  stored?: string;
  touchPhone?: boolean;
  broken?: boolean;
} = {}) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set(ENTER_KEY_STORAGE_KEY, stored);
  const events: string[] = [];
  const win = {
    localStorage: broken
      ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
      : {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    matchMedia: () => ({ matches: touchPhone }),
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  } as unknown as Window;
  return { win, store, events };
}

test("the unstored default derives from the device class", () => {
  assert.equal(enterKeyBehavior(fakeWin().win), "send");
  assert.equal(enterKeyBehavior(fakeWin({ touchPhone: true }).win), "newline");
});

test("a stored choice beats the device class in both directions", () => {
  assert.equal(enterKeyBehavior(fakeWin({ stored: "newline" }).win), "newline");
  assert.equal(enterKeyBehavior(fakeWin({ stored: "send", touchPhone: true }).win), "send");
});

test("an unrecognised stored value falls back to the derived default", () => {
  // A future rename or a hand-edited key must not wedge the composer into an undefined mode.
  assert.equal(storedEnterKeyBehavior(fakeWin({ stored: "garbage" }).win), null);
  assert.equal(enterKeyBehavior(fakeWin({ stored: "garbage", touchPhone: true }).win), "newline");
});

test("denied storage leaves the derived default in force until a choice is made", () => {
  // Private-mode localStorage throws; the composer must still resolve a mode.
  assert.equal(enterKeyBehavior(fakeWin({ broken: true, touchPhone: true }).win), "newline");
});

test("a choice storage refuses to keep still governs this page", () => {
  // The change event alone was a lie: it announced a choice every reader immediately re-derived
  // away, so the settings row snapped back and the composer never changed.
  const { win, events } = fakeWin({ broken: true });
  setEnterKeyBehavior("newline", win);
  assert.equal(events.length, 1, "the change is still announced");
  assert.equal(enterKeyBehavior(win), "newline", "the denied choice must hold for the page's lifetime");
  assert.equal(enterKeystrokeSends(true, win), true, "and the composer must follow it");
});

test("the pair swaps as a unit", () => {
  const send = fakeWin().win;
  assert.equal(enterKeystrokeSends(false, send), true, "send mode: plain Enter sends");
  assert.equal(enterKeystrokeSends(true, send), false, "send mode: Shift+Enter is the newline");
  const newline = fakeWin({ touchPhone: true }).win;
  assert.equal(enterKeystrokeSends(false, newline), false, "newline mode: plain Enter is the newline");
  assert.equal(enterKeystrokeSends(true, newline), true, "newline mode: Shift+Enter sends");
});

test("the setter persists per device and announces the change", () => {
  const { win, store, events } = fakeWin();
  setEnterKeyBehavior("newline", win);
  assert.equal(store.get(ENTER_KEY_STORAGE_KEY), "newline");
  assert.equal(events.length, 1);
  assert.equal(enterKeyBehavior(win), "newline");
});
