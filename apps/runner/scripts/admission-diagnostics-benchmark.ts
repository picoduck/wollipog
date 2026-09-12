import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/session-manager.js";
import { SessionStore } from "../src/session-store.js";

const WAITER_COUNT = 50_000;
const TURN_BOUNDARY_CYCLES = 1_000;
const MAX_ELAPSED_MS = 5_000;
const MAX_TURN_BOUNDARY_ELAPSED_MS = 5_000;
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

  let residentLeaseRootScans = 0;
  const usedSlots = internals.boxAdmission.usedSlots.bind(internals.boxAdmission) as (path: string) => number;
  internals.boxAdmission.usedSlots = (path: string): number => {
    residentLeaseRootScans++;
    return usedSlots(path);
  };
  let activeTurnLeaseRootScans = 0;
  const activeTurnUsedSlots = internals.activeTurnAdmission.usedSlots.bind(
    internals.activeTurnAdmission,
  ) as (path: string) => number;
  internals.activeTurnAdmission.usedSlots = (path: string): number => {
    activeTurnLeaseRootScans++;
    return activeTurnUsedSlots(path);
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
  assert.equal(residentLeaseRootScans, 1, "the global lease root must be scanned once, not once per waiter");
  assert.ok(elapsedMs < MAX_ELAPSED_MS,
    `capacity diagnostics took ${elapsedMs.toFixed(1)}ms (limit ${MAX_ELAPSED_MS}ms)`);

  internals.admissionQueue.length = 0;
  const cyclesStartedAt = performance.now();
  for (let index = 0; index < TURN_BOUNDARY_CYCLES; index++) {
    const sessionId = `active-turn-${index}`;
    assert.equal(internals.activeTurnAdmission.acquire({ sessionId, agentId: "claude", weight: 1 }), true);
    manager.reportCapacity();
    internals.activeTurnAdmission.release(sessionId);
    manager.reportCapacity();
  }
  const cyclesElapsedMs = performance.now() - cyclesStartedAt;
  assert.equal(residentLeaseRootScans, 1,
    "active-turn reports must reuse the unchanged 256-slot resident observation");
  assert.ok(cyclesElapsedMs < MAX_TURN_BOUNDARY_ELAPSED_MS,
    `turn-boundary diagnostics took ${cyclesElapsedMs.toFixed(1)}ms ` +
    `(limit ${MAX_TURN_BOUNDARY_ELAPSED_MS}ms)`);
  console.log(JSON.stringify({
    waiters: WAITER_COUNT,
    capacity: 256,
    blockerObjects: status.blockers?.length,
    residentLeaseRootScans,
    activeTurnLeaseRootScans,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    maxElapsedMs: MAX_ELAPSED_MS,
    turnBoundaryCycles: TURN_BOUNDARY_CYCLES,
    turnBoundaryElapsedMs: Number(cyclesElapsedMs.toFixed(1)),
    maxTurnBoundaryElapsedMs: MAX_TURN_BOUNDARY_ELAPSED_MS,
  }));
  manager.shutdownAll();
} finally {
  rmSync(root, { recursive: true, force: true });
}
