import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { budgetApi, FULL_COVERAGE } from "./main-ci-health.mjs";
import { candidateSuiteVersion, REQUIRED, validationRecord, workerIdentity, WORKER } from "./main-rolling-validation.mjs";
import { isSupersededWorkerAttempt } from "./main-rolling-outcomes.mjs";
import { listJobs } from "./merge-queue-wait-report.mjs";

export const CERTIFICATION_SCHEMA = "exact-full-regression-v1";
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const CORE_STEPS = ["Typecheck", "Unit Tests", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
  "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
  "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
const fail = (reason) => { const error = new Error(reason); error.reason = reason; throw error; };
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const date = (s) => typeof s === "string" && Number.isFinite(Date.parse(s));
const fingerprint = (runs) => JSON.stringify(runs.map((r) =>
  [r.id, r.run_attempt, r.head_sha, r.display_title, r.status, r.conclusion]).sort((a, b) => a[0] - b[0]));

/** Executed-test evidence required by the rolling-full-v1 health contract. */
export function fullTestStepsPassed(jobs) {
  const exact = (name) => {
    const matches = jobs.filter((j) => j.name === name);
    return matches.length === 1 ? matches[0] : null;
  };
  const passed = (job, name) => job?.steps?.some((s) => s.name === name && s.conclusion === "success");
  const required = REQUIRED.map(exact);
  return CORE_STEPS.every((name) => passed(required[0], name)) &&
    required.slice(1, 6).every((job) => passed(job, "Remote-Instance Browser End-to-End Tests")) &&
    passed(required[1], "Rendered Production Browser Smoke") &&
    passed(required[6], "WebKit Browser End-to-End Tests") &&
    passed(required[7], "Compare the Diff Against the Settings-Rows Paths") &&
    passed(required[8], "Compare Against the Committed win32 Baselines") &&
    passed(required[9], "Require Every Job to Have Succeeded");
}

/** Read-only exact-target proof. Pointers locate evidence; cached verdicts grant nothing. */
export async function collectCertification(repository, targetSha, { api: rawApi, pointerRunId = null,
  now = () => new Date().toISOString(), requireHeaders = false } = {}) {
  const result = { schema: CERTIFICATION_SCHEMA, repository, targetSha, coverageVersion: FULL_COVERAGE,
    status: "unknown", reason: null, suiteVersion: null, observedAt: now(), runId: null, attempt: null,
    sourceSha: null, mainSha: null, url: null };
  try {
    if (!REPOSITORY.test(repository) || !SHA.test(targetSha) || !date(result.observedAt) ||
        pointerRunId !== null && !positive(pointerRunId)) fail("invalid-certification-request");
    if (FULL_COVERAGE !== "rolling-full-v1") fail("unsupported-full-coverage-version");
    const bounded = budgetApi(rawApi, { limit: 48, reserve: 0, requireHeaders });
    const root = `/repos/${repository}`;
    const immutable = new Map();
    const read = async (path) => {
      if (!immutable.has(path)) immutable.set(path, await bounded(path));
      return immutable.get(path);
    };
    const mainSha = (await bounded(`${root}/git/ref/heads/main`))?.object?.sha;
    if (!SHA.test(mainSha)) fail("main-unavailable");
    result.mainSha = mainSha;
    const onMain = async (sha) => sha === mainSha ||
      (await read(`${root}/compare/${sha}...${mainSha}`))?.merge_base_commit?.sha === sha;
    if (!await onMain(targetSha)) fail("candidate-outside-main");
    const workflows = async (sourceSha) => {
      const blobs = {};
      for (const [key, path] of Object.entries({ worker: WORKER, ci: ".github/workflows/ci.yml", windows: ".github/workflows/settings-rows-win32.yml" })) {
        const file = await read(`${root}/contents/${path}?ref=${sourceSha}`);
        if (!SHA.test(file?.sha) || file.encoding !== "base64" || typeof file.content !== "string") fail("workflow-contract-unavailable");
        blobs[key] = file.sha;
        const source = Buffer.from(file.content, "base64").toString("utf8");
        const bindings = key === "worker" ? ["run-name: Rolling ${{ inputs.target_sha }} ${{ inputs.claim_id }}",
          "uses: ./.github/workflows/ci.yml", "target_sha: ${{ inputs.target_sha }}"]
          : key === "ci" ? ["ref: ${{ inputs.target_sha }}", "EXPECTED_SHA: ${{ inputs.target_sha }}", "expected_sha: ${{ inputs.target_sha }}",
            'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"']
            : ["ref: ${{ inputs.ref }}", "EXPECTED_SHA: ${{ inputs.expected_sha }}", 'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'];
        if (!bindings.every((binding) => source.includes(binding))) fail("unsupported-workflow-contract");
      }
      return blobs;
    };
    await workflows(mainSha);
    const expectedSuite = await candidateSuiteVersion(read, repository, mainSha);
    result.suiteVersion = expectedSuite;
    const base = `${root}/actions/workflows/main-rolling-validation.yml/runs?branch=main&event=workflow_dispatch`;
    const list = async (query = "", complete = false) => {
      const runs = [];
      let total;
      for (let page = 1; page <= 10; page++) {
        const body = await bounded(`${base}${query}&per_page=100&page=${page}`);
        if (!Array.isArray(body?.workflow_runs) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
            total !== undefined && total !== body.total_count) fail("incomplete-worker-listing");
        total = body.total_count;
        runs.push(...body.workflow_runs);
        if (!complete) return runs;
        if (total > 1000) fail("evidence-window-exceeds-bound");
        if (runs.length === total && new Set(runs.map((r) => r.id)).size === total) return runs;
        if (!body.workflow_runs.length || runs.length > total) fail("incomplete-worker-listing");
      }
      fail("evidence-window-exceeds-bound");
    };
    const exact = (run) => workerIdentity(run, repository)?.targetSha === targetSha;
    const active = async () => {
      const runs = [];
      for (const status of ACTIVE) runs.push(...await list(`&status=${status}`, true));
      return runs.filter(exact);
    };
    for (const run of await active()) if (await onMain(run.head_sha))
      return { ...result, status: "pending", reason: "candidate-validation-active", runId: run.id, attempt: run.run_attempt };
    const seed = (await list()).filter(exact);
    if (pointerRunId !== null && !seed.some((r) => r.id === pointerRunId)) {
      const pointer = await bounded(`${root}/actions/runs/${pointerRunId}`);
      if (!exact(pointer)) fail("candidate-pointer-mismatch");
      seed.push(pointer);
    }
    if (!seed.length) return { ...result, status: "missing", reason: "request-exact-candidate-validation" };
    if (!seed.every((r) => date(r.created_at))) fail("invalid-worker-clock");
    const since = seed.map((r) => r.created_at).sort()[0];
    const query = `&created=${encodeURIComponent(">=" + since)}`;
    const census = (await list(query, true)).filter(exact);
    if (!seed.every((r) => census.some((other) => other.id === r.id))) fail("candidate-listing-changed");
    const ordered = [...census].sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
    if (ordered.length > 8) fail("candidate-attempt-window-exceeds-bound");
    for (const listed of ordered) {
      const run = await bounded(`${root}/actions/runs/${listed.id}`);
      if (!exact(run) || fingerprint([listed]) !== fingerprint([run])) fail("candidate-run-changed");
      if (!await onMain(run.head_sha)) continue;
      if (ACTIVE.includes(run.status)) return { ...result, status: "pending", reason: "candidate-validation-active", runId: run.id, attempt: run.run_attempt };
      const comparison = await read(`${root}/compare/${targetSha}...${run.head_sha}`);
      if (comparison?.merge_base_commit?.sha !== targetSha) fail("candidate-workflow-ancestry-mismatch");
      const blobs = await workflows(run.head_sha);
      const { jobs, truncated } = await listJobs(bounded, repository, run.id, run.run_attempt);
      if (truncated) fail("candidate-jobs-truncated");
      if (isSupersededWorkerAttempt(run, jobs)) continue;
      const record = validationRecord(repository, run, jobs, blobs);
      result.runId = run.id; result.attempt = run.run_attempt; result.sourceSha = run.head_sha;
      result.url = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
      if (record.suiteVersion !== expectedSuite) return { ...result, status: "incompatible", reason: "candidate-suite-version-mismatch" };
      if (record.verdict !== "success" || !fullTestStepsPassed(jobs))
        return { ...result, status: record.verdict === "failure" ? "failed" : "unknown", reason: "candidate-full-regression-not-passing" };
      // Reconcile current attempts and target census after all job and workflow reads.
      if ((await bounded(`${root}/git/ref/heads/main`))?.object?.sha !== mainSha) fail("main-moved-during-certification");
      if (fingerprint([await bounded(`${root}/actions/runs/${run.id}`)]) !== fingerprint([run])) fail("candidate-rerun-or-invalidation");
      if (fingerprint((await list(query, true)).filter(exact)) !== fingerprint(census)) fail("candidate-listing-changed");
      if ((await active()).length) fail("candidate-validation-active");
      return { ...result, status: "certified", reason: null };
    }
    return { ...result, status: "missing", reason: "no-complete-exact-candidate-verdict" };
  } catch (error) {
    return { ...result, status: "unknown", reason: error.reason ?? "certification-evidence-unavailable" };
  }
}

/** Existing gh authentication, GET only. Never put response bodies or credentials in errors. */
export function forgeReader(execute = execFileSync) {
  const api = async (path) => {
    let raw;
    try { raw = execute("gh", ["api", "--include", "--method", "GET", path.replace(/^\//, "")],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { fail("certification-forge-read-failed"); }
    const normalized = raw.replace(/\r\n/g, "\n"), boundary = normalized.indexOf("\n\n");
    if (boundary < 0) fail("certification-forge-headers-unavailable");
    const headers = normalized.slice(0, boundary);
    const field = (name) => Number(headers.match(new RegExp("^" + name + ":\\s*(\\d+)\\s*$", "mi"))?.[1]);
    api.rateLimit = { limit: field("x-ratelimit-limit"), remaining: field("x-ratelimit-remaining") };
    return JSON.parse(normalized.slice(boundary + 2));
  };
  return api;
}

export async function main(argv, { api, log = console.log } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    report: { type: "boolean" }, repository: { type: "string" }, "target-sha": { type: "string" }, "run-id": { type: "string" },
  } });
  const report = await collectCertification(values.repository, values["target-sha"], {
    api: api ?? forgeReader(), pointerRunId: values["run-id"] === undefined ? null : Number(values["run-id"]), requireHeaders: api === undefined,
  });
  log(JSON.stringify(report));
  return values.report || report.status === "certified" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
