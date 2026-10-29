import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocated, analyze, cachedApi, category, collectOccupancy, combineOccupancy, dropCopiedJobs, main, mergeGroupCriticalWaits,
  modeledRequiredMinutes, options, parseScenario, projectJob, replay, runnerClass, runningAt, scenarios, timeline, withinWindow,
} from "./ci-runner-occupancy.mjs";
import { AGGREGATOR } from "./merge-queue-wait-report.mjs";

const repository = "example/project";
const at = (minute) => new Date(Date.UTC(2026, 9, 27, 12, 0) + minute * 60_000).toISOString();
const step = { conclusion: "success", started_at: at(0) };
const rawJob = (id, name, created, started, completed, extra = {}) => ({
  id, name, status: "completed", conclusion: "success", created_at: at(created), started_at: at(started), completed_at: at(completed),
  runner_id: 7, runner_group_name: "GitHub Actions", labels: ["ubuntu-24.04"], steps: [step], ...extra,
});
const rawRun = (id, extra = {}) => ({
  id, path: ".github/workflows/ci.yml", event: "merge_group", status: "completed", conclusion: "success",
  run_attempt: 1, created_at: at(0), head_branch: "gh-readonly-queue/main/pr-1-" + "a".repeat(40), ...extra,
});
const job = (runId, name, created, started, completed, extra = {}) =>
  projectJob(rawRun(runId, extra.run), { run_attempt: extra.attempt ?? 1, ...rawJob(extra.id ?? runId * 100 + created, name, created, started, completed, extra.job) });
const window = { since: at(0), until: at(60) };

test("a job held a runner only with a runner id or executed steps", () => {
  assert.equal(allocated(rawJob(1, "a", 0, 1, 5)), true);
  // Cancelled while queued: GitHub keeps a start placeholder but never assigned a runner.
  assert.equal(allocated(rawJob(1, "a", 0, 0, 8, { conclusion: "cancelled", runner_id: 0, steps: [] })), false);
  assert.equal(allocated(rawJob(1, "a", 0, 0, 8, { conclusion: "cancelled", runner_id: 0, steps: [{ conclusion: "skipped", started_at: at(0) }] })), false);
  assert.equal(allocated(rawJob(1, "a", 0, 0, 8, { conclusion: "cancelled", runner_id: 0 })), true);
  assert.equal(allocated(rawJob(1, "a", 0, 0, 0, { conclusion: "skipped" })), false);
  assert.equal(allocated(rawJob(1, "a", 0, null, null, { status: "queued", started_at: null, runner_id: 0, steps: [] })), false);
  assert.equal(allocated({ ...rawJob(1, "a", 0, 1, 5), status: "in_progress", completed_at: null, runner_id: 0, steps: [] }), true);
});

test("runner classes and categories come from labels and the workflow file", () => {
  assert.equal(runnerClass(["ubuntu-24.04"]), "linux");
  assert.equal(runnerClass(["windows-latest"]), "windows");
  assert.equal(runnerClass(["macos-15"]), "macos");
  assert.equal(runnerClass(["self-hosted", "linux"]), "self-hosted");
  assert.equal(runnerClass(["wollipog-release-finalizer"]), "other");
  assert.equal(runnerClass([]), "unknown");
  assert.equal(category({ path: ".github/workflows/main-rolling-validation.yml", event: "workflow_dispatch" }), "main-rolling-validation/workflow_dispatch");
  assert.equal(category({ path: "dynamic/dependabot/dependabot-updates", event: "dynamic" }), "dependabot-updates/dynamic");
});

test("projected jobs keep only API metadata", () => {
  const projected = job(1, "Browser End-to-End Tests (1)", 0, 2, 30, { job: { runner_name: "GitHub Actions 12", steps: [{ ...step, name: "secret step" }] } });
  assert.deepEqual(Object.keys(projected).sort(), ["allocated", "apiStartedAt", "attempt", "branch", "category", "completedAt", "conclusion",
    "createdAt", "event", "hosted", "jobId", "name", "pullRequest", "runId", "runnerClass", "status", "workflow"]);
  assert.equal(projected.hosted, true);
  assert.equal(job(1, "a", 0, 1, 2, { job: { runner_group_name: "Default" } }).hosted, false);
});

