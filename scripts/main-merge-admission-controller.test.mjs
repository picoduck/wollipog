import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { ADMISSION_CONTEXT, authorizedRepair, failureFingerprint, main, planAdmissionCycle, planRollback,
  readAdmissionEntries, rebuildAdmissionCycle, REQUIRED_RESULT, requiredResult, admissionState, restorationProofRefusal,
  writeAdmissionPlan, CONTROLLER } from "./main-merge-admission-controller.mjs";
import { repairDigest } from "./main-merge-repair.mjs";

const repository = "example/project", base = "a".repeat(40), head = "b".repeat(40), group = "c".repeat(40);
const at = seconds => new Date(Date.UTC(2026, 9, 26, 1) + seconds * 1000).toISOString();
const entry = () => ({ repository, kind: "merge_group", pullRequest: 42, headSha: head, baseSha: base,
  integrationSha: group, members: [{ pullRequest: 42, headSha: head }] });
// The group's own aggregator already succeeded: just-in-time admission may write its success.
const census = () => ({ repository, complete: true, mainSha: base, entries: [entry()], requiredResults: { [group]: "success" },
  admissionStates: { [group]: "none" }, fingerprint: "fixture" });
const control = () => ({ available: true, repair: null });
function health() {
  return { schema: "main-ci-health-v1", repository, currentMainSha: base, observedAt: at(0), status: "passing", reasons: [],
    unresolvedFailures: [], latestPassingSnapshot: { repository, testedSha: base, targetSha: base, certification: "full", result: "passing",
      coverageVersion: "rolling-full-v1", runId: 20, attempt: 1, checkoutVerified: true, targetAncestryVerified: true,
      workflowAncestryVerified: true, workflowRevision: base }, backlog: { clock: "forge-landing-time", commits: 0, merges: 0,
      oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: 0 } };
}
const red = () => ({ ...health(), status: "failing", unresolvedFailures: [{ repository, runId: 21, attempt: 1,
  testedSha: base, targetSha: base, result: "failing", targetAncestryVerified: true,
  workflowAncestryVerified: true, completedAt: at(10) }] });
const cycle = extra => planAdmissionCycle({ repository, census: census(), health: health(), control: control(), now: at(11), ...extra });
const grant = () => ({ ...entry(), authorizationId: "repair-1", failureFingerprint: failureFingerprint(red()), approvedAt: at(10), expiresAt: at(100) });
const verifyAuthority = async ({ grant: g }) => ({ approved: true, authorizationDigest: repairDigest(g) });
const verifyChecks = async ({ entry: e }) => ({ repository, headSha: e.headSha, baseSha: e.baseSha, integrationSha: e.integrationSha,
  status: "passed", fast: true, failingScenarios: true, normalReviewAndMergeRequired: true });

test("ready, queued and building targets are reevaluated; a complete cycle never inherits a prior success", async () => {
  const current = census(); current.entries.push({ repository, kind: "pull_request", pullRequest: 42,
    headSha: head, baseSha: base, integrationSha: head });
  const green = await cycle({ census: current });
  assert.ok(green.decisions.every(d => d.state === "success"));
  const failed = await cycle({ census: current, health: red(), previous: green });
  assert.ok(failed.decisions.every(d => d.state === "failure"));
  assert.ok(failed.decisions.every(d => d.plannedBlockLatencyMs === 1000));
  const expired = await cycle({ census: current, now: at(120), previous: green });
  assert.ok(expired.decisions.every(d => d.state === "failure" && d.plannedBlockLatencyMs === 0));
});

test("incomplete census, unavailable control state, moved main and unknown health cannot pass", async () => {
  for (const extra of [{ census: { ...census(), complete: false } }, { control: undefined },
    { health: null }, { census: { ...census(), mainSha: head } }, { health: { ...health(), status: "unknown" } }]) {
    const plan = await cycle(extra);
    assert.ok(plan.reasons.length || plan.decisions.every(d => d.state === "failure"));
    assert.ok(plan.decisions.every(d => d.state !== "success"));
  }
});

test("malformed failure collections still produce auditable holds instead of aborting the cycle", async () => {
  for (const failures of [{}, "unavailable", [null]]) {
    const plan = await cycle({ health: { ...health(), status: "unknown", unresolvedFailures: failures } });
    assert.equal(plan.decisions.length, 1);
    assert.equal(plan.decisions[0].decision, "hold");
    assert.equal(plan.decisions[0].plannedBlockLatencyMs, null);
    assert.doesNotThrow(() => failureFingerprint({ unresolvedFailures: failures }));
  }
});

