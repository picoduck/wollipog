import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { githubApi } from "./merge-group-cleanup.mjs";

// Splits merge-group CI time into waiting for a runner and executing, so a queue entry that
// expires can be attributed to one or the other (#2674). Read-only: it lists runs, jobs and
// merge-queue removals, and never changes anything.

export const AGGREGATOR = "Typecheck, Test & Sidecar Bundle";
const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-([1-9][0-9]*)-[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const MAX_PAGES = 10;
const POOL = 6;
const MINUTE = 60_000;
// GitHub creates a job within seconds of its last dependency finishing.
const DEPENDENCY_SLACK_MS = 5_000;

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
  return Number.isFinite(span) ? span / MINUTE : null;
};
const latest = (jobs) => jobs.reduce((last, job) => !last || Date.parse(job.completed_at) > Date.parse(last.completed_at) ? job : last, null);

export function pullRequestOf(branch) {
  const match = QUEUE_BRANCH.exec(branch ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * The chain of executed jobs ending at `job`, newest first. A job created after the run started
 * was created when its last dependency finished, which is the latest job to complete by then; a
 * job created with the run has no dependency. The jobs API does not name dependencies, so this is
 * reconstructed from timing.
 */
export function criticalPath(run, job, work) {
  const path = [job];
  const started = Date.parse(run.created_at);
  for (let current = job; Date.parse(current.created_at) - started > DEPENDENCY_SLACK_MS;) {
    const created = Date.parse(current.created_at);
    const previous = latest(work.filter((candidate) =>
      !path.includes(candidate) && Date.parse(candidate.completed_at) <= created + DEPENDENCY_SLACK_MS));
    if (!previous) break;
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
  const executed = jobs.filter((job) => job.conclusion !== "skipped" && job.started_at && job.completed_at);
  const aggregator = executed.find((job) => job.name === AGGREGATOR) ?? null;
  const work = executed.filter((job) => job !== aggregator);
  const waits = executed.map((job) => minutes(job.created_at, job.started_at)).filter((value) => value !== null);
  const requiredMinutes = aggregator ? minutes(run.created_at, aggregator.completed_at) : null;
  const executionMinutes = aggregator
    ? criticalPath(run, aggregator, work).reduce((sum, job) => sum + minutes(job.started_at, job.completed_at), 0) : null;
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
export async function listRuns(api, repository, since, until) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&status=completed` +
      `&exclude_pull_requests=true&created=${encodeURIComponent(`${since}..${until}`)}&per_page=100&page=${page}`);
    if (!Array.isArray(body?.workflow_runs) || !Number.isSafeInteger(body?.total_count))
      throw new ReportError("Unreadable workflow run listing");
    runs.push(...body.workflow_runs);
    if (runs.length >= body.total_count || body.workflow_runs.length === 0) return { runs, truncated: false };
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

export async function collect(api, { repository, since, until, timeoutMinutes }) {
  const { runs, truncated } = await listRuns(api, repository, since, until);
  const ci = runs.filter((run) => run?.path === ".github/workflows/ci.yml" && run?.event === "merge_group");
  const metrics = await pool(ci, async (run) => {
    // The first attempt is the one the queue waited on. A rerun copies the earlier attempt's
    // finished jobs with new creation times, so its timeline cannot be read as waits.
    const body = await api(`/repos/${repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
    if (!Array.isArray(body?.jobs)) throw new ReportError("Unreadable job listing");
    return runMetrics(run, body.jobs);
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

const fixed = (value) => value === null ? "—" : value.toFixed(1);

export function markdown(report) {
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
    `- Aggregator never ran: ${summary.aggregatorNeverRan}.`,
    `- Queue removals in the window: ${Object.entries(summary.removalReasons).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}` +
      (report.removalsTruncated ? ` (incomplete: a pull request has more than ${MAX_PAGES * 100} removals)` : "") + ".",
    ...summary.timedOut.map((removal) => `  - #${removal.pullRequest} removed with checks_timed_out at ${removal.at}.`),
    "",
    "Times run from the run's creation, which can lag the queue entry; the queue's own window starts at the entry.",
    "Removals are counted only for pull requests with a merge-group run created in the window.",
  ];
  return lines.join("\n");
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
  if (!REPOSITORY.test(values.repo ?? "")) throw new ReportError("--repo <owner>/<name> is required");
  if (since >= until) throw new ReportError("--since must be before --until");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new ReportError("--timeout-minutes must be positive");
  return {
    repository: values.repo, since: new Date(since).toISOString(), until: new Date(until).toISOString(), timeoutMinutes, json: values.json,
  };
}

/** Runs the report; resolves to the process exit code. */
export async function main(argv, { env = process.env, fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  try {
    const opts = options(argv);
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new ReportError("Set GITHUB_TOKEN, for example GITHUB_TOKEN=$(gh auth token)");
    const report = await collect(githubApi(token, fetchImpl), opts);
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
