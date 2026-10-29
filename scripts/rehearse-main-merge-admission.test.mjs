import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehearseAdmission } from "./rehearse-main-merge-admission.mjs";

test("historical health replay and inert recovery prove hold, exact repair, independent release and ordered rollback", async () => {
  const projection = JSON.parse(readFileSync(new URL("./fixtures/main-merge-health-projection.json", import.meta.url), "utf8"));
  const report = await rehearseAdmission(projection);
  const phases = Object.fromEntries(report.phases.map(p => [p.phase, p]));
  assert.equal(phases["historical-baseline-replay"].decision, "ordinary-admission-eligible");
  assert.equal(phases.hold.decision, "hold"); assert.equal(phases.expiry.decision, "hold");
  assert.equal(phases["authorized-exact-head-repair"].decision, "authorized-repair-eligible");
  assert.equal(phases["authorized-exact-head-repair"].normalReviewAndMergeRequired, true);
  assert.equal(phases["merged-identity-reconciliation"].decision, "merged-repair-bound");
  assert.equal(phases["purpose-repair-validation-request"].purpose, "repair");
  assert.equal(phases["purpose-repair-validation-request"].targetSha, phases["merged-identity-reconciliation"].mergeSha);
  assert.equal(phases["purpose-repair-validation-request"].certification, "none");
  assert.equal(phases["pending-validation-holds"].decision, "hold"); assert.equal(phases["receipt-alone-holds"].decision, "hold");
  assert.equal(phases["independent-health-reconciliation"].decision, "release-eligible");
  assert.equal(phases.release.decision, "ordinary-admission-eligible");
  assert.equal(phases["rollback-before-full-restoration"].decision, "restore-full-queue-validation-first");
  assert.equal(phases["rollback-after-full-restoration-and-exact-operator-approval"].decision, "operator-hold-removal-planned");
  assert.equal(phases["rollback-after-full-restoration-and-exact-operator-approval"].holdRetained, true);
  assert.equal(phases["rollback-after-full-restoration-and-exact-operator-approval"].fullRequiredContextRetained, true);
  assert.equal(report.latency.failureToPlannedBlockMs, 1000); assert.equal(report.latency.expiryToPlannedBlockMs, 0);
  assert.ok(Number.isFinite(report.latency.failureComputeMs)); assert.ok(Number.isFinite(report.latency.expiryComputeMs));
  // Every delivery keeps the writer's 10% call reserve (10 of 96, 5 of 48) and delivers the rest of
  // the holds on the next cycle from its own durable progress; nothing refuses with zero writes (#3633).
  for (const f of Object.values(report.fanout)) {
    assert.equal(f.complete, true, "every fixture completes within a bounded number of cycles");
    assert.equal(f.totalWrites, f.targetCount); assert.equal(f.liveMutations, 0); assert.ok(Number.isFinite(f.computeMs));
    for (const c of f.cycles) assert.ok(c.headroomCalls >= c.reserveCalls && c.reserveCalls >= Math.ceil(c.limit * 0.1),
      `cycle ${c.cycle} keeps at least 10% of its cap spare`);
  }
  for (const [name, expectedLatency] of [["failure", 9300], ["expiry", 8300]]) {
    const f = report.fanout[name];
    assert.equal(f.targetCount, 45); assert.equal(f.writes, 45); assert.equal(f.cyclesToComplete, 1);
    assert.equal(f.reports, 1); assert.equal(f.censuses, 1);
    assert.equal(f.calls, 83); assert.equal(f.callLimit, 96); assert.equal(f.firstCycleHeadroomCalls, 13);
    assert.equal(f.failureOrExpiryToLastPlannedHoldMs, expectedLatency);
    assert.equal(f.lastPlannedBlockLatencyMs, expectedLatency);
  }
  // The original 48-call cap (REST limit 1000): previously zero writes, now 5 holds a cycle.
  const short = report.fanout.insufficientBudget;
  assert.equal(short.capacity.callsUsed, 38); assert.equal(short.capacity.callLimit, 48);
  assert.equal(short.capacity.reserveCalls, 5); assert.equal(short.capacity.writesAvailable, 5);
  assert.deepEqual(short.cycles.map(c => c.writes), [5, 5, 5, 5, 5, 5, 5, 5, 5]);
  assert.equal(short.cyclesToComplete, 9); assert.equal(short.failureOrExpiryToLastPlannedHoldMs, 485_300);
  const contemporary = report.fanout.currentReadCost35Targets;
  assert.deepEqual(contemporary.cycles.map(c => c.writes), [33, 2]); assert.equal(contemporary.calls, 86);
  assert.equal(contemporary.failureOrExpiryToLastPlannedHoldMs, 66_500);
  // Unbatched measured cost at the live-observed 45 targets: previously two writes short and zero writes.
  const larger = report.fanout.currentReadCost45Targets;
  assert.equal(larger.capacity.callsUsed, 53); assert.equal(larger.capacity.writesAvailable, 33);
  assert.deepEqual(larger.cycles.map(c => c.writes), [33, 12]); assert.equal(larger.failureOrExpiryToLastPlannedHoldMs, 67_500);
  // #3711's batched cost previously fitted 45 holds in exactly 96/96 calls; it now keeps 10 spare.
  for (const [key, latency] of [["batchedMeasuredCost45Targets", 67_100], ["batchedMeasuredCostExpiry45Targets", 66_100]]) {
    const batched = report.fanout[key];
    assert.equal(batched.unbatchedReadCalls, 53); assert.equal(batched.savedCalls, 2);
    assert.equal(batched.workflowQueries, 2, "one batch per cycle"); assert.equal(batched.censuses, 2); assert.equal(batched.reports, 2);
    assert.equal(batched.capacity.callsUsed, 51); assert.equal(batched.calls, 86); assert.equal(batched.firstCycleHeadroomCalls, 10);
    assert.deepEqual(batched.cycles.map(c => [c.writes, c.alreadyHeld]), [[35, 0], [10, 35]]);
    assert.equal(batched.failureOrExpiryToLastPlannedHoldMs, latency);
  }
  // The 46th target, previously one short and zero writes, is held in the second cycle.
  const batchedShort = report.fanout.batchedMeasuredCost46Targets;
  assert.equal(batchedShort.capacity.callsUsed, 51); assert.equal(batchedShort.capacity.writesAvailable, 35);
  assert.deepEqual(batchedShort.cycles.map(c => c.writes), [35, 11]); assert.equal(batchedShort.failureOrExpiryToLastPlannedHoldMs, 67_200);
  const latest = report.fanout.latestObservedCost45Targets;
  assert.equal(latest.unbatchedReadCalls, 38); assert.equal(latest.savedCalls, 4);
  assert.equal(latest.capacity.callsUsed, 34); assert.equal(latest.calls, 79);
  assert.equal(latest.writes, 45); assert.equal(latest.firstCycleHeadroomCalls, 17);
  assert.equal(latest.failureOrExpiryToLastPlannedHoldMs, 8900);
  // At the #3637 five-commit backlog cost, the landing-critical group withdrawals go first.
  const backlog = report.fanout.backlogLimitCost45TargetsTwoHeldGroups;
  assert.equal(backlog.capacity.callsUsed, 55); assert.equal(backlog.capacity.writesAvailable, 31);
  assert.equal(backlog.groupHoldsInFirstCycle, 2, "both groups holding a success are held in the first cycle");
  assert.deepEqual(backlog.cycles.map(c => c.writes), [31, 14]); assert.equal(backlog.cyclesToComplete, 2);
  assert.equal(backlog.failureOrExpiryToLastPlannedHoldMs, 67_900); assert.equal(backlog.minHeadroomCalls, 10);
  assert.equal(report.liveMutations, 0); assert.deepEqual(report.disabledWriter, { mode: "disabled", writes: 0 });
  assert.match(report.source.evidenceClass, /historical/); assert.match(report.forgeRace, /No finite unconditional/);
});
