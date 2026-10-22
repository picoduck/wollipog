import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyTimingContext, attemptRecord, combineReports, collectEvents, eventSummary, listJobs, outcome, queueHistory, readTimingLog,
  AGGREGATOR, collect, listRemovals, main, markdown, MAX_PAGES, options, pullRequestOf, quantile, runMetrics, summarize,
} from "./merge-queue-wait-report.mjs";

const repository = "example/project";
const branch = (n) => `gh-readonly-queue/main/pr-${n}-${"c".repeat(40)}`;
const at = (minute) => new Date(Date.UTC(2026, 9, 6, 17, 0) + minute * 60_000).toISOString();
const job = (name, created, started, completed, conclusion = "success") => ({
  name, conclusion, created_at: at(created), started_at: started === null ? null : at(started), completed_at: completed === null ? null : at(completed),
});
const run = (id, n, completed = 60) => ({
  id, run_attempt: 1, event: "merge_group", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success",
  head_branch: branch(n), created_at: at(0), updated_at: at(completed),
});

test("queue branches name their pull request", () => {
  assert.equal(pullRequestOf(branch(2701)), 2701);
  assert.equal(pullRequestOf("main"), null);
  assert.equal(pullRequestOf(undefined), null);
});

test("a run's required result splits into critical-path waiting and executing", () => {
  // Shaped like #2701's second group: a shard waits 40 minutes, runs 18, then the aggregator
  // waits for a runner after its dependencies finish.
  const metrics = runMetrics(run(1, 2701, 63), [
    job("Typecheck, Unit Tests & Bundles", 0, 2, 20),
    job("Browser End-to-End Tests (3)", 0, 40, 58),
    job("Settings-Rows win32 Baselines / Compare", 1, 1, 1, "skipped"),
    job(AGGREGATOR, 58, 62, 63),
  ]);
  assert.equal(metrics.pullRequest, 2701);
  assert.equal(metrics.requiredMinutes, 63);
  assert.equal(metrics.criticalExecutionMinutes, 19);
  assert.equal(metrics.criticalWaitMinutes, 44);
  assert.equal(metrics.longestJobWaitMinutes, 40);
  assert.equal(metrics.longestExecutionMinutes, 18);
  assert.equal(metrics.aggregatorWaitMinutes, 4);
  assert.equal(metrics.wallMinutes, 63);
  assert.equal(metrics.aggregatorRan, true);
});

test("a dependency chain's sequential execution is not counted as waiting (#3343 review)", () => {
  // Settings-rows comparison depends on change detection; neither waited for a runner.
  const metrics = runMetrics(run(3, 1, 16), [
    job("Browser End-to-End Tests (1)", 0, 0, 12),
    job("Settings-Rows win32 Baselines / Detect Settings-Rows Changes", 0, 0, 5),
    job("Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", 5, 5, 15),
    job(AGGREGATOR, 15, 15, 16),
  ]);
  assert.equal(metrics.criticalExecutionMinutes, 16);
  assert.equal(metrics.criticalWaitMinutes, 0);
  // The same chain, where the comparison waited three minutes for a runner.
  const waited = runMetrics(run(4, 1, 19), [
    job("Settings-Rows win32 Baselines / Detect Settings-Rows Changes", 0, 0, 5),
    job("Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", 5, 8, 18),
    job(AGGREGATOR, 18, 18, 19),
  ]);
  assert.equal(waited.criticalWaitMinutes, 3);
});

test("a parallel job finishing as a dependency does is never taken for that dependency (#3343 review)", () => {
  const second = (s) => new Date(Date.UTC(2026, 9, 16) + s * 1000).toISOString();
  const timed = (name, created, started, completed) => ({
    name, conclusion: "success", created_at: second(created), started_at: second(started), completed_at: second(completed),
  });
  // A shard finishes three seconds after change detection; the comparison needs only detection.
  const metrics = runMetrics({ id: 5, run_attempt: 1, head_branch: branch(1), created_at: second(0) }, [
    timed("Browser End-to-End Tests (1)", 0, 0, 603),
    timed("Settings-Rows win32 Baselines / Detect Settings-Rows Changes", 0, 540, 600),
    timed("Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", 600, 600, 900),
    timed(AGGREGATOR, 900, 900, 960),
  ]);
  assert.equal(metrics.criticalExecutionMinutes, 7);
  assert.equal(metrics.criticalWaitMinutes, 9);
});

