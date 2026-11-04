import assert from "node:assert/strict";
import test from "node:test";
import { FINALIZER_JOB, NATIVE_RELEASE_JOBS, readReleaseTimings, releaseTimings } from "./release-timings.mjs";
const run = () => ({ id: 123, run_attempt: 1, status: "completed", conclusion: "success", event: "push", head_branch: "v0.34.0", head_sha: "a".repeat(40), path: ".github/workflows/release.yml", repository: { full_name: "example/project" } });
const jobs = () => [...NATIVE_RELEASE_JOBS, FINALIZER_JOB].map((name, i) => ({
  id: i + 1, name, status: "completed", conclusion: "success",
  created_at: i === 6 ? "2026-10-19T23:26:09Z" : "2026-10-19T22:47:09Z",
  started_at: i === 6 ? "2026-10-19T23:56:22Z" : "2026-10-19T23:06:49Z",
  completed_at: i === 6 ? "2026-10-19T23:57:29Z" : "2026-10-19T23:26:09Z",
}));
test("release measurements distinguish finalization wait from actual execution", () => {
  const report = releaseTimings(run(), jobs());
  assert.equal(report.finalizationStartDelaySeconds, 1813);
  assert.equal(report.jobs.at(-1).queueSeconds, 1813);
  assert.equal(report.jobs.at(-1).executionSeconds, 67);
  assert.equal(report.withinFiveMinutes, false);
  assert.equal(report.naturalStableSuccess, true);
});
test("dispatches, reruns, prereleases, and failures do not satisfy stable release evidence", () => {
  for (const change of [{ event: "workflow_dispatch" }, { run_attempt: 2 }, { head_branch: "v0.35.0-rc.1" }, { conclusion: "failure" }])
    assert.equal(releaseTimings({ ...run(), ...change }, jobs()).naturalStableSuccess, false);
  const failed = jobs(); failed[0].conclusion = "failure";
  assert.equal(releaseTimings(run(), failed).naturalStableSuccess, false);
});
test("incomplete or ambiguous native/finalizer timings cannot manufacture success", () => {
  for (const edit of [
    (j) => j.pop(), (j) => j.push(j[0]), (j) => { j[0].completed_at = null; },
    (j) => { j[0].started_at = "2026-10-19T21:00:00Z"; },
    (j) => { j[6].created_at = "2026-10-19T20:00:00Z"; },
  ]) { const j = jobs(); edit(j); assert.throws(() => releaseTimings(run(), j)); }
});
test("the reader binds pagination to the exact release attempt", () => {
  const paths = [];
  const result = readReleaseTimings("example/project", 123, (args) => {
    paths.push(args[1]);
    return paths.length === 1 ? run() : { total_count: 7, jobs: paths.length === 2 ? jobs().slice(0, 3) : jobs().slice(3) };
  });
  assert.equal(result.jobs.length, 7);
  assert.equal(paths[2], "repos/example/project/actions/runs/123/attempts/1/jobs?per_page=100&page=2");
  assert.throws(() => readReleaseTimings("example/project", 123, () => ({ ...run(), path: "other" })));
});
