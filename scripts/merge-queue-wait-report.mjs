import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { parseTiming, TIMING_MARKER } from "./ci-timing.mjs";
import { parseSelection, SELECTION_MARKER } from "./ci-suite-selection.mjs";
import { githubApi } from "./merge-group-cleanup.mjs";

// Splits merge-group CI time into waiting for a runner and executing, so a queue entry that
// expires can be attributed to one or the other (#2674). Read-only: it lists runs, jobs and
// merge-queue removals, and never changes anything.

export const AGGREGATOR = "Typecheck, Test & Sidecar Bundle";
const ADVISORY_JOBS = new Set(["Suite Selection Shadow (Advisory)", "Regression Admission Shadow (Advisory)"]);
const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-([1-9][0-9]*)-[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const MAX_PAGES = 10;
const POOL = 6;
const MINUTE = 60_000;
// GitHub creates a job within seconds of its last dependency finishing.
export const DEPENDENCY_SLACK_MS = 5_000;

/** A failure this script describes itself; anything else is reported without its message. */
export class ReportError extends Error {}

export const REMOVALS_QUERY = `query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT], first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } }
      }
    }
  }
}`;

const minutes = (from, to) => {
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) && span >= 0 ? span / MINUTE : null;
};
const latest = (jobs) => jobs.reduce((last, job) => !last || Date.parse(job.completed_at) > Date.parse(last.completed_at) ? job : last, null);

export function pullRequestOf(branch) {
  const match = QUEUE_BRANCH.exec(branch ?? "");
  return match ? Number(match[1]) : null;
}

// A called workflow's jobs are named "<caller> / <job>".
const callerOf = (job) => job.name.includes(" / ") ? job.name.slice(0, job.name.indexOf(" / ")) : null;

/**
 * The jobs `job` can depend on, from ci.yml's structure: the aggregator needs every other
 * required work job. Checks/browser work waits for PR Suite Routing and the Merge Group
 * Gate (#3637); delegated recovery waits only for PR routing. An executed gate is execution
 * on the critical path, never queue wait. A skipped gate consumes no execution. A called
 * workflow's jobs depend only on jobs of the same call. Advisory shadow work is never a dependency.
 * Older runs have neither planning job. The jobs API does not name dependencies; tests pin this model.
 */
const PLANNING_JOBS = new Set(["PR Suite Routing", "Merge Group Gate"]);
export function dependencyCandidates(job, work, aggregator) {
  const requiredWork = work.filter((other) => !ADVISORY_JOBS.has(other.name));
  if (job === aggregator) return requiredWork;
  if (PLANNING_JOBS.has(job.name)) return [];
  const gated = job.name === "Typecheck, Unit Tests & Bundles" || /^Browser End-to-End Tests \([1-5]\)$/.test(job.name);
  const routed = gated || job.name === "Delegated Pipeline Recovery";
  const routing = routed ? requiredWork.filter((other) => other.name === "PR Suite Routing" ||
    gated && other.name === "Merge Group Gate") : [];
  const caller = callerOf(job);
  return caller === null ? routing : work.filter((other) => other !== job && callerOf(other) === caller);
}

/**
 * The chain of executed jobs ending at `job`, newest first, or null when it cannot be told apart.
 * A job created with the run has no dependency. One created later was created when its last
 * dependency finished: the latest of its possible dependencies to complete by then.
 */
export function criticalPath(run, job, work, aggregator = job) {
  if (![run.created_at, job.created_at, ...work.map((item) => item.created_at)].every((time) => Number.isFinite(Date.parse(time)))) return null;
  const path = [job];
  const started = Date.parse(run.created_at);
  for (let current = job; Date.parse(current.created_at) - started > DEPENDENCY_SLACK_MS;) {
    const created = Date.parse(current.created_at);
    const previous = latest(dependencyCandidates(current, work, aggregator).filter((candidate) =>
      !path.includes(candidate) && Date.parse(candidate.completed_at) <= created + DEPENDENCY_SLACK_MS));
    if (!previous) return null;
    path.push(previous);
    current = previous;
  }
  return path;
}

/**
 * One merge-group run's timeline. A job's created-to-started span is its wait for a runner. The
 * required result's time from the run's creation splits into the execution of its critical path
 * (see criticalPath) and everything else, which is waiting.
 */