test("a late job with no known dependency leaves the split unmeasured rather than guessed", () => {
  const metrics = runMetrics(run(6, 1, 30), [
    job("Browser End-to-End Tests (1)", 0, 0, 10),
    job("Typecheck, Unit Tests & Bundles", 10, 12, 28),
    job(AGGREGATOR, 28, 29, 30),
  ]);
  assert.equal(metrics.requiredMinutes, 30);
  assert.equal(metrics.criticalExecutionMinutes, null);
  assert.equal(metrics.criticalWaitMinutes, null);
  assert.equal(summarize([metrics], [], 120).criticalPathUnmeasured, 1);
});

test("the assumed dependency structure matches the CI workflow files", () => {
  // Only the aggregator has needs in ci.yml, and the settings-rows call is the only called workflow,
  // whose comparison needs only its change detection.
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.deepEqual(ci.match(/^\s+needs:.*$/gm).map((line) => line.trim()), ["needs: [checks, browser, win32, webkit]"]);
  assert.match(ci, /\n  check:\n(?:    .*\n)*?    name: Typecheck, Test & Sidecar Bundle\n(?:    .*\n)*?    needs: \[checks, browser, win32, webkit\]\n/);
  assert.deepEqual(ci.match(/uses: \.\/\.github\/workflows\/[^\s]+/g), ["uses: ./.github/workflows/settings-rows-win32.yml"]);
  const win32 = readFileSync(".github/workflows/settings-rows-win32.yml", "utf8");
  assert.deepEqual(win32.match(/^\s+needs:.*$/gm).map((line) => line.trim()), ["needs: scope"]);
});

test("an aggregator that never ran leaves the required result unmeasured", () => {
  const metrics = runMetrics(run(2, 2741), [job("Browser End-to-End Tests (1)", 0, 5, 30), job(AGGREGATOR, 30, null, 43, "failure")]);
  assert.equal(metrics.aggregatorRan, false);
  assert.equal(metrics.requiredMinutes, null);
  assert.equal(metrics.criticalWaitMinutes, null);
  assert.equal(metrics.longestJobWaitMinutes, 5);
});

test("quantiles use nearest rank and ignore missing values", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([null, 3, 1, 2], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([4, 1], 1), 4);
});

test("the summary counts timeouts, waiting-dominated runs and removal reasons", () => {
  const slow = { requiredMinutes: 130, criticalWaitMinutes: 100, criticalExecutionMinutes: 30, aggregatorRan: true };
  const fast = { requiredMinutes: 35, criticalWaitMinutes: 5, criticalExecutionMinutes: 30, aggregatorRan: true };
  const broken = { requiredMinutes: null, criticalWaitMinutes: null, criticalExecutionMinutes: null, aggregatorRan: false };
  const removals = [{ pullRequest: 1, at: at(0), reason: "checks_timed_out" }, { pullRequest: 2, at: at(1), reason: "merged" }];
  const summary = summarize([slow, fast, broken], removals, 120);
  assert.equal(summary.overTimeout, 1);
  assert.equal(summary.waitingDominated, 1);
  assert.equal(summary.aggregatorNeverRan, 1);
  assert.deepEqual(summary.removalReasons, { checks_timed_out: 1, merged: 1 });
  assert.deepEqual(summary.timedOut, [removals[0]]);
  assert.equal(summary.measures.requiredMinutes.max, 130);
});

