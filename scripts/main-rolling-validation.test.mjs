import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { CANDIDATE_POLICY, candidatePlan, candidateReceipt, queueCandidate } from "./main-validation-candidates.mjs";
import { admit, COMPACT_EVERY, emptyState, main, observe, plan, readState, reconcile, REQUIRED, RETRY_MS, STATE_REF,
  STALLED_MS, candidateSuiteVersion, requestCandidate, isSupersededWorkerAttempt, validationRecord, validState, workerIdentity, WORKER, writeState } from "./main-rolling-validation.mjs";

const repository = "example/project";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), W = "d".repeat(40);
const claimId = "12345678-1234-1234-1234-123456789012";
const nextClaim = "22345678-1234-1234-1234-123456789012";
const at = (minutes = 0) => new Date(Date.UTC(2026, 9, 22, 10, minutes)).toISOString();
const run = (overrides = {}) => ({ id: 10, run_attempt: 1, display_title: `Rolling ${A} ${claimId}`, path: WORKER,
  admissionVerified: true,
  head_sha: W, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success",
  repository: { full_name: repository }, head_repository: { full_name: repository }, created_at: at(),
  run_started_at: at(1), updated_at: at(40), html_url: `https://github.com/${repository}/actions/runs/10`, ...overrides });
const jobs = () => REQUIRED.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success",
  created_at: at(), started_at: at(1), completed_at: at(39), steps: [{ name: "Verify Rolling Checkout", number: 1,
    conclusion: "success", started_at: at(1), completed_at: at(2) }] }));
const blobs = { worker: W, ci: B, windows: C };
const record = (r = run(), js = jobs()) => validationRecord(repository, r, js, blobs);
const pendingState = () => plan(emptyState(repository), { active: [], records: [] }, A, at(), claimId).next;
const claimed = () => ({ ...emptyState(repository), active: { targetSha: A, claimId, claimedAt: at(), runId: 10,
  dispatchCount: 1, lastDispatchAt: at() }, status: "validating" });
const eventFor = (r) => ({ ref: "refs/heads/main", inputs: { target_sha: workerIdentity(r, repository).targetSha,
  claim_id: workerIdentity(r, repository).claimId } });

test("candidate requests deduplicate across purposes and retain their cost bound", () => {
  const request = { targetSha: A, suiteVersion: "f".repeat(64), purpose: "release", requestedAt: at(), claimId };
  let ledger = queueCandidate(undefined, request);
  assert.deepEqual(queueCandidate(ledger, { ...request, purpose: "repair", claimId: nextClaim }), ledger);
  const receipt = candidateReceipt(ledger, A, "repair", request.suiteVersion, at(5));
  assert.equal(receipt.purpose, "repair"); assert.equal(receipt.scheduledPurpose, "release");
  assert.equal(receipt.queueWaitMinutes, 5); assert.equal(receipt.certification, "none");
  assert.equal(CANDIDATE_POLICY.release.minimumIntervalMs, CANDIDATE_POLICY.repair.minimumIntervalMs);
  assert.equal(CANDIDATE_POLICY.release.priority, CANDIDATE_POLICY.repair.priority);
  for (let i = 1; i < CANDIDATE_POLICY.maxRequests; i++) ledger = queueCandidate(ledger,
    { ...request, targetSha: i.toString(16).padStart(40, "0") });
  assert.throws(() => queueCandidate(ledger, { ...request, targetSha: B }), /retention limit/);
  assert.throws(() => queueCandidate(undefined, { ...request, purpose: "unbounded" }), /Invalid/);
});

test("candidate policy prioritizes main, caps shared/per-purpose admissions, and never retries ambiguous dispatch", () => {
  const request = { targetSha: A, suiteVersion: "f".repeat(64), purpose: "release", requestedAt: at(), claimId };
  const observation = { active: [], records: [] };
  const ledger = queueCandidate(undefined, request);
  assert.equal(candidatePlan(ledger, observation, request.suiteVersion, at(1), false).request, null);
  assert.equal(candidatePlan(ledger, { ...observation, active: [run({ status: "in_progress" })] }, request.suiteVersion, at(1), true).request, null);
  assert.equal(candidatePlan(ledger, observation, request.suiteVersion, at(1), true).request.targetSha, A);
  ledger.lastAdmissionAt = at();
  assert.equal(candidatePlan(ledger, observation, request.suiteVersion, at(59), true).request, null);
  assert.ok(candidatePlan(ledger, observation, request.suiteVersion, at(60), true).request);
  ledger.requests[0].dispatchedAt = at();
  const ambiguous = candidatePlan(ledger, observation, request.suiteVersion, at(180), true);
  assert.equal(ambiguous.request, null); assert.equal(ambiguous.next.requests[0].status, "reconciliation-required");
});

test("candidate receipts withdraw success for failed or pending reruns and incompatible suites", () => {
  const good = record();
  let ledger = queueCandidate(undefined, { targetSha: A, suiteVersion: good.suiteVersion, purpose: "release", requestedAt: at(), claimId });
  let result = candidatePlan(ledger, { active: [], records: [good] }, good.suiteVersion, at(42), true);
  assert.equal(result.next.requests[0].status, "success"); assert.equal(result.request, null);
  const receipt = candidateReceipt(result.next, A, "release", good.suiteVersion, at(42));
  assert.ok(receipt.waitMinutes > 0); assert.ok(receipt.executionMinutes > 0);
  result = candidatePlan(result.next, { active: [run({ status: "in_progress", run_attempt: 2 })], records: [good] }, good.suiteVersion, at(45), true);
  assert.equal(result.next.requests[0].status, "dispatched");
  const failed = { ...good, attempt: 2, verdict: "failure" };
  result = candidatePlan(result.next, { active: [], records: [good, failed] }, good.suiteVersion, at(50), true);
  assert.equal(result.next.requests[0].status, "failure"); assert.equal(result.request, null);
  ledger = queueCandidate(undefined, { targetSha: A, suiteVersion: "f".repeat(64), purpose: "repair", requestedAt: at(), claimId });
  assert.equal(candidatePlan(ledger, { active: [], records: [good] }, "e".repeat(64), at(42), true).next.requests[0].status, "incompatible-suite");
  assert.ok(candidatePlan(ledger, { active: [], records: [good] }, "f".repeat(64), at(42), true).request,
    "a newly requested suite can validate a snapshot previously tested with a different suite");
});

