import assert from "node:assert/strict";
import test from "node:test";
import { mergedRepairBinding, repairDigest, repairRecovery, requestMergedRepairCandidate } from "./main-merge-repair.mjs";

const repository = "example/project", head = "a".repeat(40), base = "b".repeat(40), group = "c".repeat(40), merged = "d".repeat(40), tree = "e".repeat(40);
const suite = "f".repeat(64), claim = "12345678-1234-1234-1234-123456789012";
const at = seconds => new Date(Date.UTC(2026, 9, 26, 1) + seconds * 1000).toISOString();
const authorization = () => ({ repository, authorizationId: "repair-1", pullRequest: 42,
  headSha: head, baseSha: base, integrationSha: group, approvedAt: at(0), expiresAt: at(120) });
const admission = a => ({ authorizationDigest: repairDigest(a), integrationSha: group, admittedAt: at(30) });
function forge() {
  const pull = { number: 42, merged: true, head: { sha: head }, base: { ref: "main", repo: { full_name: repository } },
    merge_commit_sha: merged, merged_at: at(60) };
  const data = { pull, mergeCommit: { sha: merged, tree: { sha: tree }, parents: [{ sha: base }] },
    groupCommit: { sha: group, tree: { sha: tree } }, main: merged, reads: [], afterRead: () => {} };
  data.api = async (path, options = {}) => {
    assert.equal(options.method ?? "GET", "GET", "merge binding is read-only"); data.reads.push(path);
    let result;
    if (path.endsWith("/pulls/42")) result = structuredClone(data.pull);
    else if (path.endsWith(`/git/commits/${merged}`)) result = structuredClone(data.mergeCommit);
    else if (path.endsWith(`/git/commits/${group}`)) result = structuredClone(data.groupCommit);
    else if (path.endsWith("/git/ref/heads/main")) result = { object: { sha: data.main } };
    else assert.fail(`unexpected request ${path}`);
    data.afterRead(path); return result;
  };
  return data;
}
const binding = () => ({ decision: "merged-repair-bound", repository, pullRequest: 42, headSha: head, baseSha: base,
  integrationSha: group, mergeSha: merged, treeSha: tree, authorizationId: "repair-1" });
const receipt = () => ({ schema: "main-validation-candidate-v1", purpose: "repair", scheduledPurpose: "repair",
  targetSha: merged, suiteVersion: suite, runId: 20, status: "success", certification: "none", claimId: claim,
  observedAt: at(90), requestedAt: at(70), dispatchedAt: at(80), statusObservedAt: at(90) });
function health() {
  const pass = { repository, certification: "full", coverageVersion: "rolling-full-v1", result: "passing", testedSha: merged,
    targetSha: merged, workflowRevision: merged, suiteVersion: suite, runId: 20, attempt: 1,
    checkoutVerified: true, targetAncestryVerified: true, workflowAncestryVerified: true };
  return { schema: "main-ci-health-v1", repository, observedAt: at(90), currentMainSha: merged, status: "passing", reasons: [],
    unresolvedFailures: [], latestPassingSnapshot: pass, fullCertification: pass,
    backlog: { commits: 0, merges: 0, clock: "forge-landing-time", oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: 0 } };
}

test("exact admitted group binds to a different squash SHA only through the approved tree and base", async () => {
  const a = authorization(), data = forge();
  const result = await mergedRepairBinding(repository, a, admission(a), { api: data.api });
  assert.equal(result.decision, "merged-repair-bound"); assert.equal(result.mergeSha, merged);
  assert.equal(result.treeSha, tree); assert.equal(result.headSha, head);
  assert.equal(result.authorizationDigest, repairDigest(a)); assert.equal(data.reads.length, 6);
});

test("changed heads, trees, bases, foreign repos, missing merges and competing repairs do not bind", async () => {
  for (const edit of [d => { d.pull.head.sha = base; }, d => { d.pull.number = 43; },
    d => { d.pull.base.repo.full_name = "other/project"; }, d => { d.pull.merged = false; },
    d => { d.mergeCommit.tree.sha = base; }, d => { d.mergeCommit.parents = [{ sha: head }]; },
    d => { d.mergeCommit.parents.push({ sha: head }); }, d => { d.main = group; },
    d => { d.pull.merged_at = at(20); }]) {
    const a = authorization(), data = forge(); edit(data);
    assert.equal((await mergedRepairBinding(repository, a, admission(a), { api: data.api })).decision, "hold");
  }
});

