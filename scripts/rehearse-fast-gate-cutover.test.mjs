import assert from "node:assert/strict";
import test from "node:test";
import { inertForge, REPOSITORY } from "./fast-gate-rehearsal-forge.mjs";
import { rehearseFastGateCutover, SCHEMA } from "./rehearse-fast-gate-cutover.mjs";

const byId = report => Object.fromEntries(report.flows.map(f => [f.id, f]));

test("all seven #3637 AC2 flows are decided by delivered modules and match their expectations", async t => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("The rehearsal must never reach the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const report = await rehearseFastGateCutover();
  assert.equal(report.schema, SCHEMA); assert.equal(report.enforcement, "none"); assert.equal(report.liveMutations, 0);
  assert.equal(report.repository, REPOSITORY);
  assert.deepEqual(report.flows.map(f => f.id), ["missed-failure", "validator-outage", "exhausted-investigation-budget",
    "stale-backlogged-health", "queued-entry-hold", "exact-head-repair", "exact-candidate-release"]);
  for (const flow of report.flows) {
    for (const step of flow.steps) assert.ok(step.match, `${flow.id}: ${step.step} expected ${JSON.stringify(step.expected)}, got ${JSON.stringify(step.actual)}`);
    assert.ok(flow.steps.every(s => /^main-|^release-certification/.test(s.decidedBy)), `${flow.id} names a deciding module for every step`);
    assert.ok(flow.gaps.length > 0, `${flow.id} discloses its limits`);
  }
  assert.deepEqual(report.summary, { flows: 7, passed: 7, steps: 51 });
});

test("measured virtual detection, hold and recovery times are reproducible", async () => {
  const [first, second] = [await rehearseFastGateCutover(), await rehearseFastGateCutover()];
  assert.equal(JSON.stringify(first), JSON.stringify(second), "the rehearsal is deterministic");
  const flows = byId(first);
  assert.deepEqual(flows["missed-failure"].times, { landingToFailedVerdictMs: 2_117_800, landingToHealthFailingObservedMs: 2_178_100,
    failureToLastHoldReceiptMs: 70_700, exposureAdmissionsBeforeHold: 2, failureToReleaseReceiptMs: 4_059_500, landingToReleaseReceiptMs: 6_177_300 });
  assert.deepEqual(flows["queued-entry-hold"].times, { failureToLastHoldReceiptMs: 67_500, lastPlannedBlockLatencyMs: 67_500, landingToFailedVerdictMs: 2_117_800 });
  assert.deepEqual(flows["validator-outage"].times, { firstHoldProbeAfterLandingMs: 7_200_000, workerStartToUnknownMs: 7_262_000 });
  assert.equal(flows["stale-backlogged-health"].times.firstAgeHoldProbeSeconds, 7_200);
  assert.equal(flows["stale-backlogged-health"].times.ageHoldPlannedBlockLatencyMs, 3_600);
  assert.deepEqual(flows["exact-candidate-release"].times, { requestToCertifiedMs: 5_719_000, candidateDispatchDelayMs: 3_602_800 });
});

test("call budgets stay inside the unchanged caps and every write stays in the inert forge", async () => {
  const flows = byId(await rehearseFastGateCutover());
  const missed = flows["missed-failure"].callBudgets;
  for (const key of ["failingHealthReport", "holdWriter", "releaseWriter"]) {
    assert.equal(missed[key].limit, 96); assert.ok(missed[key].calls < missed[key].limit); assert.equal(missed[key].reason, null);
  }
  assert.equal(missed.inertDispatches, 2, "only the regression and the repair are dispatched, both virtually");
  const queued = flows["queued-entry-hold"].callBudgets;
  assert.equal(queued.holdCapacity.shortfall, 0); assert.equal(queued.holdCapacity.remainingFloor, 3000);
  assert.equal(queued.holdWriter.mutationCalls, 9, "three census/workflow GraphQL reads plus six statuses");
  const outage = flows["validator-outage"].callBudgets.outageWriter;
  assert.equal(outage.calls, 1); assert.equal(outage.mutationCalls, 0, "an outage refuses before any status request");
  const backlog = flows["stale-backlogged-health"].callBudgets;
  assert.equal(backlog.maxHealthReportCalls, 57, "each unvalidated commit adds landing-evidence reads");
  assert.deepEqual([backlog.backlogLimitCapacity.callsUsed, backlog.backlogLimitCapacity.writesAvailable], [55, 41],
    "at the five-commit limit fewer than the #3633 45-target fan-out fits");
});

test("delivered #3633 rehearsal is reused for hold fan-out and ordered rollback evidence", async () => {
  const reused = (await rehearseFastGateCutover()).delivered3633Rehearsal;
  assert.equal(reused.schema, "main-merge-admission-rehearsal-v1"); assert.equal(reused.liveMutations, 0);
  assert.equal(reused.phases.find(p => p.phase === "rollback-before-full-restoration").decision, "restore-full-queue-validation-first");
  assert.equal(reused.fanout.batchedMeasuredCost46Targets.writes, 0);
  assert.equal(reused.fanout.batchedMeasuredCost45Targets.calls, 96);
});

test("inert forge serves only its fixture repository and refuses unknown mutations", async () => {
  const w = inertForge();
  await assert.rejects(w.api("/repos/picoduck/wollipog/git/ref/heads/main"), /only its fixture repository/);
  await assert.rejects(w.api(`/repos/${REPOSITORY}/issues`, { method: "POST", body: {} }), /refuses this mutation/);
  await assert.rejects(w.api(`/repos/another/repository/statuses/${w.tip()}`, { method: "POST", body: { state: "success", context: "Regression Admission" } }),
    /only its fixture repository/);
  await assert.rejects(w.api("/graphql", { method: "POST", body: { query: "query{repository{pullRequests(first:1){nodes{number}}}}",
    variables: { owner: "another", name: "repository" } } }), /only its fixture repository/);
  assert.equal(w.state.statuses.length, 0);
  w.open(1); const advanced = w.land("advanced", { pull: 2 });
  const census = await w.api("/graphql", { method: "POST", body: { query: "pullRequests(", variables: { owner: "fixture", name: "fast-gate-rehearsal" } } });
  assert.notEqual(census.data.repository.pullRequests.nodes[0].baseRefOid, advanced, "an open PR's base stays at its last sync, as on GitHub");
  await assert.rejects(w.api(`/repos/${REPOSITORY}/git/ref/heads/ci/main-health-state`), error => error.status === 404);
  assert.throws(() => w.at(w.now - 1), /cannot move backwards/);
  w.state.outage = true;
  await assert.rejects(w.api("/rate_limit"), error => error.status === 503);
});