test("dispatch identity separates the immutable target from workflow head and rejects other sources", () => {
  assert.equal(workerIdentity(run(), repository).targetSha, A);
  assert.equal(workerIdentity(run(), repository).workflowRevision, W);
  for (const changed of [{ path: ".github/workflows/ci.yml" }, { event: "pull_request" }, { head_branch: "topic" },
    { repository: { full_name: "other/repo" } }, { head_repository: { full_name: "other/repo" } },
    { display_title: `Rolling ${A} $(evil)` }, { head_sha: "main" }, { id: -1 }, { run_attempt: 0 }])
    assert.equal(workerIdentity(run(changed), repository), null);
});

test("only exact worker checkout proofs and every required job can certify the target", () => {
  const good = record();
  assert.equal(good.verdict, "success");
  assert.equal(good.testedSha, A);
  assert.equal(good.dispatcherSha, W);
  assert.equal(good.workflowRevision.executedBlobSha, W);
  assert.equal(good.dispatchToVerdictMinutes, 40);
  assert.ok(good.metrics.consumedRunnerMinutes > 0);
  assert.ok(good.metrics.requiredMinutes > 0);
  assert.equal(good.metrics.browserShardImbalance.observed, 5);
  assert.equal(good.jobs[1].name, REQUIRED[1]);
  assert.equal(good.jobs[1].measurementName, "Browser End-to-End Tests (1)");
  assert.equal(good.suiteVersion.length, 64);
  for (let i = 0; i < REQUIRED.length; i++) {
    const missing = jobs().filter((_, index) => index !== i);
    assert.equal(record(run(), missing).verdict, "incomplete", REQUIRED[i]);
    assert.equal(record(run(), [...jobs(), jobs()[i]]).verdict, "incomplete", "duplicate job");
  }
  const failed = jobs(); failed[1].conclusion = "failure"; failed.at(-1).conclusion = "failure";
  assert.equal(record(run({ conclusion: "failure" }), failed).verdict, "failure");
  const noCheckout = jobs(); noCheckout[0].steps[0].conclusion = "skipped";
  assert.equal(record(run(), noCheckout).verdict, "incomplete");
  const cancelled = jobs(); cancelled[1].conclusion = "cancelled";
  assert.equal(record(run({ conclusion: "cancelled" }), cancelled).verdict, "incomplete");
  assert.equal(record(run({ conclusion: "startup_failure" }), []).verdict, "incomplete");
  const rerun = record(run({ run_attempt: 2 }));
  assert.equal(rerun.attempt, 2);
  assert.equal(rerun.metrics.consumedRunnerMinutes, null, "do not invent cost for copied rerun jobs");
});

test("burst/reordered wakes retain active execution and replace only pending intent", () => {
  let state = claimed();
  const active = run({ status: "in_progress", conclusion: null });
  const queued = plan(state, { active: [active], records: [] }, B, at(5), nextClaim);
  assert.equal(queued.dispatch, true);
  state = { ...queued.next, pending: { ...queued.next.pending, dispatchCount: 1, lastDispatchAt: at(5) } };
  const repeated = plan(state, { active: [active], records: [] }, B, at(6), claimId);
  assert.equal(repeated.dispatch, false); assert.equal(repeated.next.pending.claimId, nextClaim);
  const replacement = plan(state, { active: [active], records: [] }, C, at(7), claimId);
  assert.equal(replacement.dispatch, true); assert.equal(replacement.next.pending.targetSha, C);
  assert.equal(replacement.next.active.runId, 10); assert.equal(replacement.next.active.targetSha, A);
  assert.equal(replacement.next.pending.priorRunId, 10);
});

test("no change, incomplete attempts, stalled execution and unknown dispatch have distinct bounds", () => {
  const done = plan(emptyState(repository), { active: [], records: [record()] }, A, at(41));
  assert.equal(done.dispatch, false); assert.equal(done.next.pending, null);
  const red = record(run({ conclusion: "failure" }), jobs().map((j) => ({ ...j, conclusion: "failure" })));
  assert.equal(plan(done.next, { active: [], records: [red] }, A, at(42)).dispatch, false);
  const state = pendingState();
  state.pending.dispatchCount = 1; state.pending.lastDispatchAt = at();
  assert.equal(plan(state, { active: [], records: [] }, A, at(9)).dispatch, false);
  assert.equal(plan(state, { active: [], records: [] }, A, at(RETRY_MS / 60_000)).dispatch, true);
  state.pending.dispatchCount = 3;
  assert.equal(plan(state, { active: [], records: [] }, A, at(11)).next.status, "dispatch-unknown-operator-required");
  const hung = run({ status: "in_progress", conclusion: null });
  const stalled = plan(claimed(), { active: [hung], records: [] }, A, at(STALLED_MS / 60_000 + 1));
  assert.equal(stalled.dispatch, false); assert.equal(stalled.next.status, "stalled-active-run");
  const rerun = run({ status: "in_progress", conclusion: null, run_attempt: 2, run_started_at: at(180) });
  assert.equal(plan(claimed(), { active: [rerun], records: [] }, A, at(181)).next.status, "validating");
  const incomplete = [10, 11, 12].map((id) => record(run({ id, conclusion: "failure" }), []));
  assert.equal(plan(state, { active: [], records: incomplete }, A, at(50)).next.status, "recovery-limit-operator-required");
  assert.equal(plan(state, { active: [], records: incomplete }, B, at(50)).dispatch, true);
  const superseded = [10, 11, 12].map((id) => record(run({ id, conclusion: "cancelled" }), []));
  const recovered = plan(state, { active: [], records: superseded }, A, at(50));
  assert.equal(recovered.dispatch, true); assert.equal(recovered.next.lastVerdict, null);
});

