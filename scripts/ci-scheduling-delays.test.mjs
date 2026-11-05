import { test } from "node:test";
import assert from "node:assert/strict";
import { splitJob, analyzeReports } from "./ci-scheduling-delays.mjs";
import { attemptRecord } from "./merge-queue-wait-report.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 10, 2) + seconds * 1000).toISOString();
const rawJob = (id, name, created, started, ended, steps) => ({ id, name, status: "completed", conclusion: "success",
  created_at: at(created), started_at: at(started), completed_at: at(ended),
  steps: steps.map(([a,b]) => ({ conclusion: "success", started_at: at(a), completed_at: at(b) })) });
const report = (jobs, attempt = 1) => {
  const window = { since: at(0), until: at(86400) };
  return { schemaVersion: 2, repository: "example/project", collectedAt: at(900), windows: [window],
    pagination: [], removals: [], attemptsTruncated: false, removalsTruncated: false,
    records: [attemptRecord("example/project", { id: 10, run_attempt: attempt, event: "merge_group", created_at: at(0),
      status: "completed", conclusion: "success" }, jobs, window)] };
};
const job = () => ({ id: 1, name: "Browser End-to-End Tests (1)", state: "passing",
  createdAt: at(0), startedAt: at(60), apiStartedAt: at(60), completedAt: at(240),
  steps: [{ state: "passing", startedAt: at(70), completedAt: at(130) },
    { state: "passing", startedAt: at(120), completedAt: at(190) }] });

test("partitions queue, union of steps, overhead and terminal finalization without double counting", () => {
  const result = splitJob(job());
  assert.equal(result.runnerWaitMinutes, 1);
  assert.equal(result.stepExecutionMinutes, 2);
  assert.equal(result.finalizationMinutes, 50 / 60);
  assert.ok(Math.abs(result.runnerOverheadMinutes - 10 / 60) < 1e-10);
  assert.equal(result.stepExecutionMinutes + result.finalizationMinutes + result.runnerOverheadMinutes, 3);
});
test("retains #4046 conflicts and unexplained gaps as unmeasured; never subtracts an offset", () => {
  for (const row of [{ ...job(), completedAt: at(4000) },
    { ...job(), steps: [{ state: "passing", startedAt: at(3600), completedAt: at(3660) }] }]) {
    const result = splitJob(row);
    assert.equal(result.timingQuality.state, "unmeasured-allocation");
    assert.equal(result.stepExecutionMinutes, null);
    assert.equal(result.runnerWaitMinutes, null);
    assert.equal(result.finalizationMinutes, null);
    assert.equal(result.unmeasuredIntervalMinutes, result.observedIntervalMinutes);
  }
});
test("reruns, missing steps and unstarted cancellations do not manufacture timing", () => {
  assert.equal(splitJob(job(), 2).runnerWaitMinutes, null);
  assert.equal(splitJob({ ...job(), steps: [] }).stepExecutionMinutes, null);
  assert.equal(splitJob({ ...job(), state: "cancelled", startedAt: null }).runnerWaitMinutes, null);
  assert.equal(splitJob({ ...job(), state: "skipped", steps: [] }).stepExecutionMinutes, 0);
});

test("critical-path partition reconciles to required time; a conflicted dependency withdraws the path", () => {
  const work = rawJob(1, "Browser End-to-End Tests (1)", 0, 60, 240, [[70,130],[120,190]]);
  const aggregate = rawJob(2, "Typecheck, Test & Sidecar Bundle", 241, 300, 310, [[301,309]]);
  const result = analyzeReports([report([work, aggregate])]).records[0];
  assert.deepEqual(result.criticalPathJobIds, [2,1]);
  const total = result.jobs.reduce((sum,j) => sum + j.runnerWaitMinutes + j.stepExecutionMinutes +
    j.runnerOverheadMinutes + j.finalizationMinutes, result.schedulingGapMinutes);
  assert.ok(Math.abs(total - result.requiredResultMinutes) < 1e-10);
  // Keep the dependency end before aggregator creation: only the clock conflict can withdraw it.
  const conflictedWork = { ...work, steps: [{ conclusion: "success", started_at: at(10), completed_at: at(50) }] };
  const conflicted = analyzeReports([report([conflictedWork, aggregate])]).records[0];
  assert.equal(conflicted.criticalPathJobIds, null);
  assert.equal(conflicted.schedulingGapMinutes, null);
  assert.equal(conflicted.jobs[0].onCriticalPath, null);
  assert.equal(conflicted.dependencyCompletionToAggregatorStartMinutes, null);
});

test("skipped routing placeholders contribute zero; skipped or absent aggregators have no required result", () => {
  const routing = { ...rawJob(3, "PR Suite Routing", 0, 1, 10, []), conclusion: "skipped" };
  const work = rawJob(1, "Browser End-to-End Tests (1)", 11, 60, 240, [[70,190]]);
  const aggregate = rawJob(2, "Typecheck, Test & Sidecar Bundle", 241, 300, 310, [[301,309]]);
  const result = analyzeReports([report([routing, work, aggregate])]).records[0];
  assert.deepEqual(result.criticalPathJobIds, [2,1,3]);
  assert.equal(result.jobs.find((j) => j.id === 3).stepExecutionMinutes, 0);
  const total = result.jobs.reduce((sum,j) => sum + j.runnerWaitMinutes + j.stepExecutionMinutes +
    j.runnerOverheadMinutes + j.finalizationMinutes, result.schedulingGapMinutes);
  assert.ok(Math.abs(total - result.requiredResultMinutes) < 1e-10);
  for (const jobs of [[routing, work], [routing, work, { ...aggregate, conclusion: "skipped", steps: [] }]]) {
    const row = analyzeReports([report(jobs)]).records[0];
    assert.equal(row.requiredResultMinutes, null);
    assert.equal(row.criticalPathJobIds, null);
    assert.equal(row.dependencyCompletionToAggregatorStartMinutes, null);
  }
});

test("reruns carry no required-result, critical-path or dependency-wait allocation", () => {
  const work = rawJob(1, "Browser End-to-End Tests (1)", 0, 60, 240, [[70,190]]);
  const aggregate = rawJob(2, "Typecheck, Test & Sidecar Bundle", 241, 300, 310, [[301,309]]);
  const result = analyzeReports([report([work, aggregate], 2)]).records[0];
  assert.equal(result.requiredResultMinutes, null);
  assert.equal(result.criticalPathJobIds, null);
  assert.equal(result.dependencyCompletionToAggregatorStartMinutes, null);
});
