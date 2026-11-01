import assert from "node:assert/strict";
import test from "node:test";
import { worktreeDirtyPaths } from "./worktree-dirty-paths.js";

test("dirty diagnostics count omitted paths and bound escaped filenames", () => {
  const result = worktreeDirtyPaths(20, Array.from({ length: 20 }, (_, i) => `${i}\n${"\u0001".repeat(200)}`));
  assert.match(result, /20 paths/u);
  assert.match(result, /12 more$/u);
  assert.ok(result.length < 850);
  assert.ok(!result.includes("\n"));
});