export function runMetrics(run, jobs) {
  const executed = jobs.filter((job) => job.conclusion !== "skipped" && minutes(job.started_at, job.completed_at) !== null);
  const aggregator = executed.find((job) => job.name === AGGREGATOR) ?? null;
  const work = executed.filter((job) => job !== aggregator);
  const waits = executed.map((job) => minutes(job.created_at, job.started_at)).filter((value) => value !== null);
  const requiredMinutes = aggregator ? minutes(run.created_at, aggregator.completed_at) : null;
  // Disabled routing is a real dependency despite consuming no runner. Its known completion
  // anchors delayed work creation. Do not interpret skipped-job API start placeholders as
  // execution: a skipped anchor contributes exactly zero, and missing times stay unmeasured.
  const skippedRouting = jobs.filter((job) => job.name === "PR Suite Routing" && job.conclusion === "skipped" &&
    minutes(job.created_at, job.completed_at) !== null);
  const anchors = skippedRouting.length === 1 ? skippedRouting.map((job) => ({ ...job, started_at: job.completed_at })) : [];
  const path = aggregator ? criticalPath(run, aggregator, [...work, ...anchors]) : null;
  const executionMinutes = path ? path.reduce((sum, job) => sum + minutes(job.started_at, job.completed_at), 0) : null;
  return {
    id: run.id,
    rerun: run.run_attempt > 1,
    pullRequest: pullRequestOf(run.head_branch),
    createdAt: run.created_at,
    wallMinutes: executed.length ? minutes(run.created_at, latest(executed).completed_at) : null,
    requiredMinutes,
    criticalExecutionMinutes: executionMinutes,
    criticalWaitMinutes: requiredMinutes !== null && executionMinutes !== null ? requiredMinutes - executionMinutes : null,
    longestJobWaitMinutes: waits.length ? Math.max(...waits) : null,
    longestExecutionMinutes: work.length ? Math.max(...work.map((job) => minutes(job.started_at, job.completed_at))) : null,
    aggregatorWaitMinutes: aggregator ? minutes(aggregator.created_at, aggregator.started_at) : null,
    aggregatorRan: aggregator !== null,
  };
}

/** Nearest-rank quantile of the finite values, or null when there are none. */
export function quantile(values, q) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export const MEASURES = [
  ["requiredMinutes", "Run created to required result"],
  ["criticalWaitMinutes", "Critical path waiting"],
  ["criticalExecutionMinutes", "Critical path executing"],
  ["longestJobWaitMinutes", "Longest job wait for a runner"],
  ["aggregatorWaitMinutes", "Aggregator wait after dependencies"],
  ["longestExecutionMinutes", "Longest job execution"],
  ["wallMinutes", "Run created to last job finished"],
];

export function summarize(metrics, removals, timeoutMinutes) {
  const measures = Object.fromEntries(MEASURES.map(([key]) => {
    const values = metrics.map((metric) => metric[key]);
    return [key, { median: quantile(values, 0.5), p90: quantile(values, 0.9), max: quantile(values, 1) }];
  }));
  const reasons = {};
  for (const removal of removals) reasons[removal.reason] = (reasons[removal.reason] ?? 0) + 1;
  return {
    runs: metrics.length,
    timeoutMinutes,
    measures,
    overTimeout: metrics.filter((m) => m.requiredMinutes !== null && m.requiredMinutes > timeoutMinutes).length,
    waitingDominated: metrics.filter((m) => m.criticalWaitMinutes !== null && m.criticalWaitMinutes > m.criticalExecutionMinutes).length,
    aggregatorNeverRan: metrics.filter((m) => !m.aggregatorRan).length,
    criticalPathUnmeasured: metrics.filter((m) => m.aggregatorRan && m.criticalExecutionMinutes === null).length,
    removalReasons: reasons,
    timedOut: removals.filter((removal) => removal.reason === "checks_timed_out"),
  };
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

/** Completed merge-group CI runs created in the window, newest first. */
export async function listRuns(api, repository, since, until, event = "merge_group", completedOnly = true) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?event=${event}${completedOnly ? "&status=completed" : ""}` +
      `&exclude_pull_requests=true&created=${encodeURIComponent(`${since}..${until}`)}&per_page=100&page=${page}`);
    if (!Array.isArray(body?.workflow_runs) || !Number.isSafeInteger(body?.total_count))
      throw new ReportError("Unreadable workflow run listing");
    runs.push(...body.workflow_runs);
    if (runs.length >= body.total_count || body.workflow_runs.length === 0) return { runs, truncated: runs.length < body.total_count };
  }
  return { runs, truncated: true };
}

/** One pull request's merge-queue removals, every page up to the bound. */
export async function listRemovals(api, repository, number) {
  const [owner, repo] = repository.split("/");
  const nodes = [];
  let after = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await api("/graphql", { query: REMOVALS_QUERY, variables: { owner, repo, number, after } });
    const items = payload?.data?.repository?.pullRequest?.timelineItems;
    if (payload?.errors?.length || !Array.isArray(items?.nodes) || typeof items?.pageInfo?.hasNextPage !== "boolean")
      throw new ReportError("Unreadable merge-queue removals");
    nodes.push(...items.nodes);
    if (!items.pageInfo.hasNextPage) return { nodes, truncated: false };
    if (typeof items.pageInfo.endCursor !== "string") throw new ReportError("Unreadable merge-queue removals");
    after = items.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}

export async function collect(api, { repository, since, until, timeoutMinutes, allEvents = false, assumedRate = null }) {
  if (allEvents) return collectEvents(api, { repository, since, until, timeoutMinutes, assumedRate });
  const { runs, truncated } = await listRuns(api, repository, since, until);
  const ci = runs.filter((run) => run?.path === ".github/workflows/ci.yml" && run?.event === "merge_group");
  const metrics = await pool(ci, async (run) => {
    // The first attempt is the one the queue waited on. A rerun copies the earlier attempt's
    // finished jobs with new creation times, so its timeline cannot be read as waits.
    const { jobs, truncated: jobsTruncated } = await listJobs(api, repository, run.id, 1);
    return { ...runMetrics(run, jobsTruncated ? [] : jobs), jobsTruncated };
  });
  const pullRequests = [...new Set(metrics.map((metric) => metric.pullRequest).filter((n) => n !== null))].sort((a, b) => a - b);
  const [from, to] = [Date.parse(since), Date.parse(until)];
  let removalsTruncated = false;
  const removals = (await pool(pullRequests, async (number) => {
    const { nodes, truncated: partial } = await listRemovals(api, repository, number);
    removalsTruncated ||= partial;
    return nodes
      .filter((node) => Date.parse(node?.createdAt) >= from && Date.parse(node.createdAt) <= to)
      .map((node) => ({ pullRequest: number, at: node.createdAt, reason: node.reason }));
  })).flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { repository, since, until, truncated, removalsTruncated, metrics, summary: summarize(metrics, removals, timeoutMinutes) };
}

export function outcome(item) {
  if (!item) return "unmeasured";
  if (item.status && item.status !== "completed") return "unfinished";
  return ({ success: "passing", failure: "failing", timed_out: "failing", action_required: "failing",
    cancelled: "cancelled", skipped: "skipped" })[item.conclusion] ?? "unmeasured";
}

const duration = (from, to) => {
  const value = minutes(from, to);
  return value !== null && value >= 0 ? value : null;
};
const distribution = (values) => ({ measured: values.filter(Number.isFinite).length,
  median: quantile(values, 0.5), p90: quantile(values, 0.9), max: quantile(values, 1) });

export async function listJobs(api, repository, runId, attempt) {
  const jobs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100${page === 1 ? "" : `&page=${page}`}`);
    if (!Array.isArray(body?.jobs)) throw new ReportError("Unreadable job listing");
    jobs.push(...body.jobs);
    if (Number.isSafeInteger(body.total_count) ? jobs.length >= body.total_count : body.jobs.length < 100)
      return { jobs: [...new Map(jobs.map((job, i) => [job.id ?? i, job])).values()], truncated: false };
  }
  return { jobs, truncated: true };
}

