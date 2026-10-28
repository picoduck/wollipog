import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CONTROLLER } from "./main-merge-admission-controller.mjs";
import { POLICY } from "./main-merge-admission.mjs";
import { sha } from "./fast-gate-rehearsal-forge.mjs";
import { harness, TIMING } from "./rehearse-fast-gate-cutover.mjs";

/** #3633 AC1/AC5: an outage of any length cannot let a merge group land on an old admission.
 * Inert and offline. Every decision comes from the delivered controller (real health report,
 * census and default-deny writer) over the #3637 fake forge on a virtual clock. The forge's
 * landing rule is a fixture model of GitHub's merge queue: a group lands only when its required
 * aggregator and `Regression Admission` both report success on its exact SHA while its base is
 * main; a failure ejects it; a missing result is removed at the check-response timeout.
 */
export const SCHEMA = "admission-lease-rehearsal-v1";
const MINUTE = 60_000, TICK = 10_000;
export const LEASE_TIMING = Object.freeze({
  aggregatorMs: TIMING.fastGateMs, // The group's own checks finish 10 minutes after creation.
  checkResponseTimeoutMs: 120 * MINUTE, // Live ruleset check_response_timeout_minutes.
  cycleMs: CONTROLLER.reevaluateMs, tickMs: TICK,
  source: "Fixture assumptions: #3637's 10-minute fast-gate bound, the live 120-minute queue timeout, the controller's 60-second cycle and a 10-second forge tick. GitHub's real landing latency is not measured.",
});

/**
 * One group's life. `preChange` reproduces the earlier behavior (success written on every eligible
 * cycle, before the group's own checks finish) by reporting the aggregator early to the planner
 * only; the forge still lands at the real aggregator time. `rerunAtMs`/`rerunMs` rerun the group's
 * aggregator after it first succeeded. Everything else is identical.
 */
export async function leaseCase({ id, outageStartMs = null, outageMs = 0, failAtMs = null, forgeLandingMs = 0, preChange = false,
  rerunAtMs = null, rerunMs = 0 }) {
  const { w } = await harness.baselineWorld();
  const unvalidated = w.land("unvalidated", { pull: 301 });
  w.at(w.now + TIMING.controllerWakeMs);
  const worker = await harness.validateLatest(w, "failure", { finish: false });
  w.open(302, { head: sha("head:302") });
  const group = w.enqueue("candidate", [302], { base: unvalidated });
  const t0 = w.now;
  w.reportRequired("candidate", preChange ? "success" : "pending");
  const down = tick => outageStartMs !== null && tick >= t0 + outageStartMs && tick < t0 + outageStartMs + outageMs;
  // The aggregator's real result on the group SHA: what GitHub's merge queue sees.
  const truth = tick => tick < t0 + LEASE_TIMING.aggregatorMs ? "pending"
    : rerunAtMs !== null && tick >= t0 + rerunAtMs && tick < t0 + rerunAtMs + rerunMs ? "pending" : "success";
  // When both contexts became green: GitHub's landing latency counts from then, not from rewrites.
  const aggregatorGreenSince = tick => t0 + (rerunAtMs !== null && tick >= t0 + rerunAtMs ? rerunAtMs + rerunMs : LEASE_TIMING.aggregatorMs);
  const admissionGreenSince = () => {
    const history = w.state.statuses.filter(s => s.targetSha === group.sha);
    let i = history.length;
    while (i > 0 && history[i - 1].state === "success") i--;
    return i < history.length ? Date.parse(history[i].at) : null;
  };
  let nextCycle = t0, failedAt = null, success = null, outcome = null, cycles = 0, withdrawals = 0;
  for (let tick = t0; !outcome; tick += TICK) {
    if (tick > w.now) w.at(tick);
    if (failAtMs !== null && failedAt === null && tick >= t0 + failAtMs) { w.finishRun(worker.run, "failure", w.now); failedAt = w.now; }
    if (!preChange) w.reportRequired("candidate", truth(tick));
    if (!down(tick) && tick >= nextCycle) {
      const { plan } = await harness.cycle(w);
      const before = w.latestStatus(group.sha);
      const delivered = await harness.deliver(w, plan);
      cycles++;
      nextCycle = tick + LEASE_TIMING.cycleMs;
      const after = w.latestStatus(group.sha);
      if (after !== before && after?.state === "pending") withdrawals++;
      // Evaluation age is measured from the observation the writer itself rebuilt and used.
      if (delivered.complete && after !== before && after?.state === "success")
        success = { writtenAt: Date.parse(after.at), observedAt: Date.parse(delivered.revalidatedObservedAt) };
    }
    // Fixture model of the merge queue's landing rule.
    const status = w.latestStatus(group.sha);
    if (status?.state === "failure") outcome = { kind: "ejected", at: w.now };
    else if (truth(tick) === "success" && status?.state === "success" && group.base === w.tip() &&
        Math.max(admissionGreenSince(), aggregatorGreenSince(tick)) + forgeLandingMs <= w.now)
      outcome = { kind: "landed", at: w.now };
    else if (w.now >= t0 + LEASE_TIMING.checkResponseTimeoutMs) outcome = { kind: "removed-checks-timed-out", at: w.now };
  }
  const rel = value => value === null || value === undefined ? null : value - t0;
  const landed = outcome.kind === "landed";
  return { id, preChange, outageStartMs, outageMs, failAtMs, forgeLandingMs, rerunAtMs, rerunMs, withdrawals, outcome: outcome.kind,
    outcomeAtMs: rel(outcome.at),
    failedAtMs: rel(failedAt), successWrittenAtMs: rel(success?.writtenAt), successObservedAtMs: rel(success?.observedAt),
    // Landed although main's health had already failed: the evaluation behind its success was stale.
    staleLanding: landed && failedAt !== null && failedAt <= outcome.at,
    evaluationAgeAtLandingMs: landed && success ? outcome.at - success.observedAt : null,
    aggregatorToLandingMs: landed ? outcome.at - t0 - LEASE_TIMING.aggregatorMs : null, cycles };
}

