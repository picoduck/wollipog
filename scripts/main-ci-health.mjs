import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CI_PATH = ".github/workflows/ci.yml";
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const LATEST = /<!-- main-ci-health latest:(\d+) -->/;
export const ALERT_TITLE = "Main CI Is Failing";
export const ALERT_LABEL = "main-ci-red";
export const REQUEST_MS = 10_000;

export function targetFromEvent(event, repository) {
  const run = event?.workflow_run;
  if (!REPOSITORY.test(repository ?? "") || !["requested", "in_progress", "completed"].includes(event?.action) ||
      !(isMainPushRun(run, repository) || run?.path === ".github/workflows/main-rolling-validation.yml" &&
        run?.event === "workflow_dispatch" && run?.head_branch === "main" && run?.repository?.full_name === repository &&
        run?.head_repository?.full_name === repository))
    throw new Error("Unsupported main health event");
  return { repository };
}

function isMainPushRun(run, repository) {
  return run?.event === "push" && run?.head_branch === "main" && run?.path === CI_PATH &&
    run?.repository?.full_name === repository && run?.head_repository?.full_name === repository &&
    Number.isSafeInteger(run?.id) && run.id > 0 && SHA.test(run?.head_sha) &&
    typeof run?.html_url === "string" && run.html_url === `https://github.com/${repository}/actions/runs/${run.id}`;
}

function isAlert(issue) {
  return issue?.state === "open" && !issue.pull_request && issue.title === ALERT_TITLE &&
    issue.user?.login === "github-actions[bot]" && Number.isSafeInteger(issue.number) &&
    Array.isArray(issue.labels) && issue.labels.some((label) => label?.name === ALERT_LABEL);
}

function runLine(repository, run) {
  return `[\`${run.head_sha.slice(0, 9)}\`](https://github.com/${repository}/commit/${run.head_sha}) ` +
    `in [CI run ${run.id}](${run.html_url})`;
}

function jobList(jobs) {
  // Job names come from the trusted workflow file; flattening keeps each on its own list item.
  return jobs.length
    ? jobs.map((name) => `- ${String(name).replace(/\s+/g, " ").trim()}`).join("\n")
    : "- (no failed job reported; open the run)";
}

export function alertBody({ repository, run, jobs, author }) {
  return [
    `<!-- main-ci-health latest:${run.id} -->`,
    `\`main\` CI failed on ${runLine(repository, run)}.`,
    "",
    "Failing jobs:",
    "",
    jobList(jobs),
    "",
    "Every merge-queue entry fails until `main` passes again. See " +
      `[docs/main-ci-health.md](https://github.com/${repository}/blob/main/docs/main-ci-health.md) for what to do.`,
    "",
    "This issue closes itself only after a verified complete full-validation descendant supersedes the failure.",
    ...(author ? ["", `cc @${author}`] : []),
  ].join("\n");
}

export function githubApi(token, fetchImpl = fetch) {
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl("https://api.github.com" + path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_MS),
      redirect: "error",
    });
    // Never print response bodies or exception messages: they are untrusted and
    // may contain credentials. The status code suffices to diagnose and retry.
    if (!response.ok) {
      const error = new Error("GitHub API request failed");
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}

async function headAuthor(api, repository, run) {
  const commit = await api(`/repos/${repository}/commits/${run.head_sha}`);
  const login = commit?.author?.login;
  return commit?.author?.type === "User" && typeof login === "string" && /^[A-Za-z0-9-]+$/.test(login) ? login : null;
}

// This ref is a queryable snapshot and recovery index, never a source of verdicts.
export const HEALTH_REF = "refs/heads/ci/main-health-state";
export const HEALTH_SCHEMA = "main-ci-health-v1";
export const FULL_COVERAGE = "rolling-full-v1";
export const STALE_MS = 2 * 60 * 60_000;
export const MAX_RECORDS = 128;
const WORKER_PATH = ".github/workflows/main-rolling-validation.yml";
const WINDOWS_PATH = ".github/workflows/settings-rows-win32.yml";
const ACTIVE = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);
const ZERO = "0".repeat(40);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const fail = (reason) => { const error = new Error(reason); error.reason = reason; throw error; };

