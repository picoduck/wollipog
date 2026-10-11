import assert from "node:assert/strict";
import test from "node:test";
import { assertEntryBudget, entryChunks } from "./entry-bundle-budget.js";

test("entry budget counts shared static dependencies once, excluding deferred code", () => {
  const chunk = (fileName: string, code: string, imports: string[] = [], dynamicImports: string[] = []) =>
    ({ type: "chunk" as const, fileName, code, imports, dynamicImports, modules: {} });
  const bundle = {
    "entry.js": chunk("entry.js", "1234", ["a.js", "shared.js"], ["lazy.js"]),
    "a.js": chunk("a.js", "123", ["shared.js"]),
    "shared.js": chunk("shared.js", "é", ["entry.js"]),
    "lazy.js": chunk("lazy.js", "x".repeat(100)),
  };
  const chunks = entryChunks(bundle, "entry.js");
  assert.equal(assertEntryBudget(chunks, 9), 9);
  assert.throws(() => assertEntryBudget(chunks, 8), /requires 9.*budget is 8/);
  assert.throws(() => entryChunks(bundle, "missing.js"), /Missing static entry chunk/);
});