// Outage lengths include one longer than the queue timeout; failures land inside each outage.
export const OUTAGE_MINUTES = Object.freeze([5, 30, 130]);
export const OUTAGE_STARTS_MINUTES = Object.freeze([2, 9.5]);

export async function rehearseAdmissionLease() {
  const cases = [];
  cases.push(await leaseCase({ id: "healthy-lands-just-in-time" }));
  cases.push(await leaseCase({ id: "failure-while-controller-up-ejects", failAtMs: 5 * MINUTE }));
  cases.push(await leaseCase({ id: "pre-change-early-success-lands-stale", preChange: true, outageStartMs: 2 * MINUTE,
    outageMs: 30 * MINUTE, failAtMs: 3 * MINUTE }));
  for (const start of OUTAGE_STARTS_MINUTES) for (const length of OUTAGE_MINUTES)
    cases.push(await leaseCase({ id: `outage-${start}m-for-${length}m`, outageStartMs: start * MINUTE, outageMs: length * MINUTE,
      failAtMs: (start + 0.5) * MINUTE }));
  // The disclosed race: health fails after the just-in-time write but before GitHub lands the group.
  // The success is written about 7 s after the aggregator; the controller then stops and health
  // fails while a fixture 30-second forge latency delays the landing.
  cases.push(await leaseCase({ id: "race-failure-between-write-and-landing", forgeLandingMs: 30_000,
    failAtMs: LEASE_TIMING.aggregatorMs + 15_000, outageStartMs: LEASE_TIMING.aggregatorMs + TICK, outageMs: 10 * MINUTE }));
  // A rerun after the just-in-time write must withdraw that success before the rerun can land it (#3768 review).
  cases.push(await leaseCase({ id: "rerun-after-success-withdrawn", forgeLandingMs: 2 * MINUTE,
    rerunAtMs: LEASE_TIMING.aggregatorMs + 20_000, rerunMs: 3 * MINUTE }));
  // Disclosed limit: a rerun started inside the race window while the controller is down cannot be withdrawn.
  cases.push(await leaseCase({ id: "rerun-during-outage-disclosed", forgeLandingMs: 2 * MINUTE,
    rerunAtMs: LEASE_TIMING.aggregatorMs + 20_000, rerunMs: 10 * MINUTE, outageStartMs: LEASE_TIMING.aggregatorMs + TICK,
    outageMs: 30 * MINUTE, failAtMs: LEASE_TIMING.aggregatorMs + 2 * MINUTE }));
  const jit = cases.filter(c => !c.preChange);
  const outages = jit.filter(c => c.outageStartMs !== null && c.id.startsWith("outage-"));
  const race = cases.find(c => c.id === "race-failure-between-write-and-landing");
  const rerun = cases.find(c => c.id === "rerun-after-success-withdrawn");
  const rerunOutage = cases.find(c => c.id === "rerun-during-outage-disclosed");
  const raceBoundMs = POLICY.maxObservationAgeSeconds * 1000 + CONTROLLER.maxCycleAgeMs + race.forgeLandingMs;
  const healthy = cases.find(c => c.id === "healthy-lands-just-in-time");
  const summary = {
    cases: cases.length,
    outageCasesNeverLand: outages.every(c => c.outcome !== "landed"),
    outageLengthsMinutes: OUTAGE_MINUTES,
    preChangeLandsStale: cases.find(c => c.preChange).staleLanding,
    staleLandingsOutsideRace: jit.filter(c => c.staleLanding && c !== race && c !== rerunOutage).length,
    rerunWithdrawn: { withdrawals: rerun.withdrawals, outcome: rerun.outcome, staleLanding: rerun.staleLanding,
      evaluationAgeAtLandingMs: rerun.evaluationAgeAtLandingMs, freshAfterRerun: rerun.successWrittenAtMs >= rerun.rerunAtMs + rerun.rerunMs },
    rerunDuringOutage: { staleLanding: rerunOutage.staleLanding, evaluationAgeAtLandingMs: rerunOutage.evaluationAgeAtLandingMs,
      extendsRaceByRerunMs: rerunOutage.rerunMs },
    raceWindow: { staleLanding: race.staleLanding, evaluationAgeAtLandingMs: race.evaluationAgeAtLandingMs, boundMs: raceBoundMs,
      withinBound: race.evaluationAgeAtLandingMs !== null && race.evaluationAgeAtLandingMs <= raceBoundMs },
    availabilityCost: { healthyAggregatorToLandingMs: healthy.aggregatorToLandingMs, maxAddedLatencyMs: LEASE_TIMING.cycleMs + TICK,
      outageStallUntilRemovalMs: LEASE_TIMING.checkResponseTimeoutMs },
  };
  summary.pass = summary.outageCasesNeverLand && summary.preChangeLandsStale && summary.staleLandingsOutsideRace === 0 &&
    summary.rerunWithdrawn.withdrawals >= 1 && summary.rerunWithdrawn.outcome === "landed" && !summary.rerunWithdrawn.staleLanding &&
    summary.rerunWithdrawn.freshAfterRerun &&
    summary.raceWindow.withinBound && healthy.outcome === "landed" && healthy.aggregatorToLandingMs <= summary.availabilityCost.maxAddedLatencyMs &&
    cases.find(c => c.id === "failure-while-controller-up-ejects").outcome === "ejected";
  return { schema: SCHEMA, issue: "#3633 AC1/AC5", mode: "inert-offline-fixture", enforcement: "none", timing: LEASE_TIMING,
    evidenceClass: "Delivered controller decisions over the #3637 inert forge with a fixture merge-queue landing rule. Not live enforcement and not a measurement of GitHub's landing latency.",
    summary, cases, liveMutations: 0 };
}

export async function main(argv = process.argv.slice(2)) {
  const report = await rehearseAdmissionLease();
  if (argv[0]) writeFileSync(argv[0], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary));
  return report.summary.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(code => { process.exitCode = code; });
