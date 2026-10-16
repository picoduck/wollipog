import assert from "node:assert/strict";
import test from "node:test";
import { AGGREGATOR, collect, markdown, options, pullRequestOf, quantile, runMetrics, summarize } from "./merge-queue-wait-report.mjs";

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

test("collection reads each run's own attempt and only removals inside the window", async () => {
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
  assert.ok(paths.includes("/repos/example/project/actions/runs/12/attempts/2/jobs?per_page=100"));
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
