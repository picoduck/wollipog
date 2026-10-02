import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOSER_USAGE_MIN_COLUMN_PX, composerUsagePlacement } from "./composer-usage-placement.js";

test("the composer column threshold is 640px", () => {
  assert.equal(COMPOSER_USAGE_MIN_COLUMN_PX, 640);
});

test("a wide desktop composer column seats the usage triggers in the bar", () => {
  assert.equal(composerUsagePlacement({ phone: false, narrowColumn: false, modelSettingsOpenable: true }), "bar");
});

test("a phone, or a narrow column at any width, moves them into Model Settings", () => {
  assert.equal(composerUsagePlacement({ phone: true, narrowColumn: false, modelSettingsOpenable: true }), "model-settings");
  assert.equal(composerUsagePlacement({ phone: false, narrowColumn: true, modelSettingsOpenable: true }), "model-settings");
  assert.equal(composerUsagePlacement({ phone: true, narrowColumn: true, modelSettingsOpenable: true }), "model-settings");
});

test("without a Model Settings that can open, the figures stay in the bar at every width", () => {
  assert.equal(composerUsagePlacement({ phone: true, narrowColumn: true, modelSettingsOpenable: false }), "bar");
  assert.equal(composerUsagePlacement({ phone: false, narrowColumn: true, modelSettingsOpenable: false }), "bar");
});
