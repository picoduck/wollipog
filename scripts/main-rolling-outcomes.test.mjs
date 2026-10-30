import assert from "node:assert/strict";
import test from "node:test";
import { isSupersededWorkerAttempt } from "./main-rolling-outcomes.mjs";

const run = { status: "completed", run_attempt: 1, conclusion: "cancelled" };
const marker = { name: "Admit Main Snapshot", steps: [
  { name: "Skip Superseded Rolling Claim", conclusion: "success" }], started_at: "2026-10-24T12:00:00Z" };

test("native cancellation proves no execution, not a failed validation or a rerun", () => {
  assert.ok(isSupersededWorkerAttempt(run, []));
  assert.ok(isSupersededWorkerAttempt(run, [{ name: "Admit Main Snapshot", started_at: null, steps: [] }]));
  for (const changed of [{ status: "in_progress" }, { run_attempt: 2 }, { conclusion: "failure" },
    { conclusion: "startup_failure" }, { conclusion: "success" }])
    assert.equal(isSupersededWorkerAttempt({ ...run, ...changed }, []), false, JSON.stringify(changed));
  assert.equal(isSupersededWorkerAttempt(run, [{ name: "Admit Main Snapshot", started_at: "2026-10-24T12:00:00Z" }]), false);
  assert.equal(isSupersededWorkerAttempt(run, [{ name: "Admit Main Snapshot", steps: [{ name: "Started" }] }]), false);
});

test("explicit rejection receipt is valid only with no executed or unknown suite jobs", () => {
  const done = { ...run, conclusion: "success" };
  assert.ok(isSupersededWorkerAttempt(done, [marker]));
  assert.ok(isSupersededWorkerAttempt(done, [marker, { name: "Full Validation", conclusion: "skipped" }]));
  for (const job of [{ name: "Unexpected Work", conclusion: "success" },
    { name: "Full Validation / Browser End-to-End Tests (1)", conclusion: "failure" },
    { name: "Full Validation / Browser End-to-End Tests (1)", conclusion: "cancelled" },
    { name: "Full Validation / Browser End-to-End Tests (1)", conclusion: "skipped", steps: [{ name: "Ran" }] }])
    assert.equal(isSupersededWorkerAttempt(done, [marker, job]), false, JSON.stringify(job));
  assert.equal(isSupersededWorkerAttempt(done, [marker, marker]), false);
  assert.equal(isSupersededWorkerAttempt(done, [{ ...marker,
    steps: [{ ...marker.steps[0], conclusion: "skipped" }] }]), false);
  assert.equal(isSupersededWorkerAttempt({ ...done, run_attempt: 2 }, [marker]), false);
});

test("known terminal health dispatch overhead does not turn a skipped claim into a verdict", () => {
  const done = { ...run, conclusion: "success" };
  const wake = { name: "Wake Main CI Health", status: "completed", conclusion: "success", steps: [
    { name: "Set up job", conclusion: "success" }, { name: "Dispatch Exact Worker Health", conclusion: "success" },
    { name: "Complete job", conclusion: "success" }] };
  assert.ok(isSupersededWorkerAttempt(done, [marker, wake]));
  assert.ok(isSupersededWorkerAttempt({ ...done, conclusion: "failure" }, [marker, { ...wake, conclusion: "failure" }]));
  assert.equal(isSupersededWorkerAttempt(done, [marker, wake, wake]), false);
  assert.equal(isSupersededWorkerAttempt(done, [marker, { ...wake, conclusion: null }]), false);
  assert.equal(isSupersededWorkerAttempt(done, [marker, { ...wake, steps: [...wake.steps, { name: "Unit Tests", conclusion: "success" }] }]), false);
  assert.equal(isSupersededWorkerAttempt({ ...done, run_attempt: 2 }, [marker, wake]), false);
});