export function unknownHealth(repository, observedAt, reason) {
  return { schema: HEALTH_SCHEMA, repository, observedAt, currentMainSha: null, status: "unknown",
    reasons: [reason], fullCertification: null, latestAttempt: null, latestPassingSnapshot: null,
    unresolvedFailures: [], evidence: [], legacyEvidence: [], backlog: { commits: null, merges: null, mergeCommits: null,
      oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: null, clock: "committer-time-proxy" } };
}

async function pages(api, path, key) {
  const items = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const body = await api(`${path}&per_page=100&page=${page}`);
    if (!Array.isArray(body?.[key]) || !Number.isSafeInteger(body.total_count) || body.total_count < 0)
      fail("invalid-pagination");
    total ??= body.total_count;
    if (body.total_count !== total) fail("listing-changed");
    items.push(...body[key]);
    if (!body[key].every((item) => positive(item?.id))) fail("invalid-pagination");
    if (items.length >= total) {
      if (items.length !== total || new Set(items.map((item) => item.id)).size !== items.length)
        fail("invalid-pagination");
      return items;
    }
    if (!body[key].length) fail("incomplete-pagination");
  }
  fail("incomplete-pagination");
}

export async function readHealthState(api, repository) {
  let oid = null;
  try {
    const ref = await api(`/repos/${repository}/git/ref/heads/ci/main-health-state`);
    oid = ref?.object?.sha;
    if (!SHA.test(oid)) fail("invalid-health-ref");
    const commit = await api(`/repos/${repository}/git/commits/${oid}`);
    if (!SHA.test(commit?.tree?.sha)) fail("invalid-health-tree");
    const tree = await api(`/repos/${repository}/git/trees/${commit.tree.sha}`);
    const entry = tree?.tree?.find((item) => item.path === "health.json" && item.type === "blob");
    const recovered = { oid, sequence: 0, pointers: [], recovered: true };
    if (!SHA.test(entry?.sha)) return recovered;
    const blob = await api(`/repos/${repository}/git/blobs/${entry.sha}`);
    if (blob?.encoding !== "base64" || !Number.isSafeInteger(blob.size) || blob.size > 2_000_000) return recovered;
    const data = JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
    if (data?.schema !== HEALTH_SCHEMA || data.repository !== repository ||
        !Number.isSafeInteger(data.sequence) || data.sequence < 0 || !Array.isArray(data.runPointers) ||
        data.runPointers.length > MAX_RECORDS || !data.runPointers.every(positive)) return recovered;
    // Discard cached results, ancestry, times, reasons, job names and unknown fields.
    return { oid, sequence: data.sequence, pointers: [...new Set(data.runPointers)], recovered: false };
  } catch (error) {
    if (error?.status !== 404 && !(error instanceof SyntaxError)) throw error;
    return { oid, sequence: 0, pointers: [], recovered: true };
  }
}

export async function writeHealthState(api, repository, previous, health) {
  const sequence = previous.sequence + 1;
  const runPointers = [...new Set([...(health.status === "unknown" ? previous.pointers ?? [] : []),
    ...[...health.evidence, ...health.legacyEvidence].map((record) => record.runId)])];
  if (runPointers.length > MAX_RECORDS) fail("evidence-limit");
  const compact = previous.recovered || sequence % 128 === 0;
  const root = `/repos/${repository}`;
  const tree = await api(`${root}/git/trees`, { method: "POST", body: { tree: [
    { path: "health.json", mode: "100644", type: "blob", content: JSON.stringify({ ...health, sequence, runPointers }) + "\n" },
  ] } });
  const commit = await api(`${root}/git/commits`, { method: "POST", body: {
    message: "Reconcile exact main regression health", tree: tree.sha,
    parents: previous.oid && !compact ? [previous.oid] : [],
  } });
  const repo = await api(root);
  const result = await api("/graphql", { method: "POST", body: {
    query: "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
    variables: { input: { repositoryId: repo.node_id, refUpdates: [{ name: HEALTH_REF,
      beforeOid: previous.oid ?? ZERO, afterOid: commit.sha, force: Boolean(previous.oid && compact) }] } },
  } });
  if (result?.errors?.length || !result?.data?.updateRefs) fail("health-write-conflict");
  return commit.sha;
}

