import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { DEFAULT_EXPERIMENT_FLAGS } from "./experiments.js";
import { GLOBAL_VIEW_ITEMS } from "./navigation.js";
import {
  defaultRailPreferences,
  getRailPreferences,
  moveRailView,
  parseRailPreferences,
  railDigitForIndex,
  railDigits,
  railPreferencesAreDefault,
  railViewForDigit,
  reconcileRailOrder,
  resetRailPreferences,
  resetRailPreferencesForTest,
  setRailViewHidden,
  visibleRailViews,
  type RailPreferences,
} from "./rail-preferences.js";

const CANONICAL = GLOBAL_VIEW_ITEMS.map((item) => item.name);

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
  resetRailPreferencesForTest();
});

test("absent, garbage, and non-object payloads all fall back to the canonical default", () => {
  for (const raw of [null, "", "not json", "42", "[]", "null"]) {
    const preferences = parseRailPreferences(raw);
    assert.deepEqual([...preferences.order], CANONICAL, JSON.stringify(raw));
    assert.equal(preferences.hidden.size, 0);
    assert.equal(railPreferencesAreDefault(preferences), true);
  }
});

test("a saved order round-trips per instance and hiding never touches order", () => {
  moveRailView("usage", "up");
  setRailViewHidden("archived", true);
  const written = getRailPreferences();
  assert.notDeepEqual([...written.order], CANONICAL);
  assert.equal(written.hidden.has("archived"), true);

  resetRailPreferencesForTest();
  const reloaded = getRailPreferences();
  assert.deepEqual([...reloaded.order], [...written.order], "the reordered rail survives a reload");
  assert.deepEqual([...reloaded.hidden], ["archived"]);
  assert.equal(getRailPreferences("remote-1").hidden.size, 0, "instances do not share the rail");

  // A hidden destination retains its configured position, so restoring returns it there.
  const archivedIndex = reloaded.order.indexOf("archived");
  setRailViewHidden("archived", false);
  assert.equal(getRailPreferences().order.indexOf("archived"), archivedIndex);
});

test("removed destinations drop silently and never-saved ones join beside their canonical neighbors", () => {
  // A save written by a client that still had a `board` destination, with Usage moved first.
  const preferences = parseRailPreferences(JSON.stringify({
    v: 1,
    order: ["usage", "inbox", "board", "automations", "runs", "pods", "runners", "skills", "projects", "archived"],
    hidden: ["board", "pods"],
  }));
  assert.deepEqual([...preferences.order].sort(), [...CANONICAL].sort(), "every known destination exactly once");
  assert.equal(preferences.order[0], "usage", "the user's order survives the dropped name");
  assert.deepEqual([...preferences.hidden], ["pods"], "a removed name cannot stay hidden");

  // A destination this save never knew (drop Skills from the save): it re-enters after its
  // nearest surviving canonical predecessor (Connections), not at the end of the list.
  const missingSkills = parseRailPreferences(JSON.stringify({
    v: 1,
    order: CANONICAL.filter((name) => name !== "skills").reverse(),
    hidden: [],
  }));
  const order = missingSkills.order;
  assert.equal(order.indexOf("skills"), order.indexOf("runners") + 1);
});

test("Sessions is required: neither a save nor the setter can hide it", () => {
  const preferences = parseRailPreferences(JSON.stringify({ v: 1, order: CANONICAL, hidden: ["inbox", "usage"] }));
  assert.deepEqual([...preferences.hidden], ["usage"]);
  setRailViewHidden("inbox", true);
  assert.equal(getRailPreferences().hidden.has("inbox"), false);
});

test("digits derive solely from the visible order and skip hidden or gated destinations", () => {
  const preferences: RailPreferences = { order: CANONICAL, hidden: new Set(["automations"]) };
  const flags = { ...DEFAULT_EXPERIMENT_FLAGS, multiAgent: false, pods: false };
  const visible = visibleRailViews(preferences, flags);
  assert.deepEqual(visible, ["inbox", "runners", "skills", "projects", "archived", "usage"]);
  const digits = railDigits(visible);
  assert.equal(digits.get("inbox"), "1");
  assert.equal(digits.get("runners"), "2", "a hidden destination consumes no slot");
  assert.equal(digits.get("usage"), "6");
  assert.equal(railViewForDigit(visible, "2"), "runners");
  assert.equal(railViewForDigit(visible, "7"), null, "a digit past the visible list is inert");
});

test("the tenth visible destination gets 0 and later ones get nothing", () => {
  assert.equal(railDigitForIndex(8), "9");
  assert.equal(railDigitForIndex(9), "0");
  assert.equal(railDigitForIndex(10), null);
  const eleven = Array.from({ length: 11 }, (_, index) => `view-${index}`) as never[];
  assert.equal(railViewForDigit(eleven, "0"), "view-9" as never);
});

test("moves clamp at the edges and reset restores the product default", () => {
  moveRailView("inbox", "up");
  assert.deepEqual([...getRailPreferences().order], CANONICAL, "the first destination cannot move further up");
  moveRailView("usage", "down");
  assert.deepEqual([...getRailPreferences().order], CANONICAL, "the last destination cannot move further down");

  moveRailView("projects", "up");
  setRailViewHidden("skills", true);
  assert.equal(railPreferencesAreDefault(getRailPreferences()), false);
  resetRailPreferences();
  assert.equal(railPreferencesAreDefault(getRailPreferences()), true);
  resetRailPreferencesForTest();
  assert.equal(railPreferencesAreDefault(getRailPreferences()), true, "reset persists, not just clears memory");
});

test("reconcileRailOrder is deterministic for an empty save", () => {
  assert.deepEqual(reconcileRailOrder([]), CANONICAL);
});