function forge() {
  const data = { oid: null, values: new Map(), trees: new Map(), commits: new Map(), runs: [], jobs: new Map(),
    dispatches: [], mutations: [], requests: [], main: A, count: 0, nextRunId: 100, deniedAncestry: false, deniedRevisions: new Set() };
  const oid = () => (++data.count).toString(16).padStart(40, "0");
  const notFound = () => { const error = new Error("not found"); error.status = 404; throw error; };
  const api = async (path, options = {}) => {
    data.requests.push(path);
    const { body, method = "GET" } = options;
    if (path === "/graphql") {
      const update = body.variables.input.refUpdates[0];
      data.mutations.push(update);
      if (update.beforeOid !== (data.oid ?? "0".repeat(40))) return { errors: [{ message: "CAS failed" }] };
      data.oid = update.afterOid;
      return { data: { updateRefs: { clientMutationId: null } } };
    }
    const url = new URL(`https://api.github.com${path}`);
    const local = url.pathname.replace(`/repos/${repository}`, "");
    if (local === "") return { node_id: "repository-node" };
    if (local === "/git/ref/heads/main") return { object: { sha: data.main } };
    if (local === "/git/ref/heads/ci/main-rolling-state") return data.oid ? { object: { sha: data.oid } } : notFound();
    if (local === "/git/trees" && method === "POST") {
      const sha = oid(), blob = oid(); data.values.set(blob, body.tree[0].content);
      data.trees.set(sha, { tree: [{ path: "state.json", type: "blob", sha: blob }] }); return { sha };
    }
    if (local === "/git/commits" && method === "POST") {
      const sha = oid(); data.commits.set(sha, { ...body, tree: { sha: body.tree } }); return { sha };
    }
    if (local.startsWith("/git/commits/")) return data.commits.get(local.split("/").at(-1)) ?? notFound();
    if (local.startsWith("/git/trees/")) return data.trees.get(local.split("/").at(-1)) ?? notFound();
    if (local.startsWith("/git/blobs/")) {
      const value = data.values.get(local.split("/").at(-1));
      return { content: Buffer.from(value).toString("base64"), encoding: "base64", size: value.length };
    }
    if (local.includes("/compare/")) {
      const source = local.split("/").at(-1).split("...")[0];
      return { merge_base_commit: { sha: data.deniedAncestry || data.deniedRevisions.has(source) ? "f".repeat(40) : source } };
    }
    if (local.startsWith("/contents/")) return { sha: W };
    if (local.startsWith("/commits/")) return { commit: { committer: { date: at(-1) } } };
    if (local.endsWith("/dispatches")) {
      data.dispatches.push(body);
      if (data.nativeQueue) {
        const busy = data.runs.some((r) => r.status === "in_progress");
        for (const r of data.runs.filter((r) => r.status === "pending")) {
          r.status = "completed"; r.conclusion = "cancelled"; data.jobs.set(`${r.id}/${r.run_attempt}`, []);
        }
        data.runs.push(run({ id: ++data.nextRunId, display_title: `Rolling ${body.inputs.target_sha} ${body.inputs.claim_id}`,
          status: busy ? "pending" : "in_progress", conclusion: null }));
      }
      if (data.dispatchError) throw data.dispatchError;
      return null;
    }
    if (local.endsWith("/runs")) {
      const selected = data.runs.filter((r) => r.status === url.searchParams.get("status"));
      return { workflow_runs: selected, total_count: selected.length };
    }
    const id = Number(local.split("/")[3]);
    if (local.endsWith("/jobs")) {
      const result = data.jobs.get(`${id}/${local.split("/")[5]}`) ?? jobs();
      return { jobs: result, total_count: result.length };
    }
    if (local.startsWith("/actions/runs/")) {
      const result = data.runs.find((r) => r.id === id);
      return result ? { ...result, ...(local.includes("/attempts/") ? { run_attempt: Number(local.split("/")[5]) } : {}) } : notFound();
    }
    throw new Error(`Unexpected fake request ${method} ${local}`);
  };
  data.finish = (r) => {
    r.status = "completed"; r.conclusion = "success";
    const pending = data.runs.find((other) => other.status === "pending");
    if (pending) pending.status = "in_progress";
  };
  return { data, api };
}

test("candidate request persists before dispatch, concurrent/cross-purpose duplicates share one claim", async () => {
  const { data, api } = forge();
  await assert.rejects(requestCandidate(repository, B, { api }), /state requires operator/);
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  const receipts = await Promise.all(["release", "repair"].map((purpose) => requestCandidate(repository, B, { api, purpose, now: () => at() })));
  assert.equal(receipts[0].claimId, receipts[1].claimId);
  assert.equal(data.dispatches.length, 0);
  assert.equal((await readState(api, repository)).value.candidates.requests.length, 1);
  data.deniedAncestry = true;
  await assert.rejects(requestCandidate(repository, C, { api }), /outside main/);
});

test("candidate dispatch/admission survives wakes, then new main takes priority without cancelling it", async () => {
  const { data, api } = forge();
  data.nativeQueue = true;
  data.runs.push(run());
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  const receipt = await requestCandidate(repository, B, { api, purpose: "repair", now: () => at(41) });
  assert.equal(receipt.suiteVersion, await candidateSuiteVersion(api, repository, W));
  const dispatched = await reconcile(repository, { api, now: () => at(102), log: () => {} });
  assert.equal(data.dispatches.length, 1);
  assert.equal(dispatched.state.pending.targetSha, B);
  const worker = data.runs.at(-1);
  data.jobs.set(`${worker.id}/1`, []);
  const wake = await reconcile(repository, { api, now: () => at(43), log: () => {} });
  assert.equal(wake.state.pending.claimId, receipt.claimId, "ordinary completed-main reconciliation retains candidate admission intent");
  assert.equal(data.dispatches.length, 1);
  assert.equal(await admit(repository, eventFor(worker), worker.id, 1, { api }), true);
  data.jobs.set(`${worker.id}/1`, jobs());
  assert.equal(await admit(repository, eventFor(worker), worker.id, 1, { api }), false, "duplicate admission cannot repeat a full run");
  worker.run_attempt = 2;
  assert.equal(await admit(repository, eventFor(worker), worker.id, 2, { api }), false);
  worker.run_attempt = 1;
  data.main = C;
  const next = await reconcile(repository, { api, now: () => at(44), log: () => {} });
  assert.equal(next.state.pending.targetSha, C);
  assert.equal(worker.status, "in_progress");
  data.finish(worker);
  const done = await reconcile(repository, { api, now: () => at(85), log: () => {} });
  assert.equal(done.state.candidates.requests[0].status, "success");
  assert.equal(done.state.candidates.requests[0].runId, worker.id);
  assert.equal(data.dispatches.filter((d) => d.inputs.target_sha === B).length, 1);
});

test("candidate dispatch ambiguity consumes its budget and cannot loop or displace main", async () => {
  const { data, api } = forge();
  data.runs.push(run());
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  await requestCandidate(repository, B, { api, now: () => at(41) });
  data.dispatchError = new Error("unknown delivery");
  await assert.rejects(reconcile(repository, { api, now: () => at(102), log: () => {} }), /unknown delivery/);
  data.dispatchError = null;
  for (const minutes of [43, 60, 180]) await reconcile(repository, { api, now: () => at(minutes), log: () => {} });
  assert.equal(data.dispatches.length, 1);
  assert.equal((await readState(api, repository)).value.candidates.requests[0].status, "reconciliation-required");
  data.main = C;
  await reconcile(repository, { api, now: () => at(181), log: () => {} });
  assert.equal(data.dispatches.at(-1).inputs.target_sha, C);
});