const TEST_STEP = /^(Unit Tests|Remote-Instance Browser End-to-End Tests|WebKit Browser End-to-End Tests|Rendered Production Browser Smoke)$/;
const hasStarted = (item) => item.status === undefined || ["in_progress", "completed"].includes(item.status);
const jobHasStarted = (job) => hasStarted(job) && (job.status !== "completed" ||
  // Terminal cancellation can retain the queued start placeholder. Require actual step evidence.
  (job.steps ?? []).some((step) => step.conclusion !== "skipped" && Number.isFinite(Date.parse(step.started_at))));

/** Only API metadata is retained. No names from tests, log bodies, inputs or runner identities. */
export function attemptRecord(repository, run, jobs, window, jobsTruncated = false) {
  const attempt = run.run_attempt;
  const first = attempt === 1;
  const projected = jobs.map((job) => ({
    id: job.id ?? null, name: job.name, state: outcome(job), conclusion: job.conclusion ?? null,
    createdAt: job.created_at ?? null, startedAt: jobHasStarted(job) ? job.started_at ?? null : null,
    apiStartedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    // Reruns may contain copied jobs with reset creation times; never interpret those as waits.
    runnerWaitMinutes: first && jobHasStarted(job) && job.conclusion !== "skipped" ? duration(job.created_at, job.started_at) : null,
    executionMinutes: first && jobHasStarted(job) && job.conclusion !== "skipped" ? duration(job.started_at, job.completed_at) : null,
    steps: (job.steps ?? []).map((step) => ({ number: step.number, name: step.name,
      state: outcome(step), conclusion: step.conclusion ?? null, startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
      minutes: first && step.conclusion !== "skipped" ? duration(step.started_at, step.completed_at) : null,
      kind: TEST_STEP.test(step.name) ? "test" : "non-test-overhead" })),
  }));
  const measured = projected.filter((job) => Number.isFinite(job.executionMinutes));
  const missing = projected.filter((job) => job.state !== "skipped" && job.executionMinutes === null).length;
  const shards = projected.filter((job) => /^Browser End-to-End Tests \([1-5]\)$/.test(job.name));
  const shardTimes = shards.map((job) => job.executionMinutes).filter(Number.isFinite);
  const split = runMetrics(run, jobs.filter((job) => jobHasStarted(job) ||
    job.name === "PR Suite Routing" && job.conclusion === "skipped"));
  return {
    repository, event: run.event, sha: run.head_sha ?? null,
    testedSha: run.event === "pull_request" ? null : run.head_sha ?? null,
    suiteRevision: run.event === "pull_request" ? null : run.head_sha ?? null,
    workflow: run.path, workflowId: run.workflow_id ?? null,
    workflowRevision: { sourceSha: run.head_sha ?? null, executedBlobSha: null, state: "unmeasured" },
    runId: run.id, attempt, attemptClass: first ? "first" : "rerun", checkSuiteId: run.check_suite_id ?? null,
    pullRequest: pullRequestOf(run.head_branch) ?? run.pull_requests?.[0]?.number ?? null,
    branch: run.head_branch, state: outcome(run), conclusion: run.conclusion ?? null,
    createdAt: run.created_at, startedAt: hasStarted(run) ? run.run_started_at ?? null : null,
    apiStartedAt: run.run_started_at ?? null, updatedAt: run.updated_at ?? null,
    window, jobsTruncated, jobs: projected,
    readiness: run.event === "pull_request" ? projected.some((job) => job.state !== "skipped")
      ? "admitted-by-workflow-guard" : "unmeasured" : "not-applicable",
    metrics: {
      ...Object.fromEntries(MEASURES.map(([key]) => [key, first && !jobsTruncated ? split[key] : null])),
      measuredRunnerMinutes: measured.length ? measured.reduce((sum, job) => sum + job.executionMinutes, 0) : null,
      consumedRunnerMinutes: !jobsTruncated && jobs.length > 0 && missing === 0 && measured.length > 0
        ? measured.reduce((sum, job) => sum + job.executionMinutes, 0) : null,
      missingJobTiming: missing,
      nonTestOverheadMinutes: first && !jobsTruncated && measured.length > 0 && projected.every((job) => job.state === "skipped" ||
        job.steps.length > 0 && job.steps.every((step) => step.state === "skipped" || step.minutes !== null))
        ? projected.flatMap((job) => job.steps).filter((step) => step.kind === "non-test-overhead")
          .reduce((sum, step) => sum + (step.minutes ?? 0), 0) : null,
      browserShardImbalance: { observed: shardTimes.length, expected: 5,
        complete: shards.length === 5 && shardTimes.length === 5,
        maxMinusMinMinutes: shardTimes.length > 1 ? Math.max(...shardTimes) - Math.min(...shardTimes) : null,
        maxOverMin: shardTimes.length > 1 && Math.min(...shardTimes) > 0 ? Math.max(...shardTimes) / Math.min(...shardTimes) : null },
    },
    testTiming: { state: "unmeasured", reason: "Use the bounded ci-timing-v1 log projection; historical runs may predate it." },
  };
}

