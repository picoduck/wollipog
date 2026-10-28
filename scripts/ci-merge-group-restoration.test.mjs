import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHECK_STEPS, COVERAGE, FULL_JOBS, MAX_RUNS, REQUIRED_CONTEXT, certifyRun, main, observeRestoration,
  verifyRestoration } from "./ci-merge-group-restoration.mjs";
import { planRollback } from "./main-merge-admission-controller.mjs";

const repository = "owner/repo";
const since = "2026-10-27T12:00:00Z";
const step = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
// Shaped like a real merge-group attempt listing, including skipped and advisory jobs.
function fullRun(id, createdAt = "2026-10-27T13:00:00Z", headSha = "d".repeat(40)) {
  const run = { id, run_attempt: 1, event: "merge_group", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success",
    repository: { full_name: repository }, head_branch: `gh-readonly-queue/main/pr-1-${"a".repeat(40)}`, head_sha: headSha, created_at: createdAt };
  const job = (name, steps, conclusion = "success") => ({ name, run_id: id, run_attempt: 1, status: "completed", conclusion, steps });
  const jobs = [
    job("PR Suite Routing", [], "skipped"),
    job("Typecheck, Unit Tests & Bundles", CHECK_STEPS.map((name) => step(name))),
    ...[1, 2, 3, 4, 5].map((shard) => job(`Browser End-to-End Tests (${shard})`, [step("Remote-Instance Browser End-to-End Tests"),
      step("Rendered Production Browser Smoke", shard === 1 ? "success" : "skipped")])),
    job("WebKit End-to-End Tests", [step("WebKit Browser End-to-End Tests")]),
    job("Settings-Rows win32 Baselines / Detect Settings-Rows Changes", [step("Compare the Diff Against the Settings-Rows Paths")]),
    job("Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", [], "skipped"),
    job("Suite Selection Shadow (Advisory)", [step("Compute Trusted Suite Selection")]),
    job(REQUIRED_CONTEXT, [step("Require Every Job to Have Succeeded")]),
    job("Regression Admission Shadow (Advisory)", [], "skipped"),
  ];
  return { run, listing: { total_count: jobs.length, jobs } };
}
const edit = (fixture, change) => {
  const copy = structuredClone(fixture);
  change(copy);
  copy.listing.total_count = copy.listing.jobs.length;
  return copy;
};
const named = (fixture, name) => fixture.listing.jobs.find((job) => job.name === name);

test("the verifier's job inventory is the rolling full inventory and its steps exist in ci.yml", () => {
  assert.equal(FULL_JOBS.length, 10);
  assert.ok(FULL_JOBS.includes(REQUIRED_CONTEXT));
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  for (const name of [...CHECK_STEPS, "Remote-Instance Browser End-to-End Tests", "Rendered Production Browser Smoke",
    "WebKit Browser End-to-End Tests", "Require Every Job to Have Succeeded", "Record Reduced Merge Group Coverage"]) {
    assert.ok(workflow.includes(`      - name: ${name}\n`), name);
  }
  assert.match(workflow, /^  merge_group_gate:\n(?:    .*\n)*?    name: Merge Group Gate$/m);
});

test("a complete successful merge group with the gate absent or skipped is certified full", () => {
  const fixture = fullRun(11);
  assert.deepEqual(certifyRun(repository, fixture.run, fixture.listing), []);
  const skipped = edit(fixture, (copy) => copy.listing.jobs.push({ name: "Merge Group Gate", run_id: 11, run_attempt: 1,
    status: "completed", conclusion: "skipped", steps: [] }));
  assert.deepEqual(certifyRun(repository, skipped.run, skipped.listing), []);
  const compared = edit(fixture, (copy) => Object.assign(named(copy, "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines"),
    { conclusion: "success", steps: [step("Compare Against the Committed win32 Baselines")] }));
  assert.deepEqual(certifyRun(repository, compared.run, compared.listing), []);
});