test("unavailable candidate suite evidence cannot block the main backlog", async () => {
  const { data, api } = forge();
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  await requestCandidate(repository, B, { api, now: () => at() });
  const unavailable = async (path, options) => {
    if (path.includes("/contents/")) throw new Error("unavailable");
    return api(path, options);
  };
  data.main = C;
  await reconcile(repository, { api: unavailable, now: () => at(90), log: () => {} });
  assert.equal(data.dispatches.length, 1); assert.equal(data.dispatches[0].inputs.target_sha, C);
});

test("candidate admission rechecks a newly advanced main backlog", async () => {
  const { data, api } = forge();
  data.nativeQueue = true; data.runs.push(run());
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  await requestCandidate(repository, B, { api, now: () => at(41) });
  await reconcile(repository, { api, now: () => at(102), log: () => {} });
  const worker = data.runs.at(-1);
  data.jobs.set(`${worker.id}/1`, []);
  data.main = C;
  assert.equal(await admit(repository, eventFor(worker), worker.id, 1, { api }), false);
  await reconcile(repository, { api, now: () => at(103), log: () => {} });
  assert.equal(data.dispatches.at(-1).inputs.target_sha, C);
});

test("transient optional evidence errors preserve an already-dispatched admission claim", async () => {
  const { data, api } = forge();
  data.nativeQueue = true; data.runs.push(run());
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  const receipt = await requestCandidate(repository, B, { api, now: () => at(41) });
  await reconcile(repository, { api, now: () => at(102), log: () => {} });
  const worker = data.runs.at(-1); data.jobs.set(`${worker.id}/1`, []);
  let reads = 0;
  const unavailable = async (path, options) => {
    if (path.includes("/contents/") && ++reads > 3) throw new Error("optional transient failure");
    return api(path, options);
  };
  const wake = await reconcile(repository, { api: unavailable, now: () => at(103), log: () => {} });
  assert.equal(wake.state.pending.claimId, receipt.claimId);
  assert.equal(await admit(repository, eventFor(worker), worker.id, 1, { api }), true);
});

test("candidate scheduling remains bounded with over 1000 historical workers", async () => {
  const { data, api } = forge(); data.runs.push(run());
  await writeState(api, repository, await readState(api, repository), emptyState(repository));
  await requestCandidate(repository, B, { api, now: () => at(41) });
  const large = async (path, options) => {
    const result = await api(path, options);
    return path.includes("status=completed") ? { ...result, total_count: 1500 } : result;
  };
  const before = data.requests.length;
  await reconcile(repository, { api: large, now: () => at(102), log: () => {} });
  assert.equal(data.dispatches.length, 1); assert.equal(data.dispatches[0].inputs.target_sha, B);
  assert.ok(data.requests.length - before <= 55, `bounded reads/writes: ${data.requests.length - before}`);
  assert.ok(!data.requests.some((p) => /status=completed.*page=2|page=2.*status=completed/.test(p)));
});

test("retained terminal candidate receipts do not cause repeated historical job reads", async () => {
  const { data, api } = forge(); data.runs.push(run());
  let ledger;
  for (let i = 1; i <= CANDIDATE_POLICY.maxRequests; i++) ledger = queueCandidate(ledger,
    { targetSha: i.toString(16).padStart(40, "0"), suiteVersion: "f".repeat(64), purpose: "release", requestedAt: at(), claimId });
  ledger.requests.forEach((r, i) => Object.assign(r, { status: "success", runId: i + 100, dispatchedAt: at() }));
  await writeState(api, repository, await readState(api, repository), { ...emptyState(repository), candidates: ledger });
  const before = data.requests.length;
  await reconcile(repository, { api, now: () => at(102), log: () => {} });
  assert.ok(data.requests.length - before <= 45, `steady-state calls: ${data.requests.length - before}`);
  assert.ok(!data.requests.some((p) => /\/actions\/runs\/1\d\d/.test(p)), "no terminal candidate run re-reads");
});

test("newer incompatible-suite work does not leave a reusable older-suite request looping", () => {
  const good = record();
  const ledger = queueCandidate(undefined, { targetSha: A, suiteVersion: good.suiteVersion, purpose: "release", requestedAt: at(), claimId });
  const other = { ...good, runId: 11, suiteVersion: "f".repeat(64) };
  const result = candidatePlan(ledger, { active: [], records: [good, other] }, good.suiteVersion, at(102), true);
  assert.equal(result.next.requests[0].status, "reconciliation-required");
  assert.equal(result.request, null, "do not silently reuse green preceding a newer incompatible run");
});

test("request recording has its own CAS-fenced job outside controller pending coalescing", () => {
  const workflow = readFileSync(new URL("../.github/workflows/main-rolling-controller.yml", import.meta.url), "utf8");
  const requestJob = workflow.slice(workflow.indexOf("  request:"), workflow.indexOf("  reconcile:"));
  assert.match(requestJob, /run: node scripts\/main-rolling-validation.mjs request/);
  assert.doesNotMatch(requestJob, /concurrency:|actions: write/);
});

test("state writes are fenced, compact at the bound, reject stale writers and strip unknown data", async () => {
  const { data, api } = forge();
  let previous = await readState(api, repository);
  assert.equal(previous.recovered, true);
  const first = await writeState(api, repository, previous, claimed());
  assert.equal(data.mutations[0].name, STATE_REF);
  assert.equal(data.mutations[0].beforeOid, "0".repeat(40));
  assert.equal(data.mutations[0].force, false);
  const value = { ...first.value, sequence: COMPACT_EVERY - 1 };
  previous = { ...first, value };
  const compacted = await writeState(api, repository, previous, value);
  assert.equal(data.commits.get(compacted.oid).parents.length, 0);
  assert.equal(data.mutations.at(-1).force, true);
  assert.equal(data.mutations.at(-1).beforeOid, first.oid);
  await assert.rejects(writeState(api, repository, first, first.value), /compare-and-swap/);
  const current = await readState(api, repository);
  assert.equal(current.value.sequence, COMPACT_EVERY);
  assert.equal(validState({ ...current.value, records: [{ runId: -1 }] }, repository), false);
  assert.equal(validState({ ...current.value, status: "sensitive arbitrary text" }, repository), false);
  const blobId = data.trees.get(data.commits.get(data.oid).tree.sha).tree[0].sha;
  data.values.set(blobId, JSON.stringify({ ...current.value, unexpected: "private text", active: { ...current.value.active, secret: "private text" } }));
  const clean = await readState(api, repository);
  assert.ok(!JSON.stringify(clean).includes("private text"));
  data.values.set(blobId, "{bad json");
  const corrupt = await readState(api, repository);
  assert.equal(corrupt.recovered, true); assert.equal(corrupt.oid, data.oid);
  const unavailable = async () => { const error = new Error("private transport error"); error.status = 403; throw error; };
  await assert.rejects(readState(unavailable, repository));
  await assert.rejects(readState(async () => { throw new Error("network failed"); }, repository));
});