test("a rerun's copied jobs are counted once, at their original attempt", () => {
  const original = job(1, "Unit", 0, 1, 20, { id: 1 });
  const copy = job(1, "Unit", 40, 1, 20, { id: 2, attempt: 2 });
  const retried = job(1, "Browser", 40, 41, 60, { id: 3, attempt: 2 });
  const kept = dropCopiedJobs([copy, retried, original]);
  assert.deepEqual(kept.map((item) => item.jobId).sort(), [1, 3]);
});

test("the timeline counts running and queued jobs, clipped to the window", () => {
  const segments = timeline([
    job(1, "a", -10, 5, 20),
    job(1, "b", 0, 10, 30),
    job(2, "cancelled while queued", 15, 15, 25, { job: { conclusion: "cancelled", runner_id: 0, steps: [] } }),
    job(2, "skipped", 0, 0, 0, { job: { conclusion: "skipped" } }),
  ], at(0), at(60));
  assert.deepEqual(segments.map(([a, b, r, q]) => [(a - Date.parse(at(0))) / 60_000, (b - Date.parse(at(0))) / 60_000, r, q]), [
    [0, 5, 0, 2], [5, 10, 1, 1], [10, 15, 2, 0], [15, 20, 2, 1], [20, 25, 1, 1], [25, 30, 1, 0], [30, 60, 0, 0],
  ]);
  assert.equal(runningAt(segments, Date.parse(at(12))), 2);
  assert.equal(runningAt(segments, Date.parse(at(55))), 0);
});

test("analysis attributes runner minutes and waits per workflow and event, and measures saturation", () => {
  const report = {
    kind: "runner-occupancy", repository, since: window.since, until: window.until, collectedAt: at(70),
    runListingTruncated: false, jobListingsTruncated: 0, attemptsTruncated: 0,
    runs: [{ id: 1, category: "ci/merge_group", status: "completed", conclusion: "success", createdAt: at(0) },
      { id: 2, category: "ci/pull_request", status: "completed", conclusion: "success", createdAt: at(0) },
      { id: 3, category: "pr-ci-supersede/workflow_run", status: "completed", conclusion: "skipped", createdAt: at(0) }],
    jobs: [
      job(1, "Unit", 0, 0, 20),
      job(1, "Browser", 0, 10, 40),
      job(2, "Unit", 0, 0, 30, { run: { event: "pull_request" } }),
    ],
  };
  report.jobs[2].category = "ci/pull_request";
  const result = analyze(report, { ceiling: 2, longWaitMinutes: 5 });
  assert.equal(result.totalRunnerMinutes, 80);
  assert.equal(result.categories["ci/merge_group"].runnerMinutes, 50);
  assert.equal(result.categories["ci/merge_group"].runnerWait.max, 10);
  assert.equal(result.categories["ci/pull_request"].share, 30 / 80);
  assert.equal(result.categories["pr-ci-supersede/workflow_run"].skippedRuns, 1);
  // 0-10: two running and Browser queued at the ceiling; 10-20: three running.
  assert.equal(result.occupancy.peakRunning, 3);
  assert.equal(result.occupancy.peakDemand, 3);
  assert.equal(result.occupancy.queuedJobMinutes, 10);
  assert.equal(result.occupancy.queuedNearCeilingShare, 1);
  assert.equal(result.longWaits.jobs, 1);
  assert.equal(result.longWaits.runningAtCreation.median, 2);
  assert.equal(result.days["2026-10-27"]["ci/merge_group"], 50);
  assert.equal(result.hours[12].peakRunning, 3);
});