test("fresh authoritative age-budget overruns permit only an exact repair; stale observations never do", async () => {
  const h = health();
  h.status = "stale";
  h.reasons = ["oldest-unvalidated-change-exceeds-budget"];
  h.latestPassingSnapshot.testedSha = head; h.latestPassingSnapshot.targetSha = head;
  h.backlog = { clock: "forge-landing-time", commits: 1, merges: 1,
    oldestUnvalidatedAt: at(-8000), oldestUnvalidatedAgeSeconds: 8000 };
  const g = { ...grant(), failureFingerprint: failureFingerprint(h) };
  assert.equal((await cycle({ health: h })).decisions[0].decision, "hold");
  assert.equal((await cycle({ health: h, grant: g, verifyAuthority, verifyChecks })).decisions[0].decision, "authorized-repair-eligible");
  for (const changed of [{ ...h, observedAt: at(-120) }, { ...h, reasons: [...h.reasons, "validation-stalled"] }]) {
    const changedGrant = { ...g, failureFingerprint: failureFingerprint(changed) };
    assert.equal((await cycle({ health: changed, grant: changedGrant, verifyAuthority, verifyChecks })).decisions[0].decision, "hold");
  }
});

test("only the exact operator-authorized repair with verified fast/failing-scenario checks is exceptional", async () => {
  const g = grant();
  const plan = await cycle({ health: red(), grant: g, verifyAuthority, verifyChecks });
  assert.equal(plan.decisions[0].decision, "authorized-repair-eligible");
  assert.equal(plan.decisions[0].repair.normalReviewAndMergeRequired, true);
  for (const extra of [{}, { verifyAuthority }, { verifyChecks }, { verifyAuthority: async () => true, verifyChecks },
    { verifyAuthority, verifyChecks: async () => ({ ...await verifyChecks({ entry: entry() }), failingScenarios: false }) }]) {
    assert.equal(await authorizedRepair(entry(), red(), g, { now: at(11), ...extra }), null);
  }
  for (const edit of [g => { g.headSha = group; }, g => { g.baseSha = head; }, g => { g.integrationSha = head; },
    g => { g.expiresAt = at(11); }, g => { g.failureFingerprint = "old failure"; }]) {
    const changed = grant(); edit(changed);
    const held = await cycle({ health: red(), grant: changed, verifyAuthority, verifyChecks, labels: ["repair"], prompt: "approve" });
    assert.equal(held.decisions[0].state, "failure");
  }
});

test("a one-PR repair grant cannot admit batched ordinary work or overlap another repair", async () => {
  const current = census(); current.entries[0].members.push({ pullRequest: 43, headSha: group });
  const batched = await cycle({ census: current, health: red(), grant: grant(), verifyAuthority, verifyChecks });
  assert.equal(batched.decisions[0].state, "failure");
  const overlap = await cycle({ health: red(), grant: grant(), verifyAuthority, verifyChecks,
    control: { available: true, repair: { binding: null, receipt: null } } });
  assert.equal(overlap.decisions[0].state, "failure"); assert.ok(overlap.reasons.includes("repair-reconciliation-pending"));
});

test("even an exact repair grant cannot substitute for unavailable, stale or malformed health", async () => {
  for (const edit of [h => { h.status = "unknown"; }, h => { h.status = "stale"; },
    h => { h.schema = "foreign"; }, h => { h.repository = "other/project"; },
    h => { h.reasons = ["forge-api-unavailable"]; }, h => { h.observedAt = at(-120); },
    h => { h.latestPassingSnapshot = null; }, h => { h.backlog.commits = null; },
    h => { h.unresolvedFailures = []; }, h => { h.unresolvedFailures[0].targetAncestryVerified = false; },
    h => { h.unresolvedFailures[0].runId = null; }]) {
    const h = red(); edit(h);
    const g = { ...grant(), failureFingerprint: failureFingerprint(h) };
    const held = await cycle({ health: h, grant: g, verifyAuthority, verifyChecks });
    assert.ok(held.decisions.every(d => d.state === "failure" && d.repair === null));
    assert.equal(await authorizedRepair(entry(), h, g, { now: at(11), verifyAuthority, verifyChecks }), null);
  }
});

test("forged, truncated and changing queue listings never form a complete census", async () => {
  const body = { data: { repository: { defaultBranchRef: { name: "main", target: { oid: base } }, pullRequests: {
    pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false, headRefOid: head, baseRefOid: base,
      mergeQueueEntry: { headCommit: { oid: group }, baseCommit: { oid: base } } }] } } } };
  const result = await readAdmissionEntries(async () => body, repository);
  assert.equal(result.entries.length, 2); assert.equal(result.complete, true);
  for (const edit of [b => { b.errors = [{}]; }, b => { b.data.repository.pullRequests.pageInfo.hasNextPage = true; },
    b => { b.data.repository.pullRequests.nodes[0].headRefOid = "bad"; },
    b => { b.data.repository.pullRequests.nodes.push(b.data.repository.pullRequests.nodes[0]); }]) {
    const b = structuredClone(body); edit(b);
    await assert.rejects(readAdmissionEntries(async () => b, repository));
  }
});

const aggregator = (status, conclusion, appId = REQUIRED_RESULT.appId, name = REQUIRED_RESULT.context) =>
  ({ __typename: "CheckRun", name, status, conclusion, checkSuite: { app: { databaseId: appId } } });
const rollup = (nodes, hasNextPage = false) => ({ contexts: { pageInfo: { hasNextPage }, nodes } });

