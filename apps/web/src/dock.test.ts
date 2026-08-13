import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MAX_HEIGHT,
  DOCK_MIN_HEIGHT,
  clampDockHeight,
  parseStoredDockVisible,
  parseStoredHeight,
  resolveDockDrag,
} from "./dock.js";

test("clampDockHeight bounds", () => {
  assert.equal(clampDockHeight(10), DOCK_MIN_HEIGHT);
  assert.equal(clampDockHeight(10_000), DOCK_MAX_HEIGHT);
  assert.equal(clampDockHeight(300), 300);
});

test("clampDockHeight: a viewport-aware max caps every height, and a tiny max can't invert bounds", () => {
  assert.equal(clampDockHeight(640, 400), 400, "viewport ceiling wins over DOCK_MAX");
  assert.equal(clampDockHeight(300, 400), 300, "under the ceiling passes through");
  assert.equal(clampDockHeight(10_000, 50), DOCK_MIN_HEIGHT, "max below MIN floors at MIN, never inverts");
  assert.equal(clampDockHeight(640, 10_000), DOCK_MAX_HEIGHT, "huge max still bounded by DOCK_MAX");
});

test("parseStoredHeight: garbage falls back to the default; valid values clamp", () => {
  assert.equal(parseStoredHeight(null), DOCK_DEFAULT_HEIGHT);
  assert.equal(parseStoredHeight(""), DOCK_DEFAULT_HEIGHT); // Number("") is 0 — blank ≠ zero
  assert.equal(parseStoredHeight("garbage"), DOCK_DEFAULT_HEIGHT);
  assert.equal(parseStoredHeight("Infinity"), DOCK_DEFAULT_HEIGHT);
  assert.equal(parseStoredHeight("300"), 300);
  assert.equal(parseStoredHeight("5"), DOCK_MIN_HEIGHT);
});

test("resolveDockDrag: up grows, down shrinks, far down snaps closed", () => {
  assert.deepEqual(resolveDockDrag(280, -100), { collapse: false, height: 380 }); // drag up
  assert.deepEqual(resolveDockDrag(280, 100), { collapse: false, height: 180 }); // drag down
  assert.equal(resolveDockDrag(280, 250).collapse, true, "below snap threshold collapses");
  assert.equal(resolveDockDrag(280, 10_000).collapse, true);
  assert.equal(resolveDockDrag(280, -10_000).height, DOCK_MAX_HEIGHT);
  assert.equal(resolveDockDrag(280, -10_000, 400).height, 400, "drag respects a viewport-aware max");
});

test("parseStoredHeight respects a viewport-aware max (short window at mount)", () => {
  assert.equal(parseStoredHeight("640", 400), 400);
  assert.equal(parseStoredHeight("garbage", 400), DOCK_DEFAULT_HEIGHT, "default fits under a 400 ceiling");
  assert.equal(parseStoredHeight("garbage", 200), 200, "default itself clamps to a shorter ceiling");
});

test("parseStoredDockVisible: explicit new-key values win", () => {
  assert.equal(parseStoredDockVisible("1", null), true);
  assert.equal(parseStoredDockVisible("0", "0"), false, "explicit hidden beats legacy expanded");
});

test("parseStoredDockVisible: migration — only a legacy explicitly-expanded dock stays visible", () => {
  assert.equal(parseStoredDockVisible(null, "0"), true, "legacy expanded → visible");
  assert.equal(parseStoredDockVisible(null, "1"), false, "legacy collapsed → hidden");
  assert.equal(parseStoredDockVisible(null, null), false, "fresh install → hidden");
  assert.equal(parseStoredDockVisible("garbage", "garbage"), false, "garbage everywhere → hidden");
});