export function eventSummary(records, assumedRate = null) {
  const cohorts = [];
  for (const event of ["pull_request", "merge_group", "push"]) for (const attemptClass of ["first", "rerun"]) {
    const rows = records.filter((record) => record.event === event && record.attemptClass === attemptClass);
    const states = Object.fromEntries(["passing", "failing", "cancelled", "skipped", "unfinished", "unmeasured"]
      .map((state) => [state, rows.filter((row) => row.state === state).length]));
    cohorts.push({ event, attemptClass, records: rows.length, states,
      byState: Object.fromEntries(Object.keys(states).map((state) => [state, {
        records: states[state],
        measures: Object.fromEntries([...MEASURES.map(([key]) => key), "consumedRunnerMinutes", "nonTestOverheadMinutes"]
          .map((key) => [key, distribution(rows.filter((row) => row.state === state).map((row) => row.metrics[key]))])),
      }])),
      measures: Object.fromEntries([...MEASURES.map(([key]) => key), "consumedRunnerMinutes", "nonTestOverheadMinutes"]
        .map((key) => [key, distribution(rows.map((row) => row.metrics[key]))])),
      measuredRunnerMinutes: rows.some((row) => row.metrics.measuredRunnerMinutes !== null)
        ? rows.reduce((sum, row) => sum + (row.metrics.measuredRunnerMinutes ?? 0), 0) : null,
      jobsTruncated: rows.filter((row) => row.jobsTruncated).length });
  }
  const retryOnlyRuns = records.filter((row) => row.attempt > 1 && row.state === "passing" && records.some((first) =>
    first.repository === row.repository && first.runId === row.runId && first.attempt === 1 && first.sha === row.sha && first.state === "failing"))
    .map((row) => ({ repository: row.repository, runId: row.runId, attempt: row.attempt, sha: row.sha }));
  return { cohorts, retryOnlyRuns,
    // This is event duplication of exact SHAs, not equivalence of PR heads and integration SHAs.
    sharedEventShas: [...new Set(records.map((row) => row.sha).filter(Boolean))].map((sha) => ({ sha,
      events: [...new Set(records.filter((row) => row.sha === sha).map((row) => row.event))] })).filter((row) => row.events.length > 1),
    cost: { state: "unmeasured", billedMinutes: null, currency: null, amount: null,
      reason: "Job elapsed time is not billed usage. Plan allowances, OS rounding/multipliers and invoice rates unavailable." },
    costEstimate: { assumedUniformUsdPerRunnerMinute: assumedRate,
      estimatedElapsedCostUsd: assumedRate !== null && records.some((row) => row.metrics.measuredRunnerMinutes !== null)
        ? records.reduce((sum, row) => sum + (row.metrics.measuredRunnerMinutes ?? 0), 0) * assumedRate : null,
      actualBilledCostUsd: null, basis: "Hypothetical uniform rate on measured elapsed minutes only; missing/rerun timing excluded, no billing rounding or allowances." },
    validationLag: { state: "not-yet-measurable", lastPassingSnapshotSha: null, lastPassingSnapshotAt: null,
      oldestUnvalidatedChangeAt: null, oldestUnvalidatedChangeAgeMinutes: null, commitsBeyondSnapshot: null,
      mergesBeyondSnapshot: null, failureDetectedAt: null, detectionLagMinutes: null, restoredAt: null, restorationMinutes: null } };
}

