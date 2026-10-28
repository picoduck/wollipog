import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { githubApi } from "./merge-group-cleanup.mjs";
import { AGGREGATOR, collect, collectEvents, criticalPath, listJobs, markdown as queueWaitMarkdown, MAX_PAGES, quantile, ReportError, summarize } from "./merge-queue-wait-report.mjs";

// Measures how every workflow in the repository shares the hosted-runner pool (#2674): runner
// occupancy over time, queued demand, and runner-minutes and runner waits per workflow and event.
// Read-only. Responses are cached on disk so the merge-queue report can reuse them without
// spending the shared API budget twice.

const MINUTE = 60_000;
const POOL = 4;
const SLICE_MS = 6 * 60 * MINUTE;
const UNSETTLED = /"status":"(queued|in_progress|waiting|pending|requested)"/;

/**
 * Wraps a GitHub API function with a response cache in `dir` and a rate-limit floor. Only
 * settled responses are cached: a listing that still shows queued or running work is refetched.
 * Before the first network call and every `checkEvery` calls, it reads the exempt rate-limit
 * endpoint and refuses to continue below `floor` remaining on either quota, so a partial
 * collection resumes from the cache instead of exhausting quota shared with other consumers.
 */
export function cachedApi(api, dir, { floor = 1500, checkEvery = 100 } = {}) {
  const stats = { hits: 0, calls: 0 };
  const wrapped = async (path, body) => {
    const key = createHash("sha256").update(JSON.stringify([path, body ?? null])).digest("hex");
    const file = join(dir, `${key}.json`);
    try {
      const cached = JSON.parse(await readFile(file, "utf8"));
      stats.hits++;
      return cached.response;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new ReportError("Unreadable API cache entry");
    }
    if (stats.calls % checkEvery === 0) {
      const limits = await api("/rate_limit");
      const remaining = [limits?.resources?.core?.remaining, limits?.resources?.graphql?.remaining];
      if (!remaining.every(Number.isSafeInteger)) throw new ReportError("Unreadable rate limit");
      if (Math.min(...remaining) < floor)
        throw new ReportError(`API budget floor ${floor} reached after ${stats.calls} calls; rerun later to resume from the cache`);
    }
    stats.calls++;
    const response = await api(path, body);
    if (!UNSETTLED.test(JSON.stringify(response))) {
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ path, response }));
      await rename(`${file}.tmp`, file);
    }
    return response;
  };
  wrapped.stats = stats;
  return wrapped;
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

/** Every workflow's runs created in [since, until), listed in six-hour slices to stay under the 1,000-result search cap. */
export async function listAllRuns(api, repository, since, until) {
  const runs = new Map();
  let truncated = false;
  for (let from = Date.parse(since); from < Date.parse(until); from += SLICE_MS) {
    const to = new Date(Math.min(from + SLICE_MS, Date.parse(until))).toISOString();
    const range = encodeURIComponent(`${new Date(from).toISOString()}..${to}`);
    let seen = 0;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) { truncated = true; break; }
      const body = await api(`/repos/${repository}/actions/runs?exclude_pull_requests=true&created=${range}&per_page=100&page=${page}`);
      if (!Array.isArray(body?.workflow_runs) || !Number.isSafeInteger(body?.total_count)) throw new ReportError("Unreadable workflow run listing");
      seen += body.workflow_runs.length;
      for (const run of body.workflow_runs) runs.set(run.id, run);
      if (seen >= body.total_count || body.workflow_runs.length === 0) break;
    }
  }
  const inWindow = [...runs.values()].filter((run) =>
    Date.parse(run.created_at) >= Date.parse(since) && Date.parse(run.created_at) < Date.parse(until));
  return { runs: inWindow.sort((a, b) => a.id - b.id), truncated };
}

/** A job held a runner only with a runner id or executed-step evidence; cancelled queued jobs keep start placeholders. */
export function allocated(job) {
  if (job.conclusion === "skipped" || !Number.isFinite(Date.parse(job.started_at))) return false;
  if (job.status === "in_progress") return true;
  return (job.runner_id ?? 0) > 0 ||
    (job.steps ?? []).some((step) => step.conclusion !== "skipped" && Number.isFinite(Date.parse(step.started_at)));
}

export function runnerClass(labels = []) {
  const names = labels.map((label) => String(label).toLowerCase());
  if (names.includes("self-hosted")) return "self-hosted";
  if (names.some((name) => name.startsWith("windows"))) return "windows";
  if (names.some((name) => name.startsWith("macos"))) return "macos";
  if (names.some((name) => name.startsWith("ubuntu"))) return "linux";
  return names.length ? "other" : "unknown";
}