const CORE_STEPS = ["Typecheck", "Unit Tests", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
  "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
  "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
const EVIDENCE_STEPS = [...CORE_STEPS, "Verify Rolling Checkout", "Remote-Instance Browser End-to-End Tests",
  "Rendered Production Browser Smoke", "WebKit Browser End-to-End Tests", "Compare the Diff Against the Settings-Rows Paths",
  "Compare Against the Committed win32 Baselines", "Require Every Job to Have Succeeded"];

/** Independent forge reads. Never consume coordination state or uploaded artifacts. */
export async function collectHealth(repository, { api, pointers = [], now = () => new Date().toISOString() } = {}) {
  const observedAt = now(), health = unknownHealth(repository, observedAt, "no-full-evidence");
  try {
    const { workerIdentity, REQUIRED } = await import("./main-rolling-validation.mjs");
    const root = `/repos/${repository}`;
    const mainSha = (await api(`${root}/git/ref/heads/main`))?.object?.sha;
    if (!SHA.test(mainSha)) fail("main-unavailable");
    health.currentMainSha = mainSha;
    const immutable = new Map();
    const read = async (path) => {
      if (!immutable.has(path)) immutable.set(path, await api(path));
      return immutable.get(path);
    };
    const ancestor = async (sha, descendant = mainSha) => {
      if (sha === descendant) return true;
      const comparison = await read(`${root}/compare/${sha}...${descendant}`);
      if (!SHA.test(comparison?.merge_base_commit?.sha)) fail("ancestry-unavailable");
      return comparison.merge_base_commit.sha === sha;
    };
    // Forge workflow creation is the rolling-era horizon. Older persisted/alert IDs are
    // independently re-read as well; no mutable state can narrow the forge listing.
    const workflow = await api(`${root}/actions/workflows/main-rolling-validation.yml`);
    if (workflow?.path !== WORKER_PATH || !timestamp(workflow.created_at)) fail("workflow-unavailable");
    health.evidenceSince = workflow.created_at;
    const [rolling, legacy] = await Promise.all([
      pages(api, `${root}/actions/workflows/main-rolling-validation.yml/runs?branch=main&event=workflow_dispatch`, "workflow_runs"),
      pages(api, `${root}/actions/workflows/ci.yml/runs?branch=main&event=push&created=${encodeURIComponent(">=" + workflow.created_at)}`, "workflow_runs"),
    ]);
    const fingerprint = (items) => items.map((run) => [run.id, run.run_attempt, run.head_sha, run.status, run.conclusion])
      .sort((a, b) => a[0] - b[0]);
    const runs = new Map([...rolling, ...legacy].map((run) => [run.id, run]));
    for (const id of pointers) {
      if (!positive(id)) fail("invalid-pointer");
      if (!runs.has(id)) runs.set(id, await api(`${root}/actions/runs/${id}`));
    }
    const records = [], legacyRecords = [];
    const requiredNames = REQUIRED.map((name) => name.replace(/^Full Validation \/ /, ""));
    const candidates = [];
    // Read newer target ancestry first so a complete descendant with the exact same
    // workflow suite can cover older targets without fetching every historical job.
    for (const listed of runs.values()) {
      const identity = workerIdentity(listed, repository);
      if (!identity && !isMainPushRun(listed, repository)) continue;
      const target = identity?.targetSha ?? listed.head_sha;
      if (!await ancestor(listed.head_sha) || !await ancestor(target)) fail("non-main-ancestry");
      let index = 0;
      for (; index < candidates.length; index++) {
        const other = candidates[index], otherTarget = workerIdentity(other, repository)?.targetSha ?? other.head_sha;
        if (target === otherTarget) { if (listed.id > other.id) break; }
        else if (await ancestor(otherTarget, target)) break;
        else if (!await ancestor(target, otherTarget)) fail("incomparable-targets");
      }
      candidates.splice(index, 0, listed);
    }
    const inspected = [];
    const supersededRunIds = [];
    for (const listed of candidates) {
      const listedIdentity = workerIdentity(listed, repository);
      const isLegacy = isMainPushRun(listed, repository);
      if (!listedIdentity && !isLegacy) continue;
      const run = await api(`${root}/actions/runs/${listed.id}`);
      const identity = workerIdentity(run, repository);
      if (run.id !== listed.id || run.run_attempt !== listed.run_attempt || run.head_sha !== listed.head_sha ||
          (listedIdentity ? !identity || identity.targetSha !== listedIdentity.targetSha || identity.claimId !== listedIdentity.claimId : !isMainPushRun(run, repository)))
        fail("run-changed");
      const targetSha = identity?.targetSha ?? run.head_sha;
      if (!await ancestor(run.head_sha) || !await ancestor(targetSha)) fail("non-main-ancestry");
      const blobs = {};
      for (const [key, path] of Object.entries({ ...(identity ? { worker: WORKER_PATH } : {}), ci: CI_PATH, windows: WINDOWS_PATH })) {
        const file = await read(`${root}/contents/${path}?ref=${run.head_sha}`);
        if (!SHA.test(file?.sha)) fail("workflow-revision-unavailable");
        blobs[key] = file.sha;
        if (identity) {
          if (file.encoding !== "base64" || typeof file.content !== "string") fail("workflow-contract-unavailable");
          const source = Buffer.from(file.content, "base64").toString("utf8");
          const bindings = key === "worker" ? ["uses: ./.github/workflows/ci.yml", "target_sha: ${{ inputs.target_sha }}"]
            : key === "ci" ? ["ref: ${{ inputs.target_sha }}", "EXPECTED_SHA: ${{ inputs.target_sha }}", "expected_sha: ${{ inputs.target_sha }}",
              'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"']
              : ["ref: ${{ inputs.ref }}", "EXPECTED_SHA: ${{ inputs.expected_sha }}", 'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'];
          if (!bindings.every((binding) => source.includes(binding))) fail("unsupported-workflow-contract");
        }
      }
      let covered = false;
      for (const pass of records.filter((record) => record.certification === "full" &&
        !records.some((other) => other.targetSha === record.targetSha && (other.runId > record.runId ||
          other.runId === record.runId && other.attempt > record.attempt)))) {
        if (targetSha !== pass.targetSha && await ancestor(targetSha, pass.targetSha) &&
            Object.entries(blobs).every(([key, value]) => pass.workflowBlobs[key] === value)) { covered = true; break; }
      }
      if (covered) { supersededRunIds.push(run.id); continue; }
      inspected.push(run);
      if (!positive(run.run_attempt) || run.run_attempt > 10) fail("attempt-limit");
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const snapshot = await api(`${root}/actions/runs/${run.id}/attempts/${attempt}`);
        if (snapshot?.id !== run.id || snapshot.run_attempt !== attempt || snapshot.head_sha !== run.head_sha ||
            (identity ? workerIdentity(snapshot, repository)?.targetSha !== targetSha ||
              workerIdentity(snapshot, repository)?.claimId !== identity.claimId : !isMainPushRun(snapshot, repository)))
          fail("attempt-changed");
        const jobs = await pages(api, `${root}/actions/runs/${run.id}/attempts/${attempt}/jobs?filter=all`, "jobs");
        const prefix = identity ? "Full Validation / " : "";
        const inventory = requiredNames.map((name) => {
          name = prefix + name;
          const matches = jobs.filter((job) => job.name === name);
          const job = matches.length === 1 ? matches[0] : null;
          return { name, id: job?.id ?? null, status: job?.status ?? "missing", conclusion: job?.conclusion ?? "missing",
            checkoutVerified: Boolean(identity && job?.steps?.some((step) => step.name === "Verify Rolling Checkout" && step.conclusion === "success")),
            steps: (job?.steps ?? []).filter((step) => EVIDENCE_STEPS.includes(step.name))
              .map((step) => ({ name: step.name, conclusion: step.conclusion })),
          };
        });
        const completed = inventory.every((job) => job.status === "completed");
        const checkoutVerified = Boolean(identity && inventory.slice(0, -1).every((job) => job.checkoutVerified));
        const stepPassed = (job, name) => job.steps.some((step) => step.name === name && step.conclusion === "success");
        const testsVerified = CORE_STEPS.every((name) => stepPassed(inventory[0], name)) &&
          inventory.slice(1, 6).every((job) => stepPassed(job, "Remote-Instance Browser End-to-End Tests")) &&
          stepPassed(inventory[1], "Rendered Production Browser Smoke") &&
          stepPassed(inventory[6], "WebKit Browser End-to-End Tests") &&
          stepPassed(inventory[7], "Compare the Diff Against the Settings-Rows Paths") &&
          stepPassed(inventory[8], "Compare Against the Committed win32 Baselines") &&
          stepPassed(inventory[9], "Require Every Job to Have Succeeded");
        const fullSuccess = identity && checkoutVerified && testsVerified && completed &&
          inventory.every((job) => job.conclusion === "success") && snapshot.status === "completed" && snapshot.conclusion === "success";
        const failure = snapshot.status === "completed" && RED.has(snapshot.conclusion) &&
          (!isLegacy || inventory.every((job) => job.status !== "missing")) &&
          inventory.some((job) => RED.has(job.conclusion) && (isLegacy || job.checkoutVerified));
        const record = { repository, source: identity ? "rolling-full" : "legacy-main-push", targetSha, testedSha: targetSha,
          claimId: identity?.claimId ?? null, runId: run.id, attempt, url: `https://github.com/${repository}/actions/runs/${run.id}/attempts/${attempt}`,
          workflowPath: run.path, workflowRevision: run.head_sha, dispatcherSha: run.head_sha,
          workflowBlobs: blobs, suiteVersion: createHash("sha256").update(JSON.stringify(blobs)).digest("hex"),
          suiteRevision: targetSha, coverageVersion: identity ? FULL_COVERAGE : "legacy-unverified",
          workflowAncestryVerified: true, targetAncestryVerified: true, checkoutVerified,
          certification: fullSuccess ? "full" : "none", inventory, result: fullSuccess ? "passing" : failure ? "failing"
            : ACTIVE.has(snapshot.status) ? "pending" : "unknown", status: snapshot.status,
          observedAt, createdAt: snapshot.created_at, startedAt: snapshot.run_started_at ?? null,
          completedAt: snapshot.status === "completed" && timestamp(snapshot.updated_at) ? snapshot.updated_at : null };
        (identity ? records : legacyRecords).push(record);
        if (records.length + legacyRecords.length > MAX_RECORDS) fail("evidence-limit");
      }
      const fresh = await api(`${root}/actions/runs/${run.id}`);
      if (fresh.run_attempt !== run.run_attempt || fresh.status !== run.status || fresh.conclusion !== run.conclusion)
        fail("run-changed");
    }
    health.evidence = records; health.legacyEvidence = legacyRecords; health.supersededRunIds = supersededRunIds;
    const rank = async (items) => {
      const ordered = [];
      for (const item of items) {
        let at = 0;
        for (; at < ordered.length; at++) {
          const other = ordered[at];
          if (item.targetSha === other.targetSha) {
            if (item.runId > other.runId || item.runId === other.runId && item.attempt > other.attempt) break;
          } else if (await ancestor(other.targetSha, item.targetSha)) break;
          else if (!await ancestor(item.targetSha, other.targetSha)) fail("incomparable-targets");
        }
        ordered.splice(at, 0, item);
      }
      return ordered;
    };
    const ordered = await rank(records);
    health.latestAttempt = ordered[0] ?? null;
    const newestForTarget = new Map();
    for (const record of ordered) if (!newestForTarget.has(record.targetSha)) newestForTarget.set(record.targetSha, record);
    // A rerun (or a new worker at that target) withdraws the target's old green.
    const passes = [...newestForTarget.values()].filter((record) => record.certification === "full" &&
      !legacyRecords.some((other) => other.targetSha === record.targetSha && other.result === "failing" && other.runId > record.runId));
    health.latestPassingSnapshot = passes[0] ?? null;
    const failures = await rank([...records, ...legacyRecords].filter((record) => record.result === "failing"));
    for (const failure of failures) {
      let superseded = false;
      for (const pass of passes) {
        const laterIdentity = pass.runId > failure.runId || pass.runId === failure.runId && pass.attempt > failure.attempt;
        if (await ancestor(failure.targetSha, pass.targetSha) && (failure.targetSha !== pass.targetSha || laterIdentity) &&
            (failure.source === "legacy-main-push" || failure.coverageVersion === pass.coverageVersion)) { superseded = true; break; }
      }
      if (!superseded) health.unresolvedFailures.push(failure);
    }
    const passing = health.latestPassingSnapshot;
    health.reasons = [];
    if (passing) {
      if (passing.targetSha === mainSha) {
        health.backlog = { ...health.backlog, commits: 0, merges: 0, mergeCommits: 0, oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: 0 };
        health.fullCertification = passing;
      } else {
        const commits = [];
        let total;
        for (let page = 1; page <= 10; page++) {
          const comparison = await api(`${root}/compare/${passing.targetSha}...${mainSha}?per_page=100&page=${page}`);
          if (comparison?.merge_base_commit?.sha !== passing.targetSha || !Array.isArray(comparison.commits) ||
              !Number.isSafeInteger(comparison.total_commits) || total !== undefined && total !== comparison.total_commits)
            fail("ancestry-unavailable");
          total = comparison.total_commits;
          commits.push(...comparison.commits);
          if (commits.length >= total) break;
        }
        if (commits.length !== total || new Set(commits.map((commit) => commit.sha)).size !== total) fail("incomplete-commit-pagination");
        const times = commits.map((commit) => commit?.commit?.committer?.date);
        if (!times.length || !times.every(timestamp)) fail("commit-time-unavailable");
        const oldest = new Date(Math.min(...times.map(Date.parse))).toISOString();
        const mergedPullRequests = new Set();
        for (const commit of commits) {
          const pulls = await api(`${root}/commits/${commit.sha}/pulls?per_page=100`);
          if (!Array.isArray(pulls) || pulls.length >= 100) fail("incomplete-merge-pagination");
          for (const pull of pulls) if (positive(pull.number) && timestamp(pull.merged_at) && pull.merge_commit_sha === commit.sha &&
            pull.base?.ref === "main" && pull.base?.repo?.full_name === repository) mergedPullRequests.add(pull.number);
        }
        health.backlog = { ...health.backlog, commits: total, merges: mergedPullRequests.size,
          mergeCommits: commits.filter((commit) => commit.parents?.length > 1).length,
          oldestUnvalidatedAt: oldest, oldestUnvalidatedAgeSeconds: Math.max(0, (Date.parse(observedAt) - Date.parse(oldest)) / 1000) };
      }
    } else health.reasons.push("no-full-passing-snapshot");
    if (health.latestAttempt?.result === "unknown") health.reasons.push("latest-validation-incomplete");
    const started = health.latestAttempt?.startedAt ?? health.latestAttempt?.createdAt;
    if (health.latestAttempt?.result === "pending" && timestamp(started) && Date.parse(observedAt) - Date.parse(started) > STALE_MS)
      health.reasons.push("validation-stalled");
    health.status = health.unresolvedFailures.length ? "failing" : health.reasons.length ? "unknown"
      : health.backlog.oldestUnvalidatedAgeSeconds * 1000 > STALE_MS ? "stale"
      : health.fullCertification ? "passing" : "pending";
    if (health.status === "stale") health.reasons.push("oldest-unvalidated-change-exceeds-budget");
    // Re-pin main and attempts after the complete observation, not merely each job read.
    if ((await api(`${root}/git/ref/heads/main`))?.object?.sha !== mainSha) fail("main-moved");
    for (const run of inspected) {
      const fresh = await api(`${root}/actions/runs/${run.id}`);
      if (fresh.run_attempt !== run.run_attempt || fresh.status !== run.status || fresh.conclusion !== run.conclusion)
        fail("run-changed");
    }
    const [freshRolling, freshLegacy] = await Promise.all([
      pages(api, `${root}/actions/workflows/main-rolling-validation.yml/runs?branch=main&event=workflow_dispatch`, "workflow_runs"),
      pages(api, `${root}/actions/workflows/ci.yml/runs?branch=main&event=push&created=${encodeURIComponent(">=" + workflow.created_at)}`, "workflow_runs"),
    ]);
    if (JSON.stringify(fingerprint(rolling)) !== JSON.stringify(fingerprint(freshRolling)) ||
        JSON.stringify(fingerprint(legacy)) !== JSON.stringify(fingerprint(freshLegacy))) fail("listing-changed");
    return health;
  } catch (error) {
    health.status = "unknown"; health.fullCertification = null; health.latestPassingSnapshot = null;
    health.backlog = unknownHealth(repository, observedAt, "unknown").backlog;
    health.reasons = [error?.reason ?? "forge-api-unavailable"];
    return health;
  }
}