test("a group's required result is success only from the pinned aggregator, completed and unanimous", () => {
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS")])), "success");
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS"), { __typename: "StatusContext", context: "Other", state: "SUCCESS" }])), "success");
  assert.equal(requiredResult(rollup([])), "pending", "no aggregator yet");
  assert.equal(requiredResult(rollup([aggregator("IN_PROGRESS", null)])), "pending");
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS"), aggregator("QUEUED", null)])), "pending", "a rerun in flight");
  for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "SKIPPED", "NEUTRAL"])
    assert.equal(requiredResult(rollup([aggregator("COMPLETED", conclusion)])), "failure", conclusion);
  // Another app could write a check with the same name; only GitHub Actions' pinned issuer counts.
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS", 4242)])), "unavailable");
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS"), aggregator("COMPLETED", "SUCCESS", 4242)])), "unavailable");
  for (const broken of [undefined, null, {}, { contexts: {} }, rollup([aggregator("COMPLETED", "SUCCESS")], true),
    rollup(Array(101).fill(aggregator("COMPLETED", "SUCCESS")))]) assert.equal(requiredResult(broken), "unavailable");
});

test("the group's current admission status is read from the same rollup; unreadable is unknown", () => {
  const status = state => ({ __typename: "StatusContext", context: ADMISSION_CONTEXT, state });
  assert.equal(admissionState(rollup([])), "none");
  assert.equal(admissionState(rollup([aggregator("COMPLETED", "SUCCESS"), status("SUCCESS")])), "success");
  assert.equal(admissionState(rollup([status("PENDING")])), "pending");
  for (const state of ["FAILURE", "ERROR"]) assert.equal(admissionState(rollup([status(state)])), "failure");
  assert.equal(admissionState(rollup([{ __typename: "StatusContext", context: "Other", state: "SUCCESS" }])), "none");
  for (const broken of [undefined, {}, rollup([status("SUCCESS")], true), rollup([status("SUCCESS"), status("PENDING")]), rollup([status("EXPECTED")])])
    assert.equal(admissionState(broken), "unknown");
});

test("the census reads each group's aggregator on its exact SHA outside entry identity", async () => {
  const body = (nodes) => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: base } }, pullRequests: {
    pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false, headRefOid: head, baseRefOid: base,
      mergeQueueEntry: { headCommit: { oid: group, statusCheckRollup: rollup(nodes) }, baseCommit: { oid: base } } }] } } } });
  let query = null;
  const pending = await readAdmissionEntries(async (path, { body: request }) => { query = request.query; return body([]); }, repository);
  assert.match(query, /statusCheckRollup\{contexts\(first:100\)\{pageInfo\{hasNextPage\}/);
  assert.match(query, /checkSuite\{app\{databaseId\}\}/);
  const done = await readAdmissionEntries(async () => body([aggregator("COMPLETED", "SUCCESS"),
    { __typename: "StatusContext", context: ADMISSION_CONTEXT, state: "SUCCESS" }]), repository);
  assert.deepEqual([pending.requiredResults, done.requiredResults], [{ [group]: "pending" }, { [group]: "success" }]);
  assert.deepEqual([pending.admissionStates, done.admissionStates], [{ [group]: "none" }, { [group]: "success" }]);
  assert.match(query, /\.\.\. on StatusContext\{context state\}/);
  // A finishing aggregator changes what may be written, never which integration is targeted.
  assert.deepEqual(done.entries, pending.entries); assert.equal(done.fingerprint, pending.fingerprint);
});

