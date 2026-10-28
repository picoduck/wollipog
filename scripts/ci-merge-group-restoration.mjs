import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { REQUIRED } from "./main-rolling-validation.mjs";

// Read-only rollback proof for the disabled merge-group gate (docs/ci-aggregation.md). After the
// gate is switched back, it proves that the newest merge-group runs executed today's complete full
// suite set before anyone may remove an admission hold. Its result is the `fullQueueProof` shape
// planRollback() in main-merge-admission-controller.mjs requires. It never dispatches or writes.
export const RESTORATION_SCHEMA = "merge-group-restoration-v1";
export const COVERAGE = "full-merge-group-v1";
export const REQUIRED_CONTEXT = "Typecheck, Test & Sidecar Bundle";
export const MAX_RUNS = 3;
const WORKFLOW = ".github/workflows/ci.yml";
const GATE_JOB = "Merge Group Gate";
const REDUCED_STEP = "Record Reduced Merge Group Coverage";
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const time = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  ? Date.parse(value) : NaN;

// The rolling worker's full inventory, named as merge-group jobs (no reusable-call prefix).
export const FULL_JOBS = REQUIRED.map((name) => name.replace(/^Full Validation \/ /, ""));
const CHECKS = "Typecheck, Unit Tests & Bundles";
const SHARDS = FULL_JOBS.filter((name) => /^Browser End-to-End Tests \(\d+\)$/.test(name));
const WEBKIT = "WebKit End-to-End Tests";
const DETECT = "Settings-Rows win32 Baselines / Detect Settings-Rows Changes";
const COMPARE = "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines";
// The checks job's Node partitions, engine boundaries, containment and bundles; all must succeed.
export const CHECK_STEPS = ["Typecheck", "Unit Tests", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
  "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
  "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
const STEPS = new Map([[CHECKS, CHECK_STEPS], [WEBKIT, ["WebKit Browser End-to-End Tests"]],
  [DETECT, ["Compare the Diff Against the Settings-Rows Paths"]], [COMPARE, ["Compare Against the Committed win32 Baselines"]],
  [REQUIRED_CONTEXT, ["Require Every Job to Have Succeeded"]],
  ...SHARDS.map((name, index) => [name, ["Remote-Instance Browser End-to-End Tests", ...(index ? [] : ["Rendered Production Browser Smoke"])]])]);

/** Pure: one exact run attempt and its complete job listing. Returns reasons; empty means full. */
export function certifyRun(repository, run, listing) {
  const reasons = [];
  if (run?.event !== "merge_group" || run.path !== WORKFLOW || run.repository?.full_name !== repository ||
      typeof run.head_branch !== "string" || !run.head_branch.startsWith("gh-readonly-queue/main/") ||
      !SHA.test(run.head_sha ?? "") || !positive(run.id) || !positive(run.run_attempt)) reasons.push("run-identity-unavailable");
  if (run?.status !== "completed" || run.conclusion !== "success") reasons.push("run-not-successful");
  const jobs = listing?.jobs;
  if (!Array.isArray(jobs) || listing.total_count !== jobs.length || jobs.length > 100 ||
      jobs.some((job) => job?.run_id !== run?.id || job.run_attempt !== run?.run_attempt)) {
    return [...reasons, "job-listing-incomplete"];
  }
  const named = (name) => jobs.filter((job) => job.name === name);
  const passed = (job, step) => (job.steps ?? []).some((item) => item.name === step && item.status === "completed" && item.conclusion === "success");
  // Every browser job must be one of the five shards; a missing or extra leg is not full coverage.
  if (jobs.filter((job) => /^Browser End-to-End Tests\b/.test(job.name ?? "")).length !== SHARDS.length) reasons.push("browser-shards-incomplete");
  for (const name of FULL_JOBS) {
    const matches = named(name);
    if (matches.length !== 1) { reasons.push(`job-missing:${name}`); continue; }
    const [job] = matches;
    // The called workflow path-scopes win32 comparison identically in full and reduced modes.
    if (name === COMPARE && job.status === "completed" && job.conclusion === "skipped") continue;
    if (job.status !== "completed" || job.conclusion !== "success") { reasons.push(`job-not-successful:${name}`); continue; }
    for (const step of STEPS.get(name) ?? []) if (!passed(job, step)) reasons.push(`step-not-successful:${name}/${step}`);
  }
  // Restoration means the gate itself is off: its job must be absent or skipped, never recording.
  const gate = named(GATE_JOB);
  if (gate.length > 1 || gate.some((job) => job.status !== "completed" || job.conclusion !== "skipped")) reasons.push("merge-group-gate-active");
  if (jobs.some((job) => (job.steps ?? []).some((step) => step.name === REDUCED_STEP && step.conclusion !== "skipped")))
    reasons.push("reduced-coverage-recorded");
  return [...new Set(reasons)];
}

/**
 * Pure: the newest `count` completed merge-group runs created at or after `since` must each be
 * certified full. In-progress runs are not evidence; fewer completed runs than required is a refusal.
 */
export function verifyRestoration({ repository, since, count = 1, listing, jobsByRun = {} } = {}) {
  const reasons = [];
  const start = time(since);
  if (!REPOSITORY.test(repository ?? "")) reasons.push("repository-unavailable");
  if (!Number.isFinite(start)) reasons.push("since-unavailable");
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RUNS) reasons.push("count-out-of-range");
  const runs = Array.isArray(listing?.workflow_runs) ? listing.workflow_runs : null;
  if (!runs) reasons.push("run-listing-unavailable");
  const selected = (runs ?? []).filter((run) => run?.status === "completed" && time(run.created_at) >= start)
    .sort((a, b) => time(b.created_at) - time(a.created_at)).slice(0, reasons.length ? 0 : count);
  if (!reasons.length && selected.length < count) reasons.push("insufficient-completed-merge-group-runs");
  const evidence = selected.map((run) => {
    const runReasons = certifyRun(repository, run, jobsByRun[run.id]);
    return { runId: positive(run.id) ? run.id : null, attempt: positive(run.run_attempt) ? run.run_attempt : null,
      headSha: SHA.test(run.head_sha ?? "") ? run.head_sha : null, createdAt: run.created_at ?? null,
      certification: runReasons.length ? "none" : "full", reasons: runReasons };
  });
  if (evidence.some((run) => run.certification !== "full")) reasons.push("run-not-certified-full");
  const verified = !reasons.length;
  return { schema: RESTORATION_SCHEMA, repository: REPOSITORY.test(repository ?? "") ? repository : null, since: since ?? null,
    verified, coverage: COVERAGE, requiredContext: REQUIRED_CONTEXT, workflowSha: verified ? evidence[0].headSha : null,
    runs: evidence, reasons };
}

