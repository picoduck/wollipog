import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTestTypecheckDebt } from "./tsconfig-test-debt.js";

test("the debt list parses despite the explanatory comments the config carries", () => {
  const config = [
    "// Typecheck for this package's test files (see #1435).",
    "//   indented comment lines are stripped too",
    "{",
    '  "extends": "./tsconfig.json",',
    '  "exclude": ["src/a.test.ts", "src/b.test.tsx"]',
    "}",
  ].join("\n");
  assert.deepEqual(parseTestTypecheckDebt(config), ["src/a.test.ts", "src/b.test.tsx"]);
});

test("a config without an exclude list has no debt", () => {
  assert.deepEqual(parseTestTypecheckDebt('{ "extends": "./tsconfig.json" }'), []);
});

test("a malformed exclude list is refused rather than read as empty", () => {
  assert.throws(() => parseTestTypecheckDebt('{ "exclude": null }'), TypeError);
  assert.throws(() => parseTestTypecheckDebt('{ "exclude": "src/a.test.ts" }'), TypeError);
  assert.throws(() => parseTestTypecheckDebt('{ "exclude": ["src/a.test.ts", 3] }'), TypeError);
});