test("collection reads each run's first attempt and only removals inside the window", async () => {
  const since = at(-60), until = at(120);
  const paths = [];
  const api = async (path, body) => {
    paths.push(path);
    if (path === "/graphql") {
      const nodes = body.variables.number === 2699
        ? [{ createdAt: at(61), reason: "checks_timed_out" }, { createdAt: at(-120), reason: "merged" }]
        : [{ createdAt: at(30), reason: "merged" }];
      return { data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes } } } } };
    }
    if (path.includes("/workflows/ci.yml/runs")) {
      const page = Number(new URL(path, "https://x").searchParams.get("page"));
      const runs = page === 1 ? [run(10, 2699), { ...run(11, 2700), path: ".github/workflows/other.yml" }] : [{ ...run(12, 2701), run_attempt: 2 }];
      return { total_count: 3, workflow_runs: runs };
    }
    return { jobs: [job("Browser End-to-End Tests (1)", 0, 39, 61), job(AGGREGATOR, 61, 62, 62)] };
  };
  const report = await collect(api, { repository, since, until, timeoutMinutes: 60 });
  assert.equal(report.truncated, false);
  assert.deepEqual(report.metrics.map((m) => m.id), [10, 12]);
  // A rerun is measured on its first attempt, the one the queue waited on.
  assert.ok(paths.includes("/repos/example/project/actions/runs/12/attempts/1/jobs?per_page=100"));
  assert.ok(!paths.some((path) => path.includes("/attempts/2/")));
  assert.deepEqual(report.metrics.map((m) => m.rerun), [false, true]);
  const listing = new URL(paths[0], "https://x");
  assert.equal(listing.searchParams.get("created"), `${since}..${until}`);
  assert.equal(listing.searchParams.get("event"), "merge_group");
  assert.equal(listing.searchParams.get("status"), "completed");
  assert.deepEqual(report.summary.removalReasons, { checks_timed_out: 1, merged: 1 });
  assert.equal(report.summary.overTimeout, 2);
  const text = markdown(report);
  assert.match(text, /2 runs\./);
  assert.match(text, /#2699 removed with checks_timed_out/);
  // 62 minutes to the required result, of which the shard ran 22 and the aggregator 0.
  assert.match(text, /\| Critical path waiting \| 40\.0 \| 40\.0 \| 40\.0 \|/);
});

const timeline = (nodes, hasNextPage = false, endCursor = null) =>
  ({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage, endCursor }, nodes } } } } });

test("removal history is read page by page, and an unbounded history is marked incomplete (#3343 review)", async () => {
  const afters = [];
  const paged = await listRemovals(async (path, body) => {
    afters.push(body.variables.after);
    return body.variables.after === null
      ? timeline([{ createdAt: at(0), reason: "merged" }], true, "cursor-1")
      : timeline([{ createdAt: at(1), reason: "checks_timed_out" }]);
  }, repository, 7);
  assert.deepEqual(afters, [null, "cursor-1"]);
  assert.deepEqual(paged.nodes.map((node) => node.reason), ["merged", "checks_timed_out"]);
  assert.equal(paged.truncated, false);
  const endless = await listRemovals(async () => timeline([], true, "next"), repository, 7);
  assert.equal(endless.truncated, true);
  await assert.rejects(listRemovals(async () => timeline([], true, null), repository, 7), /Unreadable merge-queue removals/);
  await assert.rejects(listRemovals(async () => ({ data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } } }), repository, 7),
    /Unreadable merge-queue removals/);

  const report = await collect(async (path) => path === "/graphql" ? timeline([], true, "next")
    : path.includes("/workflows/") ? { total_count: 1, workflow_runs: [run(1, 5)] } : { jobs: [] },
  { repository, since: at(-1), until: at(1), timeoutMinutes: 120 });
  assert.equal(report.removalsTruncated, true);
  assert.match(markdown(report), new RegExp(`more than ${MAX_PAGES * 100} removals`));
});