test("reduced, partial, unfinished, gate-active or mis-identified runs are never certified", () => {
  const fixture = fullRun(12);
  const refuse = (change, reason) => {
    const copy = edit(fixture, change);
    assert.ok(certifyRun(repository, copy.run, copy.listing).includes(reason), reason);
  };
  // A reduced group runs one browser leg; an extra or renamed leg is not the five-shard envelope either.
  refuse((copy) => { copy.listing.jobs = copy.listing.jobs.filter((job) => !/\([2-5]\)$/.test(job.name)); }, "browser-shards-incomplete");
  refuse((copy) => copy.listing.jobs.push({ ...named(copy, "Browser End-to-End Tests (5)"), name: "Browser End-to-End Tests (6)" }), "browser-shards-incomplete");
  refuse((copy) => { named(copy, "Browser End-to-End Tests (3)").conclusion = "cancelled"; }, "job-not-successful:Browser End-to-End Tests (3)");
  refuse((copy) => { named(copy, "WebKit End-to-End Tests").status = "in_progress"; }, "job-not-successful:WebKit End-to-End Tests");
  refuse((copy) => { copy.listing.jobs = copy.listing.jobs.filter((job) => job.name !== "WebKit End-to-End Tests"); }, "job-missing:WebKit End-to-End Tests");
  refuse((copy) => copy.listing.jobs.push(named(copy, "WebKit End-to-End Tests")), "job-missing:WebKit End-to-End Tests");
  refuse((copy) => { named(copy, "Settings-Rows win32 Baselines / Detect Settings-Rows Changes").conclusion = "skipped"; },
    "job-not-successful:Settings-Rows win32 Baselines / Detect Settings-Rows Changes");
  refuse((copy) => { named(copy, "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines").conclusion = "failure"; },
    "job-not-successful:Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines");
  for (const name of CHECK_STEPS) {
    refuse((copy) => { named(copy, "Typecheck, Unit Tests & Bundles").steps.find((item) => item.name === name).conclusion = "skipped"; },
      `step-not-successful:Typecheck, Unit Tests & Bundles/${name}`);
  }
  refuse((copy) => { named(copy, "Browser End-to-End Tests (1)").steps[1].conclusion = "skipped"; },
    "step-not-successful:Browser End-to-End Tests (1)/Rendered Production Browser Smoke");
  refuse((copy) => { named(copy, REQUIRED_CONTEXT).steps = []; }, `step-not-successful:${REQUIRED_CONTEXT}/Require Every Job to Have Succeeded`);
  // Restoration requires the gate switched off, even when an active gate happened to select full.
  for (const [conclusion, steps] of [["success", [step("Record Full Merge Group Coverage"), step("Record Reduced Merge Group Coverage", "skipped")]],
    ["success", [step("Record Full Merge Group Coverage", "skipped"), step("Record Reduced Merge Group Coverage")]], ["failure", []]]) {
    refuse((copy) => copy.listing.jobs.push({ name: "Merge Group Gate", run_id: 12, run_attempt: 1, status: "completed", conclusion, steps }),
      "merge-group-gate-active");
  }
  refuse((copy) => named(copy, "Browser End-to-End Tests (1)").steps.push(step("Record Reduced Merge Group Coverage")), "reduced-coverage-recorded");
  refuse((copy) => { copy.run.conclusion = "failure"; }, "run-not-successful");
  refuse((copy) => { copy.run.status = "in_progress"; }, "run-not-successful");
  for (const field of [["event", "pull_request"], ["path", ".github/workflows/other.yml"], ["head_branch", "main"], ["head_sha", "short"],
    ["repository", { full_name: "other/repo" }], ["run_attempt", 0]]) {
    refuse((copy) => { copy.run[field[0]] = field[1]; }, "run-identity-unavailable");
  }
  for (const change of [(copy) => { copy.listing.total_count += 1; }, (copy) => { copy.listing.jobs[0].run_attempt = 2; },
    (copy) => { copy.listing.jobs[0].run_id = 99; }, (copy) => { copy.listing = null; }]) {
    const copy = structuredClone(fixture);
    change(copy);
    assert.ok(certifyRun(repository, copy.run, copy.listing).includes("job-listing-incomplete"));
  }
});