test("controller persists native pending intent; two successors start without completion callbacks", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  const log = () => {};
  const first = await reconcile(repository, { api, now: () => at(), log });
  assert.equal(first.state.active, null); assert.equal(first.state.pending.dispatchCount, 1);
  const a = data.runs.at(-1);
  assert.equal(await admit(repository, eventFor(a), a.id, 1, { api }), true);
  data.main = B;
  await reconcile(repository, { api, now: () => at(2), log });
  const b = data.runs.at(-1);
  assert.equal(b.status, "pending"); assert.equal(a.status, "in_progress");
  data.main = C;
  await reconcile(repository, { api, now: () => at(3), log });
  const c = data.runs.at(-1);
  assert.equal(b.conclusion, "cancelled"); assert.equal(c.status, "pending");
  data.finish(a);
  assert.equal(c.status, "in_progress", "native slot activates successor without a controller callback");
  assert.equal(await admit(repository, eventFor(c), c.id, 1, { api }), true);
  assert.equal((await readState(api, repository)).value.active.runId, c.id);
  data.main = W;
  await reconcile(repository, { api, now: () => at(42), log });
  const d = data.runs.at(-1); assert.equal(d.status, "pending");
  data.finish(c);
  assert.equal(d.status, "in_progress");
  assert.equal(await admit(repository, eventFor(d), d.id, 1, { api }), true);
  assert.equal(data.dispatches.length, 4);
  assert.ok(!data.requests.some((path) => path.endsWith("/cancel")), "never cancel any active run");
  const report = await observe(api, repository, (await readState(api, repository)).value, { report: true });
  assert.equal(report.records.find((r) => r.runId === b.id)?.verdict, "superseded");
});

test("lost/corrupt state reconstructs active work and verdicts from Actions; untrusted hints cannot certify", async () => {
  const { data, api } = forge();
  data.runs = [run({ status: "in_progress", conclusion: null })]; data.main = C;
  const recovered = await reconcile(repository, { api, now: () => at(20), log: () => {} });
  assert.equal(recovered.state.active.runId, 10);
  assert.equal(recovered.state.pending.targetSha, C);
  assert.equal(data.dispatches.length, 1, "recovery queues latest main behind the recovered active run");
  data.oid = null; data.main = A; data.runs = [run()];
  const done = await reconcile(repository, { api, now: () => at(41), log: () => {} });
  assert.equal(done.state.status, "current-target-completed");
  assert.equal(data.dispatches.length, 1, "no additional dispatch for a verified target");
  const before = data.oid;
  await reconcile(repository, { api, now: () => at(42), log: () => {} });
  assert.equal(data.oid, before, "quiet traffic does not grow the state ref");
});

test("unknown dispatch is not retried in-place, and admission checks run, claim and main ancestry", async () => {
  const { data, api } = forge();
  data.dispatchError = new Error("unknown response");
  await assert.rejects(reconcile(repository, { api, now: () => at(), log: () => {} }));
  assert.equal(data.dispatches.length, 1);
  const stored = await readState(api, repository);
  assert.equal(stored.value.pending.dispatchCount, 1);
  const event = { ref: "refs/heads/main", inputs: { target_sha: A, claim_id: stored.value.pending.claimId } };
  data.runs = [run({ display_title: `Rolling ${A} ${event.inputs.claim_id}`, status: "in_progress" })];
  assert.equal(await admit(repository, event, 10, 1, { api }), true);
  assert.equal((await readState(api, repository)).value.active.runId, 10);
  data.deniedAncestry = true;
  await assert.rejects(admit(repository, event, 10, 1, { api }), /ancestry/);
  await assert.rejects(admit(repository, { ...event, ref: "refs/heads/topic" }, 10, 1, { api }));
  await assert.rejects(admit(repository, event, 10, 2, { api }), /mismatch/);
  data.deniedAncestry = false;
  const current = await readState(api, repository);
  await writeState(api, repository, current, { ...current.value, active: { ...current.value.active, claimId: nextClaim } });
  assert.equal(await admit(repository, event, 10, 1, { api }), false);
});

test("a main-named tag with an untrusted workflow revision cannot certify or block main", async () => {
  const { data, api } = forge();
  data.runs = [run()]; data.deniedRevisions.add(W);
  const result = await reconcile(repository, { api, now: () => at(41), log: () => {} });
  assert.equal(result.records.length, 0);
  assert.equal(data.dispatches.length, 1, "real main validation still dispatches");
  data.oid = null; data.runs = [run({ status: "in_progress", conclusion: null })];
  const active = await reconcile(repository, { api, now: () => at(42), log: () => {} });
  assert.equal(active.state.active, null, "untrusted active tag is not adopted as a validation");
});

test("a completed unadmitted older claim releases the latest pending main target", async () => {
  const { data, api } = forge();
  const first = await reconcile(repository, { api, now: () => at(), log: () => {} });
  assert.equal(first.state.pending.runId, null);
  data.main = B;
  data.runs = [run({ display_title: `Rolling ${A} ${first.state.pending.claimId}`, conclusion: "startup_failure" })];
  data.jobs.set("10/1", []);
  const next = await reconcile(repository, { api, now: () => at(11), log: () => {} });
  assert.equal(next.state.pending.targetSha, B);
  assert.equal(data.dispatches.at(-1).inputs.target_sha, B);
});

test("steady-state reconciliation reads only relevant evidence and stays within its API-call budget", async () => {
  const { data, api } = forge();
  data.runs = [run(), ...Array.from({ length: 8 }, (_, i) => run({ id: 20 + i, display_title: `Rolling ${B} ${claimId}` }))];
  const first = await reconcile(repository, { api, now: () => at(41), log: () => {} });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].workflowAncestryVerified, true);
  const before = data.requests.length;
  await reconcile(repository, { api, now: () => at(42), log: () => {} });
  assert.ok(data.requests.length - before <= 22, `steady-state REST/GraphQL calls: ${data.requests.length - before}`);
});

test("errors never log response bodies or token-bearing exception messages", async () => {
  const errors = [];
  const rc = await main(["reconcile"], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "private-token", GITHUB_REF: "refs/heads/main" },
    api: async () => { throw new Error("private-token private response body"); }, error: (line) => errors.push(line) });
  assert.equal(rc, 1); assert.ok(!errors.join("").includes("private-token"));
  assert.deepEqual(JSON.parse(errors[0]), { event: "main_rolling_error", httpStatus: null, status: "reconciliation-required" });
});

