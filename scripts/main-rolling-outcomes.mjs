/**
 * A non-verdict, never a certificate. Call only after validating worker identity,
 * source/target ancestry and a complete Actions job listing for this exact attempt.
 * A rerun must still invalidate its earlier certificate, even when it ran no jobs.
 */
export function isSupersededWorkerAttempt(run, jobs) {
  if (run?.status !== "completed" || run.run_attempt !== 1 || !Array.isArray(jobs)) return false;
  if (run.conclusion === "cancelled" && jobs.every((job) => !job.started_at && !job.steps?.length)) return true;
  const admission = jobs.filter((job) => job.name === "Admit Main Snapshot");
  const noOtherWork = jobs.every((job) => job.name === "Admit Main Snapshot" ||
    (job.name === "Full Validation" || job.name?.startsWith("Full Validation / ")) &&
    job.conclusion === "skipped" && !job.steps?.length);
  return noOtherWork && admission.length === 1 && admission[0].steps?.some((step) =>
    step.name === "Skip Superseded Rolling Claim" && step.conclusion === "success") === true;
}
