import assert from "node:assert/strict";
import { test } from "node:test";
import { safeHttpUrl } from "./git-ops.js";

test("safeHttpUrl rejects forge URLs with executable or non-web schemes", () => {
  assert.equal(safeHttpUrl("https://github.com/picoduck/wollipog/pull/1"), "https://github.com/picoduck/wollipog/pull/1");
  assert.equal(safeHttpUrl("http://github.example.test/pull/1"), "http://github.example.test/pull/1");
  for (const value of ["javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/x", "/pull/1", "invalid", undefined]) {
    assert.equal(safeHttpUrl(value), null, String(value));
  }
});
