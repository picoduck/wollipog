import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOSER_USAGE_MIN_COLUMN_REM, composerUsagePlacement } from "./composer-usage-placement.js";

test("the composer column threshold is 40rem, 640px at the default root", () => {
  assert.equal(COMPOSER_USAGE_MIN_COLUMN_REM * 16, 640);
});

test("a wide composer column seats the usage triggers in the bar", () => {
  assert.equal(composerUsagePlacement({ narrow: false, modelSettingsOpenable: true }), "bar");
  assert.equal(composerUsagePlacement({ narrow: false, modelSettingsOpenable: false }), "bar");
});

test("a phone or narrow column moves them into Model Settings when it can open", () => {
  assert.equal(composerUsagePlacement({ narrow: true, modelSettingsOpenable: true }), "model-settings");
});

test("without a Model Settings that can open, a narrow column gives them their own row", () => {
  assert.equal(composerUsagePlacement({ narrow: true, modelSettingsOpenable: false }), "row");
});
