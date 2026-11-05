import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { timingQuality } from "./ci-job-timing.mjs";
import { AGGREGATOR, ADVISORY_JOBS, criticalPath, combineReports, quantile } from "./merge-queue-wait-report.mjs";

const minutes = (a, b) => {
  const span = Date.parse(b) - Date.parse(a);
  return Number.isFinite(span) && span >= 0 ? span / 60_000 : null;
};
const raw = (job) => ({ ...job, created_at: job.createdAt, started_at: job.apiStartedAt,
  completed_at: job.completedAt, steps: job.steps.map((step) => ({ ...step,
    started_at: step.startedAt, completed_at: step.completedAt })) });

/** Partition a first-attempt job without treating unexplained clocks as execution. */
export function splitJob(job, attempt = 1) {
  const quality = timingQuality(job);
  const observedIntervalMinutes = minutes(job.apiStartedAt, job.completedAt);
  const result = { id: job.id, name: job.name, state: job.state, createdAt: job.createdAt,
    startedAt: job.startedAt, apiStartedAt: job.apiStartedAt, completedAt: job.completedAt,
    timingQuality: quality, observedIntervalMinutes,
    steps: job.steps.map((step) => ({ number: step.number, state: step.state,
      conclusion: step.conclusion, startedAt: step.startedAt, completedAt: step.completedAt })),
    runnerWaitMinutes: null, stepExecutionMinutes: null, runnerOverheadMinutes: null,
    finalizationMinutes: null, unmeasuredIntervalMinutes: null };
  if (job.state === "skipped") return { ...result, runnerWaitMinutes: 0,
    stepExecutionMinutes: 0, runnerOverheadMinutes: 0, finalizationMinutes: 0 };
  if (!job.startedAt) return result;
  if (attempt !== 1 || quality.state === "unmeasured-allocation")
    return { ...result, unmeasuredIntervalMinutes: observedIntervalMinutes };
  result.runnerWaitMinutes = minutes(job.createdAt, job.startedAt);
  const steps = job.steps.filter((step) => step.state !== "skipped" && step.conclusion !== "skipped");
  if (!steps.length || steps.some((step) => minutes(step.startedAt, step.completedAt) === null)) return result;
  // Union intervals: overlapping steps must never count twice.
  const intervals = steps.map((step) => [Date.parse(step.startedAt), Date.parse(step.completedAt)])
    .sort((a, b) => a[0] - b[0]);
  let execution = 0, end = -Infinity;
  for (const [a, b] of intervals) { execution += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  result.stepExecutionMinutes = execution / 60_000;
  result.finalizationMinutes = minutes(new Date(end).toISOString(), job.completedAt);
  result.runnerOverheadMinutes = observedIntervalMinutes === null || result.finalizationMinutes === null ? null
    : observedIntervalMinutes - result.stepExecutionMinutes - result.finalizationMinutes;
  return result;
}

const distribution = (values) => ({ measured: values.filter(Number.isFinite).length,
  median: quantile(values, 0.5), p90: quantile(values, 0.9), max: quantile(values, 1) });

export function analyzeReports(reports) {
  const source = combineReports(reports);
  const records = source.records.map((row) => {
    const jobs = row.jobs.map((job) => raw(job));
    const aggregator = jobs.find((job) => job.name === AGGREGATOR);
    const work = jobs.filter((job) => job !== aggregator && (job.startedAt ||
      job.name === "PR Suite Routing" && job.state === "skipped"));
    const path = row.attempt === 1 && !row.jobsTruncated && aggregator?.startedAt
      ? criticalPath({ created_at: row.createdAt }, aggregator, work) : null;
    const pathIds = path?.map((job) => job.id) ?? null;
    const split = row.jobs.map((job) => ({ ...splitJob(job, row.attempt),
      onCriticalPath: pathIds ? pathIds.includes(job.id) : null }));
    const dependencies = row.jobs.filter((job) => job.name !== AGGREGATOR && !ADVISORY_JOBS.has(job.name));
    const latest = dependencies.every((job) => Number.isFinite(Date.parse(job.completedAt)) &&
      timingQuality(job).state !== "unmeasured-allocation")
      ? dependencies.map((job) => job.completedAt).sort().at(-1) : null;
    const requiredResultMinutes = row.attempt === 1 && aggregator?.startedAt
      ? minutes(row.createdAt, aggregator.completedAt) : null;
    const criticalJobs = split.filter((job) => job.onCriticalPath);
    const allocated = pathIds && criticalJobs.every((job) => job.runnerWaitMinutes !== null &&
      (job.state === "skipped" || job.observedIntervalMinutes !== null))
      ? criticalJobs.reduce((sum, job) => sum + job.runnerWaitMinutes +
        (job.state === "skipped" ? 0 : job.observedIntervalMinutes), 0) : null;
    return { runId: row.runId, attempt: row.attempt, event: row.event, state: row.state,
      pullRequest: row.pullRequest, sha: row.sha, createdAt: row.createdAt, window: row.window,
      requiredResultMinutes, schedulingGapMinutes: requiredResultMinutes !== null && allocated !== null
        ? requiredResultMinutes - allocated : null,
      criticalPathJobIds: pathIds, dependencyCompletionToAggregatorStartMinutes:
        row.attempt === 1 && !row.jobsTruncated && latest && aggregator?.startedAt &&
          timingQuality(aggregator).state !== "unmeasured-allocation" ? minutes(latest, aggregator.startedAt) : null,
      jobs: split };
  });
  const summary = ["pull_request", "merge_group"].map((event) => {
    const rows = records.filter((row) => row.event === event && row.attempt === 1);
    const critical = rows.flatMap((row) => row.jobs.filter((job) => job.onCriticalPath));
    const totals = (key) => rows.map((row) => row.criticalPathJobIds &&
      row.jobs.filter((job) => job.onCriticalPath).every((job) => job[key] !== null)
      ? row.jobs.filter((job) => job.onCriticalPath).reduce((sum, job) => sum + job[key], 0) : null);
    return { event, firstAttempts: rows.length, passing: rows.filter((row) => row.state === "passing").length,
      identifiedCriticalPaths: rows.filter((row) => row.criticalPathJobIds).length,
      requiredResultMinutes: distribution(rows.map((row) => row.requiredResultMinutes)),
      passingRequiredResultMinutes: distribution(rows.filter((row) => row.state === "passing").map((row) => row.requiredResultMinutes)),
      dependencyCompletionToAggregatorStartMinutes: distribution(rows.map((row) => row.dependencyCompletionToAggregatorStartMinutes)),
      criticalRunnerWaitMinutes: distribution(totals("runnerWaitMinutes")),
      criticalStepExecutionMinutes: distribution(totals("stepExecutionMinutes")),
      criticalFinalizationMinutes: distribution(totals("finalizationMinutes")),
      criticalRunnerOverheadMinutes: distribution(totals("runnerOverheadMinutes")),
      criticalJobs: critical.length,
      schedulingGapMinutes: distribution(rows.map((row) => row.schedulingGapMinutes)),
      conflictJobs: rows.flatMap((row) => row.jobs).filter((job) => job.timingQuality.state === "unmeasured-allocation").length };
  });
  return { schemaVersion: 1, repository: source.repository, collectedAt: source.collectedAt,
    windows: source.windows, pagination: source.pagination, attemptsTruncated: source.attemptsTruncated,
    removalsTruncated: source.removalsTruncated, summary, removals: source.removals,
    records: records.map((row) => ({ ...row,
      otherJobIds: row.jobs.filter((job) => !job.onCriticalPath && job.timingQuality.state !== "unmeasured-allocation").map((job) => job.id),
      jobs: row.jobs.filter((job) => job.onCriticalPath || job.timingQuality.state === "unmeasured-allocation") })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Supply version-2 report files; offline reads only");
  console.log(JSON.stringify(analyzeReports(await Promise.all(process.argv.slice(2)
    .map(async (file) => JSON.parse(await readFile(file, "utf8"))))), null, 2));
}
