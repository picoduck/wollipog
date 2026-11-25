// Shared by both CLI entry points without importing either CLI's module evaluation.
export const WORKER = ".github/workflows/main-rolling-validation.yml";
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const date = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s));

export function workerIdentity(run, repository) {
  const match = /^Rolling ([a-f0-9]{40}) ([a-f0-9-]{36})$/.exec(run?.display_title ?? "");
  if (!REPOSITORY.test(repository) || !match || !UUID.test(match[2]) ||
      run.path !== WORKER || run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      !positive(run.id) || !positive(run.run_attempt) || !SHA.test(run.head_sha) || !date(run.created_at)) return null;
  return { targetSha: match[1], claimId: match[2], runId: run.id, attempt: run.run_attempt,
    workflowRevision: run.head_sha, createdAt: run.created_at };
}
