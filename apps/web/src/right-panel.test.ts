import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_SNAP_CLOSE_WIDTH,
  clampRightPanelWidth,
  parseStoredRightPanelMode,
  parseStoredRightPanelWidth,
  resolveRightPanelDrag,
} from "./right-panel.js";

test("clampRightPanelWidth: pins to the min/max bounds and passes in-range values through", () => {
  assert.equal(clampRightPanelWidth(RIGHT_PANEL_MIN_WIDTH - 100), RIGHT_PANEL_MIN_WIDTH);
  assert.equal(clampRightPanelWidth(RIGHT_PANEL_MAX_WIDTH + 100), RIGHT_PANEL_MAX_WIDTH);
  assert.equal(clampRightPanelWidth(400), 400);
});

test("clampRightPanelWidth: a viewport-aware max caps every width, and a tiny max can't invert bounds", () => {
  assert.equal(clampRightPanelWidth(640, 400), 400, "viewport ceiling wins over the panel max");
  assert.equal(clampRightPanelWidth(350, 400), 350, "under the ceiling passes through");
  assert.equal(clampRightPanelWidth(10_000, 50), RIGHT_PANEL_MIN_WIDTH, "max below MIN floors at MIN, never inverts");
  assert.equal(clampRightPanelWidth(640, 10_000), RIGHT_PANEL_MAX_WIDTH, "huge max still bounded by the panel max");
});

test("resolveRightPanelDrag respects a viewport-aware max", () => {
  assert.equal(resolveRightPanelDrag(380, -10_000, 420).width, 420);
});

test("parseStoredRightPanelWidth: missing key falls back to the default", () => {
  assert.equal(parseStoredRightPanelWidth(null), RIGHT_PANEL_DEFAULT_WIDTH);
});

test("parseStoredRightPanelWidth: garbage and non-finite values fall back to the default", () => {
  for (const raw of ["", "abc", "NaN", "Infinity", "-Infinity", "12px"]) {
    assert.equal(parseStoredRightPanelWidth(raw), RIGHT_PANEL_DEFAULT_WIDTH, `raw=${JSON.stringify(raw)}`);
  }
});

test("parseStoredRightPanelWidth: numeric strings parse and clamp", () => {
  assert.equal(parseStoredRightPanelWidth("400"), 400);
  assert.equal(parseStoredRightPanelWidth("1"), RIGHT_PANEL_MIN_WIDTH);
  assert.equal(parseStoredRightPanelWidth("9999"), RIGHT_PANEL_MAX_WIDTH);
});

test("parseStoredRightPanelMode: valid modes pass through", () => {
  for (const m of ["launcher", "review", "files", "terminal", "browser", "sidechat", "subagents"] as const) {
    assert.equal(parseStoredRightPanelMode(m), m);
  }
});

test("parseStoredRightPanelMode: missing/garbage falls back to the launcher", () => {
  for (const raw of [null, "", "shell", "Files", "0"]) {
    assert.equal(parseStoredRightPanelMode(raw), "launcher", `raw=${JSON.stringify(raw)}`);
  }
});

test("resolveRightPanelDrag: dragging the left edge leftward grows the panel", () => {
  const r = resolveRightPanelDrag(380, -40);
  assert.deepEqual(r, { collapse: false, width: 420 });
});

test("resolveRightPanelDrag: dragging past the max clamps to the max", () => {
  assert.deepEqual(resolveRightPanelDrag(600, -500), { collapse: false, width: RIGHT_PANEL_MAX_WIDTH });
});

test("resolveRightPanelDrag: dragging just under the min pins at the min without collapsing", () => {
  const r = resolveRightPanelDrag(RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MIN_WIDTH - RIGHT_PANEL_SNAP_CLOSE_WIDTH);
  assert.deepEqual(r, { collapse: false, width: RIGHT_PANEL_MIN_WIDTH });
});

test("resolveRightPanelDrag: dragging below the snap threshold collapses", () => {
  const r = resolveRightPanelDrag(380, 380 - RIGHT_PANEL_SNAP_CLOSE_WIDTH + 1);
  assert.equal(r.collapse, true);
  // Width still reports the clamped minimum so live rendering never shows a sliver.
  assert.equal(r.width, RIGHT_PANEL_MIN_WIDTH);
});