test("a delayed duplicate dispatch cannot repeat an already verified target", async () => {
  const { data, api } = forge();
  const initial = await readState(api, repository);
  await writeState(api, repository, initial, pendingState());
  data.runs = [run(), run({ id: 11, status: "in_progress", conclusion: null })];
  const event = { ref: "refs/heads/main", inputs: { target_sha: A, claim_id: claimId } };
  assert.equal(await admit(repository, event, 11, 1, { api }), false);
});

test("an admission CAS race cannot discard or promote a newer pending claim", async () => {
  const { data, api } = forge();
  await writeState(api, repository, await readState(api, repository), pendingState());
  data.runs = [run({ status: "in_progress", conclusion: null })];
  let raced = false;
  const racingApi = async (path, options) => {
    if (path === "/graphql" && !raced) {
      raced = true;
      const current = await readState(api, repository);
      await writeState(api, repository, current, { ...current.value,
        pending: { ...current.value.pending, targetSha: B, claimId: nextClaim } });
    }
    return api(path, options);
  };
  const event = { ref: "refs/heads/main", inputs: { target_sha: A, claim_id: claimId } };
  assert.equal(await admit(repository, event, 10, 1, { api: racingApi }), false);
  const final = await readState(api, repository);
  assert.equal(final.value.active, null); assert.equal(final.value.pending.targetSha, B);
});

test("workflow security, exact checkout wiring and original gate contracts remain explicit", () => {
  const read = (path) => readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8");
  const controller = read("main-rolling-controller.yml"), worker = read("main-rolling-validation.yml");
  const ci = read("ci.yml"), windows = read("settings-rows-win32.yml");
  assert.match(controller, /branches: \[main\]/);
  assert.match(controller, /types: \[completed\]/);
  assert.match(controller, /cron: '7,17,27,37,47,57 \* \* \* \*'/);
  assert.match(worker, /group: main-rolling-full-validation\n  cancel-in-progress: false/);
  for (const text of [controller, worker]) {
    assert.match(text, /permissions: \{\}/);
    assert.match(text, /persist-credentials: false/);
    assert.doesNotMatch(text, /pull_request_target|secrets: inherit|download-artifact/);
    for (const shell of text.matchAll(/run: (.+)/g)) assert.ok(!shell[1].includes("${{"));
  }
  assert.match(controller, /group: main-rolling-state\n      cancel-in-progress: false/);
  assert.doesNotMatch(worker, /group: main-rolling-state/, "a queued controller must not evict pending worker admission");
  assert.match(worker, /name: Full Validation\n    permissions:\n      contents: read\n    uses: .\/.github\/workflows\/ci.yml/);
  assert.equal((ci.match(/ref: \$\{\{ inputs.target_sha \}\}/g) ?? []).length, 4);
  assert.equal((ci.match(/name: Verify Rolling Checkout/g) ?? []).length, 3);
  assert.equal((windows.match(/name: Verify Rolling Checkout/g) ?? []).length, 2);
  assert.match(controller, /on:\n  push:\n    branches: \[main\]/, "main pushes retain the authoritative rolling controller");
  assert.match(ci, /  merge_group:/);
  assert.match(ci, /    needs: \[checks, browser, win32, webkit, suite_plan\]/);
  assert.match(ci, /CI_EVIDENCE_HEAD: \$\{\{ inputs.target_sha \|\| github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(ci, /--head "\$CI_EVIDENCE_HEAD"/);
});

test("native pending intent is dispatched while the active snapshot remains untouched", () => {
  const activeClaim = { targetSha: A, claimId, claimedAt: at(), runId: 10, dispatchCount: 1, lastDispatchAt: at() };
  const state = { ...emptyState(repository), active: activeClaim };
  const active = run({ status: "in_progress", conclusion: null });
  const result = plan(state, { active: [active], records: [] }, B, at(5), nextClaim);
  assert.equal(result.dispatch, true, "queue the successor now; completion callback is not required");
  assert.deepEqual(result.next.active, activeClaim);
  assert.equal(result.next.pending.targetSha, B);
  assert.equal(result.next.pending.claimId, nextClaim);
  assert.equal(result.next.pending.priorRunId, 10);
});

test("a cancelled first-attempt native pending run is a non-verdict, never a validation failure", () => {
  const superseded = record(run({ status: "completed", conclusion: "cancelled" }), []);
  assert.equal(superseded.verdict, "superseded");
  assert.equal(superseded.checkoutVerified, false);
  assert.equal(superseded.dispatchToVerdictMinutes, null);
  assert.equal(record(run({ run_attempt: 2, conclusion: "cancelled" }), []).verdict, "incomplete",
    "a rerun must still withdraw its previous certificate");
});


test("pending promotion requires authoritative terminal evidence for the predecessor", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await reconcile(repository, { api, now: () => at(), log: () => {} });
  const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
  data.main = B; await reconcile(repository, { api, now: () => at(2), log: () => {} });
  const b = data.runs.at(-1);
  await assert.rejects(admit(repository, eventFor(b), b.id, 1, { api }), /predecessor/i);
  assert.equal((await readState(api, repository)).value.active.runId, a.id);
  assert.equal((await readState(api, repository)).value.status, "predecessor-evidence-operator-required");
});

test("lost coordination reconstructs the admitted owner and native queued claim before promotion", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await reconcile(repository, { api, now: () => at(), log: () => {} });
  const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
  data.main = B; await reconcile(repository, { api, now: () => at(2), log: () => {} });
  const b = data.runs.at(-1); data.oid = null;
  const restored = await reconcile(repository, { api, now: () => at(3), log: () => {} });
  assert.equal(restored.state.active.runId, a.id);
  assert.equal(restored.state.pending.runId, b.id); assert.equal(restored.state.pending.priorRunId, a.id);
  assert.equal(data.dispatches.length, 2);
  data.finish(a);
  assert.equal(await admit(repository, eventFor(b), b.id, 1, { api }), true);
});

test("a late superseded run cannot execute the suite and its explicit wake repairs a lost native slot", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await reconcile(repository, { api, now: () => at(), log: () => {} });
  const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
  data.main = B; await reconcile(repository, { api, now: () => at(2), log: () => {} });
  const b = data.runs.at(-1);
  data.main = C; await reconcile(repository, { api, now: () => at(3), log: () => {} });
  const c = data.runs.at(-1);
  // The documented queue order is not dispatch order: a delayed old dispatch can displace C.
  c.status = "completed"; c.conclusion = "cancelled"; data.jobs.set(`${c.id}/1`, []);
  b.status = "pending"; b.conclusion = null; data.finish(a);
  assert.equal(b.status, "in_progress");
  assert.equal(await admit(repository, eventFor(b), b.id, 1, { api }), false);
  assert.equal((await readState(api, repository)).value.pending.claimId, eventFor(c).inputs.claim_id);
  // This is the explicit workflow_dispatch wake on rejected admission, not workflow_run.
  await reconcile(repository, { api, now: () => at(41), log: () => {} });
  const replacement = data.runs.at(-1);
  assert.notEqual(replacement.id, c.id); assert.equal(replacement.status, "pending");
  data.jobs.set(`${b.id}/1`, [{ name: "Admit Main Snapshot", steps: [
    { name: "Skip Superseded Rolling Claim", conclusion: "success" }], status: "completed", conclusion: "success" }]);
  data.finish(b);
  assert.equal(await admit(repository, eventFor(replacement), replacement.id, 1, { api }), true);
  assert.equal(record(b, data.jobs.get(`${b.id}/1`)).verdict, "superseded");
});

