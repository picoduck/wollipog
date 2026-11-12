import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AGGREGATOR, attemptRecord, combineReports, eventSummary, listJobs, markdown, reprojectAttempt } from "./merge-queue-wait-report.mjs";

const run = { id: 1, run_attempt: 1, event: "merge_group", status: "completed",
  conclusion: "failure", created_at: "2026-11-09T18:06:28Z" };
const aggregate = { id: 2, name: AGGREGATOR, status: "completed", conclusion: "success" };
const record = (jobs, overrides = {}, truncated = false) =>
  attemptRecord("example/project", { ...run, ...overrides }, jobs, {}, truncated);

test("the complete November 9 incident inventory replays as absent, never as a passing result", () => {
  const evidence = JSON.parse(readFileSync(new URL("../docs/ci-missing-aggregate-2026-11-09.json", import.meta.url)));
  assert.equal(evidence.jobs.length, evidence.jobsTotalCount);
  assert.equal(evidence.jobs.filter((job) => job.conclusion === "success").length, 18);
  assert.equal(evidence.jobs.filter((job) => job.conclusion === "skipped").length, 2);
  assert.equal(evidence.jobs.some((job) => job.name === AGGREGATOR), false);
  const row = attemptRecord(evidence.repository, evidence.run, evidence.jobs, {}, false, 10);
  assert.equal(row.aggregation.state, "absent");
  assert.equal(row.state, "failing");
  assert.equal(row.metrics.requiredMinutes, null);
  assert.deepEqual(reprojectAttempt(row).aggregation, row.aggregation);
});

test("a terminal attempt with successful work and no aggregate is absent, not delayed", () => {
  const row = record([{ id: 3, name: "Unit Tests (1)", status: "completed", conclusion: "success" }]);
  assert.equal(row.aggregation.state, "absent");
  assert.equal(row.aggregation.reason, "terminal-run-without-aggregate");
  assert.equal(row.state, "failing", "diagnosis never changes the workflow outcome");
  assert.equal(row.metrics.requiredMinutes, null);
});

test("aggregation distinguishes job presence and terminal outcomes without timing guesses", () => {
  const cases = [
    ["queued", null, "pending"], ["waiting", null, "pending"],
    ["in_progress", null, "running"], ["completed", "success", "passing"],
    ["completed", "failure", "failing"], ["completed", "timed_out", "failing"],
    ["completed", "cancelled", "cancelled"], ["completed", "skipped", "skipped"],
    ["completed", "neutral", "unmeasured"],
  ];
  for (const [status, conclusion, expected] of cases) {
    const row = record([{ ...aggregate, status, conclusion }]);
    assert.equal(row.aggregation.state, expected, `${status}/${conclusion}`);
    assert.deepEqual(reprojectAttempt(row).aggregation, row.aggregation);
  }
  const active = record([], { status: "in_progress", conclusion: null });
  assert.equal(active.aggregation.state, "pending");
  assert.equal(active.aggregation.reason, "not-created");
  assert.equal(record([], { status: undefined, conclusion: null }).aggregation.state, "unmeasured");
  assert.equal(record([aggregate], {}, true).aggregation.state, "unmeasured");
  assert.equal(record([], {}, true).aggregation.state, "unmeasured");
  assert.equal(record([aggregate, { ...aggregate, id: 4 }]).aggregation.reason, "multiple-aggregate-records");
  const missingInventory = { ...record([]), jobs: undefined };
  assert.equal(reprojectAttempt(missingInventory).aggregation.state, "unmeasured");
});

test("combining historical exports recomputes diagnosis, including terminal and active absence", () => {
  const rows = [record([]), record([], { id: 2, status: "in_progress", conclusion: null }),
    record([{ ...aggregate, conclusion: "skipped" }], { id: 3 })];
  const legacy = rows.map(({ aggregation, status, ...row }) => ({ ...row,
    jobs: row.jobs.map(({ status, ...job }) => job) }));
  assert.equal(legacy.some((row) => "status" in row || row.jobs.some((job) => "status" in job)), false);
  const report = { schemaVersion: 2, repository: "example/project", records: legacy, windows: [],
    pagination: [], removals: [], collectedAt: "2026-11-10T00:00:00Z" };
  const combined = combineReports([report, report]);
  assert.deepEqual(combined.records.map((row) => row.aggregation.state), ["absent", "pending", "skipped"]);
  assert.equal(eventSummary(combined.records).aggregation.absent, 1);
  assert.match(markdown(combined), /Required aggregation:.*absent 1/);
  assert.match(markdown(combined), /run 1, attempt 1: absent \(terminal-run-without-aggregate\)/);
});

test("duplicate paginated jobs cannot establish absence from an incomplete inventory", async () => {
  const result = await listJobs(async () => ({ total_count: 2, jobs: [
    { id: 3, name: "Unit Tests (1)", status: "completed", conclusion: "success" },
  ] }), "example/project", 1, 1);
  assert.equal(result.truncated, true);
  assert.equal(record(result.jobs, {}, result.truncated).aggregation.state, "unmeasured");
});
