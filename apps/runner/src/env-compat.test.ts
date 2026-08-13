import assert from "node:assert/strict";
import test from "node:test";
import { readCompatibleEnv } from "./env-compat.js";

test("readCompatibleEnv prefers the Wollipog name without warning", () => {
  const warnings: string[] = [];
  assert.equal(
    readCompatibleEnv(
      { WOLLIPOG_EXAMPLE: "current", MAM_EXAMPLE: "legacy" },
      "WOLLIPOG_EXAMPLE",
      "MAM_EXAMPLE",
      (warning) => warnings.push(warning),
    ),
    "current",
  );
  assert.deepEqual(warnings, []);
});

test("readCompatibleEnv warns on legacy fallback without logging its value", () => {
  const warnings: string[] = [];
  assert.equal(
    readCompatibleEnv(
      { MAM_EXAMPLE: "do-not-log-this-value" },
      "WOLLIPOG_EXAMPLE",
      "MAM_EXAMPLE",
      (warning) => warnings.push(warning),
    ),
    "do-not-log-this-value",
  );
  assert.deepEqual(warnings, ["MAM_EXAMPLE is deprecated; use WOLLIPOG_EXAMPLE"]);
  assert.doesNotMatch(warnings[0]!, /do-not-log-this-value/);
});

test("readCompatibleEnv treats an explicitly empty Wollipog value as authoritative", () => {
  const warnings: string[] = [];
  assert.equal(
    readCompatibleEnv(
      { WOLLIPOG_EXAMPLE: "", MAM_EXAMPLE: "legacy" },
      "WOLLIPOG_EXAMPLE",
      "MAM_EXAMPLE",
      (warning) => warnings.push(warning),
    ),
    "",
  );
  assert.deepEqual(warnings, []);
});

test("readCompatibleEnv fails closed on a defined non-string Wollipog value", () => {
  const warnings: string[] = [];
  assert.equal(
    readCompatibleEnv(
      { WOLLIPOG_EXAMPLE: { invalid: true }, MAM_EXAMPLE: "legacy" },
      "WOLLIPOG_EXAMPLE",
      "MAM_EXAMPLE",
      (warning) => warnings.push(warning),
    ),
    undefined,
  );
  assert.deepEqual(warnings, []);
});