test("merge-group critical-path waits follow the merge-queue report's dependency model", () => {
  const runs = [{ id: 9, createdAt: at(0) }];
  const jobs = [
    job(9, "Typecheck, Unit Tests & Bundles", 0, 1, 20),
    job(9, "Browser End-to-End Tests (3)", 0, 40, 58),
    job(9, AGGREGATOR, 58, 62, 63),
    job(9, "Browser End-to-End Tests (3)", 70, 71, 80, { id: 5, attempt: 2 }),
  ];
  const result = mergeGroupCriticalWaits(jobs, runs);
  assert.equal(result.measured, 1);
  assert.deepEqual(Object.keys(result.jobs).sort(), [AGGREGATOR, "Browser End-to-End Tests (3)"].sort());
  assert.equal(result.jobs["Browser End-to-End Tests (3)"].runnerWait.median, 40);
  assert.equal(result.jobs[AGGREGATOR].runnerWait.median, 4);
});

test("a sub-window keeps earlier runs occupying runners but attributes only its own runs", () => {
  const report = combineOccupancy([{ kind: "runner-occupancy", repository, since: at(-60), until: at(60), collectedAt: at(70),
    runListingTruncated: false, jobListingsTruncated: 0, attemptsTruncated: 0,
    runs: [{ id: 1, category: "ci/merge_group", status: "completed", createdAt: at(-30) },
      { id: 2, category: "ci/merge_group", status: "completed", createdAt: at(5) }],
    jobs: [job(1, "Browser", -30, -20, 30), job(2, "Unit", 5, 10, 20)] }]);
  const result = analyze(withinWindow(report, { since: at(0), until: at(60) }));
  assert.equal(result.completeness.runs, 1);
  assert.equal(result.totalRunnerMinutes, 10);
  assert.equal(result.occupancy.peakRunning, 2);
  assert.throws(() => withinWindow(report, { since: at(-120), until: at(0) }), /inside the collected windows/);
  const split = analyze(withinWindow(report, [{ since: at(-40), until: at(-20) }, { since: at(0), until: at(60) }]));
  assert.equal(split.completeness.runs, 2);
  assert.equal(split.occupancy.observedMinutes, 80);
  assert.throws(() => withinWindow(report, [{ since: at(0), until: at(30) }, { since: at(20), until: at(40) }]), /nonoverlapping/);
});

test("combining collections deduplicates shared-boundary runs and jobs", () => {
  const first = { kind: "runner-occupancy", repository, since: at(0), until: at(30), collectedAt: at(31),
    runListingTruncated: false, jobListingsTruncated: 0, attemptsTruncated: 0,
    runs: [{ id: 1 }], jobs: [job(1, "a", 0, 1, 2, { id: 11 })] };
  const second = { ...first, since: at(30), until: at(60), collectedAt: at(61), runs: [{ id: 1 }, { id: 2 }],
    jobs: [job(1, "a", 0, 1, 2, { id: 11 }), job(2, "b", 30, 31, 32, { id: 12 })] };
  const combined = combineOccupancy([second, first]);
  assert.equal(combined.runs.length, 2);
  assert.equal(combined.jobs.length, 2);
  assert.equal(combined.since, at(0));
  assert.equal(combined.until, at(60));
  assert.throws(() => combineOccupancy([first, { ...second, repository: "other/repo" }]), /one repository/);
});

test("collection lists runs in slices, skips all-skipped runs and reads every attempt's jobs", async () => {
  const calls = [];
  const runs = [rawRun(1), rawRun(2, { conclusion: "skipped" }), rawRun(3, { run_attempt: 2 }),
    rawRun(4, { created_at: at(60 * 7) })];
  const api = async (path) => {
    calls.push(path);
    if (path.includes("/actions/runs?")) {
      const range = decodeURIComponent(/created=([^&]+)/.exec(path)[1]).split("..");
      const listed = runs.filter((run) => run.created_at >= range[0] && run.created_at <= range[1]);
      return { total_count: listed.length, workflow_runs: listed };
    }
    const [, id, attempt] = /runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(path);
    return { total_count: 1, jobs: [rawJob(Number(id) * 10 + Number(attempt), "Unit", 0, 1, 5)] };
  };
  const report = await collectOccupancy(api, { repository, since: at(0), until: at(60 * 7) });
  assert.equal(calls.filter((path) => path.includes("/actions/runs?")).length, 2);
  assert.deepEqual(report.runs.map((run) => run.id), [1, 2, 3]);
  assert.deepEqual(report.jobs.map((item) => [item.runId, item.attempt]), [[1, 1], [3, 1], [3, 2]]);
  assert.equal(calls.some((path) => path.includes("runs/2/")), false);
});