test("merge groups get a success only just in time; waiting groups get no write and health holds still fail", async () => {
  const groupDecision = (plan) => plan.decisions.find(d => d.entry.kind === "merge_group");
  const ready = groupDecision(await cycle());
  assert.deepEqual([ready.state, ready.decision, ready.requiredResult, ready.awaiting], ["success", "ordinary-admission-eligible", "success", null]);
  for (const result of ["pending", "failure", "unavailable", undefined]) {
    const waiting = groupDecision(await cycle({ census: { ...census(), requiredResults: result === undefined ? undefined : { [group]: result } } }));
    assert.deepEqual([waiting.state, waiting.decision, waiting.awaiting], ["none", "ordinary-admission-eligible", "required-result"], String(result));
  }
  // Stacked behind another group (its base is not main yet): waiting, not failed, so it is not ejected.
  const stacked = groupDecision(await cycle({ census: { ...census(), entries: [{ ...entry(), baseSha: head }] } }));
  assert.deepEqual([stacked.state, stacked.decision, stacked.reasons, stacked.awaiting], ["none", "hold", ["base-moved"], "queue-head"]);
  // Any health reason still writes failure, with or without its aggregator, stacked or not.
  for (const extra of [{ health: red() }, { health: red(), census: { ...census(), requiredResults: {} } },
    { health: red(), census: { ...census(), entries: [{ ...entry(), baseSha: head }] } }])
    assert.equal(groupDecision(await cycle(extra)).state, "failure");
  // A rerun (or any loss of readiness) after a published success withdraws it to pending (#3768 review).
  for (const [published, expected] of [["success", "pending"], ["failure", "pending"], ["unknown", "pending"], [undefined, "pending"],
    ["pending", "none"], ["none", "none"]]) {
    const rerun = groupDecision(await cycle({ census: { ...census(), requiredResults: { [group]: "pending" },
      admissionStates: published === undefined ? undefined : { [group]: published } } }));
    assert.deepEqual([rerun.state, rerun.awaiting, rerun.admissionState], [expected, "required-result", published ?? "unknown"], String(published));
  }
  // An existing success of unproven issuer never suppresses the pinned writer's own success (#3768 review).
  const again = groupDecision(await cycle({ census: { ...census(), admissionStates: { [group]: "success" } } }));
  assert.deepEqual([again.state, again.decision], ["success", "ordinary-admission-eligible"]);
  const movedAfterSuccess = groupDecision(await cycle({ census: { ...census(), entries: [{ ...entry(), baseSha: head }],
    admissionStates: { [group]: "success" } } }));
  assert.deepEqual([movedAfterSuccess.state, movedAfterSuccess.awaiting], ["pending", "queue-head"]);
  // Pull-request heads only gate enqueueing; their states are unchanged.
  const pr = { repository, kind: "pull_request", pullRequest: 7, headSha: head, baseSha: base, integrationSha: head };
  const prPlan = await cycle({ census: { ...census(), entries: [pr] } });
  assert.deepEqual([prPlan.decisions[0].state, "requiredResult" in prPlan.decisions[0]], ["success", false]);
  // An exact repair is also admitted only after its own aggregator succeeded.
  const repairing = { health: red(), grant: grant(), verifyAuthority, verifyChecks };
  assert.equal(groupDecision(await cycle(repairing)).state, "success");
  const early = groupDecision(await cycle({ ...repairing, census: { ...census(), requiredResults: { [group]: "pending" } } }));
  assert.deepEqual([early.state, early.decision], ["none", "authorized-repair-eligible"]);
});

test("the writer skips waiting groups and refuses any group success without its aggregator", async () => {
  const configuration = { enabled: true, repository, context: ADMISSION_CONTEXT };
  const waiting = await cycle({ census: { ...census(), requiredResults: { [group]: "pending" } } });
  let posts = 0;
  const api = async (path, { body } = {}) => { if (path === "/rate_limit") return {}; posts++; return { id: posts, context: body.context, state: body.state }; };
  api.rateLimit = { limit: 5000, remaining: 4900 };
  const skipped = await writeAdmissionPlan(waiting, { configuration, api, now: () => at(12), revalidate: async () => waiting });
  assert.deepEqual([skipped.writes, skipped.attemptedWrites, skipped.capacity.plannedWrites, posts], [0, 0, 0, 0]);
  const withdrawn = await cycle({ census: { ...census(), requiredResults: { [group]: "pending" }, admissionStates: { [group]: "success" } } });
  const bodies = [];
  const recording = async (path, { body } = {}) => { if (path === "/rate_limit") return {}; bodies.push(body); return { id: bodies.length, context: body.context, state: body.state }; };
  recording.rateLimit = { limit: 5000, remaining: 4900 };
  const delivered = await writeAdmissionPlan(withdrawn, { configuration, api: recording, now: () => at(12), revalidate: async () => withdrawn });
  assert.deepEqual([delivered.writes, bodies.map(b => b.state)], [1, ["pending"]]);
  // Pending is a group withdrawal only; a pull-request decision may never be written pending.
  const pr = { repository, kind: "pull_request", pullRequest: 7, headSha: head, baseSha: base, integrationSha: head };
  const prPlan = await cycle({ census: { ...census(), entries: [pr] } }); prPlan.decisions[0].state = "pending";
  await assert.rejects(writeAdmissionPlan(prPlan, { configuration, api: recording, now: () => at(12), revalidate: async () => prPlan }));
  // A forged or stale decision claiming success for a group whose aggregator has not succeeded.
  for (const forged of [{ requiredResult: "pending" }, { requiredResult: undefined }, { requiredResult: "failure" }]) {
    const plan = structuredClone(waiting); Object.assign(plan.decisions[0], { state: "success", ...forged });
    posts = 0;
    await assert.rejects(writeAdmissionPlan(plan, { configuration, api, now: () => at(12), revalidate: async () => plan }));
    assert.equal(posts, 0, "rejected before any status request");
  }
});