/** `<workflow file without .yml>/<event>`, the unit of demand this report attributes. */
export function category(run) {
  const file = String(run.path ?? "").split("/").pop().replace(/\.ya?ml$/, "") || "unknown";
  return `${file}/${run.event}`;
}

/** Only API metadata is retained: no job logs, step names, runner names or test identities. */
export function projectJob(run, job) {
  return {
    runId: run.id, attempt: job.run_attempt ?? 1, category: category(run), event: run.event,
    workflow: run.path ?? null, pullRequest: run.pull_requests?.[0]?.number ?? null, branch: run.head_branch ?? null,
    jobId: job.id, name: job.name, status: job.status ?? null, conclusion: job.conclusion ?? null,
    createdAt: job.created_at ?? null, apiStartedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    allocated: allocated(job), runnerClass: runnerClass(job.labels),
    hosted: job.runner_group_name === "GitHub Actions" ? true : job.runner_group_name ? false : null,
  };
}

/**
 * A rerun copies the earlier attempt's finished jobs into the new attempt. A copy has the same
 * name and execution span as its original, so keep only the earliest attempt's record of it.
 */
export function dropCopiedJobs(jobs) {
  const seen = new Set();
  return [...jobs].sort((a, b) => a.attempt - b.attempt).filter((job) => {
    if (!job.allocated) return true;
    const key = `${job.runId}\0${job.name}\0${job.apiStartedAt}\0${job.completedAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function collectOccupancy(api, { repository, since, until }) {
  const { runs, truncated } = await listAllRuns(api, repository, since, until);
  let jobsTruncated = 0;
  const jobs = (await pool(runs, async (run) => {
    // An all-skipped run never asked for a runner. Unfinished runs are reported, not measured.
    if (run.status !== "completed" || run.conclusion === "skipped") return [];
    const listed = [];
    for (let attempt = 1; attempt <= Math.min(run.run_attempt ?? 1, MAX_PAGES); attempt++) {
      const listing = await listJobs(api, repository, run.id, attempt);
      if (listing.truncated) jobsTruncated++;
      listed.push(...listing.jobs.map((job) => projectJob(run, { run_attempt: attempt, ...job })));
    }
    return listed;
  })).flat();
  return {
    schemaVersion: 1, kind: "runner-occupancy", repository, since, until, collectedAt: new Date().toISOString(),
    runListingTruncated: truncated, jobListingsTruncated: jobsTruncated,
    attemptsTruncated: runs.filter((run) => (run.run_attempt ?? 1) > MAX_PAGES).length,
    runs: runs.map((run) => ({ id: run.id, category: category(run), event: run.event, workflow: run.path ?? null,
      status: run.status, conclusion: run.conclusion ?? null, attempts: run.run_attempt ?? 1,
      createdAt: run.created_at, branch: run.head_branch ?? null })),
    jobs,
  };
}

/** Combine collections, deduplicating runs by id and jobs by id. Later collections win. */
export function combineOccupancy(reports) {
  if (!reports.length || reports.some((report) => report.kind !== "runner-occupancy" || report.repository !== reports[0].repository))
    throw new ReportError("Inputs must be runner-occupancy reports for one repository");
  const sorted = [...reports].sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
  const since = sorted.map((report) => report.since).sort()[0];
  const until = sorted.map((report) => report.until).sort().at(-1);
  return { ...sorted.at(-1), since, until,
    windows: sorted.flatMap((report) => report.windows ?? [{ since: report.since, until: report.until }]),
    runListingTruncated: sorted.some((report) => report.runListingTruncated),
    jobListingsTruncated: sorted.reduce((sum, report) => sum + report.jobListingsTruncated, 0),
    attemptsTruncated: sorted.reduce((sum, report) => sum + report.attemptsTruncated, 0),
    runs: [...new Map(sorted.flatMap((report) => report.runs).map((run) => [run.id, run])).values()],
    jobs: [...new Map(sorted.flatMap((report) => report.jobs).map((job) => [job.jobId, job])).values()] };
}

/**
 * Restrict attribution (runs, per-category minutes and waits) to runs created in the half-open
 * `windows`, while keeping every collected job in the occupancy timeline, which is clipped to them.
 * Each analysis window must lie inside the contiguous span of the collected windows.
 */
export function withinWindow(report, windows) {
  const wanted = (Array.isArray(windows) ? windows : [windows]).map((item) => [Date.parse(item.since), Date.parse(item.until)])
    .sort((a, b) => a[0] - b[0]);
  if (wanted.some(([a, b], i) => !(a < b) || (i > 0 && a < wanted[i - 1][1]))) throw new ReportError("Analysis windows must be ordered and nonoverlapping");
  const collected = [];
  for (const [a, b] of (report.windows ?? [{ since: report.since, until: report.until }])
    .map((item) => [Date.parse(item.since), Date.parse(item.until)]).sort((x, y) => x[0] - y[0])) {
    if (collected.length && a <= collected.at(-1)[1]) collected.at(-1)[1] = Math.max(collected.at(-1)[1], b);
    else collected.push([a, b]);
  }
  if (!wanted.every(([a, b]) => collected.some(([c, d]) => c <= a && b <= d)))
    throw new ReportError("Each analysis window must lie inside the collected windows");
  const inside = (time) => wanted.some(([a, b]) => Date.parse(time) >= a && Date.parse(time) < b);
  const runs = report.runs.filter((run) => inside(run.createdAt));
  const ids = new Set(runs.map((run) => run.id));
  return { ...report, windows: wanted.map(([a, b]) => ({ since: new Date(a).toISOString(), until: new Date(b).toISOString() })),
    runs, jobs: report.jobs, attributedJobs: report.jobs.filter((job) => ids.has(job.runId)) };
}

/**
 * Combine the merge-queue report's original completed-merge-group view (`collect`, no
 * `--all-events`) across days, as #2674's trial cohort requires: adjacent daily windows share
 * their endpoints, so runs are deduplicated by id and removals by pull request, time and reason,
 * and every percentile is recomputed from the combined run metrics, never averaged.
 */
export function combineQueueWaitDays(reports) {
  if (!reports.length || reports.some((report) => report.schemaVersion !== undefined || !Array.isArray(report.metrics) ||
      report.repository !== reports[0].repository || report.summary?.timeoutMinutes !== reports[0].summary?.timeoutMinutes))
    throw new ReportError("Inputs must be original merge-queue reports for one repository and timeout");
  const metrics = [...new Map(reports.flatMap((report) => report.metrics).map((metric) => [metric.id, metric])).values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const removals = [...new Map(reports.flatMap((report) => [...report.summary.timedOut,
    ...(report.removals ?? [])]).map((removal) => [`${removal.pullRequest}/${removal.at}/${removal.reason}`, removal])).values()];
  const since = reports.map((report) => report.since).sort()[0], until = reports.map((report) => report.until).sort().at(-1);
  const summary = summarize(metrics, removals, reports[0].summary.timeoutMinutes);
  // The original report keeps only timed-out removals in full; other reasons survive as counts.
  // Shared endpoints can repeat a non-timeout removal, which counts cannot deduplicate, so
  // report the per-day sums beside an explicit duplicate-risk flag rather than guess.
  const reasonSums = {};
  for (const report of reports) for (const [reason, count] of Object.entries(report.summary.removalReasons))
    if (reason !== "checks_timed_out") reasonSums[reason] = (reasonSums[reason] ?? 0) + count;
  summary.removalReasons = { ...reasonSums, ...(summary.timedOut.length ? { checks_timed_out: summary.timedOut.length } : {}) };
  return { repository: reports[0].repository, since, until,
    windows: reports.map((report) => ({ since: report.since, until: report.until })).sort((a, b) => a.since.localeCompare(b.since)),
    truncated: reports.some((report) => report.truncated), removalsTruncated: reports.some((report) => report.removalsTruncated),
    duplicateRunsDropped: reports.reduce((sum, report) => sum + report.metrics.length, 0) - metrics.length,
    nonTimeoutRemovalCountsMayRepeatAtSharedEndpoints: true,
    metrics, summary };
}

const span = (from, to) => {
  const value = (Date.parse(to) - Date.parse(from)) / MINUTE;
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const distribution = (values) => {
  const finite = values.filter(Number.isFinite);
  return { measured: finite.length, median: quantile(finite, 0.5), p90: quantile(finite, 0.9), max: quantile(finite, 1),
    total: finite.reduce((sum, value) => sum + value, 0) };
};

/**
 * Piecewise-constant counts of jobs holding a runner and jobs waiting for one, clipped to the
 * window. Waiting runs from creation to start; a job cancelled before allocation waited until it
 * completed. Returns segments of [from, to, running, queued].
 */
export function timeline(jobs, since, until) {
  const lo = Date.parse(since), hi = Date.parse(until);
  // The window bounds are events too, so idle stretches count toward every time fraction.
  const deltas = new Map(lo < hi ? [[lo, [0, 0]], [hi, [0, 0]]] : []);
  const add = (from, to, field) => {
    const a = Math.max(lo, from), b = Math.min(hi, to);
    if (!(a < b)) return;
    for (const [time, sign] of [[a, 1], [b, -1]]) {
      const delta = deltas.get(time) ?? [0, 0];
      delta[field] += sign;
      deltas.set(time, delta);
    }
  };
  for (const job of jobs) {
    const created = Date.parse(job.createdAt), started = Date.parse(job.apiStartedAt), completed = Date.parse(job.completedAt);
    if (job.allocated && Number.isFinite(started) && Number.isFinite(completed)) {
      if (Number.isFinite(created) && created < started) add(created, started, 1);
      add(started, completed, 0);
    } else if (job.conclusion !== "skipped" && Number.isFinite(created) && Number.isFinite(completed)) {
      add(created, completed, 1);
    }
  }
  const times = [...deltas.keys()].sort((a, b) => a - b);
  const segments = [];
  let running = 0, queued = 0;
  for (let i = 0; i < times.length; i++) {
    const [r, q] = deltas.get(times[i]);
    running += r;
    queued += q;
    if (i + 1 < times.length) segments.push([times[i], times[i + 1], running, queued]);
  }
  return segments;
}

/** Running count just after `time`, from a timeline. */
export function runningAt(segments, time) {
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid][1] <= time) lo = mid + 1;
    else if (segments[mid][0] > time) hi = mid - 1;
    else return segments[mid][2];
  }
  return 0;
}

function occupancy(segments, ceiling) {
  const total = segments.reduce((sum, [a, b]) => sum + (b - a), 0);
  const weighted = (predicate) => segments.reduce((sum, segment) => sum + (predicate(segment) ? segment[1] - segment[0] : 0), 0);
  const queuedMs = segments.reduce((sum, [a, b, , q]) => sum + q * (b - a), 0);
  const queuedNearCeilingMs = segments.reduce((sum, [a, b, r, q]) => sum + (r >= ceiling - 1 ? q * (b - a) : 0), 0);
  const fraction = (value) => total > 0 ? value / total : null;
  return {
    observedMinutes: total / MINUTE,
    peakRunning: Math.max(0, ...segments.map((segment) => segment[2])),
    peakDemand: Math.max(0, ...segments.map((segment) => segment[2] + segment[3])),
    meanRunning: fraction(segments.reduce((sum, [a, b, r]) => sum + r * (b - a), 0)),
    meanQueued: fraction(queuedMs),
    atCeiling: fraction(weighted(([, , r]) => r >= ceiling)),
    atCeilingMinusOne: fraction(weighted(([, , r]) => r === ceiling - 1)),
    demandOverCeiling: fraction(weighted(([, , r, q]) => r + q > ceiling)),
    anyQueued: fraction(weighted(([, , , q]) => q > 0)),
    queuedJobMinutes: queuedMs / MINUTE,
    // Waiting while the pool is at or one below its ceiling is consistent with slot contention;
    // waiting while it is well below is not explained by the concurrency limit.
    queuedNearCeilingShare: queuedMs > 0 ? queuedNearCeilingMs / queuedMs : null,
  };
}

/** Which merge-group job sat on the critical path and how long it waited for a runner there. */
export function mergeGroupCriticalWaits(jobs, runs) {
  const created = new Map(runs.map((run) => [run.id, run.createdAt]));
  const byRun = new Map();
  for (const job of jobs) {
    if (job.category !== "ci/merge_group" || job.attempt !== 1) continue;
    byRun.set(job.runId, [...(byRun.get(job.runId) ?? []), job]);
  }
  const perJob = new Map();
  let measured = 0;
  for (const [runId, list] of byRun) {
    const raw = list.filter((job) => job.allocated && job.conclusion !== "skipped").map((job) => ({ name: job.name,
      conclusion: job.conclusion, created_at: job.createdAt, started_at: job.apiStartedAt, completed_at: job.completedAt }));
    const aggregator = raw.find((job) => job.name === AGGREGATOR);
    if (!aggregator || !created.has(runId)) continue;
    const path = criticalPath({ created_at: created.get(runId) }, aggregator, raw.filter((job) => job !== aggregator));
    if (!path) continue;
    measured++;
    for (const job of path) {
      const entry = perJob.get(job.name) ?? { onPath: 0, waits: [], executions: [] };
      entry.onPath++;
      entry.waits.push(span(job.created_at, job.started_at));
      entry.executions.push(span(job.started_at, job.completed_at));
      perJob.set(job.name, entry);
    }
  }
  return { runs: byRun.size, measured, jobs: Object.fromEntries([...perJob].sort((a, b) => b[1].onPath - a[1].onPath)
    .map(([name, entry]) => [name, { onPath: entry.onPath, runnerWait: distribution(entry.waits), execution: distribution(entry.executions) }])) };
}

/**
 * A modeled scenario, written `capacity=20[,priority=<category>][,drop=<regex>][,limit=<k>:<regex>]`.
 * `priority` serves that category's waiting jobs first; `drop` removes jobs whose
 * `<category>|<name>|<run id>` matches; `limit` lets at most `k` matching jobs of one run hold slots at once,
 * as a matrix `max-parallel` would.
 */
export function parseScenario(text) {
  const fields = Object.fromEntries(String(text).split(",").map((part) => {
    const at = part.indexOf("=");
    return at > 0 ? [part.slice(0, at), part.slice(at + 1)] : [part, ""];
  }));
  const capacity = Number(fields.capacity);
  const limitMatch = fields.limit === undefined ? null : /^([1-9][0-9]*):(.+)$/.exec(fields.limit);
  if (!Number.isSafeInteger(capacity) || capacity < 1 || (fields.limit !== undefined && !limitMatch) ||
      Object.keys(fields).some((key) => !["capacity", "priority", "drop", "limit"].includes(key)))
    throw new ReportError(`Unreadable scenario ${JSON.stringify(text)}: use capacity=<n>[,priority=<category>][,drop=<regex>][,limit=<k>:<regex>]`);
  const pattern = (source) => {
    try {
      return new RegExp(source);
    } catch {
      throw new ReportError(`Unreadable scenario pattern ${JSON.stringify(source)}`);
    }
  };
  return { label: String(text), capacity, priority: fields.priority || null, drop: fields.drop ? pattern(fields.drop) : null,
    limit: limitMatch ? { count: Number(limitMatch[1]), pattern: pattern(limitMatch[2]) } : null };
}

/**
 * Trace-driven replay of runner allocation: each job that held a runner becomes ready when GitHub
 * created it and runs for its observed execution time on one of `capacity` slots. Waiting jobs are
 * served first-come first-served, or the `priority` category first, subject to any per-run
 * `limit`. Creation times are held at their observed values, so a dependent job is not created
 * earlier when its dependencies finish sooner; that model assumption is stated with every result.
 * Returns modeled waits by job id.
 */
export function replay(jobs, { capacity, priority = null, drop = null, limit = null }) {
  const label = (job) => `${job.category}|${job.name}|${job.runId}`;
  const pending = jobs.filter((job) => job.allocated && (!drop || !drop.test(label(job))))
    .map((job) => ({ id: job.jobId, run: job.runId, ready: Date.parse(job.createdAt),
      service: Date.parse(job.completedAt) - Date.parse(job.apiStartedAt),
      level: priority !== null && job.category === priority ? 0 : 1, limited: Boolean(limit?.pattern.test(label(job))) }))
    .filter((item) => Number.isFinite(item.ready) && Number.isFinite(item.service) && item.service >= 0)
    .sort((a, b) => a.ready - b.ready || a.id - b.id);
  const running = []; // ordered by end time; never more than `capacity` entries
  const limitedByRun = new Map();
  const waiting = [[], []];
  const waits = new Map();
  const eligible = (item) => !item.limited || (limitedByRun.get(item.run) ?? 0) < limit.count;
  let next = 0, time = -Infinity;
  for (;;) {
    while (running.length && running[0].end <= time) {
      const done = running.shift();
      if (done.limited) limitedByRun.set(done.run, limitedByRun.get(done.run) - 1);
    }
    while (next < pending.length && pending[next].ready <= time) waiting[pending[next].level].push(pending[next++]);
    while (running.length < capacity) {
      let chosen = null;
      for (const queue of waiting) {
        const index = queue.findIndex(eligible);
        if (index >= 0) {
          chosen = queue.splice(index, 1)[0];
          break;
        }
      }
      if (!chosen) break;
      waits.set(chosen.id, (time - chosen.ready) / MINUTE);
      if (chosen.limited) limitedByRun.set(chosen.run, (limitedByRun.get(chosen.run) ?? 0) + 1);
      const entry = { end: time + chosen.service, run: chosen.run, limited: chosen.limited };
      let at = running.length;
      while (at > 0 && running[at - 1].end > entry.end) at--;
      running.splice(at, 0, entry);
    }
    const queued = waiting.some((queue) => queue.length > 0);
    const arrival = next < pending.length ? pending[next].ready : Infinity;
    const completion = running.length && queued ? running[0].end : Infinity;
    if (arrival === Infinity && completion === Infinity) break;
    time = Math.min(arrival, completion);
  }
  return waits;
}

/**
 * Modeled merge-group latency: each measured first attempt's required-result time with the
 * observed runner waits of its critical-path jobs replaced by modeled waits.
 */
function modeledRequired(jobs, runs, waits) {
  const created = new Map(runs.map((run) => [run.id, run.createdAt]));
  const byRun = new Map();
  for (const job of jobs) if (job.category === "ci/merge_group" && job.attempt === 1 && job.allocated)
    byRun.set(job.runId, [...(byRun.get(job.runId) ?? []), job]);
  const observed = [], modeled = [];
  for (const [runId, list] of byRun) {
    const raw = list.map((job) => ({ id: job.jobId, name: job.name, conclusion: job.conclusion,
      created_at: job.createdAt, started_at: job.apiStartedAt, completed_at: job.completedAt }));
    const aggregator = raw.find((job) => job.name === AGGREGATOR);
    if (!aggregator || !created.has(runId)) continue;
    const path = criticalPath({ created_at: created.get(runId) }, aggregator, raw.filter((job) => job !== aggregator));
    if (!path || path.some((job) => !waits.has(job.id))) continue;
    const required = span(created.get(runId), aggregator.completed_at);
    if (required === null) continue;
    observed.push(required);
    modeled.push(required + path.reduce((sum, job) => sum + waits.get(job.id) - span(job.created_at, job.started_at), 0));
  }
  return { observed: distribution(observed), modeled: distribution(modeled),
    overSixty: { observed: observed.filter((value) => value > 60).length, modeled: modeled.filter((value) => value > 60).length },
    overTimeout: { observed: observed.filter((value) => value > 120).length, modeled: modeled.filter((value) => value > 120).length } };
}

export function scenarios(occupying, attributed, runs, specs) {
  const attributedIds = new Set(attributed.filter((job) => job.allocated && job.attempt === 1).map((job) => job.jobId));
  return specs.map((spec) => {
    const waits = replay(occupying, spec);
    const categories = {};
    for (const job of attributed) {
      if (!attributedIds.has(job.jobId) || !waits.has(job.jobId)) continue;
      (categories[job.category] ??= []).push(waits.get(job.jobId));
    }
    return { scenario: spec.label, capacity: spec.capacity, priority: spec.priority, drop: spec.drop?.source ?? null,
      limit: spec.limit ? { count: spec.limit.count, pattern: spec.limit.pattern.source } : null,
      assumption: "Observed creation times and execution spans; FIFO or category priority on uniform slots; macOS sub-limit ignored.",
      categories: Object.fromEntries(Object.entries(categories).sort().map(([name, values]) => [name, distribution(values)])),
      mergeGroupRequired: modeledRequired(attributed, runs, waits) };
  });
}

export function analyze(report, { ceiling = 20, longWaitMinutes = 5, scenarios: specs = [] } = {}) {
  const occupying = dropCopiedJobs(report.jobs);
  const jobs = report.attributedJobs ? dropCopiedJobs(report.attributedJobs) : occupying;
  const windows = report.windows ?? [{ since: report.since, until: report.until }];
  const segments = windows.flatMap((window) => timeline(occupying, window.since, window.until));
  const categories = {};
  const runsByCategory = new Map();
  for (const run of report.runs) runsByCategory.set(run.category, [...(runsByCategory.get(run.category) ?? []), run]);
  const totalMinutes = jobs.filter((job) => job.allocated).reduce((sum, job) => sum + (span(job.apiStartedAt, job.completedAt) ?? 0), 0);
  for (const name of [...new Set([...runsByCategory.keys(), ...jobs.map((job) => job.category)])].sort()) {
    const own = jobs.filter((job) => job.category === name);
    const held = own.filter((job) => job.allocated);
    const runnerMinutes = held.reduce((sum, job) => sum + (span(job.apiStartedAt, job.completedAt) ?? 0), 0);
    const runs = runsByCategory.get(name) ?? [];
    categories[name] = {
      runs: runs.length, unfinishedRuns: runs.filter((run) => run.status !== "completed").length,
      skippedRuns: runs.filter((run) => run.conclusion === "skipped").length,
      jobs: own.length, allocatedJobs: held.length,
      cancelledBeforeRunner: own.filter((job) => !job.allocated && job.conclusion === "cancelled").length,
      runnerMinutes, share: totalMinutes > 0 ? runnerMinutes / totalMinutes : null,
      // Minutes of jobs that held a runner and ended cancelled, for example superseded PR CI.
      cancelledRunnerMinutes: held.filter((job) => job.conclusion === "cancelled")
        .reduce((sum, job) => sum + (span(job.apiStartedAt, job.completedAt) ?? 0), 0),
      runnerWait: distribution(held.filter((job) => job.attempt === 1).map((job) => span(job.createdAt, job.apiStartedAt))),
      runnerClasses: Object.fromEntries([...new Set(held.map((job) => job.runnerClass))].sort()
        .map((kind) => [kind, held.filter((job) => job.runnerClass === kind).length])),
    };
  }
  const longWaits = jobs.filter((job) => job.allocated && job.attempt === 1 && (span(job.createdAt, job.apiStartedAt) ?? 0) > longWaitMinutes);
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const own = segments.flatMap(([a, b, r, q]) => {
      const pieces = [];
      for (let t = a; t < b;) {
        const end = Math.min(b, Math.floor(t / (60 * MINUTE)) * 60 * MINUTE + 60 * MINUTE);
        if (new Date(t).getUTCHours() === hour) pieces.push([t, end, r, q]);
        t = end;
      }
      return pieces;
    });
    return { hour, ...occupancy(own, ceiling) };
  });
  const days = {};
  for (const job of jobs.filter((item) => item.allocated)) {
    const day = String(job.apiStartedAt).slice(0, 10);
    days[day] ??= {};
    days[day][job.category] = (days[day][job.category] ?? 0) + (span(job.apiStartedAt, job.completedAt) ?? 0);
  }
  return {
    repository: report.repository, windows, collectedAt: report.collectedAt, ceiling,
    completeness: { runs: report.runs.length, jobs: jobs.length, copiedJobsDropped: report.jobs.length - occupying.length,
      unfinishedRuns: report.runs.filter((run) => run.status !== "completed").length,
      runListingTruncated: report.runListingTruncated, jobListingsTruncated: report.jobListingsTruncated,
      attemptsTruncated: report.attemptsTruncated,
      runnerClasses: Object.fromEntries([...new Set(jobs.filter((job) => job.allocated).map((job) => job.runnerClass))].sort()
        .map((kind) => [kind, jobs.filter((job) => job.allocated && job.runnerClass === kind).length])),
      hostedAllocations: jobs.filter((job) => job.allocated && job.hosted === true).length,
      nonHostedAllocations: jobs.filter((job) => job.allocated && job.hosted === false).length },
    occupancy: occupancy(segments, ceiling),
    longWaits: { thresholdMinutes: longWaitMinutes, jobs: longWaits.length,
      runningAtCreation: distribution(longWaits.map((job) => runningAt(segments, Date.parse(job.createdAt)))) },
    totalRunnerMinutes: totalMinutes,
    categories, hours, days,
    mergeGroupCriticalPath: mergeGroupCriticalWaits(jobs, report.runs),
    scenarios: specs.length ? scenarios(occupying, jobs, report.runs, specs) : [],
  };
}

const fixed = (value, digits = 1) => value === null || value === undefined ? "—" : value.toFixed(digits);
const percent = (value) => value === null || value === undefined ? "—" : `${(100 * value).toFixed(1)}%`;

export function markdown(result) {
  const o = result.occupancy;
  return [
    `Runner occupancy for ${result.repository}, ${result.windows.map((w) => `${w.since}..${w.until}`).join(", ")}: ` +
      `${result.completeness.runs} runs, ${result.completeness.jobs} jobs, ${fixed(result.totalRunnerMinutes, 0)} runner-minutes.`,
    "",
    `Peak running ${o.peakRunning} (ceiling ${result.ceiling}); peak demand ${o.peakDemand}; mean running ${fixed(o.meanRunning)}; ` +
      `at ceiling ${percent(o.atCeiling)}, one below ${percent(o.atCeilingMinusOne)}; demand over ceiling ${percent(o.demandOverCeiling)}; ` +
      `queued job-minutes ${fixed(o.queuedJobMinutes, 0)}, ${percent(o.queuedNearCeilingShare)} of them with the pool within one job of the ceiling.`,
    `Jobs waiting over ${result.longWaits.thresholdMinutes} min: ${result.longWaits.jobs}; running at their creation p50 ${fixed(result.longWaits.runningAtCreation.median, 0)}.`,
    "",
    "| Workflow / Event | Runs | Jobs Run | Runner Minutes | Share | Wait p50 / p90 / Max (min) |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...Object.entries(result.categories).sort((a, b) => b[1].runnerMinutes - a[1].runnerMinutes).map(([name, c]) =>
      `| ${name} | ${c.runs} | ${c.allocatedJobs} | ${fixed(c.runnerMinutes, 0)} | ${percent(c.share)} | ` +
      `${fixed(c.runnerWait.median)} / ${fixed(c.runnerWait.p90)} / ${fixed(c.runnerWait.max)} |`),
    "",
    ...(result.scenarios.length ? [
      "| Modeled Scenario | Merge-Group Job Wait p50 / p90 | PR Job Wait p50 / p90 | Merge-Group Required p50 / p90 (Observed p50 / p90) | Required > 60 / > 120 |",
      "| --- | --- | --- | --- | --- |",
      ...result.scenarios.map((s) => {
        const group = s.categories["ci/merge_group"], pr = s.categories["ci/pull_request"], req = s.mergeGroupRequired;
        return `| ${s.scenario} | ${fixed(group?.median)} / ${fixed(group?.p90)} | ${fixed(pr?.median)} / ${fixed(pr?.p90)} | ` +
          `${fixed(req.modeled.median)} / ${fixed(req.modeled.p90)} (${fixed(req.observed.median)} / ${fixed(req.observed.p90)}) | ` +
          `${req.overSixty.modeled} / ${req.overTimeout.modeled} of ${req.modeled.measured} |`;
      }), ""] : []),
    `Completeness: ${JSON.stringify(result.completeness)}.`,
  ].join("\n");
}

export function options(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      repo: { type: "string" }, since: { type: "string" }, until: { type: "string" }, cache: { type: "string" },
      input: { type: "string", multiple: true }, json: { type: "boolean", default: false },
      ceiling: { type: "string", default: "20" }, floor: { type: "string", default: "1500" },
      "queue-wait": { type: "boolean", default: false }, "all-events": { type: "boolean", default: false },
      "timeout-minutes": { type: "string", default: "120" }, scenario: { type: "string", multiple: true },
      "queue-wait-input": { type: "string", multiple: true }, window: { type: "string", multiple: true },
    } }));
  } catch (error) {
    throw new ReportError(error.message);
  }
  const ceiling = Number(values.ceiling), floor = Number(values.floor);
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new ReportError("--ceiling must be a positive integer");
  if (!Number.isSafeInteger(floor) || floor < 0) throw new ReportError("--floor must be a nonnegative integer");
  if (values["queue-wait-input"]) return { queueWaitInput: values["queue-wait-input"], json: values.json };
  if (values.input) {
    // Analyze sub-windows of the combined collection: jobs outside them still occupy runners inside them.
    if ((values.since === undefined) !== (values.until === undefined)) throw new ReportError("--since and --until go together");
    const texts = [...(values.since === undefined ? [] : [`${values.since}..${values.until}`]), ...(values.window ?? [])];
    const windows = texts.map((text) => {
      const [since, until, extra] = text.split("..").map((part) => Date.parse(part));
      if (extra !== undefined || !(Number.isFinite(since) && Number.isFinite(until) && since < until))
        throw new ReportError("--since and --until must be ordered ISO 8601 times; --window is <since>..<until>");
      return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
    });
    return { input: values.input, json: values.json, ceiling, scenarios: (values.scenario ?? []).map(parseScenario),
      ...(windows.length ? { windows } : {}) };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo ?? "")) throw new ReportError("--repo <owner>/<name> is required");
  if (!values.cache) throw new ReportError("--cache <directory> is required for collection");
  const since = Date.parse(values.since), until = Date.parse(values.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new ReportError("--since and --until must be ordered ISO 8601 times");
  return { repository: values.repo, since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    cache: values.cache, json: values.json, ceiling, floor, queueWait: values["queue-wait"], allEvents: values["all-events"],
    timeoutMinutes: Number(values["timeout-minutes"]) };
}

/** Runs the report; resolves to the process exit code. */
export async function main(argv, { env = process.env, fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  try {
    const opts = options(argv);
    if (opts.queueWaitInput) {
      const combined = combineQueueWaitDays(await Promise.all(opts.queueWaitInput.map(async (path) => JSON.parse(await readFile(path, "utf8")))));
      out(opts.json ? JSON.stringify(combined, null, 2) : queueWaitMarkdown(combined));
      return 0;
    }
    if (opts.input) {
      const combined = combineOccupancy(await Promise.all(opts.input.map(async (path) => JSON.parse(await readFile(path, "utf8")))));
      const result = analyze(opts.windows ? withinWindow(combined, opts.windows) : combined, { ceiling: opts.ceiling, scenarios: opts.scenarios });
      out(opts.json ? JSON.stringify(result, null, 2) : markdown(result));
      return 0;
    }
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new ReportError("Set GITHUB_TOKEN, for example GITHUB_TOKEN=$(gh auth token)");
    const api = cachedApi(githubApi(token, fetchImpl), opts.cache, { floor: opts.floor });
    // The merge-queue report's own collectors, unchanged, reading through the same cache.
    const report = opts.queueWait
      ? await (opts.allEvents ? collectEvents : collect)(api, opts)
      : await collectOccupancy(api, opts);
    err(`API calls ${api.stats.calls}, cache hits ${api.stats.hits}`);
    out(JSON.stringify(report, null, opts.json ? 2 : 0));
    return 0;
  } catch (error) {
    err(error instanceof ReportError ? error.message
      : Number.isInteger(error?.status) ? `GitHub API request failed (HTTP ${error.status})`
        : "GitHub API request failed: unreadable response or transport error");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