test("removals are filtered by instant, whatever offset the bounds are written in (#3343 review)", async () => {
  const api = async (path) => path === "/graphql" ? timeline([{ createdAt: "2026-10-14T05:30:00Z", reason: "checks_timed_out" }])
    : path.includes("/workflows/") ? { total_count: 1, workflow_runs: [run(1, 5)] } : { jobs: [] };
  const offset = await collect(api, { repository, since: "2026-10-14T00:00:00-05:00", until: "2026-10-14T01:00:00-05:00", timeoutMinutes: 120 });
  assert.equal(offset.summary.timedOut.length, 1);
  const outside = await collect(api, { repository, since: "2026-10-14T00:00:00Z", until: "2026-10-14T05:29:59.999Z", timeoutMinutes: 120 });
  assert.equal(outside.summary.timedOut.length, 0);
  const normalised = options(["--repo", repository, "--since", "2026-10-14T00:00:00-05:00", "--until", "2026-10-14T01:00:00-05:00"]);
  assert.equal(normalised.since, "2026-10-14T05:00:00.000Z");
  assert.equal(normalised.until, "2026-10-14T06:00:00.000Z");
});

test("the CLI never prints an unexpected exception's message (#3343 review)", async () => {
  const invoke = async (fetchImpl, argv = ["--repo", repository]) => {
    const errors = [], output = [];
    const code = await main(argv, { env: { GITHUB_TOKEN: "test-token" }, fetchImpl, out: (line) => output.push(line), err: (line) => errors.push(line) });
    return { code, errors, output };
  };
  const malformed = await invoke(async () => new Response("PRIVATE_RESPONSE_SENTINEL", { status: 200 }));
  assert.equal(malformed.code, 1);
  assert.deepEqual(malformed.errors, ["GitHub API request failed: unreadable response or transport error"]);
  const transport = await invoke(async () => { throw new Error("PRIVATE_RESPONSE_SENTINEL"); });
  assert.ok(!transport.errors.join("").includes("PRIVATE_RESPONSE_SENTINEL"));
  const denied = await invoke(async () => new Response("PRIVATE_RESPONSE_SENTINEL", { status: 403 }));
  assert.deepEqual(denied.errors, ["GitHub API request failed (HTTP 403)"]);
  const unreadable = await invoke(async () => Response.json({ message: "PRIVATE_RESPONSE_SENTINEL" }));
  assert.deepEqual(unreadable.errors, ["Unreadable workflow run listing"]);
  const badArgs = await invoke(async () => { throw new Error("unreached"); }, ["--repo", repository, "--since", "nope"]);
  assert.deepEqual(badArgs.errors, ["--since must be an ISO 8601 time"]);
  const noToken = await main(["--repo", repository], { env: {}, err: () => {}, out: () => {} });
  assert.equal(noToken, 1);
  const empty = await invoke(async () => Response.json({ total_count: 0, workflow_runs: [] }));
  assert.equal(empty.code, 0);
  assert.match(empty.output[0], /0 runs\./);
});

test("unreadable listings fail instead of reporting partial numbers", async () => {
  const opts = { repository, since: at(0), until: at(1), timeoutMinutes: 120 };
  await assert.rejects(collect(async () => ({ message: "nope" }), opts), /Unreadable workflow run listing/);
  await assert.rejects(collect(async (path) => path.includes("/workflows/") ? { total_count: 1, workflow_runs: [run(1, 5)] } : {}, opts), /Unreadable job listing/);
  await assert.rejects(collect(async (path) => path === "/graphql" ? { errors: [{}] } : path.includes("/workflows/")
    ? { total_count: 1, workflow_runs: [run(1, 5)] } : { jobs: [] }, opts), /Unreadable merge-queue removals/);
});