test("writer refuses by default and rebuilt evidence is mandatory for the complete exact target set", async () => {
  const plan = await cycle();
  assert.deepEqual(await writeAdmissionPlan(plan, { api: () => assert.fail("default denies writes") }), { mode: "disabled", writes: 0 });
  const configuration = { enabled: true, repository, context: ADMISSION_CONTEXT };
  await assert.rejects(writeAdmissionPlan(plan, { configuration, api: () => assert.fail("no revalidation") }));
  let writes = 0, rebuilds = 0;
  const api = async (path, { body } = {}) => { if (path === "/rate_limit") return {};
    writes++; assert.equal(path, `/repos/${repository}/statuses/${group}`);
    return { id: writes, context: body.context, state: body.state }; };
  api.rateLimit = { limit: 5000, remaining: 4900 };
  const result = await writeAdmissionPlan(plan, { configuration, api, now: () => at(12),
    revalidate: async e => { rebuilds++; assert.deepEqual(e, { repository }); return cycle({ health: red(), now: at(12) }); } });
  assert.equal(result.mode, "operator-enabled"); assert.equal(result.writes, 1); assert.equal(rebuilds, 1);
  for (const fresh of [await cycle({ now: at(0) }), { ...plan, censusComplete: false },
    { ...plan, decisions: [{ ...plan.decisions[0], entry: { ...entry(), headSha: group } }] },
    { ...plan, decisions: [{ ...plan.decisions[0], expiresAt: at(12) }] }]) {
    let attemptedWrites = 0;
    const noWrite = async path => { if (path !== "/rate_limit") attemptedWrites++; return {}; };
    noWrite.rateLimit = { limit: 5000, remaining: 4900 };
    await assert.rejects(writeAdmissionPlan(plan, { configuration, api: noWrite,
      now: () => at(fresh.evaluatedAt === at(0) ? 60 : 12), revalidate: async () => fresh }));
    assert.equal(attemptedWrites, 0, "invalid evidence must be rejected before a status request");
  }
  let invalidClockWrites = 0;
  const noWrite = async path => { if (path !== "/rate_limit") invalidClockWrites++; return {}; };
  noWrite.rateLimit = { limit: 5000, remaining: 4900 };
  await assert.rejects(writeAdmissionPlan(plan, { configuration, api: noWrite,
    now: () => "invalid-clock", revalidate: async () => plan }));
  assert.equal(invalidClockWrites, 0, "invalid clock must be rejected before a status request");
});

// Exactly the restoration verifier's output shape (scripts/ci-merge-group-restoration.mjs).
const restorationProof = () => ({ schema: "merge-group-restoration-v1", repository, since: at(0), verified: true,
  coverage: "full-merge-group-v1", requiredContext: "Typecheck, Test & Sidecar Bundle", workflowSha: base,
  workflowBlobs: { ".github/workflows/ci.yml": "1".repeat(40), ".github/workflows/settings-rows-win32.yml": "2".repeat(40) },
  runs: [{ runId: 31, attempt: 1, headSha: head, createdAt: at(5), certification: "full", reasons: [] }], reasons: [] });

test("rollback cannot propose hold removal before full queue validation and separate exact approval", () => {
  const first = planRollback({ repository, operatorApproval: { approved: true } });
  assert.equal(first.decision, "restore-full-queue-validation-first"); assert.equal(first.holdRetained, true);
  const proof = restorationProof();
  const restored = planRollback({ repository, fullQueueProof: proof });
  assert.equal(restored.decision, "operator-hold-removal-approval-required");
  const approved = planRollback({ repository, fullQueueProof: proof, operatorApproval: { repository, approved: true,
    action: "remove-admission-hold", fullQueueProofDigest: restored.fullQueueProofDigest } });
  assert.equal(approved.decision, "operator-hold-removal-planned"); assert.equal(approved.holdRetained, true);
  assert.equal(approved.enforcement, "none");
});

test("planRollback itself refuses forged, empty-runs, wrong-schema and foreign proofs (#3633)", () => {
  for (const [change, reason] of [
    // The earlier top-level-only check accepted this: verified, valid SHA, but its runs certify nothing.
    [p => { p.runs[0].certification = "none"; p.runs[0].reasons = ["merge-group-gate-active", "reduced-coverage-recorded"]; }, "proof-run-not-certified-full"],
    [p => { p.runs = []; }, "proof-run-not-certified-full"], [p => { delete p.runs; }, "proof-run-not-certified-full"],
    [p => { p.runs[0].headSha = "short"; }, "proof-run-not-certified-full"],
    [p => { p.schema = "other-v1"; }, "proof-identity-unavailable"], [p => { delete p.schema; }, "proof-identity-unavailable"],
    [p => { p.repository = "another/repository"; }, "proof-identity-unavailable"],
    [p => { p.reasons = ["insufficient-completed-merge-group-runs"]; }, "proof-not-verified"], [p => { p.verified = false; }, "proof-not-verified"],
    [p => { p.coverage = "rolling-full-v1"; }, "proof-coverage-unavailable"], [p => { p.workflowSha = null; }, "proof-coverage-unavailable"],
    [p => { delete p.workflowBlobs[".github/workflows/settings-rows-win32.yml"]; }, "proof-workflow-blobs-unavailable"],
  ]) {
    const proof = restorationProof(); change(proof);
    assert.ok(restorationProofRefusal(proof, repository).includes(reason), reason);
    const plan = planRollback({ repository, fullQueueProof: proof,
      operatorApproval: { repository, approved: true, action: "remove-admission-hold", fullQueueProofDigest: "0".repeat(64) } });
    assert.deepEqual([plan.decision, plan.holdRetained, plan.fullQueueProofDigest], ["restore-full-queue-validation-first", true, undefined], reason);
    assert.ok(plan.proofRefusal.includes(reason));
  }
  assert.deepEqual(restorationProofRefusal(restorationProof(), repository), []);
});