test("expired or mismatched pre-merge authorization cannot be laundered into a reconciliation record", async () => {
  const a = authorization();
  for (const recorded of [{}, { ...admission(a), admittedAt: at(120) }, { ...admission(a), admittedAt: at(-1) },
    { ...admission(a), authorizationDigest: "0".repeat(64) }, { ...admission(a), integrationSha: merged }]) {
    assert.equal((await mergedRepairBinding(repository, a, recorded, { api: () => assert.fail("no read without admission binding") })).decision, "hold");
  }
  assert.equal((await mergedRepairBinding("../private", a, admission(a), { api: () => assert.fail("invalid repository") })).decision, "hold");
  // Expiry after admission does not erase the historical exact binding or strand post-merge validation.
  const data = forge(); data.pull.merged_at = at(180);
  assert.equal((await mergedRepairBinding(repository, a, admission(a), { api: data.api })).decision, "merged-repair-bound");
});

test("a forge race or outage holds instead of reusing an earlier merge read", async () => {
  const a = authorization(), data = forge();
  data.afterRead = path => { if (path.endsWith(`/git/commits/${merged}`)) data.main = base; };
  assert.equal((await mergedRepairBinding(repository, a, admission(a), { api: data.api })).decision, "hold");
  const unavailable = await mergedRepairBinding(repository, a, admission(a), { api: async () => { throw new Error("private response"); } });
  assert.deepEqual(unavailable, { decision: "hold", reason: "repair-forge-unavailable" });
});

test("merged repair requests use only the shared purpose=repair primitive, without current-main-green precondition", async () => {
  let count = 0;
  const api = () => assert.fail("wrapper must not require broken main health before the shared request");
  const result = await requestMergedRepairCandidate(binding(), { api, now: () => at(70),
    requestCandidate: async (repo, sha, options) => { count++; assert.equal(repo, repository); assert.equal(sha, merged);
      assert.equal(options.purpose, "repair"); assert.equal(options.api, api); return { ...receipt(), status: "queued" }; } });
  assert.equal(result.decision, "repair-validation-requested"); assert.equal(count, 1);
  assert.equal((await requestMergedRepairCandidate({ decision: "hold" }, { requestCandidate: () => assert.fail("unbound request") })).decision, "hold");
});

test("receipt success alone never releases; exact fresh full evidence resolves the repair", () => {
  assert.equal(repairRecovery({ binding: binding(), receipt: receipt(), now: at(100) }).decision, "hold");
  const result = repairRecovery({ binding: binding(), receipt: receipt(), health: health(), now: at(100) });
  assert.equal(result.decision, "release-eligible"); assert.equal(result.enforcement, "none"); assert.equal(result.fullAttempt, 1);
  // Cross-purpose dedup may reuse an existing worker while the caller still requests repair.
  assert.equal(repairRecovery({ binding: binding(), receipt: { ...receipt(), scheduledPurpose: "release" }, health: health(), now: at(100) }).decision, "release-eligible");
});

test("new failures, reruns, out-of-order stale results, changed suite and main movement keep the hold", () => {
  for (const edit of [h => { h.status = "unknown"; h.fullCertification = null; },
    h => { h.status = "failing"; h.unresolvedFailures = [{ runId: 21, attempt: 1 }]; },
    h => { h.fullCertification = null; }, h => { h.fullCertification.certification = "none"; },
    h => { h.fullCertification.suiteVersion = "0".repeat(64); }, h => { h.currentMainSha = base; },
    h => { h.fullCertification.checkoutVerified = false; }, h => { h.fullCertification.testedSha = group; }]) {
    const h = health(); edit(h);
    assert.equal(repairRecovery({ binding: binding(), receipt: receipt(), health: h, now: at(100) }).decision, "hold");
  }
  for (const change of [{ purpose: "release" }, { status: "dispatched" }, { status: "failure" }, { runId: 19 },
    { certification: "full" }, { targetSha: group }, { suiteVersion: "0".repeat(64) }, { observedAt: at(101) }])
    assert.equal(repairRecovery({ binding: binding(), receipt: { ...receipt(), ...change }, health: health(), now: at(100) }).decision, "hold");
  assert.equal(repairRecovery({ binding: binding(), receipt: receipt(), health: health(), now: at(210) }).decision, "hold");
});