export async function collectEvents(api, { repository, since, until, timeoutMinutes, assumedRate = null }) {
  const windows = [{ since, until }];
  const listings = await Promise.all(["pull_request", "merge_group", "push"].map(async (event) => {
    const listing = await listRuns(api, repository, since, until, event, false);
    return { event, ...listing };
  }));
  const runs = [...new Map(listings.flatMap((listing) => listing.runs).filter((run) =>
    run.path === ".github/workflows/ci.yml" && (run.event !== "push" || run.head_branch === "main") &&
    Date.parse(run.created_at) >= Date.parse(since) && Date.parse(run.created_at) < Date.parse(until))
    .map((run) => [run.id, run])).values()];
  const records = (await pool(runs, async (run) => {
    const attempts = [];
    for (let attempt = 1; attempt <= Math.min(run.run_attempt, MAX_PAGES); attempt++) {
      const snapshot = await api(`/repos/${repository}/actions/runs/${run.id}/attempts/${attempt}`);
      if (snapshot?.id !== run.id || snapshot?.run_attempt !== attempt || snapshot?.head_sha !== run.head_sha)
        throw new ReportError("Unreadable or changed run attempt");
      const { jobs, truncated } = await listJobs(api, repository, run.id, attempt);
      attempts.push(attemptRecord(repository, snapshot, jobs, windows[0], truncated));
    }
    return attempts;
  })).flat();
  const removals = [];
  const queueEpisodes = [];
  let removalsTruncated = false;
  for (const number of [...new Set(records.filter((row) => row.event === "merge_group").map((row) => row.pullRequest).filter(Boolean))]) {
    const listing = await listRemovals(api, repository, number);
    removalsTruncated ||= listing.truncated;
    removals.push(...listing.nodes.filter((node) => Date.parse(node.createdAt) >= Date.parse(since) && Date.parse(node.createdAt) < Date.parse(until))
      .map((node) => ({ repository, pullRequest: number, at: node.createdAt, reason: node.reason })));
    const history = await queueHistory(api, repository, number);
    removalsTruncated ||= history.truncated;
    queueEpisodes.push(...history.episodes.filter((episode) => Date.parse(episode.mergedAt) >= Date.parse(since) &&
      Date.parse(episode.mergedAt) < Date.parse(until)));
  }
  return { schemaVersion: 2, repository, windows, collectedAt: new Date().toISOString(), timeoutMinutes,
    pagination: listings.map(({ event, truncated }) => ({ event, truncated, maxPages: MAX_PAGES })),
    attemptsTruncated: runs.some((run) => run.run_attempt > MAX_PAGES), removalsTruncated,
    records, removals, queueEpisodes, assumedRate, summary: eventSummary(records, assumedRate) };
}

export const QUEUE_HISTORY_QUERY = `query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$repo) { pullRequest(number:$number) {
    timelineItems(itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,MERGED_EVENT],first:100,after:$after) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename ... on AddedToMergeQueueEvent { createdAt }
        ... on RemovedFromMergeQueueEvent { createdAt reason }
        ... on MergedEvent { createdAt commit { oid } } }
    }
  } }
}`;

