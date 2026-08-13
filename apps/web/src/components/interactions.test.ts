import assert from "node:assert/strict";
import test from "node:test";
import {
  anchoredMenuPlacement,
  isRovingChoiceTarget,
  rovingChoiceIndex,
  rovingChoiceTabIndex,
  shouldHandleGlobalEscape,
} from "./interactions.js";

test("anchored menus remain usable in short scaled browser panes", () => {
  assert.deepEqual(
    anchoredMenuPlacement({
      trigger: { top: 60, right: 310, bottom: 94, left: 10, width: 300 },
      viewportWidth: 340,
      viewportHeight: 176,
      desiredWidth: 300,
      desiredHeight: 240,
    }),
    { top: 8, bottom: "auto", left: 10, width: 300, maxHeight: 160 },
  );
});

test("anchored menus prefer an intact above placement when it fits", () => {
  assert.deepEqual(
    anchoredMenuPlacement({
      trigger: { top: 130, right: 310, bottom: 164, left: 276, width: 34 },
      viewportWidth: 340,
      viewportHeight: 176,
      desiredWidth: 200,
      desiredHeight: 92,
      align: "end",
    }),
    { top: "auto", bottom: 52, left: 110, width: 200, maxHeight: 92 },
  );
});

test("above-flipped menus anchor their rendered bottom edge instead of their desired height", () => {
  const viewportHeight = 640;
  const triggerTop = 548;
  const gap = 6;
  const placement = anchoredMenuPlacement({
    trigger: { top: triggerTop, right: 55, bottom: 592, left: 11, width: 44 },
    viewportWidth: 1024,
    viewportHeight,
    desiredWidth: 260,
    desiredHeight: 336,
  });

  assert.equal(placement.top, "auto");
  assert.equal(placement.bottom, 98);
  assert.equal(viewportHeight - Number(placement.bottom), triggerTop - gap,
    "a short rendered menu still ends exactly one gap above the trigger");
});

test("roving choices wrap in every direction and skip disabled entries", () => {
  const enabled = [true, false, true, false];
  assert.equal(rovingChoiceIndex(0, enabled, "ArrowRight"), 2);
  assert.equal(rovingChoiceIndex(2, enabled, "ArrowDown"), 0);
  assert.equal(rovingChoiceIndex(0, enabled, "ArrowLeft"), 2);
  assert.equal(rovingChoiceIndex(2, enabled, "ArrowUp"), 0);
  assert.equal(rovingChoiceIndex(2, enabled, "Home"), 0);
  assert.equal(rovingChoiceIndex(0, enabled, "End"), 2);
});

test("roving choices fail closed when every entry is disabled", () => {
  assert.equal(rovingChoiceIndex(0, [false, false], "ArrowDown"), -1);
});

test("roving groups ignore keyboard events from nested close controls", () => {
  assert.equal(isRovingChoiceTarget("tab", "tab"), true);
  assert.equal(isRovingChoiceTarget(null, "tab"), false);
  assert.equal(isRovingChoiceTarget("button", "radio"), false);
});

test("a roving group keeps a first tab stop when its selected value is external", () => {
  assert.equal(rovingChoiceTabIndex(false, false, 0), 0);
  assert.equal(rovingChoiceTabIndex(false, false, 1), -1);
  assert.equal(rovingChoiceTabIndex(true, true, 1), 0);
});

test("nested controls can claim Escape before the global layer dismisses", () => {
  assert.equal(shouldHandleGlobalEscape("Escape", false), true);
  assert.equal(shouldHandleGlobalEscape("Escape", true), false);
  assert.equal(shouldHandleGlobalEscape("Enter", false), false);
});