export async function reconcile(target, { api, log = console.log, collect = collectHealth, persist = true,
  output, now = () => new Date().toISOString(), entryPoint = "cli", observationId = randomUUID() }) {
  const { repository } = target;
  const emit = (event, fields = {}) => log(JSON.stringify({ event, entryPoint, observationId, ...fields }));
  try {
    const issues = await api(`/repos/${repository}/issues?state=open&labels=${ALERT_LABEL}&per_page=20`);
    if (!Array.isArray(issues) || issues.length >= 20) fail("issue-pagination-incomplete");
    const issue = (Array.isArray(issues) ? issues : []).filter(isAlert).sort((a, b) => a.number - b.number)[0] ?? null;
    const previous = persist ? await readHealthState(api, repository) : { pointers: [] };
    const alertPointer = Number(LATEST.exec(issue?.body ?? "")?.[1]);
    const health = await collect(repository, { api, now, pointers: [...new Set([...previous.pointers, ...(positive(alertPointer) ? [alertPointer] : [])])] });
    if (output) writeFileSync(output, JSON.stringify(health, null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Main regression health: **${health.status}**\n\n\`\`\`json\n${JSON.stringify({ ...health, evidence: undefined, legacyEvidence: undefined })}\n\`\`\`\n`);
    if (persist) await writeHealthState(api, repository, previous, health);
    emit("main_ci_health_observed", { status: health.status, mainSha: health.currentMainSha, reasons: health.reasons,
      passingSha: health.latestPassingSnapshot?.testedSha ?? null, backlog: health.backlog });
    if (health.status === "unknown" || health.status === "stale") log(`::warning::Main regression health is ${health.status}; inspect the JSON reasons and docs/main-ci-health.md.`);
    const failure = health.unresolvedFailures[0];
    const pass = health.latestPassingSnapshot;
    // An old incident with unavailable evidence stays open. A fast/legacy success certifies nothing.
    const closing = issue && health.status !== "unknown" && !failure && pass?.certification === "full" &&
      (!positive(alertPointer) || health.supersededRunIds?.includes(alertPointer) ||
        [...health.evidence, ...health.legacyEvidence].some((r) => r.runId === alertPointer));
    const record = failure ?? (closing ? pass : null);
    const run = record && { id: record.runId, run_attempt: record.attempt, head_sha: record.testedSha,
      conclusion: failure ? "failure" : "success", html_url: record.url };
    const marker = `<!-- main-ci-health evidence:${record?.runId}:${record?.attempt} -->`;
    const decision = !run ? { action: "none", reason: health.status } : !failure ? { action: "close" }
      : !issue ? { action: "open" } : issue.body?.includes(marker) ||
        record.attempt === 1 && Number(LATEST.exec(issue.body ?? "")?.[1]) === record.runId
        ? { action: "none", reason: "already-reported" } : { action: "update" };
    const fields = { runId: run?.id ?? null, headSha: run?.head_sha ?? null, conclusion: run?.conclusion ?? null, issue: issue?.number ?? null };
    if (decision.action === "none") {
      emit("main_ci_health_unchanged", { ...fields, reason: decision.reason });
      return "unchanged";
    }
    if (decision.action === "open") {
      const jobs = record.inventory.filter((job) => RED.has(job.conclusion)).map((job) => job.name);
      const author = await headAuthor(api, repository, run);
      try {
        await api(`/repos/${repository}/labels`, {
          method: "POST",
          body: { name: ALERT_LABEL, color: "b60205", description: "Opened and closed by Main CI Health while main CI is red" },
        });
      } catch (error) {
        if (error?.status !== 422) throw error; // 422: the label already exists.
      }
      const created = await api(`/repos/${repository}/issues`, {
        method: "POST",
        body: { title: ALERT_TITLE, labels: [ALERT_LABEL], body: marker + "\n" + alertBody({ repository, run, jobs, author }) },
      });
      emit("main_ci_alert_opened", { ...fields, issue: created?.number ?? null });
      return "opened";
    }
    const issuePath = `/repos/${repository}/issues/${issue.number}`;
    if (decision.action === "update") {
      const jobs = record.inventory.filter((job) => RED.has(job.conclusion)).map((job) => job.name);
      // Comment first: a lost marker update repeats a comment, but never drops a failure.
      await api(`${issuePath}/comments`, {
        method: "POST",
        body: { body: `\`main\` CI failed again on ${runLine(repository, run)}.\n\nFailing jobs:\n\n${jobList(jobs)}` },
      });
      const body = LATEST.test(issue.body ?? "")
        ? issue.body.replace(LATEST, `<!-- main-ci-health latest:${run.id} -->`)
        : `<!-- main-ci-health latest:${run.id} -->\n${issue.body ?? ""}`;
      await api(issuePath, { method: "PATCH", body: { body: marker + "\n" + body.replace(/<!-- main-ci-health evidence:\d+:\d+ -->\n?/g, "") } });
      emit("main_ci_alert_updated", fields);
      return "updated";
    }
    await api(`${issuePath}/comments`, {
      method: "POST",
      body: { body: `\`main\` CI passed again on ${runLine(repository, run)}. Closing.` },
    });
    await api(issuePath, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    emit("main_ci_alert_closed", fields);
    return "closed";
  } catch (error) {
    emit("main_ci_health_unavailable", {
      status: Number.isInteger(error?.status) ? error.status : null,
      action: "Nothing changed; check GitHub API availability and the workflow token's issues permission",
    });
    throw error;
  }
}

export async function main(argv = [], { env = process.env, api, log = console.log, error = console.error } = {}) {
  try {
    const repository = env.GITHUB_REPOSITORY;
    if (!REPOSITORY.test(repository ?? "") || !env.GITHUB_TOKEN || env.GITHUB_REF !== "refs/heads/main") fail("invalid-environment");
    api ??= githubApi(env.GITHUB_TOKEN);
    const mode = argv[0] ?? "reconcile";
    if (mode === "report") {
      const previous = await readHealthState(api, repository);
      const health = await collectHealth(repository, { api, pointers: previous.pointers });
      log(JSON.stringify(health));
      return health.status === "unknown" ? 1 : 0;
    }
    if (mode !== "reconcile") fail("unsupported-mode");
    if (env.GITHUB_EVENT_NAME === "workflow_run") targetFromEvent(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")), repository);
    else if (!["schedule", "workflow_dispatch", "push"].includes(env.GITHUB_EVENT_NAME)) fail("unsupported-event");
    await reconcile({ repository }, { api, log, output: env.MAIN_CI_HEALTH_OUTPUT, entryPoint: env.GITHUB_EVENT_NAME,
      observationId: positive(Number(env.GITHUB_RUN_ID)) ? `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}` : randomUUID() });
    return 0;
  } catch {
    if (argv[0] === "report") log(JSON.stringify(unknownHealth(env.GITHUB_REPOSITORY, new Date().toISOString(), "reconciliation-unavailable")));
    if (env.MAIN_CI_HEALTH_OUTPUT) writeFileSync(env.MAIN_CI_HEALTH_OUTPUT,
      JSON.stringify(unknownHealth(env.GITHUB_REPOSITORY, new Date().toISOString(), "reconciliation-unavailable")) + "\n");
    error("::warning::Main CI Health could not reconcile; verify forge availability and scoped token permissions.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