export async function queueHistory(api, repository, number) {
  let after = null, enteredAt = null, truncated = true;
  const episodes = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const [owner, repo] = repository.split("/");
    const body = await api("/graphql", { query: QUEUE_HISTORY_QUERY, variables: { owner, repo, number, after } });
    const items = body?.data?.repository?.pullRequest?.timelineItems;
    if (body?.errors?.length || !Array.isArray(items?.nodes) || typeof items.pageInfo?.hasNextPage !== "boolean")
      throw new ReportError("Unreadable queue history");
    for (const node of items.nodes) {
      if (node.__typename === "AddedToMergeQueueEvent") enteredAt = node.createdAt;
      // A successful queue merge can emit its 'merged' removal one second before MergedEvent.
      if (node.__typename === "RemovedFromMergeQueueEvent" && node.reason !== "merged") enteredAt = null;
      if (node.__typename === "MergedEvent") {
        episodes.push({ repository, pullRequest: number, enteredAt, mergedAt: node.createdAt,
          mergeSha: node.commit?.oid ?? null, minutes: enteredAt ? duration(enteredAt, node.createdAt) : null,
          state: enteredAt ? "measured" : "unmeasured" });
        enteredAt = null;
      }
    }
    if (!items.pageInfo.hasNextPage) { truncated = false; break; }
    if (typeof items.pageInfo.endCursor !== "string") throw new ReportError("Unreadable queue history");
    after = items.pageInfo.endCursor;
  }
  return { episodes, truncated };
}

/** Fetch at most 16 MiB per explicitly selected job, projecting marker lines in memory only. */
export async function readTimingLog(token, repository, jobId, fetchImpl = fetch) {
  try { return await readTimingLogBody(token, repository, jobId, fetchImpl); }
  catch { return { state: "unmeasured", reason: "log-transport-or-unreadable-redirect" }; }
}

