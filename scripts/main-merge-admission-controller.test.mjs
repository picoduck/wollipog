import assert from "node:assert/strict";
import test from "node:test";
import { ADMISSION_CONTEXT, authorizedRepair, failureFingerprint, main, planAdmissionCycle, planRollback,
  readAdmissionEntries, writeAdmissionPlan } from "./main-merge-admission-controller.mjs";
import { repairDigest } from "./main-merge-repair.mjs";

const repository = "example/project", base = "a".repeat(40), head = "b".repeat(40), group = "c".repeat(40);
const at = seconds => new Date(Date.UTC(2026, 9, 26, 1) + seconds * 1000).toISOString();
const entry = () => ({ repository, kind: "merge_group", pullRequest: 42, headSha: head, baseSha: base,
  integrationSha: group, members: [{ pullRequest: 42, headSha: head }] });
const census = () => ({ repository, complete: true, mainSha: base, entries: [entry()], fingerprint: "fixture" });
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

test("writer refuses by default and rebuilt evidence is mandatory for each exact target", async () => {
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
    revalidate: async e => { rebuilds++; assert.deepEqual(e, entry()); return cycle({ health: red(), now: at(12) }); } });
  assert.deepEqual(result, { mode: "operator-enabled", writes: 1 }); assert.equal(rebuilds, 1);
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

test("rollback cannot propose hold removal before full queue validation and separate exact approval", () => {
  const first = planRollback({ repository, operatorApproval: { approved: true } });
  assert.equal(first.decision, "restore-full-queue-validation-first"); assert.equal(first.holdRetained, true);
  const proof = { repository, verified: true, coverage: "full-merge-group-v1", requiredContext: "Typecheck, Test & Sidecar Bundle", workflowSha: base };
  const restored = planRollback({ repository, fullQueueProof: proof });
  assert.equal(restored.decision, "operator-hold-removal-approval-required");
  const approved = planRollback({ repository, fullQueueProof: proof, operatorApproval: { repository, approved: true,
    action: "remove-admission-hold", fullQueueProofDigest: restored.fullQueueProofDigest } });
  assert.equal(approved.decision, "operator-hold-removal-planned"); assert.equal(approved.holdRetained, true);
  assert.equal(approved.enforcement, "none");
});

test("the CLI has no enabled mode and cannot construct a status-writing capability", async () => {
  for (const value of [undefined, "", "disabled", "enabled", "enforce", "Dry-Run"]) {
    assert.equal(await main({ env: { MAIN_MERGE_ADMISSION_CONTROLLER: value }, api: () => assert.fail("off must do no work") }), 0);
  }
});