test("the CLI has no enabled mode and cannot construct a status-writing capability", async () => {
  for (const value of [undefined, "", "disabled", "enabled", "enforce", "Dry-Run"]) {
    assert.equal(await main({ env: { MAIN_MERGE_ADMISSION_CONTROLLER: value }, api: () => assert.fail("off must do no work") }), 0);
  }
});

// The old per-target rebuild spends 37 reads repeatedly and fails after two
// writes. This exercises the actual adapter with the same expensive callback.
function batch(count) {
  const c = census();
  c.entries = Array.from({ length: count }, (_, i) => ({ ...entry(), pullRequest: i + 1,
    integrationSha: (i + 1).toString(16).padStart(40, "0"),
    members: [{ pullRequest: i + 1, headSha: head }] }));
  c.requiredResults = Object.fromEntries(c.entries.map(e => [e.integrationSha, "success"]));
  c.admissionStates = Object.fromEntries(c.entries.map(e => [e.integrationSha, "none"]));
  return c;
}
function inertApi(limit = 5000, remaining = limit) {
  const statuses = [];
  const api = async (path, { body } = {}) => {
    api.rateLimit.remaining--;
    if (path.includes("/statuses/")) {
      statuses.push({ path, body });
      return { id: statuses.length, context: body.context, state: body.state };
    }
    return {};
  };
  api.rateLimit = { limit, remaining };
  return { api, statuses };
}
const enabled = { enabled: true, repository, context: ADMISSION_CONTEXT };

test("one independent rebuild covers all 45 holds inside the unchanged 96-call budget", async () => {
  const plan = await cycle({ census: batch(45), health: red() });
  const { api, statuses } = inertApi();
  let rebuilds = 0;
  const result = await writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12),
    revalidate: async (_request, { api: bounded }) => {
      rebuilds++;
      for (let i = 0; i < 37; i++) await bounded(`/inert-health-read/${i}`);
      return plan;
    } });
  assert.equal(rebuilds, 1);
  assert.equal(statuses.length, 45);
  assert.ok(statuses.every(s => s.body.state === "failure"));
  assert.equal(result.writes, 45);
  assert.equal(result.apiBudget.calls, 83); // 1 quota + 37 rebuild + 45 status
  assert.equal(result.apiBudget.limit, 96);
});

test("budget/quota arithmetic delivers the highest-priority writes inside the 10% reserve and defers the rest (#3633)", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ count: fc.integer({ min: 0, max: 100 }),
    reads: fc.integer({ min: 0, max: 40 }), large: fc.boolean(), headroom: fc.integer({ min: 0, max: 110 }) }),
  async ({ count, reads, large, headroom }) => {
    const limit = large ? 5000 : 1000, floor = Math.ceil(limit * 0.6), callLimit = large ? 96 : 48;
    const reserve = Math.ceil(callLimit * CONTROLLER.headroomFraction);
    const plan = await cycle({ census: batch(count), health: red() });
    const { api, statuses } = inertApi(limit, floor + reads + 1 + headroom);
    const available = Math.max(0, Math.min(callLimit - reads - 1 - reserve, headroom));
    let rebuilds = 0;
    const result = await writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12),
      revalidate: async (_request, { api: bounded }) => {
        rebuilds++;
        for (let i = 0; i < reads; i++) await bounded(`/inert-read/${i}`);
        return plan;
      } });
    const delivered = Math.min(count, available);
    assert.equal(rebuilds, 1);
    assert.equal(result.writes, delivered); assert.equal(statuses.length, delivered);
    assert.equal(result.deferred, count - delivered); assert.equal(result.complete, delivered === count);
    assert.equal(result.capacity.reserveCalls, reserve); assert.equal(result.capacity.writesAvailable, available);
    assert.equal(result.apiBudget.calls, reads + 1 + delivered);
    assert.ok(callLimit - result.apiBudget.calls >= reserve || headroom < callLimit - reads - 1 - reserve, "the reserve is never spent");
    // Delivery follows the stable priority order; the progress record lists exactly the receipts.
    assert.deepEqual(Object.keys(result.progress.deliveries).sort(), statuses.map(s => s.path.split("/").at(-1)).sort());
    assert.equal(result.coverage.held, delivered);
  }), { numRuns: 100, examples: [[{ count: 45, reads: 37, large: true, headroom: 100 }],
    [{ count: 45, reads: 37, large: false, headroom: 100 }]] });
});

test("the reserve boundary: exactly the available writes complete with 10% spare; one more is deferred, never dropped", async () => {
  for (const [count, complete] of [[35, true], [36, false]]) {
    const plan = await cycle({ census: batch(count), health: red() });
    const { api } = inertApi();
    // #3711's batched measured cost: 1 quota + 50 reads = 51 calls used, so 96 - 51 - 10 = 35 writable.
    const result = await writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12),
      revalidate: async (_request, { api: bounded }) => { for (let i = 0; i < 50; i++) await bounded(`/inert-read/${i}`); return plan; } });
    assert.deepEqual([result.writes, result.complete, result.deferred], [35, complete, count - 35]);
    assert.equal(result.apiBudget.limit - result.apiBudget.calls, 10, "ten calls (10.4%) stay spare at the boundary");
  }
});