async function readTimingLogBody(token, repository, jobId, fetchImpl) {
  const request = await fetchImpl(`https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (request.status !== 302) return { state: "unmeasured", reason: `log-http-${request.status}` };
  const location = new URL(request.headers.get("location"));
  if (location.protocol !== "https:" || !location.hostname.endsWith(".blob.core.windows.net"))
    return { state: "unmeasured", reason: "unsupported-log-host" };
  // Never forward the GitHub token to the signed blob URL.
  const response = await fetchImpl(location, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || !response.body) return { state: "unmeasured", reason: `log-http-${response.status}` };
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, pending = "", truncated = false, selectionTruncated = false, droppingLine = false;
  const summaries = [], selections = [];
  const selectionLine = (line) => {
    if (!line.includes(SELECTION_MARKER)) return;
    if (line.length > 768_000) { selectionTruncated = true; return; }
    const selection = parseSelection(line.trimEnd());
    if (!selection) return;
    if (selections.length < 2) selections.push(selection);
    else selectionTruncated = true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) { truncated = true; break; }
      let chunk = decoder.decode(value, { stream: true });
      if (droppingLine) {
        const newline = chunk.indexOf("\n");
        if (newline < 0) continue;
        chunk = chunk.slice(newline + 1); droppingLine = false;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (line.includes(TIMING_MARKER)) {
          const summary = parseTiming(line.trimEnd());
          if (summary) {
            if (summaries.length < 10) summaries.push(summary);
            else truncated = true;
          }
        }
        selectionLine(line);
      }
      const selectionPending = pending.includes(SELECTION_MARKER);
      if (pending.length > (selectionPending ? 768_000 : 32_000)) {
        if (selectionPending) selectionTruncated = true;
        pending = ""; droppingLine = true;
      }
    }
    const last = parseTiming(pending.trimEnd());
    if (last && summaries.length < 10) summaries.push(last);
    if (!droppingLine) selectionLine(pending);
  } finally { await reader.cancel(); }
  return { state: summaries.length || selections.length ? "measured" : "unmeasured", truncated, summaries,
    ...(selections.length || selectionTruncated ? { selections, selectionTruncated } : {}),
    reason: summaries.length || selections.length ? null : "no-safe-timing-output" };
}

export function applyTimingContext(record, summary) {
  if (summary.context?.runId !== String(record.runId) || summary.context?.attempt !== record.attempt) return;
  if (summary.context.testedSha) {
    record.testedSha = summary.context.testedSha;
    record.suiteRevision = summary.context.testedSha;
  }
  if (summary.context.workflowSha) {
    record.workflowRevision.executedSourceSha = summary.context.workflowSha;
    record.workflowRevision.state = "source-measured";
  }
}

/** Recompute cohort percentiles from deduplicated raw attempts, never from daily percentiles. */
export function combineReports(reports) {
  if (!reports.length || reports.some((report) => report.schemaVersion !== 2 || report.repository !== reports[0].repository))
    throw new ReportError("Inputs must be version-2 reports for one repository");
  if (reports.some((report) => (report.assumedRate ?? null) !== (reports[0].assumedRate ?? null)))
    throw new ReportError("Inputs must use the same hypothetical cost rate");
  const sorted = [...reports].sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
  const records = [...new Map(sorted.flatMap((report) => report.records)
    .map((row) => [`${row.repository}/${row.runId}/${row.attempt}`, row])).values()];
  const removals = [...new Map(sorted.flatMap((report) => report.removals)
    .map((row) => [`${row.repository}/${row.pullRequest}/${row.at}/${row.reason}`, row])).values()];
  const queueEpisodes = [...new Map(sorted.flatMap((report) => report.queueEpisodes ?? [])
    .map((row) => [`${row.repository}/${row.pullRequest}/${row.mergedAt}`, row])).values()];
  return { ...sorted.at(-1), windows: reports.flatMap((report) => report.windows), records, removals, queueEpisodes,
    pagination: reports.flatMap((report) => report.pagination),
    attemptsTruncated: reports.some((report) => report.attemptsTruncated),
    removalsTruncated: reports.some((report) => report.removalsTruncated), summary: eventSummary(records, reports[0].assumedRate ?? null) };
}

const fixed = (value) => value === null ? "—" : value.toFixed(1);

/** Compare independently collected natural windows; never combine before and after samples. */
export function compareReports(before, after) {
  before = combineReports([before]);
  after = combineReports([after]);
  if ([before, after].some((report) => !report.windows.length || report.windows.some((window) =>
    !Number.isFinite(Date.parse(window.since)) || !Number.isFinite(Date.parse(window.until)) ||
    Date.parse(window.since) >= Date.parse(window.until)))) throw new ReportError("Comparison requires explicit valid windows");
  if (before.repository !== after.repository || before.windows.some((a) => after.windows.some((b) =>
    Date.parse(a.until) > Date.parse(b.since))))
    throw new ReportError("Comparison requires the same repository and ordered, nonoverlapping windows");
  const identity = (row) => `${row.repository}/${row.runId}/${row.attempt}`;
  const previous = new Set(before.records.map(identity));
  if (after.records.some((row) => previous.has(identity(row)))) throw new ReportError("Comparison repeats a run attempt");
  const project = (report) => ({ windows: report.windows, records: report.records.length,
    incomplete: report.attemptsTruncated || report.removalsTruncated || report.pagination.some((page) => page.truncated),
    cohorts: report.summary.cohorts.map((row) => ({ event: row.event, attemptClass: row.attemptClass,
      records: row.records, states: row.states,
      cancellationFraction: row.records ? row.states.cancelled / row.records : null,
      passing: row.byState.passing.measures, measuredRunnerMinutes: row.measuredRunnerMinutes,
      jobsTruncated: row.jobsTruncated })),
    mergedQueueLatencyMinutes: distribution(report.queueEpisodes.map((row) => row.minutes)),
  });
  return { before: project(before), after: project(after),
    interpretation: "Observational windows, not causal speedup or activation approval. Passing latency, all-state cancellations and measured elapsed runner minutes are separate; missing timing is unmeasured, not zero. Queue latency covers merged episodes only. Review workload and suite identities before comparing." };
}

export function markdown(report) {
  if (report.schemaVersion === 2) return eventMarkdown(report);
  const { summary } = report;
  const lines = [
    `Merge-group CI for ${report.repository}, runs created ${report.since} to ${report.until}: ${summary.runs} runs` +
      (report.truncated ? ` (truncated at ${MAX_PAGES * 100}; narrow the window)` : "") + ".",
    "",
    "| Measure (minutes) | Median | p90 | Max |",
    "| --- | --- | --- | --- |",
    ...MEASURES.map(([key, label]) => {
      const m = summary.measures[key];
      return `| ${label} | ${fixed(m.median)} | ${fixed(m.p90)} | ${fixed(m.max)} |`;
    }),
    "",
    `- Required result later than the ${summary.timeoutMinutes}-minute queue timeout: ${summary.overTimeout} of ${summary.runs}.`,
    `- Critical path spent longer waiting than executing: ${summary.waitingDominated} of ${summary.runs}.`,
    `- Aggregator never ran: ${summary.aggregatorNeverRan}. Critical path unmeasured (a job's dependency could not be identified): ${summary.criticalPathUnmeasured}.`,
    `- Queue removals in the window: ${Object.entries(summary.removalReasons).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}` +
      (report.removalsTruncated ? ` (incomplete: a pull request has more than ${MAX_PAGES * 100} removals)` : "") + ".",
    ...summary.timedOut.map((removal) => `  - #${removal.pullRequest} removed with checks_timed_out at ${removal.at}.`),
    "",
    "Times run from the run's creation, which can lag the queue entry; the queue's own window starts at the entry.",
    "Removals are counted only for pull requests with a merge-group run created in the window.",
  ];
  return lines.join("\n");
}

export function eventMarkdown(report) {
  return [
    `CI execution for ${report.repository}: ${report.records.length} attempt records.`, "",
    "| Event | Attempt | Runs | Pass | Fail | Cancel | Skip | Unfinished | Unmeasured | Required p50 / p90 (min) | Runner Minutes (Measured) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.cohorts.map((row) => `| ${row.event} | ${row.attemptClass} | ${row.records} | ${row.states.passing} | ${row.states.failing} | ${row.states.cancelled} | ${row.states.skipped} | ${row.states.unfinished} | ${row.states.unmeasured} | ${fixed(row.measures.requiredMinutes.median)} / ${fixed(row.measures.requiredMinutes.p90)} | ${fixed(row.measuredRunnerMinutes)} |`),
    "", `Pagination: ${JSON.stringify(report.pagination)}; attempts truncated: ${report.attemptsTruncated}; removals truncated: ${report.removalsTruncated}.`,
    `Retry-only run outcomes: ${report.summary.retryOnlyRuns.length}. Missing timing is unmeasured; measured runner minutes can be a lower bound.`,
    "Billing unavailable. Validation lag not yet measurable (#3631/#3632). Historical per-test timing requires the safe log projection.",
    ...(report.comparison ? ["", "Before/after natural-window comparison:", "```json", JSON.stringify(report.comparison, null, 2), "```"] : []),
  ].join("\n");
}

export function options(argv, now = new Date()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        "timeout-minutes": { type: "string", default: "120" },
        json: { type: "boolean", default: false },
        "all-events": { type: "boolean", default: false },
        input: { type: "string", multiple: true },
        baseline: { type: "string" },
        "timing-job": { type: "string", multiple: true },
        "assumed-usd-per-minute": { type: "string" },
      },
    }));
  } catch (error) {
    throw new ReportError(error.message);
  }
  const parse = (name, value) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new ReportError(`${name} must be an ISO 8601 time`);
    return time;
  };
  // Normalised to UTC, so the run listing and removal filtering read the same instants.
  const until = values.until === undefined ? now.getTime() : parse("--until", values.until);
  const since = values.since === undefined ? until - 48 * 60 * MINUTE : parse("--since", values.since);
  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!values.input && !REPOSITORY.test(values.repo ?? "")) throw new ReportError("--repo <owner>/<name> is required");
  if (values.baseline && !values.input) throw new ReportError("--baseline requires offline --input post-window.json");
  if (since >= until) throw new ReportError("--since must be before --until");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new ReportError("--timeout-minutes must be positive");
  if (values["timing-job"] && (!values["all-events"] || values["timing-job"].length > 10 ||
      values["timing-job"].some((id) => !/^[1-9][0-9]*$/.test(id))))
    throw new ReportError("--timing-job requires --all-events, positive job IDs and at most 10 jobs");
  const assumedRate = values["assumed-usd-per-minute"] === undefined ? null : Number(values["assumed-usd-per-minute"]);
  if (assumedRate !== null && (!values["all-events"] || !Number.isFinite(assumedRate) || assumedRate < 0))
    throw new ReportError("--assumed-usd-per-minute requires --all-events and a nonnegative finite rate");
  return {
    repository: values.repo, since: new Date(since).toISOString(), until: new Date(until).toISOString(), timeoutMinutes, json: values.json,
    ...(values["all-events"] ? { allEvents: true } : {}), ...(values.input ? { input: values.input } : {}),
    ...(values.baseline ? { baseline: values.baseline } : {}),
    ...(values["timing-job"] ? { timingJobs: values["timing-job"] } : {}),
    ...(assumedRate !== null ? { assumedRate } : {}),
  };
}