test("the cache serves settled responses, refetches unsettled ones and stops at the rate-limit floor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let remaining = 5000, fetched = 0;
  const api = async (path) => {
    if (path === "/rate_limit") return { resources: { core: { remaining }, graphql: { remaining: 5000 } } };
    fetched++;
    return path === "/live" ? { workflow_runs: [{ status: "in_progress" }] } : { workflow_runs: [{ status: "completed" }] };
  };
  const cached = cachedApi(api, dir, { floor: 1000, checkEvery: 3 });
  await cached("/done");
  await cached("/done");
  await cached("/live");
  await cached("/live");
  assert.equal(fetched, 3);
  assert.equal((await readdir(dir)).length, 1);
  remaining = 999;
  await assert.rejects(cached("/other"), /budget floor 1000 reached after 3 calls/);
  assert.equal(fetched, 3);
  assert.deepEqual(await cached("/done"), { workflow_runs: [{ status: "completed" }] });
});

test("the wrapper's own calls never take a quota below the floor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-floor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let remaining = 1003;
  const api = async (path) => path === "/rate_limit"
    ? { resources: { core: { remaining }, graphql: { remaining: 5000 } } }
    : (remaining--, { status: "completed" });
  const cached = cachedApi(api, dir, { floor: 1000 });
  let served = 0;
  await assert.rejects(async () => {
    for (let i = 0; i < 10; i++, served++) await cached(`/item/${i}`);
  }, /budget floor 1000 reached after 3 calls/);
  assert.equal(served, 3);
  assert.equal(remaining, 1000);
});

test("concurrent callers share one quota refresh and cannot jointly cross the floor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let remaining = 1002, reads = 0;
  const api = async (path) => {
    if (path === "/rate_limit") {
      reads++;
      const snapshot = remaining;
      await new Promise((resolve) => setImmediate(resolve));
      return { resources: { core: { remaining: snapshot }, graphql: { remaining: 5000 } } };
    }
    await new Promise((resolve) => setImmediate(resolve));
    remaining--;
    return { status: "completed" };
  };
  const cached = cachedApi(api, dir, { floor: 1000 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => cached(`/item/${i}`)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(remaining, 1000);
  assert.ok(reads <= 3);
});

test("a quota read that started before a call finished does not count that call as spent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-stale-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The quota snapshot is taken when the read starts and returned later; data calls spend at once.
  let remaining = 1001;
  const api = async (path) => {
    if (path === "/rate_limit") {
      const snapshot = remaining;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { resources: { core: { remaining: snapshot }, graphql: { remaining: 5000 } } };
    }
    remaining--;
    return { status: "completed" };
  };
  const cached = cachedApi(api, dir, { floor: 1000 });
  await Promise.allSettled(Array.from({ length: 4 }, (_, i) => cached(`/item/${i}`)));
  assert.equal(remaining, 1000);
});

test("combining refreshed snapshots of the same hours counts their time once", () => {
  const report = { kind: "runner-occupancy", repository, since: at(0), until: at(60), collectedAt: at(70),
    runListingTruncated: false, jobListingsTruncated: 0, attemptsTruncated: 0, runs: [], jobs: [job(1, "a", 0, 10, 20, { id: 1 })] };
  const twice = combineOccupancy([report, { ...report, collectedAt: at(80) }]);
  assert.deepEqual(twice.windows, [{ since: at(0), until: at(60) }]);
  assert.equal(analyze(twice).occupancy.observedMinutes, 60);
  assert.equal(analyze(twice).occupancy.queuedJobMinutes, 10);
  const partial = combineOccupancy([report, { ...report, since: at(30), until: at(90), collectedAt: at(95) }]);
  assert.deepEqual(partial.windows, [{ since: at(0), until: at(90) }]);
  assert.equal(analyze(partial).occupancy.observedMinutes, 90);
});