test("options default to the last 48 hours and validate their inputs", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  assert.deepEqual(options(["--repo", repository], now), {
    repository, since: "2026-10-14T12:00:00.000Z", until: "2026-10-16T12:00:00.000Z", timeoutMinutes: 120, json: false,
  });
  assert.equal(options(["--repo", repository, "--timeout-minutes", "60", "--json"], now).timeoutMinutes, 60);
  for (const argv of [[], ["--repo", "bad repo"], ["--repo", repository, "--since", "yesterday"],
    ["--repo", repository, "--since", "2026-10-17T00:00:00Z"], ["--repo", repository, "--timeout-minutes", "0"]])
    assert.throws(() => options(argv, now));
});


test("all outcome states and absent evidence remain distinct", () => {
  assert.deepEqual(["success", "failure", "cancelled", "skipped", "neutral"].map((conclusion) => outcome({ status: "completed", conclusion })),
    ["passing", "failing", "cancelled", "skipped", "unmeasured"]);
  assert.equal(outcome({ status: "queued", conclusion: null }), "unfinished");
  assert.equal(outcome(null), "unmeasured");
  const empty = attemptRecord(repository, run(1, 1), [], { since: at(0), until: at(10) });
  assert.equal(empty.metrics.consumedRunnerMinutes, null);
  assert.equal(empty.metrics.nonTestOverheadMinutes, null);
  assert.equal(empty.metrics.requiredMinutes, null);
  const unfinished = attemptRecord(repository, run(1, 1), [{ ...job("Browser End-to-End Tests (1)", 0, 1, null), status: "in_progress" }], {});
  assert.equal(unfinished.jobs[0].state, "unfinished");
  assert.equal(unfinished.metrics.consumedRunnerMinutes, null);
  const skipped = attemptRecord(repository, run(1, 1), [job("worker", 0, 0, 0, "skipped")], {});
  assert.equal(skipped.metrics.nonTestOverheadMinutes, null);
  assert.equal(skipped.metrics.consumedRunnerMinutes, null);
  const backwards = attemptRecord(repository, run(1, 1), [job(AGGREGATOR, 0, 5, 1)], {});
  assert.equal(backwards.metrics.requiredMinutes, null);
  assert.equal(backwards.metrics.consumedRunnerMinutes, null);
});

test("GitHub queued-job start placeholders never become zero runner wait", () => {
  const queued = { ...job("worker", 0, 0, null), status: "queued", conclusion: null };
  const record = attemptRecord(repository, { ...run(1, 1), status: "queued", conclusion: null, run_started_at: at(0) }, [queued], {});
  assert.equal(record.state, "unfinished");
  assert.equal(record.startedAt, null);
  assert.equal(record.apiStartedAt, at(0));
  assert.equal(record.jobs[0].startedAt, null);
  assert.equal(record.jobs[0].apiStartedAt, at(0));
  assert.equal(record.jobs[0].runnerWaitMinutes, null);
  assert.equal(record.jobs[0].executionMinutes, null);
  const running = attemptRecord(repository, run(1, 1), [{ ...queued, status: "in_progress", started_at: at(3) }], {});
  assert.equal(running.jobs[0].runnerWaitMinutes, 3);
  assert.equal(running.jobs[0].executionMinutes, null);
});

test("terminal cancellation with no executed step never becomes runner execution", () => {
  const cancelled = { ...job("worker", 0, 0, 8, "cancelled"), status: "completed", runner_id: 0, steps: [] };
  const record = attemptRecord(repository, { ...run(1, 1), conclusion: "cancelled" }, [cancelled], {});
  assert.equal(record.jobs[0].state, "cancelled");
  assert.equal(record.jobs[0].apiStartedAt, at(0));
  assert.equal(record.jobs[0].startedAt, null);
  assert.equal(record.jobs[0].runnerWaitMinutes, null);
  assert.equal(record.jobs[0].executionMinutes, null);
  assert.equal(record.metrics.measuredRunnerMinutes, null);
  assert.equal(record.metrics.consumedRunnerMinutes, null);
  assert.equal(record.metrics.wallMinutes, null);
  const allocated = attemptRecord(repository, run(1, 1), [{ ...cancelled, started_at: at(3), steps: [
    { number: 1, name: "Setup", status: "completed", conclusion: "success", started_at: at(3), completed_at: at(4) },
  ] }], {});
  assert.equal(allocated.jobs[0].runnerWaitMinutes, 3);
  assert.equal(allocated.jobs[0].executionMinutes, 5);
});

