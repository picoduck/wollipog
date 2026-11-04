import assert from "node:assert/strict";
import test from "node:test";
import { CONTROLLER } from "./main-merge-admission-controller.mjs";
import { POLICY } from "./main-merge-admission.mjs";
import { LEASE_TIMING, OUTAGE_MINUTES, rehearseAdmissionLease, SCHEMA } from "./rehearse-admission-lease.mjs";

const MINUTE = 60_000;
let report;
const run = async () => report ??= await rehearseAdmissionLease();
const byId = async id => (await run()).cases.find(c => c.id === id);

test("no controller or forge outage, of any tested length, lets a group land on an earlier admission", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("The lease rehearsal must never reach the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const r = await rehearseAdmissionLease();
  assert.equal(r.schema, SCHEMA); assert.equal(r.enforcement, "none"); assert.equal(r.liveMutations, 0);
  assert.equal(r.summary.pass, true);
  assert.ok(OUTAGE_MINUTES.some(m => m * MINUTE > LEASE_TIMING.checkResponseTimeoutMs), "one outage outlasts the queue timeout");
  const outages = r.cases.filter(c => c.id.startsWith("outage-"));
  assert.equal(outages.length, 6);
  for (const c of outages) {
    assert.notEqual(c.outcome, "landed", c.id);
    assert.equal(c.successWrittenAtMs, null, `${c.id}: no success exists before the group is ready`);
    // A controller that returns before the timeout ejects the group with a failure; otherwise the queue removes it.
    assert.equal(c.outcome, c.outageStartMs + c.outageMs < LEASE_TIMING.checkResponseTimeoutMs ? "ejected" : "removed-checks-timed-out", c.id);
  }
  assert.equal(JSON.stringify(r), JSON.stringify(await rehearseAdmissionLease()), "deterministic");
});

test("the earlier every-cycle success reproduces the sticky landing this change removes", async () => {
  const before = await byId("pre-change-early-success-lands-stale");
  assert.deepEqual([before.outcome, before.staleLanding], ["landed", true]);
  assert.ok(before.successWrittenAtMs < before.failedAtMs, "the success predates the failure");
  // The earlier controller rewrote success on every eligible cycle until the outage (#3768 review).
  assert.equal(before.successWrites, 2, "both cycles before the outage write success");
  assert.equal(before.successWrittenAtMs, 67_000);
  assert.equal(before.evaluationAgeAtLandingMs, 536_000, "a nine-minute-old evaluation lands after health failed");
});

test("healthy groups land just in time and failures with the controller up eject; the race window is bounded and disclosed", async () => {
  const healthy = await byId("healthy-lands-just-in-time");
  // Ages are measured from the observation the writer itself rebuilt and used (#3768 review).
  assert.deepEqual([healthy.outcome, healthy.staleLanding, healthy.aggregatorToLandingMs, healthy.evaluationAgeAtLandingMs], ["landed", false, 7_100, 3_100]);
  assert.ok(healthy.successWrittenAtMs >= LEASE_TIMING.aggregatorMs, "success only after the aggregator");
  const up = await byId("failure-while-controller-up-ejects");
  assert.deepEqual([up.outcome, up.successWrittenAtMs], ["ejected", null]);
  const race = await byId("race-failure-between-write-and-landing");
  assert.deepEqual([race.outcome, race.staleLanding, race.evaluationAgeAtLandingMs], ["landed", true, 36_000]);
  const { summary } = await run();
  assert.equal(summary.raceWindow.boundMs, POLICY.maxObservationAgeSeconds * 1000 + CONTROLLER.maxCycleAgeMs + race.forgeLandingMs);
  assert.ok(summary.raceWindow.withinBound);
  assert.equal(summary.staleLandingsOutsideRace, 0);
  assert.deepEqual(summary.availabilityCost, { healthyAggregatorToLandingMs: 7_100, maxAddedLatencyMs: LEASE_TIMING.cycleMs + LEASE_TIMING.tickMs,
    outageStallUntilRemovalMs: 120 * MINUTE });
});

test("an aggregator rerun after the just-in-time write withdraws that success until a fresh one (#3768 review)", async () => {
  const rerun = await byId("rerun-after-success-withdrawn");
  assert.deepEqual([rerun.outcome, rerun.staleLanding, rerun.withdrawals], ["landed", false, 1]);
  assert.ok(rerun.successWrittenAtMs >= rerun.rerunAtMs + rerun.rerunMs, "the landing success is written after the rerun");
  // Each eligible cycle rewrites the success from a fresh evaluation; the landing relies on the latest.
  assert.equal(rerun.evaluationAgeAtLandingMs, 3_100);
  assert.ok(rerun.evaluationAgeAtLandingMs <= POLICY.maxObservationAgeSeconds * 1000 + CONTROLLER.maxCycleAgeMs + rerun.forgeLandingMs);
  // Disclosed limit: a rerun begun inside the race window while the controller is down extends it by the rerun.
  const outage = await byId("rerun-during-outage-disclosed");
  assert.deepEqual([outage.outcome, outage.staleLanding, outage.withdrawals, outage.evaluationAgeAtLandingMs], ["landed", true, 0, 736_000]);
  assert.deepEqual((await run()).summary.rerunDuringOutage, { staleLanding: true, evaluationAgeAtLandingMs: 736_000, extendsRaceByRerunMs: 600_000 });
});