test("controller CAS contention with admission retries from live main before dispatching", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await reconcile(repository, { api, now: () => at(), log: () => {} });
  const a = data.runs.at(-1); let raced = false;
  const racingApi = async (path, options) => {
    if (path === "/graphql" && !raced) {
      raced = true;
      await admit(repository, eventFor(a), a.id, 1, { api });
      data.main = C;
    }
    return api(path, options);
  };
  data.main = B;
  const result = await reconcile(repository, { api: racingApi, now: () => at(2), log: () => {} });
  assert.equal(result.state.active.runId, a.id);
  assert.equal(result.state.pending.targetSha, C);
  assert.equal(data.dispatches.length, 2, "failed CAS must not dispatch its obsolete target");
  assert.equal(data.dispatches.at(-1).inputs.target_sha, C);
});

test("version-one hints migrate without inventing a queued claim or trusting extra fields", async () => {
  const { data, api } = forge();
  const stored = await writeState(api, repository, await readState(api, repository), claimed());
  const blobId = data.trees.get(data.commits.get(data.oid).tree.sha).tree[0].sha;
  data.values.set(blobId, JSON.stringify({ ...stored.value, version: 1,
    pending: { targetSha: B, observedAt: at(2) }, secret: "private" }));
  const migrated = await readState(api, repository);
  assert.equal(migrated.migrated, true); assert.equal(migrated.value.version, 2);
  assert.equal(migrated.value.active.runId, 10); assert.equal(migrated.value.pending, null);
  assert.ok(!JSON.stringify(migrated.value).includes("private"));
  data.values.set(blobId, JSON.stringify({ ...stored.value, version: 1, active: { ...stored.value.active, runId: null } }));
  const intent = await readState(api, repository);
  assert.equal(intent.value.active, null); assert.equal(intent.value.pending.claimId, claimId);
  data.values.set(blobId, JSON.stringify({ ...stored.value, version: 99 }));
  assert.equal((await readState(api, repository)).recovered, true);
});

test("supersession never hides executed work, missing execution evidence or a rerun", () => {
  const cancelled = run({ conclusion: "cancelled" });
  const untouched = [{ name: "Admit Main Snapshot", started_at: null, steps: [], conclusion: "cancelled" }];
  assert.equal(isSupersededWorkerAttempt(cancelled, untouched), true);
  assert.equal(isSupersededWorkerAttempt(cancelled, [{ ...untouched[0], started_at: at(1) }]), false);
  assert.equal(isSupersededWorkerAttempt(cancelled, jobs()), false);
  assert.equal(isSupersededWorkerAttempt(run({ run_attempt: 2, conclusion: "cancelled" }), []), false);
  assert.equal(isSupersededWorkerAttempt(run(), []), false);
  const marker = [{ name: "Admit Main Snapshot", steps: [{ name: "Skip Superseded Rolling Claim", conclusion: "success" }] }];
  assert.equal(isSupersededWorkerAttempt(run(), marker), true);
  assert.equal(isSupersededWorkerAttempt(run(), [...marker, jobs()[0]]), false);
  assert.equal(isSupersededWorkerAttempt(run(), [{ ...marker[0], steps: [{ ...marker[0].steps[0], conclusion: "skipped" }] }]), false);
});


test("rewritten predecessor hints or untrusted predecessor ancestry cannot authorize promotion", async () => {
  for (const poison of ["identity", "ancestry"]) {
    const { data, api } = forge(); data.nativeQueue = true;
    await reconcile(repository, { api, now: () => at(), log: () => {} });
    const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
    data.main = B; await reconcile(repository, { api, now: () => at(2), log: () => {} });
    const b = data.runs.at(-1); data.finish(a);
    if (poison === "identity") a.display_title = `Rolling ${C} ${nextClaim}`;
    else data.deniedRevisions.add(A); // predecessor target fails the independent main-ancestry check
    await assert.rejects(admit(repository, eventFor(b), b.id, 1, { api }), /predecessor/i, poison);
  }
});

test("an incomplete rerun withdraws its old success and permits a fresh validation", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await reconcile(repository, { api, now: () => at(), log: () => {} });
  const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
  data.finish(a); a.run_attempt = 2; a.conclusion = "cancelled";
  // The earlier attempt really passed; only the latest rerun has no execution evidence.
  data.jobs.set(`${a.id}/2`, []);
  const snapshots = async (path, options) => {
    const result = await api(path, options);
    return path.endsWith(`/runs/${a.id}/attempts/1`) ? { ...result, run_attempt: 1, conclusion: "success" } : result;
  };
  const repaired = await reconcile(repository, { api: snapshots, now: () => at(50), log: () => {} });
  assert.equal(repaired.records.find((r) => r.attempt === 1).verdict, "success");
  assert.equal(repaired.records.find((r) => r.attempt === 2).verdict, "incomplete");
  assert.equal(data.dispatches.length, 2, "old success must not suppress repair of an incomplete rerun");
  const fresh = data.runs.at(-1);
  assert.equal(await admit(repository, eventFor(fresh), fresh.id, 1, { api: snapshots }), true);
});

