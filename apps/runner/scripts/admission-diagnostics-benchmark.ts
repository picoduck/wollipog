import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/session-manager.js";
import { SessionStore } from "../src/session-store.js";

const WAITER_COUNT = 50_000;
const MAX_ELAPSED_MS = 5_000;
const root = mkdtempSync(join(tmpdir(), "wollipog-capacity-benchmark-"));

try {
  const manager = new SessionManager(
    () => {},
    () => {},
    new SessionStore(join(root, "sessions")),
    "benchmark",
    undefined,
    undefined,
    root,
    256,
  );
  // This benchmark intentionally reaches through the private orchestration boundary: it measures
  // capacityState itself without paying for 50,000 durable launch fixtures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  assert.equal(internals.boxAdmission.acquire({
    sessionId: "resident-load",
    agentId: "weighted-provider",
    weight: 256,
  }), true);

  let leaseRootScans = 0;
  const usedSlots = internals.boxAdmission.usedSlots.bind(internals.boxAdmission) as (path: string) => number;
  internals.boxAdmission.usedSlots = (path: string): number => {
    leaseRootScans++;
    return usedSlots(path);
  };
  for (let index = 0; index < WAITER_COUNT; index++) {
    internals.admissionQueue.push({
      request: {
        sessionId: `waiter-${index}`,
        agentId: `agent-${index % 1_000}`,
        weight: 257,
      },
      bypasses: 0,
      resolve: () => {},
    });
  }

  const startedAt = performance.now();
  const status = manager.capacityState();
  const elapsedMs = performance.now() - startedAt;
  assert.equal(status.blockers?.length, 256);
  assert.equal(status.blockers?.at(-1)?.kind, "diagnostic_overflow");
  assert.equal(status.blockers?.reduce((sum, blocker) => sum + (blocker.waitingSessions ?? 0), 0), WAITER_COUNT);
  assert.equal(leaseRootScans, 1, "the global lease root must be scanned once, not once per waiter");
  assert.ok(elapsedMs < MAX_ELAPSED_MS,
    `capacity diagnostics took ${elapsedMs.toFixed(1)}ms (limit ${MAX_ELAPSED_MS}ms)`);
  console.log(JSON.stringify({
    waiters: WAITER_COUNT,
    capacity: 256,
    blockerObjects: status.blockers?.length,
    leaseRootScans,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    maxElapsedMs: MAX_ELAPSED_MS,
  }));
  manager.shutdownAll();
} finally {
  rmSync(root, { recursive: true, force: true });
}
