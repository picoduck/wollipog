import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { DEFAULT_EXPERIMENT_FLAGS } from "./experiments.js";
import { saveInstanceStorageValue } from "./instance-storage.js";
import { GLOBAL_VIEW_ITEMS } from "./navigation.js";
import {
  RAIL_PREFERENCES_STORAGE_KEY,
  defaultRailPreferences,
  getRailPreferences,
  moveRailView,
  parseRailPreferences,
  phoneBarViews,
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

const CANONICAL = GLOBAL_VIEW_ITEMS.map((item) => item.id);

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

test("with no saved preferences the rail follows the Work, Oversight and Records groups", () => {
  // docs/design-system.md §4.1. Projects is daily work, so it answers 3.
  const preferences = getRailPreferences();
  assert.deepEqual([...preferences.order],
    ["inbox", "automations", "projects", "runs", "pods", "runners", "skills", "archived", "usage"]);
  assert.deepEqual(
    [...new Set(GLOBAL_VIEW_ITEMS.map((item) => item.group))],
    ["work", "oversight", "records"],
    "each group is one contiguous run of the default order",
  );
  const flags = { ...DEFAULT_EXPERIMENT_FLAGS, multiAgent: true, pods: true };
  const visible = visibleRailViews(preferences, flags);
  assert.equal(railDigits(visible).get("projects"), "3");
  assert.equal(railViewForDigit(visible, "3"), "projects");
});

test("a version-1 rail preference saved before the regrouping keeps its order, hidden items and digits", () => {
  // Written by the previous default, which put Projects seventh, with Archived hidden.
  const previousDefault = ["inbox", "automations", "runs", "pods", "runners", "skills", "projects", "archived", "usage"];
  saveInstanceStorageValue(
    RAIL_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ v: 1, order: previousDefault, hidden: ["archived"] }),
  );
  resetRailPreferencesForTest();
  const preferences = getRailPreferences();
  assert.deepEqual([...preferences.order], previousDefault, "a saved order is never re-sorted into the new default");
  assert.deepEqual([...preferences.hidden], ["archived"]);
  assert.equal(railPreferencesAreDefault(preferences), false);
  const flags = { ...DEFAULT_EXPERIMENT_FLAGS, multiAgent: true, pods: true };
  const digits = railDigits(visibleRailViews(preferences, flags));
  assert.deepEqual(
    [...digits],
    [["inbox", "1"], ["automations", "2"], ["runs", "3"], ["pods", "4"], ["runners", "5"], ["skills", "6"], ["projects", "7"], ["usage", "8"]],
  );
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
  assert.deepEqual(visible, ["inbox", "projects", "runners", "skills", "archived", "usage"]);
  const digits = railDigits(visible);
  assert.equal(digits.get("inbox"), "1");
  assert.equal(digits.get("projects"), "2", "a hidden destination consumes no slot");
  assert.equal(digits.get("usage"), "6");
  assert.equal(railViewForDigit(visible, "2"), "projects");
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

const ALL_ON = { ...DEFAULT_EXPERIMENT_FLAGS, multiAgent: true, pods: true };
const ALL_OFF = { ...DEFAULT_EXPERIMENT_FLAGS, multiAgent: false, pods: false };

test("the default phone bar is Sessions, Projects, Connections and Automations whatever the experiments", () => {
  // Slicing the rail order let experiments take the phone's four slots and pushed Projects and
  // Connections into More (#1959).
  for (const flags of [ALL_ON, ALL_OFF]) {
    assert.deepEqual(phoneBarViews(defaultRailPreferences(), flags), ["inbox", "projects", "runners", "automations"]);
  }
  // Reordering the rail reorders digits and More, not the bar.
  const reordered: RailPreferences = { order: [...CANONICAL].reverse(), hidden: new Set() };
  assert.deepEqual(phoneBarViews(reordered, ALL_ON), ["inbox", "projects", "runners", "automations"]);
});

test("a hidden default tab is filled in place by the next visible non-experimental destination", () => {
  const hideProjects: RailPreferences = { order: CANONICAL, hidden: new Set(["projects"]) };
  assert.deepEqual(phoneBarViews(hideProjects, ALL_ON), ["inbox", "skills", "runners", "automations"],
    "Multi-Agent Runs and Pods come first in rail order, but never fill a slot");
  // The filler follows the user's rail order, not the canonical one.
  const usageFirst: RailPreferences = {
    order: ["usage", ...CANONICAL.filter((name) => name !== "usage")],
    hidden: new Set(["projects"]),
  };
  assert.deepEqual(phoneBarViews(usageFirst, ALL_ON), ["inbox", "usage", "runners", "automations"]);
  // Hide enough and the bar shrinks rather than taking an experiment.
  const sparse: RailPreferences = {
    order: CANONICAL,
    hidden: new Set(["projects", "runners", "automations", "skills", "archived", "usage"]),
  };
  assert.deepEqual(phoneBarViews(sparse, ALL_ON), ["inbox"]);
});

test("a chosen phone bar overrides the default and may hold an experiment the user put there", () => {
  const chosen: RailPreferences = { order: CANONICAL, hidden: new Set(), phoneBar: ["runs", "inbox", "usage", "pods"] };
  assert.deepEqual(phoneBarViews(chosen, ALL_ON), ["runs", "inbox", "usage", "pods"]);
  // Turned off, the experiments' slots are topped up in place from the rail order.
  assert.deepEqual(phoneBarViews(chosen, ALL_OFF), ["automations", "inbox", "usage", "projects"]);
  // A choice shorter than the bar is topped up at its end.
  const short: RailPreferences = { order: CANONICAL, hidden: new Set(), phoneBar: ["usage"] };
  assert.deepEqual(phoneBarViews(short, ALL_ON), ["usage", "inbox", "automations", "projects"]);
});

test("the phone bar choice is parsed defensively, survives edits and is cleared by reset", () => {
  const parsed = parseRailPreferences(JSON.stringify({
    v: 1, order: CANONICAL, hidden: [], phoneBar: ["usage", "board", 7, "usage", "inbox", "runs", "pods", "skills"],
  }));
  assert.deepEqual(parsed.phoneBar, ["usage", "inbox", "runs", "pods"],
    "unknown names and repeats are dropped and the choice holds at most four");
  assert.equal(railPreferencesAreDefault(parsed), false);
  for (const phoneBar of [[], "usage", null, ["board"]]) {
    const preferences = parseRailPreferences(JSON.stringify({ v: 1, order: CANONICAL, hidden: [], phoneBar }));
    assert.equal(preferences.phoneBar, undefined, `${JSON.stringify(phoneBar)} is no choice, so the default applies`);
  }

  saveInstanceStorageValue(
    RAIL_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ v: 1, order: CANONICAL, hidden: [], phoneBar: ["usage"] }),
  );
  resetRailPreferencesForTest();
  moveRailView("usage", "up");
  setRailViewHidden("archived", true);
  resetRailPreferencesForTest();
  assert.deepEqual(getRailPreferences().phoneBar, ["usage"], "reordering and hiding keep the stored choice");
  resetRailPreferences();
  resetRailPreferencesForTest();
  assert.equal(getRailPreferences().phoneBar, undefined);
  assert.equal(railPreferencesAreDefault(getRailPreferences()), true);
});
