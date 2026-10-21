import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NATIVE_RELEASE_JOBS = [
  "macOS (Intel)", "macOS (Apple Silicon)", "Windows x64", "Windows ARM64", "Linux x64", "Linux ARM64",
];
export const FINALIZER_JOB = "Verify runner release assets";
const time = (value) => {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) throw new Error("Missing or invalid job timestamp");
  return result;
};
const one = (jobs, name) => {
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one job named ${name}`);
  return matches[0];
};

/** Separate completed-attempt scheduling delays from execution; incomplete evidence is an error. */
export function releaseTimings(run, jobs) {
  if (run?.status !== "completed" || !Number.isSafeInteger(run.run_attempt) || !Array.isArray(jobs))
    throw new Error("A complete release attempt is required");
  const native = NATIVE_RELEASE_JOBS.map((name) => one(jobs, name));
  const finalizer = one(jobs, FINALIZER_JOB);
  const phases = [...native, finalizer].map((job) => {
    const created = time(job.created_at), started = time(job.started_at), completed = time(job.completed_at);
    if (created > started || started > completed || job.status !== "completed")
      throw new Error("Incomplete or inconsistent job timing");
    return { name: job.name, id: job.id, conclusion: job.conclusion,
      createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
      queueSeconds: (started - created) / 1000, executionSeconds: (completed - started) / 1000 };
  });
  const eligible = Math.max(...native.map((job) => time(job.completed_at)));
  if (time(finalizer.created_at) < eligible) throw new Error("Finalizer preceded its build dependencies");
  const delay = (time(finalizer.started_at) - eligible) / 1000;
  return {
    runId: run.id, attempt: run.run_attempt, headSha: run.head_sha,
    event: run.event, ref: run.head_branch, conclusion: run.conclusion,
    finalizationEligibleAt: new Date(eligible).toISOString(), finalizationStartDelaySeconds: delay,
    naturalStableSuccess: run.event === "push" && /^v\d+\.\d+\.\d+$/.test(run.head_branch ?? "") &&
      run.run_attempt === 1 && run.conclusion === "success" && phases.every((p) => p.conclusion === "success"),
    withinFiveMinutes: delay <= 300, jobs: phases,
  };
}

export function readReleaseTimings(repository, runId, gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }))) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d*$/.test(String(runId)))
    throw new Error("Expected owner/repository and a positive run id");
  const run = gh(["api", `repos/${repository}/actions/runs/${runId}`]);
  if (run.path !== ".github/workflows/release.yml" || run.repository?.full_name !== repository)
    throw new Error("Run is not this repository's release workflow");
  const jobs = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Release job pagination exceeded its bound");
    const data = gh(["api", `repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`]);
    if (!Array.isArray(data.jobs)) throw new Error("Incomplete release job metadata");
    jobs.push(...data.jobs);
    if (jobs.length === data.total_count) break;
    if (jobs.length > data.total_count || data.jobs.length === 0) throw new Error("Incomplete release job pagination");
  }
  return releaseTimings(run, jobs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(readReleaseTimings(...process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
