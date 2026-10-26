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
  assert.equal(report.liveMutations, 0); assert.deepEqual(report.disabledWriter, { mode: "disabled", writes: 0 });
  assert.match(report.source.evidenceClass, /historical/); assert.match(report.forgeRace, /No finite unconditional/);
});
