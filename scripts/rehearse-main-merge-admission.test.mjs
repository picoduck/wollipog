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
  for (const [name, expectedLatency] of [["failure", 9300], ["expiry", 8300]]) {
    const f = report.fanout[name];
    assert.equal(f.targetCount, 45); assert.equal(f.writes, 45); assert.equal(f.complete, true);
    assert.equal(f.reports, 1); assert.equal(f.censuses, 1);
    assert.equal(f.apiBudget.calls, 83); assert.equal(f.apiBudget.limit, 96);
    assert.equal(f.failureOrExpiryToLastPlannedHoldMs, expectedLatency);
    assert.equal(f.lastPlannedBlockLatencyMs, expectedLatency);
    assert.equal(f.liveMutations, 0); assert.ok(Number.isFinite(f.computeMs));
  }
  const short = report.fanout.insufficientBudget;
  assert.equal(short.writes, 0); assert.equal(short.complete, false);
  assert.equal(short.capacity.callsUsed, 38); assert.equal(short.capacity.callLimit, 48);
  assert.equal(short.capacity.writesAvailable, 10); assert.equal(short.capacity.shortfall, 35);
  assert.equal(short.failureOrExpiryToLastPlannedHoldMs, null);
  const contemporary = report.fanout.currentReadCost35Targets;
  assert.equal(contemporary.writes, 35); assert.equal(contemporary.apiBudget.calls, 88);
  assert.equal(contemporary.failureOrExpiryToLastPlannedHoldMs, 9800);
  const larger = report.fanout.currentReadCost45Targets;
  assert.equal(larger.writes, 0); assert.equal(larger.complete, false);
  assert.equal(larger.capacity.callsUsed, 53); assert.equal(larger.capacity.writesAvailable, 43);
  assert.equal(larger.capacity.shortfall, 2);
  for (const [key, latency] of [["batchedMeasuredCost45Targets", 10600], ["batchedMeasuredCostExpiry45Targets", 9600]]) {
    const batched = report.fanout[key];
    assert.equal(batched.unbatchedReadCalls, 53); assert.equal(batched.savedCalls, 2);
    assert.equal(batched.workflowQueries, 1); assert.equal(batched.censuses, 1); assert.equal(batched.reports, 1);
    assert.equal(batched.capacity.callsUsed, 51); assert.equal(batched.apiBudget.calls, 96);
    assert.equal(batched.writes, 45); assert.equal(batched.complete, true); assert.equal(batched.callHeadroom, 0);
    assert.equal(batched.failureOrExpiryToLastPlannedHoldMs, latency);
    assert.equal(batched.lastPlannedBlockLatencyMs, latency);
    assert.equal(batched.apiBudget.remainingFloor, 3000); assert.equal(batched.liveMutations, 0);
  }
  const batchedShort = report.fanout.batchedMeasuredCost46Targets;
  assert.equal(batchedShort.capacity.callsUsed, 51); assert.equal(batchedShort.capacity.writesAvailable, 45);
  assert.equal(batchedShort.capacity.shortfall, 1); assert.equal(batchedShort.writes, 0);
  assert.equal(batchedShort.failureOrExpiryToLastPlannedHoldMs, null);
  const latest = report.fanout.latestObservedCost45Targets;
  assert.equal(latest.unbatchedReadCalls, 38); assert.equal(latest.savedCalls, 4);
  assert.equal(latest.capacity.callsUsed, 34); assert.equal(latest.apiBudget.calls, 79);
  assert.equal(latest.writes, 45); assert.equal(latest.callHeadroom, 17);
  assert.equal(latest.failureOrExpiryToLastPlannedHoldMs, 8900);
  assert.equal(report.liveMutations, 0); assert.deepEqual(report.disabledWriter, { mode: "disabled", writes: 0 });
  assert.match(report.source.evidenceClass, /historical/); assert.match(report.forgeRace, /No finite unconditional/);
});
