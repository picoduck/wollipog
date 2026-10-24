import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { githubApi } from "./main-ci-health.mjs";
import { attemptRecord, listJobs } from "./merge-queue-wait-report.mjs";

import { isSupersededWorkerAttempt } from "./main-rolling-outcomes.mjs";
export { isSupersededWorkerAttempt } from "./main-rolling-outcomes.mjs";

export const STATE_REF = "refs/heads/ci/main-rolling-state";
export const WORKER = ".github/workflows/main-rolling-validation.yml";
export const MAX_HISTORY = 32;
export const COMPACT_EVERY = 128;
export const RETRY_MS = 10 * 60_000;
export const STALLED_MS = 2 * 60 * 60_000;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ZERO = "0".repeat(40);
const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
export const REQUIRED = [
  "Full Validation / Typecheck, Unit Tests & Bundles",
  ...[1, 2, 3, 4, 5].map((i) => `Full Validation / Browser End-to-End Tests (${i})`),
  "Full Validation / WebKit End-to-End Tests",
  "Full Validation / Settings-Rows win32 Baselines / Detect Settings-Rows Changes",
  "Full Validation / Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines",
  "Full Validation / Typecheck, Test & Sidecar Bundle",
];
const CHECKOUT_JOBS = REQUIRED.filter((name) => !name.endsWith("Typecheck, Test & Sidecar Bundle"));
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const date = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s));
const STATUSES = new Set(["initializing", "validating", "stalled-active-run", "current-target-completed", "dispatch-unknown-operator-required",
  "dispatch-outcome-unknown", "recovery-limit-operator-required", "predecessor-evidence-operator-required", "claimed"]);
class InvalidState extends Error {}
class StateConflict extends Error {}
class UnsafePredecessor extends Error {}

export function emptyState(repository) {
  return { version: 2, repository, sequence: 0, active: null, pending: null, lastVerdict: null, records: [], status: "initializing" };
}

const validClaim = (c) => c && SHA.test(c.targetSha) && UUID.test(c.claimId) && date(c.claimedAt) &&
  Number.isSafeInteger(c.dispatchCount) && c.dispatchCount >= 0 && c.dispatchCount <= 3 &&
  (c.lastDispatchAt === null || date(c.lastDispatchAt)) && (c.runId === null || positive(c.runId));
const cleanClaim = (c) => c && Object.fromEntries(
  ["targetSha", "claimId", "claimedAt", "runId", "dispatchCount", "lastDispatchAt"].map((key) => [key, c[key]]));
const matches = (claim, run, repository) => {
  const identity = workerIdentity(run, repository);
  return Boolean(claim && identity && claim.claimId === identity.claimId && claim.targetSha === identity.targetSha);
};
const decisive = (r) => r.verdict === "success" || r.verdict === "failure";
const latestAttempt = (records, targetSha) => records.filter((r) => r.targetSha === targetSha && r.verdict !== "superseded")
  .sort((a, b) => b.runId - a.runId || b.attempt - a.attempt)[0];

/** Coordination hints only. Even a schema-valid ref can have been rewritten by a writer. */
export function validState(s, repository) {
  return s?.version === 2 && s.repository === repository && Number.isSafeInteger(s.sequence) && s.sequence >= 0 &&
    (s.active === null || validClaim(s.active)) && (s.pending === null || validClaim(s.pending) &&
      date(s.pending.observedAt) && (s.pending.priorRunId === null || positive(s.pending.priorRunId))) &&
    (s.lastVerdict === null || positive(s.lastVerdict?.runId) && SHA.test(s.lastVerdict.targetSha)) &&
    Array.isArray(s.records) && s.records.length <= MAX_HISTORY && s.records.every((r) =>
      positive(r?.runId) && positive(r.attempt) && SHA.test(r.targetSha)) && STATUSES.has(s.status);
}

export function workerIdentity(run, repository) {
  const match = /^Rolling ([a-f0-9]{40}) ([a-f0-9-]{36})$/.exec(run?.display_title ?? "");
  if (!REPOSITORY.test(repository) || !match || !UUID.test(match[2]) ||
      run.path !== WORKER || run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      !positive(run.id) || !positive(run.run_attempt) || !SHA.test(run.head_sha) || !date(run.created_at)) return null;
  return { targetSha: match[1], claimId: match[2], runId: run.id, attempt: run.run_attempt,
    workflowRevision: run.head_sha, createdAt: run.created_at };
}

