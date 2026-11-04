import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { timingQuality, timingQualitySummary } from "./ci-job-timing.mjs";
import { AGGREGATOR, attemptRecord, combineReports, runMetrics } from "./merge-queue-wait-report.mjs";
import { analyze, projectJob, replay, timeline, modeledRequiredMinutes } from "./ci-runner-occupancy.mjs";

const at = (time) => `2026-11-01T${time}Z`;
const run = { id: 41285878818, run_attempt: 1, created_at: at("07:42:52"), event: "merge_group",
  path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" };
const fixture = (id, name, start, end, stepStart, stepEnd) => ({ id, name, status: "completed", conclusion: "success",
  runner_id: 1, created_at: run.created_at, started_at: at(start), completed_at: at(end),
  steps: [{ number: 1, name: "Complete job", conclusion: "success", started_at: at(stepStart), completed_at: at(stepEnd) }] });
const gap = fixture(124786960842, "Browser End-to-End Tests (4)", "07:43:45", "09:22:00", "08:21:58", "08:21:58");
const outside = fixture(124795175899, AGGREGATOR, "09:24:05", "09:24:08", "08:24:05", "08:24:06");
const control = fixture(3, "Typecheck & Bundles", "07:43:00", "07:44:02", "07:43:01", "07:44:00");

test("natural job fixtures classify conflicts without repairing clocks or changing raw observations", () => {
  assert.deepEqual(timingQuality(gap), { state: "unmeasured-allocation", reason: "unexplained-terminal-gap",
    terminalGapSeconds: 3602, stepsOutsideJobInterval: 0 });
  assert.deepEqual(timingQuality(outside), { state: "unmeasured-allocation", reason: "executed-steps-outside-job-interval",
    terminalGapSeconds: 3602, stepsOutsideJobInterval: 1 });
  assert.equal(timingQuality(control).state, "no-conflict-detected");
  const raw = [gap, outside, control];
  const snapshot = structuredClone(raw);
  const record = attemptRecord("example/project", run, raw, {});
  assert.deepEqual(raw, snapshot);
  for (const [i, projected] of record.jobs.entries()) {
    assert.equal(projected.apiStartedAt, raw[i].started_at);
    assert.equal(projected.completedAt, raw[i].completed_at);
    assert.equal(projected.steps[0].startedAt, raw[i].steps[0].started_at);
    assert.equal(projected.steps[0].completedAt, raw[i].steps[0].completed_at);
  }
  for (const job of record.jobs.slice(0, 2)) {
    assert.equal(job.state, "unmeasured");
    assert.equal(job.executionMinutes, null);
    assert.equal(job.runnerWaitMinutes, null);
    assert.equal(job.steps[0].minutes, null);
  }
  assert.equal(record.metrics.measuredRunnerMinutes, 62 / 60);
  assert.equal(record.metrics.consumedRunnerMinutes, null);
  assert.equal(record.metrics.unmeasuredAllocationJobs, 2);
  assert.equal(runMetrics(run, raw).criticalExecutionMinutes, null);
  // A coherent aggregator cannot hide a contradictory required branch.
  assert.equal(runMetrics(run, [gap, { ...control, name: AGGREGATOR }]).criticalExecutionMinutes, null);
});

test("180-second threshold is strict; skipped placeholders and missing step ends do not invent a gap", () => {
  const job = { ...control, completed_at: at("07:47:00") };
  assert.equal(timingQuality(job).reason, null);
  assert.equal(timingQuality({ ...job, completed_at: at("07:47:01") }).reason, "unexplained-terminal-gap");
  assert.equal(timingQuality({ ...outside, steps: [{ ...outside.steps[0], conclusion: "skipped" }] }).reason, null);
  assert.equal(timingQuality({ ...control, steps: [{ started_at: control.started_at }] }).terminalGapSeconds, null);
});

test("occupancy, waits, replay and modeled critical paths exclude contradictory allocation", () => {
  const jobs = [gap, outside, control].map((job) => projectJob(run, job));
  const window = { since: run.created_at, until: at("10:00:00") };
  assert.deepEqual(timeline(jobs, window.since, window.until), timeline([jobs[2]], window.since, window.until));
  const waits = replay(jobs, { capacity: 20 });
  assert.equal(waits.size, 1);
  assert.equal(modeledRequiredMinutes(run.created_at, jobs, waits), null);
  const result = analyze({ repository: "example/project", ...window, jobs,
    runs: [{ id: run.id, createdAt: run.created_at, category: "ci/merge_group" }] });
  assert.equal(result.totalRunnerMinutes, 62 / 60);
  assert.equal(result.timingQuality.unmeasuredAllocationJobs, 2);
  assert.equal(result.mergeGroupCriticalPath.measured, 0);
  const onlyUnknown = analyze({ repository: "example/project", ...window, jobs: jobs.slice(0, 2), runs: [] });
  assert.equal(onlyUnknown.totalRunnerMinutes, null);
  assert.equal(onlyUnknown.categories["ci/merge_group"].runnerMinutes, null);
});

test("offline historical replay documents all first-attempt conflicts and preserves prior reduced evidence", () => {
  const input = JSON.parse(readFileSync(new URL("../docs/ci-browser-shards-2026-11-02.json", import.meta.url)));
  const output = combineReports([input]);
  const first = output.records.filter((row) => row.attempt === 1);
  assert.deepEqual(timingQualitySummary(first.flatMap((row) => row.jobs)), { unmeasuredAllocationJobs: 322,
    reasons: { "executed-steps-outside-job-interval": 271, "unexplained-terminal-gap": 51 } });
  assert.equal(first.filter((row) => row.metrics.unmeasuredAllocationJobs > 0).length, 37);
  for (const row of first) for (const job of row.jobs.filter((job) => job.timingQuality.state === "unmeasured-allocation"))
    assert.equal(job.executionMinutes, null);
});