test("the newest completed runs after the switch-back must all be certified, and the proof satisfies planRollback", () => {
  const newest = fullRun(21, "2026-10-27T14:00:00Z", "e".repeat(40)), older = fullRun(20, "2026-10-27T13:00:00Z");
  const before = fullRun(19, "2026-10-27T11:59:59Z");
  const running = { ...fullRun(22, "2026-10-27T15:00:00Z").run, status: "in_progress", conclusion: null };
  const listing = { workflow_runs: [before.run, older.run, running, newest.run] };
  const jobsByRun = { 19: before.listing, 20: older.listing, 21: newest.listing };
  const proof = verifyRestoration({ repository, since, count: 2, listing, jobsByRun });
  assert.equal(proof.verified, true);
  assert.deepEqual(proof.runs.map((run) => run.runId), [21, 20]);
  assert.equal(proof.workflowSha, "e".repeat(40));
  assert.equal(proof.coverage, COVERAGE);
  const restored = planRollback({ repository, fullQueueProof: proof });
  assert.equal(restored.decision, "operator-hold-removal-approval-required");
  assert.equal(restored.holdRetained, true);
  // Only runs created at/after the switch-back count; in-progress runs are not evidence.
  assert.deepEqual(verifyRestoration({ repository, since, count: 3, listing, jobsByRun }).reasons, ["insufficient-completed-merge-group-runs"]);
  const failed = edit(newest, (copy) => { copy.run.conclusion = "failure"; });
  const refused = verifyRestoration({ repository, since, count: 2, listing: { workflow_runs: [failed.run, older.run] }, jobsByRun });
  assert.equal(refused.verified, false);
  assert.deepEqual(refused.reasons, ["run-not-certified-full"]);
  assert.equal(refused.workflowSha, null);
  assert.equal(planRollback({ repository, fullQueueProof: refused }).decision, "restore-full-queue-validation-first");
  assert.ok(verifyRestoration({ repository, since, listing, jobsByRun: {} }).runs[0].reasons.includes("job-listing-incomplete"));
  for (const [options, reason] of [[{ repository: "bad" }, "repository-unavailable"], [{ since: "yesterday" }, "since-unavailable"],
    [{ count: 0 }, "count-out-of-range"], [{ count: MAX_RUNS + 1 }, "count-out-of-range"], [{ listing: {} }, "run-listing-unavailable"]]) {
    const result = verifyRestoration({ repository, since, listing, jobsByRun, ...options });
    assert.equal(result.verified, false);
    assert.ok(result.reasons.includes(reason), reason);
    assert.deepEqual(result.runs, []);
  }
});

test("live verification is read-only and bounded to one listing plus one job read per selected run", async () => {
  const newest = fullRun(31, "2026-10-27T14:00:00Z"), older = fullRun(30, "2026-10-27T13:00:00Z");
  const reads = [];
  const api = async (path, options) => {
    assert.equal(options, undefined, "GET only");
    reads.push(path);
    if (path.includes("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [older.run, newest.run] };
    return path.includes("/runs/31/") ? newest.listing : older.listing;
  };
  const proof = await observeRestoration({ repository, since, count: 2, api });
  assert.equal(proof.verified, true);
  assert.deepEqual(reads, [
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&status=completed&created=%3E%3D2026-10-27T12%3A00%3A00Z&per_page=12`,
    `/repos/${repository}/actions/runs/31/attempts/1/jobs?per_page=100`,
    `/repos/${repository}/actions/runs/30/attempts/1/jobs?per_page=100`,
  ]);
});

test("the CLI verifies fixtures offline, refuses live use without a token and reports read failures as unverified", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-merge-group-restoration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = fullRun(41);
  const file = join(dir, "fixture.json");
  writeFileSync(file, JSON.stringify({ listing: { workflow_runs: [fixture.run] }, jobsByRun: { 41: fixture.listing } }));
  const lines = [], errors = [];
  const run = (argv, options = {}) => main(argv, { env: {}, log: (line) => lines.push(line), error: (line) => errors.push(line), ...options });
  assert.equal(await run(["--repository", repository, "--since", since, "--fixture", file]), 0);
  assert.equal(JSON.parse(lines.at(-1)).verified, true);
  assert.equal(await run(["--repository", repository, "--since", "2026-10-28T00:00:00Z", "--fixture", file]), 1);
  assert.equal(await run(["--repository", repository, "--since", since]), 2);
  assert.match(errors.at(-1), /GITHUB_TOKEN is required/);
  assert.equal(await run(["--unknown"]), 2);
  // Invalid arguments refuse before any live read.
  assert.equal(await run(["--repository", repository, "--since", "nonsense"], { api: () => { throw new Error("must not read"); } }), 1);
  assert.equal(await run(["--repository", repository, "--since", since], { api: async () => { throw new Error("503"); } }), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)).reasons, ["github-read-unavailable"]);
});
