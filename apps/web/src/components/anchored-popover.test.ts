import assert from "node:assert/strict";
import test from "node:test";
import { placePanel } from "./anchored-popover.js";

const VIEWPORT = { width: 390, height: 800 };
const PANEL = { width: 280, height: 340 };

/**
 * The panel is `position: fixed`, so anything it pushes past a screen edge is unreachable: there
 * is no ancestor left to scroll. These pin the geometry that keeps every row reachable.
 */

test("a trigger with room below opens downward, bounded by the space below it", () => {
  const placement = placePanel({ top: 100, bottom: 120, left: 40 }, VIEWPORT, PANEL);
  assert.equal(placement.top, 126);
  assert.equal(placement.bottom, undefined);
  assert.equal(placement.left, 40);
  // 800 - 120 - 6 - 8
  assert.equal(placement.maxHeight, 666);
  assert.ok(placement.top! + placement.maxHeight <= VIEWPORT.height);
});

test("a trigger near the bottom opens upward, anchored by its bottom edge", () => {
  const placement = placePanel({ top: 740, bottom: 760, left: 40 }, VIEWPORT, PANEL);
  assert.equal(placement.top, undefined);
  // The panel's bottom edge sits 6px above the trigger's top: 800 - 740 + 6.
  assert.equal(placement.bottom, 66);
  // 740 - 6 - 8
  assert.equal(placement.maxHeight, 726);
  assert.ok(placement.bottom! + placement.maxHeight <= VIEWPORT.height);
});

test("a taller-than-expected panel is bounded by its side rather than overflowing the screen", () => {
  // A panel with many per-model rows: the CSS would let it grow well past the space below.
  const placement = placePanel({ top: 600, bottom: 620, left: 40 }, { width: 390, height: 700 }, PANEL);
  // Below has 66px, above has 586px, so it opens upward and is bounded there.
  assert.equal(placement.top, undefined);
  assert.equal(placement.maxHeight, 586);
  assert.ok(placement.maxHeight <= 600, "never taller than the space it was given");
});

test("a short screen still yields a usable, internally scrollable panel", () => {
  // Neither side can hold the footprint; the larger side wins and the floor keeps it usable.
  const placement = placePanel({ top: 80, bottom: 100, left: 10 }, { width: 390, height: 200 }, PANEL);
  assert.equal(placement.maxHeight, 120, "the minimum height floor applies, and the panel scrolls");
  assert.ok(placement.top !== undefined || placement.bottom !== undefined);
});

test("the panel is kept clear of both horizontal edges", () => {
  // A trigger flush against the right edge pulls the panel back onto the screen.
  assert.equal(placePanel({ top: 10, bottom: 30, left: 380 }, VIEWPORT, PANEL).left, 102);
  // A trigger at the very left keeps the margin rather than touching the edge.
  assert.equal(placePanel({ top: 10, bottom: 30, left: 0 }, VIEWPORT, PANEL).left, 8);
});

test("exactly one vertical anchor is set, so the panel is never stretched between both edges", () => {
  for (const rect of [{ top: 100, bottom: 120, left: 40 }, { top: 740, bottom: 760, left: 40 }]) {
    const placement = placePanel(rect, VIEWPORT, PANEL);
    assert.equal(
      Number(placement.top !== undefined) + Number(placement.bottom !== undefined),
      1,
      "a fixed element given both top and bottom stretches to fill the gap",
    );
  }
});
