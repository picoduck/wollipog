import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { admit, COMPACT_EVERY, emptyState, main, plan, readState, reconcile, REQUIRED, RETRY_MS, STATE_REF,
  STALLED_MS, validationRecord, validState, workerIdentity, WORKER, writeState } from "./main-rolling-validation.mjs";

const repository = "example/project";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), W = "d".repeat(40);
const claimId = "12345678-1234-1234-1234-123456789012";
const nextClaim = "22345678-1234-1234-1234-123456789012";
const at = (minutes = 0) => new Date(Date.UTC(2026, 9, 22, 10, minutes)).toISOString();
const run = (overrides = {}) => ({ id: 10, run_attempt: 1, display_title: `Rolling ${A} ${claimId}`, path: WORKER,
  head_sha: W, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success",
  repository: { full_name: repository }, head_repository: { full_name: repository }, created_at: at(),
  run_started_at: at(1), updated_at: at(40), html_url: `https://github.com/${repository}/actions/runs/10`, ...overrides });
const jobs = () => REQUIRED.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success",
  created_at: at(), started_at: at(1), completed_at: at(39), steps: [{ name: "Verify Rolling Checkout", number: 1,
    conclusion: "success", started_at: at(1), completed_at: at(2) }] }));
const blobs = { worker: W, ci: B, windows: C };
const record = (r = run(), js = jobs()) => validationRecord(repository, r, js, blobs);
const claimed = () => plan(emptyState(repository), { active: [], records: [] }, A, at(), claimId).next;

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

test("burst/reordered wakeups preserve an active run and replace pending with live main", () => {
  let state = claimed();
  const active = run({ status: "in_progress", conclusion: null });
  for (const sha of [B, B, C, C]) {
    const result = plan(state, { active: [active], records: [] }, sha, at(5), nextClaim);
    assert.equal(result.dispatch, false);
    assert.equal(result.next.active.targetSha, A);
    assert.equal(result.next.pending.targetSha, sha);
    state = result.next;
  }
  const done = plan(state, { active: [], records: [record()] }, C, at(41), nextClaim);
  assert.equal(done.dispatch, true);
  assert.equal(done.next.active.targetSha, C);
  assert.equal(done.next.active.claimId, nextClaim);
  assert.equal(done.next.pending, null);
  assert.equal(plan(done.next, { active: [], records: [record()] }, C, at(42), claimId).next.active.claimId, nextClaim,
    "missed dispatch acknowledgment retains the original claim");
});

test("no change, cancelled startup retries, hung runs and dispatch ambiguity have distinct bounds", () => {
  const done = plan(emptyState(repository), { active: [], records: [record()] }, A, at(41));
  assert.equal(done.dispatch, false); assert.equal(done.next.pending, null);
  const red = record(run({ conclusion: "failure" }), jobs().map((j) => ({ ...j, conclusion: "failure" })));
  assert.equal(plan(done.next, { active: [], records: [red] }, A, at(42)).dispatch, false);
  const state = claimed();
  state.active.dispatchCount = 1; state.active.lastDispatchAt = at();
  assert.equal(plan(state, { active: [], records: [] }, B, at(9)).dispatch, false);
  assert.equal(plan(state, { active: [], records: [] }, B, at(RETRY_MS / 60_000)).dispatch, true);
  state.active.dispatchCount = 3;
  assert.equal(plan(state, { active: [], records: [] }, B, at(11)).next.status, "dispatch-unknown-operator-required");
  const hung = run({ status: "in_progress", conclusion: null });
  const stalled = plan(state, { active: [hung], records: [] }, B, at(STALLED_MS / 60_000 + 1));
  assert.equal(stalled.dispatch, false); assert.equal(stalled.next.status, "stalled-active-run");
  const rerun = run({ status: "in_progress", conclusion: null, run_attempt: 2, run_started_at: at(180) });
  assert.equal(plan(state, { active: [rerun], records: [] }, B, at(181)).next.status, "validating");
  const incomplete = [10, 11, 12].map((id) => record(run({ id, conclusion: "cancelled" }), []));
  assert.equal(plan(state, { active: [], records: incomplete }, A, at(50)).next.status, "recovery-limit-operator-required");
  assert.equal(plan(state, { active: [], records: incomplete }, B, at(50)).dispatch, true);
});

function forge() {
  const data = { oid: null, values: new Map(), trees: new Map(), commits: new Map(), runs: [], jobs: new Map(),
    dispatches: [], mutations: [], requests: [], main: A, count: 0, deniedAncestry: false, deniedRevisions: new Set() };
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
    if (local.endsWith("/dispatches")) { data.dispatches.push(body); if (data.dispatchError) throw data.dispatchError; return null; }
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
  return { data, api };
}

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