/** Never certify from the dispatcher head, controller result, state ref, or uploaded artifacts. */
export function validationRecord(repository, run, jobs, blobs) {
  const identity = workerIdentity(run, repository);
  if (!identity) throw new Error("Invalid rolling worker identity");
  const named = (name) => jobs.filter((j) => j.name === name);
  const unique = (name) => named(name).length === 1 ? named(name)[0] : null;
  const checkedOut = CHECKOUT_JOBS.every((name) => unique(name)?.steps?.some((step) =>
    step.name === "Verify Rolling Checkout" && step.conclusion === "success"));
  const complete = REQUIRED.every((name) => unique(name)?.status === "completed");
  const outcomes = Object.fromEntries(REQUIRED.map((name) => [name, unique(name)?.conclusion ?? "missing"]));
  const superseded = isSupersededWorkerAttempt(run, jobs);
  const green = checkedOut && complete && Object.values(outcomes).every((s) => s === "success");
  const red = checkedOut && complete && Object.values(outcomes).some((s) => ["failure", "timed_out"].includes(s)) &&
    Object.values(outcomes).every((s) => ["success", "failure", "timed_out"].includes(s));
  // Reuse the collector's ordinary-CI name model, then restore actual API names for evidence.
  const record = attemptRecord(repository, run, jobs.map((j) => ({ ...j, name: j.name.replace(/^Full Validation \/ /, "") })),
    { since: run.created_at, until: run.updated_at });
  record.jobs = record.jobs.map((j, i) => ({ ...j, measurementName: j.name, name: jobs[i].name }));
  return { ...record, ...identity, schema: "main-rolling-validation-v1", testedSha: identity.targetSha,
    sha: identity.targetSha, dispatcherSha: run.head_sha, suiteRevision: identity.targetSha,
    workflowRevision: { sourceSha: run.head_sha, executedBlobSha: blobs.worker, state: "measured" },
    suiteVersion: createHash("sha256").update(JSON.stringify(blobs)).digest("hex"), workflowBlobs: blobs,
    checkoutVerified: checkedOut, requiredOutcomes: outcomes,
    verdict: superseded ? "superseded" : run.status === "completed" && green && run.conclusion === "success" ? "success"
      : run.status === "completed" && ["failure", "timed_out"].includes(run.conclusion) && red ? "failure" : "incomplete",
    dispatchToVerdictMinutes: !superseded && run.status === "completed" && date(run.updated_at)
      ? (Date.parse(run.updated_at) - Date.parse(run.created_at)) / 60_000 : null };
}

