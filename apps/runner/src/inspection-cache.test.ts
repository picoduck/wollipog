import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { InspectionCache, InspectionLimiter } from "./inspection-cache.js";

test("inspection cache is LRU bounded and invalidates missing/changed versions", (t) => {
  t.mock.method(performance, "now", () => 0);
  const cache = new InspectionCache<number>(2, 0);
  cache.set("a", "1", 0, 0);
  cache.set("b", "1", 2, 0);
  assert.equal(cache.get("a", "1"), 0);
  cache.set("c", "1", 3, 0);
  assert.equal(cache.get("b", "1"), undefined);
  assert.equal(cache.get("a", "2"), undefined);
  assert.equal(cache.get("a", "1"), undefined);
  assert.equal(cache.get("c", null), undefined);
  assert.equal(cache.get("c", "1"), undefined);
});

test("coarse unchanged fingerprints require a later fresh observation before reuse", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const cache = new InspectionCache<number>();
  cache.set("ledger", "same-timestamp", 1, now);
  assert.equal(cache.get("ledger", "same-timestamp"), undefined);
  now = 1_999;
  cache.set("ledger", "same-timestamp", 2, now);
  assert.equal(cache.get("ledger", "same-timestamp"), undefined);
  now = 2_000;
  assert.equal(cache.get("ledger", "same-timestamp"), undefined, "elapsed time alone never promotes old proof");
  cache.set("ledger", "same-timestamp", 2, 1_999);
  assert.equal(cache.get("ledger", "same-timestamp"), undefined, "a slow read crossing the boundary is still too early");
  cache.set("ledger", "same-timestamp", 3, now);
  assert.equal(cache.get("ledger", "same-timestamp"), 3, "only the newly read result is reusable");
  assert.equal(cache.get("ledger", "new-timestamp"), undefined);
  cache.set("ledger", "new-timestamp", 4, now);
  assert.equal(cache.get("ledger", "new-timestamp"), undefined, "every changed fingerprint warms separately");
});

test("inspection slots are released after a failed inspection", async () => {
  const limiter = new InspectionLimiter(1);
  const failed = limiter.run(async () => { throw new Error("unreadable"); });
  const next = limiter.run(async () => 42);
  await assert.rejects(failed, /unreadable/);
  assert.equal(await next, 42);
});
