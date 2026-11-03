import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type CampaignForgePullRequestObservation, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

/** #4067: a Full Control campaign over picoduck/wollipog#4067 whose one child merged #4100 through
 * an approved `pr_merge`. The real control plane and ledger; synthetic forge facts only. */
function fixture(protocolVersion = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };
  db.registerRunner(metadata, 1, protocolVersion);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.behavior.completion = "retain";
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [4067], revision: 1,
    authorizedByUserId: identity.userId, authorizedAt: 1 };
  policy.issueNumbers = [4067];
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id,
      useWorktree: false, driver: "claude-code", config: { model: "opus" }, now: 1,
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      ...(id !== "root" ? { parentSessionId: "root" } : { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  hub.sendToRunner = () => true;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #4067",
    operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 1,
  { ...identity, kind: "human", actorId: identity.userId });
  assert.ok(enabled.ok, enabled.error ?? "admission failed");
  svc.hydrateHistory = async () => {};
  const plan = svc.recordCampaignPlan("root", { planComplete: true, items: [
    { key: "original:4067:delivery", title: "Deliver #4067", issue: { repository: "picoduck/wollipog", number: 4067 } },
  ] });
  assert.ok(plan.ok, plan.error ?? "plan refused");
  const item = plan.data!.items[0]!.workItemId;
  // The child's approved merge of #4100, consumed when the forge read it merged.
  db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
    category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at,resolved_at,consumed_at)
    VALUES ('merge','merge-4100','child','root','pr_merge','picoduck/wollipog#4100',?,'digest',1,'orchestrator','consumed',3,4,5)`)
    .run(JSON.stringify({ category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 4100, headSha: "a".repeat(40),
      reviewResult: "merge", requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 2,
        checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }] } }));
  // The child delivered and was verified, so only the branch can keep the campaign going.
  assert.ok(svc.assignCampaignWorkItem("root", { workItemId: item, childSessionId: "child" }).ok);
  assert.ok(svc.updateCampaignWorkItem("root", { workItemId: item,
    stage: { stage: "merged", pullRequests: [{ repository: "picoduck/wollipog", number: 4100 }] } }).ok);
  db.updateSessionStatus("child", "idle", Date.now());
  const report = db.appendEvent("child", { kind: "agent_message", text: "Merged #4100.", final: true }, Date.now()).seq;
  const verified = svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: report, followUpsAccounted: true,
    workItem: { id: item, outcome: "delivered" } });
  assert.ok(verified.ok, verified.error ?? "verification refused");
  db.updateSessionStatus("root", "idle", Date.now());
  return { db, svc, item };
}

const observed = (tipSha: string | null, overrides: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation => ({
  state: "merged", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
  checks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  mergeQueue: null, mergeCommitSha: "b".repeat(40), defaultBranch: "main",
  headBranch: { name: "agent/child", tipSha }, ...overrides,
});

const observe = (h: ReturnType<typeof fixture>, observation: CampaignForgePullRequestObservation, at = Date.now()) =>
  h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 4100 }, observation }], at);

test("a campaign whose merged branch still exists on origin is not verified complete (#4067)", () => {
  const h = fixture();
  try {
    // Not read yet: pending, never assumed deleted.
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active");
    assert.deepEqual(projection.mergedBranches, { total: 1, pending: 1, retained: 0, items: [{ sessionId: "child",
      workItemId: h.item, repository: "picoduck/wollipog", pullRequest: 4100, branch: null, headSha: "a".repeat(40),
      state: "pending", reason: "The forge has not been read for this merged pull request yet." }] });

    // The forge reports the merged branch still on origin.
    observe(h, observed("a".repeat(40)), 100);
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active", "a pending merged branch keeps the campaign from verified_complete");
    assert.equal(h.db.campaignStatusOnly("root"), "active", "the summary status agrees");
    assert.deepEqual(projection.mergedBranches?.items.map((row) => [row.branch, row.state, row.reason, row.observedAt]),
      [["agent/child", "pending", "The merged branch is still on the remote.", 100]]);
    assert.deepEqual(h.db.campaignMergedBranchTargets(), [{ campaignId: "root", refs: [{ repository: "picoduck/wollipog", number: 4100 }] }],
      "the background pass keeps reading it");
    assert.equal(h.db.campaignForgeObservations.readState("root", [{ repository: "picoduck/wollipog", number: 4100 }])
      .get("picoduck/wollipog#4100")?.finished, false);

    // Deleted on origin: the campaign is complete.
    observe(h, observed(null), 200);
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "verified_complete");
    assert.deepEqual(projection.mergedBranches?.items.map((row) => [row.branch, row.state]), [["agent/child", "deleted"]]);
    assert.deepEqual(h.db.campaignMergedBranchTargets(), []);
  } finally { h.db.close(); }
});

test("a merged branch retained with a reason finishes the campaign with handoffs, not blocked forever (#4067)", () => {
  const h = fixture();
  try {
    observe(h, observed("a".repeat(40)));
    assert.equal(h.db.campaignProjection("root")!.status, "active");
    // A handoff to an agent is still the campaign's own work.
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item, handoff: { responsibleActor: "orchestrator",
      reason: "Delete it next turn.", nextAction: "Delete the branch." } }).ok);
    assert.equal(h.db.campaignProjection("root")!.status, "active");
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item, handoff: { responsibleActor: "human",
      reason: "A release branch is cut from this head.", nextAction: "Delete the branch after the release." } }).ok);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "complete_with_handoffs");
    assert.deepEqual(projection.mergedBranches, { total: 1, pending: 0, retained: 1, items: [{ sessionId: "child",
      workItemId: h.item, repository: "picoduck/wollipog", pullRequest: 4100, branch: "agent/child", headSha: "a".repeat(40),
      state: "retained", reason: "A release branch is cut from this head.", observedAt: projection.mergedBranches!.items[0]!.observedAt }] });
  } finally { h.db.close(); }
});

test("an approved enqueue still in the queue keeps the campaign going until its merge and branch are observed (#4067)", () => {
  const h = fixture();
  try {
    // Wollipog's enqueue consumed the approval while the pull request was still open.
    observe(h, observed("a".repeat(40), { state: "open", mergeCommitSha: null }), 100);
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active", "an enqueued merge is not a finished campaign");
    assert.deepEqual(projection.mergedBranches?.items.map((row) => [row.branch, row.state, row.reason]),
      [["agent/child", "pending", "The approved merge has not landed yet; its branch is cleaned up after it does."]]);
    assert.deepEqual(h.db.campaignMergedBranchTargets(), [{ campaignId: "root", refs: [{ repository: "picoduck/wollipog", number: 4100 }] }],
      "the background pass keeps reading it until it merges");
    assert.equal(h.db.campaignForgeObservations.readState("root", [{ repository: "picoduck/wollipog", number: 4100 }])
      .get("picoduck/wollipog#4100")?.finished, false);
    observe(h, observed("a".repeat(40)), 200);
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active", "merged, but its branch is still on the remote");
    observe(h, observed(null), 300);
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");
    // A pull request closed without merging is not a merged branch.
    observe(h, observed("a".repeat(40), { state: "closed", mergeCommitSha: null }), 400);
    assert.equal(h.db.campaignProjection("root")!.mergedBranches, undefined);
  } finally { h.db.close(); }
});

test("cleanup handed to a person before the first forge read retains the branch (#4067)", () => {
  const h = fixture();
  try {
    assert.equal(h.db.campaignProjection("root")!.status, "active");
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item, handoff: { responsibleActor: "external",
      reason: "The child's forge login is unavailable.", nextAction: "Delete the branch from a maintainer account." } }).ok);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "complete_with_handoffs");
    assert.deepEqual(projection.mergedBranches?.items.map((row) => [row.branch, row.state, row.reason]),
      [[null, "retained", "The child's forge login is unavailable."]]);
  } finally { h.db.close(); }
});

test("a Wollipog deletion after the last read counts, and a refused one says why (#4067)", () => {
  const h = fixture();
  try {
    observe(h, observed("a".repeat(40)), 100);
    const deletion = (occurrence: string, forgeAction: Record<string, unknown>) => h.db.raw().prepare(`INSERT INTO workflow_decisions(
      request_id,occurrence_id,session_id,controlling_session_id,category,resource_key,resource_snapshot,resource_digest,
      policy_revision,authority,status,created_at,resolved_at,forge_action)
      VALUES (?,?,'child','root','merged_branch_deletion','branch:agent/child',?,'digest',1,'orchestrator',?,6,7,?)`)
      .run(occurrence, occurrence, JSON.stringify({ category: "merged_branch_deletion", repository: "picoduck/wollipog",
        branch: "agent/child", merged: true, mergeCommitSha: "b".repeat(40), pullRequest: 4100, headSha: "a".repeat(40),
        dependentPullRequests: { checkedAt: 5, open: [] } }), forgeAction.outcome === "refused" ? "revoked" : "consumed", JSON.stringify(forgeAction));
    deletion("refused", { kind: "branch_deletion", attempts: 1, outcome: "refused", updatedAt: 150,
      refusal: { reason: "tip_moved", summary: "The branch tip is no longer the approved merged head, so it was left alone." } });
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active");
    assert.equal(projection.mergedBranches?.items[0]?.reason,
      "The last deletion was refused: The branch tip is no longer the approved merged head, so it was left alone.");
    assert.equal(projection.mergedBranches?.items[0]?.decisionOccurrenceId, "refused", "the Orchestrator can read that decision");
    deletion("deleted", { kind: "branch_deletion", attempts: 1, outcome: "deleted", updatedAt: 160 });
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.mergedBranches?.items[0]?.state, "deleted");
    assert.equal(projection.mergedBranches?.items[0]?.decisionOccurrenceId, "deleted");
    assert.equal(projection.status, "verified_complete");
    // A later read that still shows the branch outranks the earlier deletion record.
    observe(h, observed("a".repeat(40)), 300);
    assert.equal(h.db.campaignProjection("root")!.status, "active");
  } finally { h.db.close(); }
});

test("a fork's branch is not tracked, and an older observing runner keeps today's completion (#4067)", () => {
  const fork = fixture();
  try {
    observe(fork, observed(null, { headBranch: undefined }));
    assert.equal(fork.db.campaignProjection("root")!.status, "verified_complete");
    assert.equal(fork.db.campaignProjection("root")!.mergedBranches, undefined);
  } finally { fork.db.close(); }
  const older = fixture(RUNNER_CAPABILITY_MIN_PROTOCOL.forgeDecisionActions - 1);
  try {
    assert.equal(older.db.campaignProjection("root")!.status, "verified_complete");
    assert.equal(older.db.campaignProjection("root")!.mergedBranches, undefined);
  } finally { older.db.close(); }
});
