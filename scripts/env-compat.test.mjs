import assert from "node:assert/strict";
import test from "node:test";
import { readCompatibleEnv } from "./env-compat.mjs";

test("script environment compatibility is new-first and value-free in warnings", () => {
  const warnings = [];
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
  assert.equal(
    readCompatibleEnv(
      { MAM_EXAMPLE: "secret-value" },
      "WOLLIPOG_EXAMPLE",
      "MAM_EXAMPLE",
      (warning) => warnings.push(warning),
    ),
    "secret-value",
  );
  assert.deepEqual(warnings, ["MAM_EXAMPLE is deprecated; use WOLLIPOG_EXAMPLE"]);
  assert.doesNotMatch(warnings[0], /secret-value/);
  assert.equal(readCompatibleEnv({ WOLLIPOG_EXAMPLE: "", MAM_EXAMPLE: "legacy" }, "WOLLIPOG_EXAMPLE", "MAM_EXAMPLE"), "");
});
