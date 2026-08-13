import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the root test command includes runner script tests", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts.test, /"apps\/\*\*\/scripts\/\*\*\/\*\.test\.mjs"/u);
  assert.match(
    readFileSync(new URL("../apps/runner/scripts/runner-artifacts.test.mjs", import.meta.url), "utf8"),
    /runner release names cover the exact six native targets/u,
  );
});
