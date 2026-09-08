import assert from "node:assert/strict";
import test from "node:test";
import { InspectionCache, InspectionLimiter } from "./inspection-cache.js";

test("inspection cache is LRU bounded and invalidates missing/changed versions", () => {
  const cache = new InspectionCache<number>(2);
  cache.set("a", "1", 0);
  cache.set("b", "1", 2);
  assert.equal(cache.get("a", "1"), 0);
  cache.set("c", "1", 3);
  assert.equal(cache.get("b", "1"), undefined);
  assert.equal(cache.get("a", "2"), undefined);
  assert.equal(cache.get("a", "1"), undefined);
  assert.equal(cache.get("c", null), undefined);
  assert.equal(cache.get("c", "1"), undefined);
});

test("inspection slots are released after a failed inspection", async () => {
  const limiter = new InspectionLimiter(1);
  const failed = limiter.run(async () => { throw new Error("unreadable"); });
  const next = limiter.run(async () => 42);
  await assert.rejects(failed, /unreadable/);
  assert.equal(await next, 42);
});