test("options require a repository and cache to collect, and nothing to analyze offline", () => {
  assert.throws(() => options(["--since", at(0), "--until", at(1)]), /--repo/);
  assert.throws(() => options(["--repo", repository, "--since", at(0), "--until", at(1)]), /--cache/);
  assert.throws(() => options(["--repo", repository, "--cache", "c", "--since", at(1), "--until", at(0)]), /ordered/);
  assert.deepEqual(options(["--input", "a.json"]), { input: ["a.json"], json: false, ceiling: 20, scenarios: [] });
  assert.equal(options(["--input", "a.json", "--scenario", "capacity=60"]).scenarios[0].capacity, 60);
  assert.throws(() => options(["--input", "a.json", "--since", at(0)]), /go together/);
  assert.equal(options(["--input", "a.json", "--since", at(0), "--until", at(1)]).windows[0].until, at(1));
  assert.equal(options(["--input", "a.json", "--window", `${at(0)}..${at(1)}`, "--window", `${at(2)}..${at(3)}`]).windows.length, 2);
  assert.throws(() => options(["--input", "a.json", "--window", at(0)]), /--window/);
  assert.throws(() => options(["--input", "a.json", "--ceiling", "0"]), /--ceiling/);
});

test("collection needs a token and never prints an API error body", async () => {
  const errors = [];
  assert.equal(await main(["--repo", repository, "--cache", "unused", "--since", at(0), "--until", at(1)],
    { env: {}, out: () => {}, err: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /GITHUB_TOKEN/);
});

test("replay serves waiting jobs first-come first-served on the modeled slots", () => {
  const jobs = [job(1, "a", 0, 0, 10, { id: 1 }), job(1, "b", 0, 0, 10, { id: 2 }), job(1, "c", 0, 30, 40, { id: 3 }),
    job(1, "never ran", 0, 0, 5, { id: 4, job: { conclusion: "cancelled", runner_id: 0, steps: [] } })];
  assert.deepEqual([...replay(jobs, { capacity: 2 })].sort(), [[1, 0], [2, 0], [3, 10]]);
  assert.deepEqual([...replay(jobs, { capacity: 3 })].sort(), [[1, 0], [2, 0], [3, 0]]);
});

test("replay can prioritise one category and drop modeled demand", () => {
  const pr = (id, created) => ({ ...job(1, "pr", created, created, created + 10, { id }), category: "ci/pull_request" });
  const group = { ...job(2, "group", 2, 2, 12, { id: 3 }), category: "ci/merge_group" };
  const jobs = [pr(1, 0), pr(2, 1), group];
  assert.deepEqual([...replay(jobs, { capacity: 1 })].sort(), [[1, 0], [2, 9], [3, 18]]);
  assert.deepEqual([...replay(jobs, { capacity: 1, priority: "ci/merge_group" })].sort(), [[1, 0], [2, 19], [3, 8]]);
  assert.deepEqual([...replay(jobs, { capacity: 1, drop: /^ci\/pull_request\|/ })], [[3, 0]]);
});

test("replay caps one run's matching jobs as a matrix max-parallel would", () => {
  const shard = (id) => ({ ...job(1, `Browser End-to-End Tests (${id})`, 0, 0, 10, { id }), category: "ci/pull_request" });
  const other = { ...job(2, "Unit", 0, 0, 10, { id: 9 }), category: "ci/merge_group" };
  const jobs = [shard(1), shard(2), shard(3), other];
  const limit = parseScenario("capacity=10,limit=2:^ci/pull_request\\|Browser").limit;
  assert.deepEqual([...replay(jobs, { capacity: 10, limit })].sort((a, b) => a[0] - b[0]), [[1, 0], [2, 0], [3, 10], [9, 0]]);
  // A blocked limited job does not hold back eligible work behind it.
  assert.deepEqual([...replay(jobs, { capacity: 3, limit })].sort((a, b) => a[0] - b[0]), [[1, 0], [2, 0], [3, 10], [9, 0]]);
});

test("scenarios replace critical-path waits to model merge-group latency", () => {
  const runs = [{ id: 9, createdAt: at(0) }];
  const jobs = [job(9, "Typecheck, Unit Tests & Bundles", 0, 1, 20, { id: 1 }), job(9, "Browser End-to-End Tests (3)", 0, 40, 58, { id: 2 }),
    job(9, AGGREGATOR, 58, 62, 63, { id: 3 })];
  const [result] = scenarios(jobs, jobs, runs, [parseScenario("capacity=10")]);
  assert.equal(result.mergeGroupRequired.observed.median, 63);
  // With free slots unit/build (19 minutes) now finishes after the browser job (18), and the
  // aggregator, created when its last dependency finishes, adds its 1 minute.
  assert.equal(result.mergeGroupRequired.modeled.median, 20);
  assert.equal(result.mergeGroupRequired.overSixty.observed, 1);
  assert.equal(result.mergeGroupRequired.overSixty.modeled, 0);
});

test("modeled latency waits for every required branch, not only the observed critical one", () => {
  const runs = [{ id: 9, createdAt: at(0) }];
  // The browser job ended the observed critical path only because it waited 50 minutes.
  const jobs = [job(9, "Typecheck, Unit Tests & Bundles", 0, 0, 40, { id: 1 }), job(9, "Browser End-to-End Tests (3)", 0, 50, 51, { id: 2 }),
    job(9, AGGREGATOR, 51, 51, 52, { id: 3 })];
  const [result] = scenarios(jobs, jobs, runs, [parseScenario("capacity=10")]);
  assert.equal(result.mergeGroupRequired.observed.median, 52);
  assert.equal(result.mergeGroupRequired.modeled.median, 41);
  // A called workflow's later job is created when its own earlier job finishes.
  const called = [job(9, "Typecheck, Unit Tests & Bundles", 0, 0, 5, { id: 1 }),
    job(9, "Settings-Rows win32 Baselines / Detect Settings-Rows Changes", 0, 20, 21, { id: 4 }),
    job(9, "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", 21, 60, 70, { id: 5 }),
    job(9, AGGREGATOR, 70, 70, 71, { id: 3 })];
  const [modeled] = scenarios(called, called, runs, [parseScenario("capacity=10")]);
  assert.equal(modeled.mergeGroupRequired.modeled.median, 12);
});

test("short jobs within the creation slack cannot form a dependency cycle", () => {
  const second = (s) => new Date(Date.UTC(2026, 9, 27) + s * 1000).toISOString();
  const short = (jobId, name, c, st, e) => ({ jobId, name, conclusion: "success", createdAt: second(c), apiStartedAt: second(st), completedAt: second(e) });
  const jobs = [short(1, "Settings-Rows win32 Baselines / Detect Settings-Rows Changes", 10, 10, 11),
    short(2, "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", 11, 11, 12), short(3, AGGREGATOR, 12, 12, 13)];
  assert.equal(modeledRequiredMinutes(second(0), jobs, new Map([[1, 0], [2, 0], [3, 0]])), 13 / 60);
});

test("scenario specs are validated", () => {
  assert.deepEqual({ ...parseScenario("capacity=20,priority=ci/merge_group"), drop: null },
    { label: "capacity=20,priority=ci/merge_group", capacity: 20, priority: "ci/merge_group", drop: null, limit: null });
  assert.equal(parseScenario("capacity=20,drop=^ci/push").drop.source, "^ci\\/push");
  assert.throws(() => parseScenario("capacity=0"), /Unreadable scenario/);
  assert.throws(() => parseScenario("capacity=20,speed=2"), /Unreadable scenario/);
  assert.throws(() => parseScenario("capacity=20,drop=("), /scenario pattern/);
  assert.equal(parseScenario("capacity=20,limit=2:^ci/pull_request\\|Browser").limit.count, 2);
  assert.throws(() => parseScenario("capacity=20,limit=0:x"), /Unreadable scenario/);
});