export async function readState(api, repository) {
  const root = `/repos/${repository}`;
  let oid = null;
  try {
    const ref = await api(`${root}/git/ref/heads/ci/main-rolling-state`);
    oid = ref?.object?.sha;
    if (!SHA.test(oid)) throw new Error("Invalid state ref");
    const commit = await api(`${root}/git/commits/${oid}`);
    const tree = await api(`${root}/git/trees/${commit.tree.sha}`);
    const entry = tree.tree?.find((e) => e.path === "state.json" && e.type === "blob");
    if (!SHA.test(entry?.sha)) throw new InvalidState("Missing state blob");
    const blob = await api(`${root}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64" || blob.size > 512_000) throw new InvalidState("Invalid state blob");
    let value = JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
    const migrated = value?.version === 1;
    if (migrated) {
      const pending = value.pending;
      if (pending !== null && !(pending && SHA.test(pending.targetSha) && date(pending.observedAt)))
        throw new InvalidState("Invalid legacy pending target");
      value = { ...value, version: 2, pending: null };
      if (!validState(value, repository)) throw new InvalidState("Invalid legacy state");
      // Unacknowledged old intent remains intent; an observed legacy active run is retained.
      if (value.active?.runId === null) value = { ...value, active: null,
        pending: { ...value.active, observedAt: value.active.claimedAt, priorRunId: null } };
    }
    if (!validState(value, repository)) throw new InvalidState("Invalid state schema");
    const active = cleanClaim(value.active);
    const pending = value.pending && { ...cleanClaim(value.pending), observedAt: value.pending.observedAt,
      priorRunId: value.pending.priorRunId };
    const lastVerdict = value.lastVerdict && { targetSha: value.lastVerdict.targetSha, runId: value.lastVerdict.runId };
    return { oid, value: { ...emptyState(repository), sequence: value.sequence, active, pending, lastVerdict,
      records: value.records.map((r) => ({ runId: r.runId, attempt: r.attempt, targetSha: r.targetSha })), status: value.status },
      recovered: false, migrated };
  } catch (error) {
    // Only an absent ref or malformed state is recoverable. Auth/network failures must stop us.
    if (error?.status !== 404 && !(error instanceof InvalidState) && !(error instanceof SyntaxError)) throw error;
    return { oid, value: emptyState(repository), recovered: true };
  }
}

/** beforeOid fences ordinary writes AND compaction; a stale controller cannot overwrite state. */
export async function writeState(api, repository, previous, value) {
  const root = `/repos/${repository}`;
  value = { ...value, sequence: previous.value.sequence + 1 };
  if (!validState(value, repository)) throw new Error("Refusing invalid rolling state");
  const compact = previous.recovered || value.sequence % COMPACT_EVERY === 0;
  const tree = await api(`${root}/git/trees`, { method: "POST", body: { tree: [
    { path: "state.json", mode: "100644", type: "blob", content: JSON.stringify(value) + "\n" },
  ] } });
  const commit = await api(`${root}/git/commits`, { method: "POST", body: {
    message: "Reconcile main rolling validation", tree: tree.sha,
    parents: previous.oid && !compact ? [previous.oid] : [],
  } });
  const repo = await api(root);
  const result = await api("/graphql", { method: "POST", body: {
    query: "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
    variables: { input: { repositoryId: repo.node_id, refUpdates: [{ name: STATE_REF,
      beforeOid: previous.oid ?? ZERO, afterOid: commit.sha, force: Boolean(previous.oid && compact) }] } },
  } });
  if (result?.errors?.length || !result?.data?.updateRefs) throw new StateConflict("Rolling state compare-and-swap refused");
  return { oid: commit.sha, value, recovered: false };
}

async function listRuns(api, repository, query, complete = true) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const payload = await api(`/repos/${repository}/actions/workflows/main-rolling-validation.yml/runs?branch=main&event=workflow_dispatch&per_page=100&page=${page}${query}`);
    if (!Array.isArray(payload?.workflow_runs) || !Number.isSafeInteger(payload.total_count)) throw new Error("Unreadable worker listing");
    runs.push(...payload.workflow_runs);
    if (!complete || runs.length >= payload.total_count) return runs;
  }
  throw new Error("Worker listing truncated; operator reconciliation required");
}

async function readRun(api, repository, id) {
  const run = await api(`/repos/${repository}/actions/runs/${id}`);
  if (!workerIdentity(run, repository)) throw new Error("Unexpected worker run");
  return run;
}

async function readRecords(api, repository, run, cache = new Map()) {
  const root = `/repos/${repository}`;
  const immutable = async (path) => {
    if (!cache.has(path)) cache.set(path, await api(path));
    return cache.get(path);
  };
  const paths = { worker: WORKER, ci: ".github/workflows/ci.yml", windows: ".github/workflows/settings-rows-win32.yml" };
  const blobs = {};
  for (const [key, path] of Object.entries(paths)) {
    const file = await immutable(`${root}/contents/${path}?ref=${run.head_sha}`);
    if (!SHA.test(file?.sha)) throw new Error("Workflow revision unavailable");
    blobs[key] = file.sha;
  }
  if (run.run_attempt > 10) throw new Error("Worker attempts truncated; operator required");
  const records = [];
  const target = await immutable(`${root}/commits/${workerIdentity(run, repository).targetSha}`);
  const targetCommitAt = target?.commit?.committer?.date;
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const snapshot = await api(`${root}/actions/runs/${run.id}/attempts/${attempt}`);
    if (snapshot.id !== run.id || snapshot.run_attempt !== attempt || snapshot.head_sha !== run.head_sha ||
        workerIdentity(snapshot, repository)?.targetSha !== workerIdentity(run, repository)?.targetSha) throw new Error("Changed worker attempt");
    const { jobs, truncated } = await listJobs(api, repository, run.id, attempt);
    if (truncated) throw new Error("Worker jobs truncated");
    const record = validationRecord(repository, snapshot, jobs, blobs);
    records.push({ ...record,
      targetCommitAt: date(targetCommitAt) ? targetCommitAt : null,
      // A committer timestamp is an explicit proxy, not a measured push-arrival timestamp.
      commitToVerdictMinutes: date(targetCommitAt) && date(snapshot.updated_at) && snapshot.status === "completed" && record.verdict !== "superseded"
        ? Math.max(0, (Date.parse(snapshot.updated_at) - Date.parse(targetCommitAt)) / 60_000) : null });
  }
  return records;
}

/** All active runs are read independently of the bounded completed-history window. */
export async function observe(api, repository, state, { targetSha, report = false, mainSha } = {}) {
  mainSha ??= (await api(`/repos/${repository}/git/ref/heads/main`))?.object?.sha;
  if (!SHA.test(mainSha)) throw new Error("Main ancestry unavailable");
  targetSha ??= mainSha;
  const active = [];
  for (const status of ACTIVE) active.push(...await listRuns(api, repository, `&status=${status}`));
  // Recent completions reconstruct missing/rewritten state. Old no-change evidence is re-read by id.
  const recent = await listRuns(api, repository, "&status=completed", false);
  const selected = report ? recent.slice(0, 8) : [
    ...recent.filter((r) => workerIdentity(r, repository)?.targetSha === targetSha).slice(0, 3),
    // A worker may finish before admission records its runId. Its claim still releases old work.
    ...[...new Set([state.active?.claimId, state.pending?.claimId].filter(Boolean))].flatMap((claim) =>
      recent.filter((r) => workerIdentity(r, repository)?.claimId === claim).slice(0, 1)),
  ];
  const candidates = [...active, ...selected];
  const hintIds = new Set([state.active?.runId, state.pending?.runId, state.pending?.priorRunId,
    report || state.lastVerdict?.targetSha === targetSha ? state.lastVerdict?.runId : null].filter(Boolean));
  for (const id of hintIds) {
    if (!candidates.some((r) => r.id === id)) {
      try {
        const run = await api(`/repos/${repository}/actions/runs/${id}`);
        if (workerIdentity(run, repository)) candidates.push(run);
      } catch (error) { if (error?.status !== 404) throw error; }
    }
  }
  const runs = [], ancestry = new Map(), cache = new Map();
  const onMain = async (sha) => {
    if (!ancestry.has(sha)) {
      try {
        const comparison = await api(`/repos/${repository}/compare/${sha}...${mainSha}`);
        ancestry.set(sha, comparison?.merge_base_commit?.sha === sha);
      } catch (cause) { if (cause?.status !== 404) throw cause; ancestry.set(sha, false); }
    }
    return ancestry.get(sha);
  };
  for (const run of new Map(candidates.filter((r) => workerIdentity(r, repository)).map((r) => [r.id, r])).values()) {
    // A tag named main also has head_branch=main. BOTH workflow source and target must be on main.
    if (await onMain(run.head_sha) && await onMain(workerIdentity(run, repository).targetSha)) runs.push(run);
  }
  const records = [];
  for (const run of runs.filter((r) => r.status === "completed")) records.push(...(await readRecords(api, repository, run, cache))
    .map((r) => ({ ...r, mainSnapshotSha: mainSha, workflowAncestryVerified: true, targetAncestryVerified: true })));
  const live = [];
  for (const run of runs.filter((r) => ACTIVE.includes(r.status))) {
    let admissionVerified = false;
    if (run.status === "in_progress") {
      const { jobs, truncated } = await listJobs(api, repository, run.id, run.run_attempt);
      if (truncated) throw new Error("Active worker jobs truncated");
      // A copied successful job from a prior attempt is not current execution.
      const executing = jobs.some((job) => REQUIRED.includes(job.name) && (job.status === "in_progress" ||
        run.run_attempt === 1 && job.status === "completed" && job.steps?.some((step) =>
          date(step.started_at) && step.conclusion !== "skipped")));
      const receipt = jobs.some((job) => job.name === "Admit Main Snapshot" &&
        (run.run_attempt === 1 || job.status === "in_progress") && job.steps?.some((step) =>
          step.name === "Confirm Current Rolling Claim" && step.conclusion === "success"));
      admissionVerified = executing || receipt;
    }
    live.push({ ...run, admissionVerified });
  }
  return { active: live, records, invalidRunIds: [...hintIds].filter((id) => !runs.some((run) => run.id === id)) };
}

/** Pure transition. Native concurrency owns execution; only admission promotes pending intent. */
export function plan(state, observation, mainSha, now, claimId = randomUUID(), recovering = false) {
  const records = [...observation.records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.attempt - a.attempt);
  const verdict = records.find((r) => decisive(r) && latestAttempt(records, r.targetSha) === r);
  const next = { ...state, lastVerdict: verdict ? { runId: verdict.runId, targetSha: verdict.targetSha } : null,
    records: records.slice(0, MAX_HISTORY).map((r) => ({ runId: r.runId, attempt: r.attempt, targetSha: r.targetSha })) };
  const live = [...observation.active].sort((a, b) => (b.status === "in_progress") - (a.status === "in_progress") || a.id - b.id);
  const invalid = new Set(observation.invalidRunIds ?? []);
  const contradicted = (claim) => {
    const evidence = [...live, ...records].find((r) => (r.id ?? r.runId) === claim?.runId);
    return claim && (invalid.has(claim.runId) || evidence && !(matches(claim, evidence, state.repository) ||
      evidence.claimId === claim.claimId && evidence.targetSha === claim.targetSha));
  };
  const oldActive = next.active;
  if (contradicted(next.active)) next.active = null;
  if (contradicted(next.pending) || invalid.has(next.pending?.priorRunId) ||
      oldActive && !next.active && next.pending?.priorRunId === oldActive.runId) next.pending = null;
  const activeRun = live.find((run) => matches(next.active, run, state.repository));
  if (activeRun) next.active = { ...next.active, runId: activeRun.id };
  const provenOwner = live.find((run) => run.admissionVerified);
  if (provenOwner && !matches(next.active, provenOwner, state.repository)) {
    const identity = workerIdentity(provenOwner, state.repository);
    next.active = { targetSha: identity.targetSha, claimId: identity.claimId, claimedAt: provenOwner.created_at,
      runId: provenOwner.id, dispatchCount: 1, lastDispatchAt: provenOwner.created_at };
  }
  // A manual rerun can reuse a successful admission output. The native group still
  // serializes it; track its actual occupancy and stall clock without cancelling it.
  const rerunning = live.find((run) => run.run_attempt > 1 && run.status === "in_progress");
  if (rerunning && !matches(next.active, rerunning, state.repository)) {
    const identity = workerIdentity(rerunning, state.repository);
    next.active = { targetSha: identity.targetSha, claimId: identity.claimId, claimedAt: rerunning.created_at,
      runId: rerunning.id, dispatchCount: 1, lastDispatchAt: rerunning.created_at };
  }
  if (recovering) {
    const running = live.find((run) => run.status === "in_progress");
    if (running) {
      const identity = workerIdentity(running, state.repository);
      next.active = { targetSha: identity.targetSha, claimId: identity.claimId, claimedAt: running.created_at,
        runId: running.id, dispatchCount: 1, lastDispatchAt: running.created_at };
    }
    const queued = live.filter((run) => run !== running && workerIdentity(run, state.repository)?.targetSha === mainSha).at(-1);
    if (queued) {
      const identity = workerIdentity(queued, state.repository);
      next.pending = { targetSha: identity.targetSha, claimId: identity.claimId, claimedAt: queued.created_at,
        runId: queued.id, dispatchCount: 1, lastDispatchAt: queued.created_at, observedAt: now,
        priorRunId: running?.id ?? null };
    }
  }
  const activeFinished = next.active && records.some((r) => r.claimId === next.active.claimId);
  if (activeFinished && !live.some((run) => matches(next.active, run, state.repository))) next.active = null;
  const active = live.find((run) => matches(next.active, run, state.repository));
  const attemptStart = active && (active.run_attempt > 1 && date(active.run_started_at) ? active.run_started_at : active.created_at);
  const stalled = active && Date.parse(now) - Date.parse(attemptStart) > STALLED_MS;
  // A known full verdict or a currently admitted run at live main needs no successor.
  if (decisive(latestAttempt(records, mainSha) ?? {}) || active?.admissionVerified && next.active.targetSha === mainSha) {
    next.pending = null; next.status = active ? stalled ? "stalled-active-run" : "validating" : "current-target-completed";
    return { next, dispatch: false };
  }
  const incomplete = records.filter((r) => r.targetSha === mainSha && r.verdict === "incomplete");
  if (incomplete.length >= 3) {
    next.pending = null; next.status = "recovery-limit-operator-required";
    return { next, dispatch: false };
  }
  let pending = next.pending;
  const finished = pending && records.some((r) => r.claimId === pending.claimId);
  const existing = pending && live.find((run) => matches(pending, run, state.repository));
  if (!pending || pending.targetSha !== mainSha || finished && !existing) {
    // The prior run is a terminal-evidence fence, not a timer or a state-ref certificate.
    pending = { targetSha: mainSha, claimId, claimedAt: now, runId: null, dispatchCount: 0,
      lastDispatchAt: null, observedAt: now, priorRunId: live[0]?.id ?? next.active?.runId ?? null };
  }
  if (existing && matches(pending, existing, state.repository)) pending = { ...pending, runId: existing.id };
  next.pending = pending;
  if (existing && matches(pending, existing, state.repository)) {
    next.status = stalled ? "stalled-active-run" : "validating";
    return { next, dispatch: false };
  }
  const due = !pending.lastDispatchAt || Date.parse(now) - Date.parse(pending.lastDispatchAt) >= RETRY_MS;
  next.status = stalled ? "stalled-active-run" : pending.dispatchCount >= 3 ? "dispatch-unknown-operator-required"
    : pending.dispatchCount ? "dispatch-outcome-unknown" : "claimed";
  return { next, dispatch: due && pending.dispatchCount < 3 };
}

export async function reconcile(repository, { api, now = () => new Date().toISOString(), log = console.log } = {}) {
  for (let retry = 0; retry < 3; retry++) {
    const previous = await readState(api, repository);
    const main = await api(`/repos/${repository}/git/ref/heads/main`);
    if (!SHA.test(main?.object?.sha)) throw new Error("Invalid main head");
    const observation = await observe(api, repository, previous.value, { mainSha: main.object.sha });
    const decision = plan(previous.value, observation, main.object.sha, now(), randomUUID(), previous.recovered);
    const value = decision.dispatch ? { ...decision.next,
      status: decision.next.status === "stalled-active-run" ? "stalled-active-run" : "dispatch-outcome-unknown",
      pending: { ...decision.next.pending, dispatchCount: decision.next.pending.dispatchCount + 1, lastDispatchAt: now() } }
      : decision.next;
    let stored;
    try {
      // One fenced commit records the complete intent BEFORE the only network dispatch.
      stored = isDeepStrictEqual(value, previous.value) && !previous.recovered && !previous.migrated
        ? previous : await writeState(api, repository, previous, value);
    } catch (cause) { if (cause instanceof StateConflict && retry < 2) continue; throw cause; }
    if (decision.dispatch) await api(`/repos/${repository}/actions/workflows/main-rolling-validation.yml/dispatches`, {
      method: "POST", body: { ref: "main", inputs: { target_sha: stored.value.pending.targetSha, claim_id: stored.value.pending.claimId } },
    });
    log(JSON.stringify({ event: "main_rolling_reconciled", recovered: previous.recovered, ...stored.value }));
    return { state: stored.value, records: observation.records };
  }
}

export async function admit(repository, event, runId, attempt, { api, now = () => new Date().toISOString() } = {}) {
  const targetSha = event?.inputs?.target_sha, claimId = event?.inputs?.claim_id;
  if (event?.ref !== "refs/heads/main" || !SHA.test(targetSha) || !UUID.test(claimId)) throw new Error("Invalid worker dispatch");
  const run = await readRun(api, repository, runId);
  const identity = workerIdentity(run, repository);
  if (identity.targetSha !== targetSha || identity.claimId !== claimId || run.run_attempt !== attempt) throw new Error("Worker identity mismatch");
  const comparison = await api(`/repos/${repository}/compare/${targetSha}...main`);
  if (comparison?.merge_base_commit?.sha !== targetSha) throw new Error("Target is outside main ancestry");
  for (let retry = 0; retry < 3; retry++) {
    const previous = await readState(api, repository);
    if (previous.recovered) return false;
    const pending = previous.value.pending;
    const claim = pending?.claimId === claimId && pending.targetSha === targetSha ? pending : null;
    // An unchanged run may rerun its admission; a newer pending claim fences old reruns.
    const rerun = attempt > 1 && !pending && matches(previous.value.active, run, repository) && previous.value.active.runId === runId;
    if (!claim && !rerun) return false;
    const observation = await observe(api, repository, previous.value, { targetSha });
    const alreadyDone = attempt === 1 && decisive(latestAttempt(observation.records, targetSha) ?? {});
    const priors = new Set([previous.value.active?.runId, claim?.priorRunId, claim?.runId].filter((id) => id && id !== runId));
    let terminal = true;
    for (const id of priors) {
      // Missing, rewritten or still-active predecessor evidence never authorizes promotion.
      const prior = await readRun(api, repository, id);
      if (prior.status !== "completed" || !observation.records.some((record) =>
          record.runId === id && record.attempt === prior.run_attempt)) terminal = false;
      if (id === previous.value.active?.runId && !matches(previous.value.active, prior, repository)) terminal = false;
      if (id === claim?.runId && !matches(claim, prior, repository)) terminal = false;
    }
    if (observation.active.some((other) => other.id !== runId && other.status === "in_progress")) terminal = false;
    try {
      if (!terminal) {
        await writeState(api, repository, previous, { ...previous.value,
          status: "predecessor-evidence-operator-required" });
        // Fail the step: default-success receipt/wake steps must not recursively
        // dispatch more admission runners for persistently unsafe evidence.
        throw new UnsafePredecessor("Predecessor evidence requires reconciliation");
      }
      if (alreadyDone) {
        if (claim) await writeState(api, repository, previous, { ...previous.value, pending: null });
        return false;
      }
      await writeState(api, repository, previous, { ...previous.value,
        active: { ...cleanClaim(claim ?? previous.value.active), runId }, pending: null, status: "validating" });
      return true;
    } catch (cause) { if (cause instanceof StateConflict && retry < 2) continue; throw cause; }
  }
}

export async function main(argv, { env = process.env, log = console.log, error = console.error, api } = {}) {
  try {
    const repository = env.GITHUB_REPOSITORY;
    if (!REPOSITORY.test(repository ?? "") || !env.GITHUB_TOKEN || env.GITHUB_REF !== "refs/heads/main") throw new Error("Invalid controller environment");
    api ??= githubApi(env.GITHUB_TOKEN);
    const mode = argv[0] ?? "reconcile";
    if (mode === "reconcile" || mode === "report") {
      const result = mode === "reconcile" ? await reconcile(repository, { api, log })
        : { state: (await readState(api, repository)).value };
      if (mode === "report") log(JSON.stringify(await observe(api, repository, result.state, { report: true })));
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
        `Main rolling validation: ${result.state.status}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
    } else if (mode === "admit") {
      const allowed = await admit(repository, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
        Number(env.GITHUB_RUN_ID), Number(env.GITHUB_RUN_ATTEMPT), { api });
      if (!env.GITHUB_OUTPUT) throw new Error("Worker output unavailable");
      appendFileSync(env.GITHUB_OUTPUT, `admitted=${allowed}\n`);
      log(JSON.stringify({ event: "main_rolling_admission", runId: Number(env.GITHUB_RUN_ID), admitted: allowed }));
    } else throw new Error("Unsupported rolling mode");
    return 0;
  } catch (cause) {
    // Never expose response bodies, event content, network exception messages or credentials.
    error(JSON.stringify({ event: "main_rolling_error", httpStatus: cause?.status ?? null,
      status: cause instanceof UnsafePredecessor ? "predecessor-evidence-operator-required" : "reconciliation-required" }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
