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

test("a screen too short for either side stops anchoring rather than overflowing", () => {
  // Below has 86px and above 66px: neither can host the panel, so it fills the viewport instead.
  const viewport = { width: 390, height: 200 };
  const placement = placePanel({ top: 80, bottom: 100, left: 10 }, viewport, PANEL);
  assert.equal(placement.top, 8);
  assert.equal(placement.bottom, undefined);
  assert.equal(placement.maxHeight, 184);
  assert.ok(
    placement.top! + placement.maxHeight <= viewport.height,
    "a fixed panel hanging off the edge has no ancestor left to scroll",
  );
});

test("a trigger scrolled off either edge pins the panel to that edge, still on screen", () => {
  // The placement re-runs on scroll, so an open panel's trigger can leave the viewport entirely.
  // An unclamped rectangle reports more clearance than the whole window and sails past every bound.
  const viewport = { width: 390, height: 800 };
  const offTop = placePanel({ top: -120, bottom: -100, left: 40 }, viewport, PANEL);
  assert.ok(offTop.top! >= 0, `placed at ${offTop.top}, above the top edge`);
  assert.ok(offTop.top! + offTop.maxHeight <= 800);

  const offBottom = placePanel({ top: 900, bottom: 920, left: 40 }, viewport, PANEL);
  const panelTop = 800 - offBottom.bottom! - offBottom.maxHeight;
  assert.ok(offBottom.bottom! >= 0);
  assert.ok(panelTop >= 0, `top edge at ${panelTop}`);
});

test("the panel never extends past the viewport, wherever the trigger sits", () => {
  // The invariant the whole placement exists to hold, swept rather than sampled — including
  // triggers off both edges, a trigger taller than the screen, and a degenerate viewport.
  for (const height of [0, 40, 180, 240, 420, 700, 800, 1200]) {
    for (let top = -200; top <= height + 200; top += 10) {
      for (const triggerHeight of [0, 20, height + 400]) {
        const viewport = { width: 390, height };
        const p = placePanel({ top, bottom: top + triggerHeight, left: 40 }, viewport, PANEL);
        const where = `viewport ${height}, trigger ${top}+${triggerHeight}`;
        assert.ok(p.maxHeight >= 0, `${where}: negative height ${p.maxHeight}`);
        assert.equal(
          Number(p.top !== undefined) + Number(p.bottom !== undefined),
          1,
          `${where}: a fixed element given both top and bottom stretches between them`,
        );
        if (p.top !== undefined) {
          assert.ok(p.top >= 0, `${where}: placed above the top edge at ${p.top}`);
          assert.ok(p.top + p.maxHeight <= height, `${where}: bottom edge at ${p.top + p.maxHeight}`);
        } else {
          const panelTop = height - p.bottom! - p.maxHeight;
          assert.ok(p.bottom! >= 0, `${where}: placed below the bottom edge`);
          assert.ok(panelTop >= 0, `${where}: top edge at ${panelTop}`);
        }
      }
    }
  }
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
