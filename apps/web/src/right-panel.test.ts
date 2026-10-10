import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MODES,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_SNAP_CLOSE_WIDTH,
  clampRightPanelWidth,
  parseStoredRightPanelExpanded,
  parseStoredRightPanelMode,
  parseStoredRightPanelWidth,
  resolveRightPanelDrag,
  rightPanelDragCeiling,
  rightPanelOverlays,
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

test("the panel opens 400px wide by default and never narrower than 320px (#2843)", () => {
  assert.equal(RIGHT_PANEL_DEFAULT_WIDTH, 400);
  assert.equal(RIGHT_PANEL_MIN_WIDTH, 320);
  // A width stored by an older build under the new minimum is clamped up on load.
  assert.equal(parseStoredRightPanelWidth("300"), 320);
  assert.equal(parseStoredRightPanelWidth("380"), 380);
});

test("parseStoredRightPanelMode: valid modes pass through", () => {
  for (const m of ["launcher", "review", "files", "browser", "sidechat", "subagents", "background", "decisions"] as const) {
    assert.equal(parseStoredRightPanelMode(m), m);
  }
});

test("parseStoredRightPanelMode: a stored Governance History reopens as Decision History (#2213)", () => {
  assert.equal(parseStoredRightPanelMode("governance"), "decisions");
});

test("parseStoredRightPanelMode: transient, retired, missing, and invalid modes fall back to the launcher", () => {
  // "terminal" is the retired reserved mode (#1201): older builds could persist it, and it must
  // restore the launcher rather than a panel with no body.
  for (const raw of ["requests", "terminal", null, "", "shell", "Files", "0"]) {
    assert.equal(parseStoredRightPanelMode(raw), "launcher", `raw=${JSON.stringify(raw)}`);
  }
});

test("every panel mode is a real destination — no reserved placeholder survives", () => {
  assert.equal(RIGHT_PANEL_MODES.includes("terminal" as never), false,
    "the terminal lives in the bottom dock; the panel must not reserve an unreachable mode");
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

test("rightPanelOverlays: the panel overlays exactly when docking would leave the chat column under 480px (#2725)", () => {
  // The row less the panel is the chat column; the handle straddles the panel's edge (#2843).
  assert.equal(rightPanelOverlays(400 + 480, 400), false, "480px left: docks");
  assert.equal(rightPanelOverlays(400 + 479, 400), true, "479px left: overlays");
  // A 940px window with the 64px rail and a 386px panel (its drag ceiling there) keeps 490px; with
  // the 208px labelled rail even the 320px minimum leaves 412px.
  assert.equal(rightPanelOverlays(940 - 64, 386), false);
  assert.equal(rightPanelOverlays(940 - 208, 320), true);
  // The same width answers the same way whichever mode the panel shows: the rule has no mode.
  assert.equal(rightPanelOverlays(761 - 64, 320), true);
});

test("rightPanelDragCeiling: the panel may be dragged to the row less 480px and the 10px handle, within 320–640px (#2845)", () => {
  // At 1280px with the 64px rail the full 640px fits; at 1100px with the 208px labelled rail the
  // chat column keeps its 480px and the handle's 10px.
  assert.equal(rightPanelDragCeiling(1280 - 64), RIGHT_PANEL_MAX_WIDTH);
  assert.equal(rightPanelDragCeiling(1100 - 208), 1100 - 208 - 480 - 10);
  assert.equal(rightPanelDragCeiling(640 + 480 + 10), 640, "exactly room for the maximum");
  assert.equal(rightPanelDragCeiling(640 + 480 + 9), 639);
  assert.equal(rightPanelDragCeiling(4000), RIGHT_PANEL_MAX_WIDTH, "capped at 640px however wide the row");
  assert.equal(rightPanelDragCeiling(700), RIGHT_PANEL_MIN_WIDTH, "floored at 320px where the panel overlays anyway");
  assert.equal(rightPanelDragCeiling(0), RIGHT_PANEL_MIN_WIDTH);
  assert.equal(rightPanelDragCeiling(892.6), 402, "a fractional row rounds down, never past the rule");
  assert.equal(rightPanelDragCeiling(null), RIGHT_PANEL_MAX_WIDTH, "an unmeasured row has only the 640px maximum");
});

test("a drag up to the ceiling never turns the panel into an overlay (#2845)", () => {
  for (let row = 810; row <= 1600; row += 7) {
    const ceiling = rightPanelDragCeiling(row);
    const { width } = resolveRightPanelDrag(RIGHT_PANEL_DEFAULT_WIDTH, -10_000, ceiling);
    assert.equal(width, ceiling, `row ${row}`);
    assert.equal(rightPanelOverlays(row, width), false, `row ${row}: the chat keeps ${row - width}px`);
  }
  // Only a row too narrow for the 320px minimum overlays, whatever the stored width.
  assert.equal(rightPanelOverlays(799, clampRightPanelWidth(640, rightPanelDragCeiling(799))), true);
  assert.equal(rightPanelOverlays(800, clampRightPanelWidth(640, rightPanelDragCeiling(800))), false);
});

test("parseStoredRightPanelExpanded: only the stored \"1\" expands the panel (#2845)", () => {
  assert.equal(parseStoredRightPanelExpanded("1"), true);
  for (const raw of [null, "", "0", "true", "yes", " 1", "2"]) {
    assert.equal(parseStoredRightPanelExpanded(raw), false, `raw=${JSON.stringify(raw)}`);
  }
});