test("durable progress continues a partial delivery next cycle; a changed failure or a stale record writes again", async () => {
  const plan = await cycle({ census: batch(60), health: red() });
  const deliver = (progress, now = at(12), fresh = plan) => {
    const { api, statuses } = inertApi();
    return writeAdmissionPlan(fresh, { configuration: enabled, api, now: () => now, progress,
      revalidate: async (_request, { api: bounded }) => { for (let i = 0; i < 50; i++) await bounded(`/inert-read/${i}`); return fresh; } })
      .then(result => ({ result, statuses }));
  };
  const first = await deliver(null);
  assert.deepEqual([first.result.writes, first.result.deferred, first.result.complete], [35, 25, false]);
  assert.equal(first.result.coverage.unlandable, 25, "deferred groups that never held a success cannot land");
  const second = await deliver(first.result.progress);
  assert.deepEqual([second.result.writes, second.result.capacity.alreadyHeld, second.result.complete], [25, 35, true]);
  assert.deepEqual(new Set([...first.statuses, ...second.statuses].map(s => s.path)).size, 60, "every target written exactly once");
  // A different failure set is a new hold: earlier receipts do not count.
  const other = await cycle({ census: batch(60), health: { ...red(), unresolvedFailures: [{ ...red().unresolvedFailures[0], runId: 22 }] } });
  assert.equal((await deliver(first.result.progress, at(12), other)).result.capacity.alreadyHeld, 0);
  // Receipts older than the lease, from another repository, or malformed are not trusted.
  const stale = structuredClone(first.result.progress);
  for (const d of Object.values(stale.deliveries)) d.deliveredAt = new Date(Date.parse(at(12)) - CONTROLLER.progressLeaseMs).toISOString();
  for (const progress of [stale, { ...first.result.progress, repository: "another/repository" }, { repository, deliveries: "x" }])
    assert.equal((await deliver(progress)).result.capacity.alreadyHeld, 0);
});

test("an uncertain overwrite invalidates the earlier hold receipt, so the next hold is written again (#3783 review)", async () => {
  // A PR-head hold (skippable class) is recorded, then a success POST lands but its response is lost.
  const pr = { repository, kind: "pull_request", pullRequest: 7, headSha: head, baseSha: base, integrationSha: head };
  const planFor = (health) => cycle({ census: { ...census(), entries: [pr] }, health });
  const lose = { value: false };
  let forgeState = null, ids = 0;
  const api = async (path, { body } = {}) => { if (path === "/rate_limit") return {};
    forgeState = body.state; if (lose.value) throw new Error("response lost after the forge accepted the status");
    return { id: ++ids, context: body.context, state: body.state }; };
  api.rateLimit = { limit: 5000, remaining: 4900 };
  const deliver = (plan, progress) => writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12), progress, revalidate: async () => plan });
  const held = await deliver(await planFor(red()));
  assert.equal(held.progress.deliveries[head].state, "failure");
  lose.value = true;
  const failed = await deliver(await planFor(health()), held.progress).catch(error => error);
  assert.equal(forgeState, "success", "the success reached the forge");
  assert.equal(failed.progress.deliveries[head], undefined, "the stale failure receipt is gone");
  lose.value = false;
  const again = await deliver(await planFor(red()), failed.progress);
  assert.deepEqual([again.writes, again.capacity.alreadyHeld, forgeState], [1, 0, "failure"]);
});

test("progress without a genuine receipt ID, or for a group that may hold a success, never suppresses a hold (#3783 review)", async () => {
  const pr = { repository, kind: "pull_request", pullRequest: 7, headSha: head, baseSha: base, integrationSha: head };
  const plan = await cycle({ census: { ...census(), entries: [pr] }, health: red() });
  const entry = { state: "failure", fingerprint: plan.failureFingerprint, deliveredAt: at(11) };
  const run = async (progress, p = plan) => { const { api } = inertApi();
    return writeAdmissionPlan(p, { configuration: enabled, api, now: () => at(12), progress, revalidate: async () => p }); };
  for (const statusId of [undefined, null, 0, -1, 1.5, "7"])
    assert.equal((await run({ repository, deliveries: { [head]: { ...entry, statusId } } })).writes, 1, String(statusId));
  assert.equal((await run({ repository, deliveries: { [head]: { ...entry, statusId: 7 } } })).writes, 0, "a genuine receipt is honoured");
  // A group that may hold a success is landing-critical: its withdrawal is always rewritten.
  const critical = await cycle({ census: { ...census(), admissionStates: { [group]: "success" } }, health: red() });
  const receipt = { repository, deliveries: { [group]: { state: "failure", fingerprint: critical.failureFingerprint, deliveredAt: at(11), statusId: 9 } } };
  assert.equal((await run(receipt, critical)).writes, 1);
});