test("job pagination does not turn a partial page into complete execution evidence", async () => {
  const paths = [];
  const result = await listJobs(async (path) => {
    paths.push(path);
    return { total_count: 2, jobs: [ { id: paths.length, ...job("worker", 0, 1, 2) } ] };
  }, repository, 5, 1);
  assert.equal(result.jobs.length, 2);
  assert.match(paths[1], /page=2$/);
  const partial = attemptRecord(repository, run(5, 1), result.jobs, {}, true);
  assert.equal(partial.metrics.consumedRunnerMinutes, null);
  assert.equal(partial.metrics.requiredMinutes, null);
  assert.equal(partial.metrics.measuredRunnerMinutes, 2);
});

test("event collection uses half-open windows, actual attempt outcomes and main pushes only", async () => {
  const first = { ...run(10, 5), head_sha: "a".repeat(40), workflow_id: 4, run_attempt: 2 };
  const calls = [];
  const api = async (path, body) => {
    calls.push(path);
    if (path === "/graphql") return timeline([]);
    if (path.includes("/workflows/")) {
      const event = new URL(path, "https://x").searchParams.get("event");
      const rows = event === "merge_group" ? [first, { ...first, id: 11, created_at: at(120) }]
        : event === "push" ? [{ ...first, id: 12, event, head_branch: "other" }] : [];
      return { total_count: rows.length, workflow_runs: rows };
    }
    if (path.includes("/jobs?")) return { total_count: 1, jobs: [{ id: calls.length, ...job(AGGREGATOR, 0, 1, 3) }] };
    const attempt = Number(path.split("/").at(-1));
    return { ...first, run_attempt: attempt, conclusion: attempt === 1 ? "failure" : "success" };
  };
  const report = await collectEvents(api, { repository, since: at(0), until: at(120), timeoutMinutes: 120 });
  assert.equal(report.records.length, 2);
  assert.deepEqual(report.records.map((r) => r.state), ["failing", "passing"]);
  assert.equal(report.records[1].metrics.requiredMinutes, null);
  assert.equal(report.records[1].jobs[0].runnerWaitMinutes, null);
  assert.equal(report.records[1].metrics.nonTestOverheadMinutes, null);
  assert.equal(report.records[1].metrics.consumedRunnerMinutes, null);
  assert.equal(report.summary.retryOnlyRuns.length, 1);
  assert.equal(report.summary.validationLag.oldestUnvalidatedChangeAgeMinutes, null);
  assert.equal(report.summary.validationLag.state, "not-yet-measurable");
});

test("combined reports deduplicate boundaries and compute percentiles from raw records", () => {
  const rows = [1, 2, 3, 100].map((value, i) => {
    const row = attemptRecord(repository, { ...run(i + 1, 1), head_sha: "a".repeat(40) }, [], {});
    row.metrics.requiredMinutes = value;
    return row;
  });
  const report = (records, collectedAt) => ({ schemaVersion: 2, repository, collectedAt, windows: [{}],
    records, removals: [{ repository, pullRequest: 1, at: at(0), reason: "merged" }], pagination: [],
    summary: { cohorts: "DO NOT AVERAGE THIS" } });
  const combined = combineReports([report(rows.slice(0, 3), at(10)), report(rows.slice(2), at(11))]);
  assert.equal(combined.records.length, 4);
  assert.equal(combined.removals.length, 1);
  const cohort = combined.summary.cohorts.find((row) => row.event === "merge_group" && row.attemptClass === "first");
  assert.deepEqual(cohort.measures.requiredMinutes, { measured: 4, median: 2, p90: 100, max: 100 });
  assert.throws(() => combineReports([report([], at(0)), { ...report([], at(1)), repository: "other/repo" }]));
});