/** Live and read-only: one run listing plus one job listing per selected run (at most 1 + MAX_RUNS reads). */
export async function observeRestoration({ repository, since, count = 1, api }) {
  const listing = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&status=completed` +
    `&created=${encodeURIComponent(`>=${since}`)}&per_page=${MAX_RUNS * 4}`);
  const preview = verifyRestoration({ repository, since, count, listing });
  const jobsByRun = {};
  for (const run of preview.runs) {
    if (run.runId && run.attempt) jobsByRun[run.runId] = await api(
      `/repos/${repository}/actions/runs/${run.runId}/attempts/${run.attempt}/jobs?per_page=100`);
  }
  return verifyRestoration({ repository, since, count, listing, jobsByRun });
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error, api } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { repository: { type: "string" }, since: { type: "string" },
      runs: { type: "string", default: "1" }, fixture: { type: "string" } } }));
  } catch {
    error("Usage: ci-merge-group-restoration.mjs --repository OWNER/REPO --since ISO-TIME [--runs 1-3] [--fixture FILE]");
    return 2;
  }
  const options = { repository: values.repository, since: values.since, count: Number(values.runs) };
  let proof;
  if (values.fixture) {
    const { listing, jobsByRun } = JSON.parse(readFileSync(values.fixture, "utf8"));
    proof = verifyRestoration({ ...options, listing, jobsByRun });
  } else {
    const refused = verifyRestoration({ ...options, listing: { workflow_runs: [] } }).reasons
      .filter((reason) => reason !== "insufficient-completed-merge-group-runs");
    if (refused.length) proof = verifyRestoration(options);
    else {
      if (!api) {
        if (!env.GITHUB_TOKEN) { error("GITHUB_TOKEN is required for a live read-only verification."); return 2; }
        const { githubApi, budgetApi } = await import("./main-ci-health.mjs");
        api = budgetApi(githubApi(env.GITHUB_TOKEN), { limit: 1 + MAX_RUNS, reserve: 0 });
      }
      try { proof = await observeRestoration({ ...options, api }); }
      catch { proof = { ...verifyRestoration(options), reasons: ["github-read-unavailable"] }; }
    }
  }
  log(JSON.stringify(proof, null, 2));
  return proof.verified ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