test("controller persists dispatch intent, reconciles duplicate wakeups and advances to latest main", async () => {
  const { data, api } = forge();
  const log = () => {};
  const first = await reconcile(repository, { api, now: () => at(), log });
  assert.equal(data.dispatches.length, 1);
  assert.equal(first.state.active.dispatchCount, 1);
  await reconcile(repository, { api, now: () => at(1), log });
  assert.equal(data.dispatches.length, 1);
  data.runs = [run({ display_title: `Rolling ${A} ${first.state.active.claimId}`, status: "in_progress", conclusion: null })];
  data.main = B;
  await reconcile(repository, { api, now: () => at(2), log });
  data.main = C;
  const burst = await reconcile(repository, { api, now: () => at(3), log });
  assert.equal(burst.state.pending.targetSha, C);
  assert.equal(data.dispatches.length, 1);
  data.runs[0] = { ...data.runs[0], status: "completed", conclusion: "success" };
  const completed = await reconcile(repository, { api, now: () => at(41), log });
  assert.equal(completed.records[0].testedSha, A);
  assert.equal(data.dispatches.length, 2);
  assert.equal(data.dispatches[1].inputs.target_sha, C);
});

test("lost/corrupt state reconstructs active work and verdicts from Actions; untrusted hints cannot certify", async () => {
  const { data, api } = forge();
  data.runs = [run({ status: "in_progress", conclusion: null })]; data.main = C;
  const recovered = await reconcile(repository, { api, now: () => at(20), log: () => {} });
  assert.equal(recovered.state.active.runId, 10);
  assert.equal(recovered.state.pending.targetSha, C);
  assert.equal(data.dispatches.length, 0);
  data.oid = null; data.main = A; data.runs = [run()];
  const done = await reconcile(repository, { api, now: () => at(41), log: () => {} });
  assert.equal(done.state.status, "current-target-completed");
  assert.equal(data.dispatches.length, 0);
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
  assert.equal(stored.value.active.dispatchCount, 1);
  const event = { ref: "refs/heads/main", inputs: { target_sha: A, claim_id: stored.value.active.claimId } };
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
  assert.equal(active.state.active.runId, null, "untrusted active tag is not adopted as a validation");
});

test("a completed unadmitted older claim releases the latest pending main target", async () => {
  const { data, api } = forge();
  const first = await reconcile(repository, { api, now: () => at(), log: () => {} });
  assert.equal(first.state.active.runId, null);
  data.main = B;
  data.runs = [run({ display_title: `Rolling ${A} ${first.state.active.claimId}`, conclusion: "startup_failure" })];
  data.jobs.set("10/1", []);
  const next = await reconcile(repository, { api, now: () => at(11), log: () => {} });
  assert.equal(next.state.active.targetSha, B);
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
  await writeState(api, repository, initial, { ...claimed(), active: { ...claimed().active, runId: 11 } });
  data.runs = [run(), run({ id: 11, status: "in_progress", conclusion: null })];
  const event = { ref: "refs/heads/main", inputs: { target_sha: A, claim_id: claimId } };
  assert.equal(await admit(repository, event, 11, 1, { api }), false);
});

test("admission retries a real state race without discarding the newer pending target", async () => {
  const { data, api } = forge();
  await writeState(api, repository, await readState(api, repository), claimed());
  data.runs = [run({ status: "in_progress", conclusion: null })];
  let raced = false;
  const racingApi = async (path, options) => {
    if (path === "/graphql" && !raced) {
      raced = true;
      const current = await readState(api, repository);
      await writeState(api, repository, current, { ...current.value, pending: { targetSha: B, observedAt: at(2) } });
    }
    return api(path, options);
  };
  const event = { ref: "refs/heads/main", inputs: { target_sha: A, claim_id: claimId } };
  assert.equal(await admit(repository, event, 10, 1, { api: racingApi }), true);
  const final = await readState(api, repository);
  assert.equal(final.value.active.runId, 10);
  assert.equal(final.value.pending.targetSha, B);
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
  assert.match(ci, /  push:\n    branches: \[main\]/, "shadow does not remove main fan-out");
  assert.match(ci, /  merge_group:/);
  assert.match(ci, /    needs: \[checks, browser, win32, webkit\]/);
  assert.match(ci, /CI_EVIDENCE_HEAD: \$\{\{ inputs.target_sha \|\| github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(ci, /--head "\$CI_EVIDENCE_HEAD"/);
});
