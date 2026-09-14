import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { WorktreePortAllocator } from "./worktree-port-allocator.js";

test("port allocations are contiguous, stable across restart, released, and exhaust clearly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-ports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const range = { start: 42_000, end: 42_005, blockSize: 2 };
  const first = new WorktreePortAllocator(root, range);
  assert.deepEqual(first.runtime(), { ...range, capacity: 3 });
  assert.deepEqual(first.allocate("session-a\0tree-a"), { start: 42_000, end: 42_001, size: 2 });
  assert.deepEqual(first.allocate("session-b\0tree-b"), { start: 42_002, end: 42_003, size: 2 });

  const restarted = new WorktreePortAllocator(root, range);
  assert.deepEqual(restarted.allocate("session-a\0tree-a"), { start: 42_000, end: 42_001, size: 2 });
  assert.deepEqual(restarted.allocate("session-c\0tree-c"), { start: 42_004, end: 42_005, size: 2 });
  assert.throws(() => restarted.allocate("session-d\0tree-d"), /range 42000-42005 is exhausted.*capacity 3/u);
  assert.equal(restarted.release("session-b\0tree-b"), true);
  assert.equal(restarted.release("session-b\0tree-b"), false);
  assert.deepEqual(restarted.allocate("session-d\0tree-d"), { start: 42_002, end: 42_003, size: 2 });
});

test("configuration changes grandfather live blocks while new blocks avoid every collision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-ports-reconfigure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new WorktreePortAllocator(root, { start: 42_000, end: 42_009, blockSize: 5 });
  const old = original.allocate("old");
  assert.deepEqual(old, { start: 42_000, end: 42_004, size: 5 });

  const changed = new WorktreePortAllocator(root, { start: 42_002, end: 42_013, blockSize: 4 });
  assert.deepEqual(changed.allocate("old", old), old);
  assert.deepEqual(changed.allocate("new"), { start: 42_006, end: 42_009, size: 4 });
  assert.throws(
    () => changed.allocate("conflict", { start: 42_008, end: 42_011, size: 4 }),
    /collides/u,
  );
});

test("independent allocator instances serialize stale snapshots without overlapping", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-ports-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const range = { start: 42_000, end: 42_003, blockSize: 2 };
  const first = new WorktreePortAllocator(root, range);
  const second = new WorktreePortAllocator(root, range);
  assert.deepEqual(first.allocate("first"), { start: 42_000, end: 42_001, size: 2 });
  assert.deepEqual(second.allocate("second"), { start: 42_002, end: 42_003, size: 2 });
  assert.throws(() => first.allocate("third"), /exhausted/u);
});

test("property: every allocated block is exact-sized and pairwise disjoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-ports-property-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 16 }),
    fc.integer({ min: 1, max: 8 }),
    (capacity, blockSize) => {
      const state = join(root, `${capacity}-${blockSize}`);
      const start = 20_000;
      const allocator = new WorktreePortAllocator(state, {
        start,
        end: start + capacity * blockSize - 1,
        blockSize,
      });
      const blocks = Array.from({ length: capacity }, (_, index) => allocator.allocate(`owner-${index}`));
      for (const [index, block] of blocks.entries()) {
        assert.equal(block.size, blockSize);
        assert.equal(block.end - block.start + 1, blockSize);
        assert.ok(blocks.every((other, otherIndex) => otherIndex === index || block.end < other.start || other.end < block.start));
      }
      assert.throws(() => allocator.allocate("overflow"), /exhausted/u);
    },
  ), { numRuns: 50 });
});