test("generated main bursts preserve active work and admit only the newest pending target", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(B, C, W), { minLength: 1, maxLength: 20 }), async (targets) => {
    const { data, api } = forge(); data.nativeQueue = true;
    await reconcile(repository, { api, now: () => at(), log: () => {} });
    const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
    for (const [index, target] of targets.entries()) {
      data.main = target;
      const result = await reconcile(repository, { api, now: () => at(index + 1), log: () => {} });
      assert.equal(a.status, "in_progress"); assert.equal(result.state.active.runId, a.id);
      assert.equal(result.state.pending.targetSha, target);
      assert.equal(data.runs.filter((r) => r.status === "pending").length, 1);
      assert.equal(data.runs.filter((r) => r.status === "in_progress").length, 1);
      assert.ok(validState(result.state, repository));
    }
    const newest = data.runs.find((r) => r.status === "pending");
    assert.equal(workerIdentity(newest, repository).targetSha, targets.at(-1));
    data.finish(a);
    assert.equal(newest.status, "in_progress");
    assert.equal(await admit(repository, eventFor(newest), newest.id, 1, { api }), true);
    const final = (await readState(api, repository)).value;
    assert.equal(final.active.targetSha, targets.at(-1)); assert.equal(final.pending, null);
    assert.ok(!data.requests.some((path) => path.endsWith("/cancel")));
  }), { numRuns: 200, examples: [[[B]], [[B, B, B]], [[B, C, W, B]]] });
});

test("manual reruns with copied admission are tracked as the active owner and report a stall", () => {
  const manual = run({ id: 19, run_attempt: 2, status: "in_progress", conclusion: null,
    run_started_at: at(180) });
  const result = plan(emptyState(repository), { active: [manual], records: [] }, B, at(301), nextClaim);
  assert.equal(result.next.active.runId, 19);
  assert.equal(result.next.pending.targetSha, B); assert.equal(result.next.pending.priorRunId, 19);
  assert.equal(result.next.status, "stalled-active-run");
  assert.equal(result.dispatch, true, "a pending successor may wait, but active execution is never cancelled");
});

test("state recovery queues a successor for an unadmitted current-main run before it drains", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  const unadmitted = run({ status: "in_progress", conclusion: null });
  data.runs = [unadmitted];
  data.jobs.set("10/1", [{ name: "Admit Main Snapshot", status: "in_progress", steps: [] }]);
  assert.equal(await admit(repository, eventFor(unadmitted), 10, 1, { api }), false);
  const repair = await reconcile(repository, { api, now: () => at(2), log: () => {} });
  assert.equal(repair.state.pending.targetSha, A);
  const queued = data.runs.at(-1); assert.equal(queued.status, "pending");
  data.jobs.set("10/1", [{ name: "Admit Main Snapshot", steps: [
    { name: "Skip Superseded Rolling Claim", conclusion: "success" }] }]);
  data.finish(unadmitted);
  assert.equal(queued.status, "in_progress");
  assert.equal(await admit(repository, eventFor(queued), queued.id, 1, { api }), true);
});

test("unadmitted whole-rerun occupancy at main cannot suppress native pending repair", () => {
  const current = run({ run_attempt: 2, status: "in_progress", conclusion: null, admissionVerified: false });
  const result = plan(emptyState(repository), { active: [current], records: [] }, A, at(50), nextClaim);
  assert.equal(result.dispatch, true); assert.equal(result.next.pending.targetSha, A);
  assert.equal(result.next.pending.priorRunId, current.id);
});

test("persistent predecessor rejection cannot create an automatic superseded wake loop", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await writeState(api, repository, await readState(api, repository), {
    ...claimed(), active: { ...claimed().active, claimId: nextClaim } });
  data.runs = [run()]; data.main = B;
  await reconcile(repository, { api, now: () => at(2), log: () => {} });
  const pending = data.runs.at(-1);
  // Persistent missing terminal evidence must fail the admission step, so the
  // default-success Skip/Wake steps cannot recursively start more controllers.
  const held = run({ id: 55, status: "in_progress", conclusion: null });
  const stored = await readState(api, repository);
  await writeState(api, repository, stored, { ...stored.value,
    active: { ...claimed().active, runId: 55 }, pending: { ...stored.value.pending, priorRunId: 55 } });
  data.runs.push(held);
  await assert.rejects(admit(repository, eventFor(pending), pending.id, 1, { api }), /predecessor/i);
  const stopped = await readState(api, repository);
  assert.equal(stopped.value.status, "predecessor-evidence-operator-required");
  assert.equal(stopped.value.pending.claimId, eventFor(pending).inputs.claim_id);
});

test("reconciliation discards a schema-valid active pointer whose forge identity was rewritten", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await writeState(api, repository, await readState(api, repository), {
    ...claimed(), active: { ...claimed().active, claimId: nextClaim } });
  data.runs = [run()]; data.main = B;
  const result = await reconcile(repository, { api, now: () => at(2), log: () => {} });
  assert.equal(result.state.active, null);
  const b = data.runs.at(-1);
  assert.equal(await admit(repository, eventFor(b), b.id, 1, { api }), true);
});

test("receipt, acknowledgement and wake are bound to real admission outputs and permissions", () => {
  const source = readFileSync(new URL("../.github/workflows/main-rolling-validation.yml", import.meta.url), "utf8");
  const binding = (text) => {
    const admission = text.split("  admit:\n")[1]?.split("\n  validation:")[0];
    assert.match(admission, /permissions:\n      contents: write\n      actions: write/);
    assert.match(admission, /name: Confirm Current Rolling Claim\n        if: steps.admit.outputs.admitted == 'true'/);
    assert.match(admission, /name: Skip Superseded Rolling Claim\n        if: steps.admit.outputs.admitted != 'true'/);
    assert.match(admission, /name: Wake After Superseded Admission\n        if: steps.admit.outputs.admitted != 'true'/);
    assert.match(admission, /gh workflow run main-rolling-controller.yml --ref main --repo "\$GITHUB_REPOSITORY"/);
    assert.match(text, /validation:\n    if: needs.admit.outputs.admitted == 'true'/);
  };
  binding(source);
  assert.throws(() => binding(source.replace("Skip Superseded Rolling Claim", "Renamed Receipt")));
  assert.throws(() => binding(source.replace("Wake After Superseded Admission", "Removed Wake")));
  assert.throws(() => binding(source.replace("actions: write", "actions: read")));
});

test("an operator rerun in the replaceable pending slot remains an incomplete rerun if displaced", async () => {
  const { data, api } = forge(); data.nativeQueue = true;
  await reconcile(repository, { api, now: () => at(), log: () => {} });
  const a = data.runs.at(-1); await admit(repository, eventFor(a), a.id, 1, { api });
  const manual = run({ id: 60, run_attempt: 2, status: "pending", conclusion: null });
  data.runs.push(manual); data.main = B;
  await reconcile(repository, { api, now: () => at(2), log: () => {} });
  assert.equal(a.status, "in_progress"); assert.equal(manual.conclusion, "cancelled");
  assert.equal(record(manual, []).verdict, "incomplete");
  assert.equal(data.runs.at(-1).status, "pending");
});