test("queue-to-merge measures only a surviving enqueue, without attributing an old entry", async () => {
  const report = await queueHistory(async () => timeline([
    { __typename: "AddedToMergeQueueEvent", createdAt: at(0) },
    { __typename: "RemovedFromMergeQueueEvent", createdAt: at(20) },
    { __typename: "AddedToMergeQueueEvent", createdAt: at(30) },
    { __typename: "MergedEvent", createdAt: at(50), commit: { oid: "c".repeat(40) } },
    { __typename: "MergedEvent", createdAt: at(60) },
  ]), repository, 1);
  assert.equal(report.episodes[0].minutes, 20);
  assert.equal(report.episodes[1].minutes, null);
  assert.equal(report.episodes[1].state, "unmeasured");
});

test("a merged queue removal before MergedEvent preserves the successful episode", async () => {
  const report = await queueHistory(async () => timeline([
    { __typename: "AddedToMergeQueueEvent", createdAt: at(0) },
    { __typename: "RemovedFromMergeQueueEvent", createdAt: at(5), reason: "checks_timed_out" },
    { __typename: "AddedToMergeQueueEvent", createdAt: at(10) },
    { __typename: "RemovedFromMergeQueueEvent", createdAt: at(49), reason: "merged" },
    { __typename: "MergedEvent", createdAt: at(50), commit: { oid: "c".repeat(40) } },
  ]), repository, 1);
  assert.equal(report.episodes[0].minutes, 40);
  assert.equal(report.episodes[0].enteredAt, at(10));
  assert.equal(report.episodes[0].state, "measured");
});

test("optional timing transport failure cannot discard collected metadata", async () => {
  const unavailable = await readTimingLog("token", repository, 1, async () => new Response(null, { status: 302 }));
  assert.equal(unavailable.state, "unmeasured");
  let calls = 0;
  const timedOut = await readTimingLog("token", repository, 1, async () => {
    if (++calls === 1) return new Response(null, { status: 302, headers: { location: "https://x.blob.core.windows.net/log" } });
    throw new DOMException("PRIVATE_SENTINEL", "AbortError");
  });
  assert.equal(timedOut.state, "unmeasured");
  assert.ok(!JSON.stringify(timedOut).includes("PRIVATE_SENTINEL"));
});

test("missing timing SHA never erases known source evidence", () => {
  const record = attemptRecord(repository, { ...run(1, 1), head_sha: "a".repeat(40) }, [], {});
  applyTimingContext(record, { context: { runId: "1", attempt: 1, testedSha: null, workflowSha: "b".repeat(40) } });
  assert.equal(record.testedSha, "a".repeat(40));
  assert.equal(record.suiteRevision, "a".repeat(40));
  assert.equal(record.workflowRevision.executedSourceSha, "b".repeat(40));
  assert.equal(record.workflowRevision.state, "source-measured");
  applyTimingContext(record, { context: { runId: "1", attempt: 2, testedSha: "c".repeat(40), workflowSha: null } });
  assert.equal(record.testedSha, "a".repeat(40));
});

test("log collection projects marker lines and never forwards bearer authorization", async () => {
  const { TimingSummary, TIMING_MARKER } = await import("./ci-timing.mjs");
  const safe = new TimingSummary("browser");
  safe.add({ file: process.cwd() + "/test.spec.ts", name: "PRIVATE_SENTINEL", durationMs: 5, state: "passing", retry: 1 });
  const calls = [];
  const result = await readTimingLog("secret-token", repository, 1, async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://example.blob.core.windows.net/private" } })
      : new Response("PRIVATE_LOG_SENTINEL\n2026-10-22 " + TIMING_MARKER + JSON.stringify({ ...safe.result(), secret: "PRIVATE_SENTINEL" }) + "\n");
  });
  assert.equal(result.state, "measured");
  assert.equal(result.summaries[0].retryOnly, 1);
  assert.equal(calls[1].options.headers, undefined);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});