/** Runs the report; resolves to the process exit code. */
export async function main(argv, { env = process.env, fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  try {
    const opts = options(argv);
    if (opts.input) {
      const report = combineReports(await Promise.all(opts.input.map(async (path) => JSON.parse(await readFile(path, "utf8")))));
      if (opts.baseline) report.comparison = compareReports(JSON.parse(await readFile(opts.baseline, "utf8")), report);
      out(opts.json ? JSON.stringify(report, null, 2) : markdown(report));
      return 0;
    }
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new ReportError("Set GITHUB_TOKEN, for example GITHUB_TOKEN=$(gh auth token)");
    const report = await collect(githubApi(token, fetchImpl), opts);
    for (const id of opts.timingJobs ?? []) {
      const matches = report.records.flatMap((record) => record.jobs).filter((job) => String(job.id) === id);
      if (matches.length !== 1) throw new ReportError("--timing-job must identify exactly one collected job");
      matches[0].testTiming = await readTimingLog(token, opts.repository, id, fetchImpl);
      const record = report.records.find((row) => row.jobs.includes(matches[0]));
      if (matches[0].testTiming.summaries) {
        matches[0].testTiming.summaries = matches[0].testTiming.summaries.filter((summary) =>
          summary.context?.runId === String(record.runId) && summary.context?.attempt === record.attempt);
        if (!matches[0].testTiming.summaries.length && !matches[0].testTiming.selections?.length) {
          matches[0].testTiming.state = "unmeasured";
          matches[0].testTiming.reason = "no-matching-attempt-projection";
        }
      }
      for (const summary of matches[0].testTiming.summaries ?? []) {
        applyTimingContext(record, summary);
      }
    }
    out(opts.json ? JSON.stringify(report, null, 2) : markdown(report));
    return 0;
  } catch (error) {
    // Never print other exception messages: a parse or transport error can quote a response body.
    err(error instanceof ReportError ? error.message
      : Number.isInteger(error?.status) ? `GitHub API request failed (HTTP ${error.status})`
        : "GitHub API request failed: unreadable response or transport error");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