test("withdrawals of groups that may hold a success are delivered first and gate landing safety", async () => {
  const c = batch(40);
  // Two groups currently show a success (or an unreadable state); a health failure must withdraw them first.
  const critical = [c.entries[37].integrationSha, c.entries[39].integrationSha];
  c.admissionStates[critical[0]] = "success"; c.admissionStates[critical[1]] = "unknown";
  const plan = await cycle({ census: c, health: red() });
  const { api, statuses } = inertApi();
  const result = await writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12),
    revalidate: async (_request, { api: bounded }) => { for (let i = 0; i < 80; i++) await bounded(`/inert-read/${i}`); return plan; } });
  // 96 - 81 - 10 = 5 writes: both critical groups go first.
  assert.equal(result.writes, 5);
  assert.deepEqual(statuses.slice(0, 2).map(s => s.path.split("/").at(-1)), [...critical].sort());
  assert.deepEqual([result.landingSafe, result.coverage["uncovered-landable"], result.coverage.unlandable], [true, 0, 35]);
  // With no capacity at all the batch reports itself unsafe rather than covered.
  const none = await writeAdmissionPlan(plan, { configuration: enabled, api: inertApi().api, now: () => at(12),
    revalidate: async (_request, { api: bounded }) => { for (let i = 0; i < 90; i++) await bounded(`/inert-read/${i}`); return plan; } });
  assert.deepEqual([none.writes, none.landingSafe, none.complete, none.coverage["uncovered-landable"]], [0, false, false, 2]);
});

test("late target changes, missing/additional targets and duplicates reject the entire batch", async () => {
  const plan = await cycle({ census: batch(3) });
  for (const edit of [p => { p.decisions[2].entry.headSha = group; }, p => { p.decisions.pop(); },
    p => { p.decisions.push(p.decisions[0]); }, p => { p.decisions[2] = p.decisions[0]; },
    p => { p.decisions[2].context = "other"; }, p => { p.decisions[2].expiresAt = at(12); }]) {
    const fresh = structuredClone(plan); edit(fresh);
    const { api, statuses } = inertApi();
    await assert.rejects(writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12), revalidate: async () => fresh }));
    assert.equal(statuses.length, 0);
  }
});

test("a shared rebuild cannot lend an expired grant or observation to later writes", async () => {
  for (const boundary of ["grant", "cycle"]) {
    const plan = await cycle({ census: batch(3) });
    if (boundary === "grant") plan.decisions[1].expiresAt = at(13);
    const { api: transport, statuses } = inertApi();
    let clock = at(12);
    const api = async (...args) => {
      const result = await transport(...args);
      if (statuses.length === 1) clock = boundary === "grant" ? at(13) : at(71);
      return result;
    };
    Object.defineProperty(api, "rateLimit", { get: () => transport.rateLimit });
    const audit = [];
    await assert.rejects(writeAdmissionPlan(plan, { configuration: enabled, api, now: () => clock,
      revalidate: async () => plan, log: line => audit.push(JSON.parse(line)) }), e => e.writes === 1);
    assert.equal(statuses.length, 1);
    assert.equal(audit.at(-1).complete, false);
    assert.equal(audit.at(-1).writes, 1);
  }
});

test("shared live rebuild performs one health report then one complete census, retaining failure evidence", async () => {
  let reports = 0, queries = 0;
  const report = async (argv, options) => {
    reports++;
    assert.deepEqual(argv, ["report"]);
    assert.equal(options.env.GITHUB_REF, "refs/heads/main");
    assert.equal(options.now(), at(11), "the rebuild's clock reaches the health observer");
    await options.api("/inert-health");
    options.log(JSON.stringify(red())); return 0;
  };
  let mainSha = base;
  const api = async path => {
    if (path === "/inert-health") return {};
    assert.equal(path, "/graphql"); queries++;
    assert.equal(reports, queries, "one independent health rebuild precedes each census");
    return { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainSha } },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false,
        headRefOid: head, baseRefOid: mainSha, mergeQueueEntry: null }] } } } };
  };
  const options = { repository, api, report, control: control(), now: () => at(11) };
  const failed = await rebuildAdmissionCycle(options);
  assert.equal(failed.decisions[0].state, "failure"); assert.equal(failed.decisions[0].plannedBlockLatencyMs, 1000);
  assert.equal(reports, 1); assert.equal(queries, 1);
  mainSha = group;
  const moved = await rebuildAdmissionCycle(options);
  assert.ok(moved.reasons.includes("main-observation-changed"));
  assert.equal(moved.decisions[0].state, "failure");
  assert.equal(reports, 2); assert.equal(queries, 2);
  const unavailable = await rebuildAdmissionCycle({ ...options, report: async (_args, { log }) => {
    log(JSON.stringify(health())); return 1;
  }, api: async () => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: base } },
    pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false,
      headRefOid: head, baseRefOid: base, mergeQueueEntry: null }] } } } }) });
  assert.equal(unavailable.healthSummary.status, "unknown");
  assert.equal(unavailable.decisions[0].state, "failure", "nonzero report cannot lend a passing projection");
});
