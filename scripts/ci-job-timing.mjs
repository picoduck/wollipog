// GitHub job/step clocks are observations, never offsets to repair.
export const TERMINAL_GAP_THRESHOLD_SECONDS = 180;

/** Accept REST jobs or report projections. Skipped steps are not execution. */
export function timingQuality(job) {
  // Reduced historical exports can retain a conflict while omitting its source steps.
  // Do not silently promote that explicitly unmeasured allocation to measured time.
  if (!(job.steps?.length) && job.timingQuality?.state === "unmeasured-allocation")
    return { ...job.timingQuality };
  const start = Date.parse(job.started_at ?? job.apiStartedAt ?? job.startedAt);
  const end = Date.parse(job.completed_at ?? job.completedAt);
  const steps = job.conclusion === "skipped" || job.state === "skipped" ? []
    : (job.steps ?? []).filter((step) => step.conclusion !== "skipped" && step.state !== "skipped");
  const times = steps.map((step) => [Date.parse(step.started_at ?? step.startedAt), Date.parse(step.completed_at ?? step.completedAt)]);
  const outside = Number.isFinite(start) && Number.isFinite(end) ? times.filter((pair) =>
    pair.some((time) => Number.isFinite(time) && (time < start || time > end))).length : 0;
  const ends = times.map((pair) => pair[1]).filter(Number.isFinite);
  const terminalGapSeconds = Number.isFinite(end) && ends.length ? (end - Math.max(...ends)) / 1000 : null;
  const reason = outside ? "executed-steps-outside-job-interval"
    : terminalGapSeconds > TERMINAL_GAP_THRESHOLD_SECONDS ? "unexplained-terminal-gap" : null;
  return { state: reason ? "unmeasured-allocation" : "no-conflict-detected", reason,
    terminalGapSeconds, stepsOutsideJobInterval: outside };
}

export const timingConflict = (job) => timingQuality(job).state === "unmeasured-allocation";
export function timingQualitySummary(jobs) {
  const flagged = jobs.map(timingQuality).filter((quality) => quality.state === "unmeasured-allocation");
  return { unmeasuredAllocationJobs: flagged.length, reasons: Object.fromEntries(
    ["executed-steps-outside-job-interval", "unexplained-terminal-gap"].map((reason) =>
      [reason, flagged.filter((quality) => quality.reason === reason).length])) };
}
