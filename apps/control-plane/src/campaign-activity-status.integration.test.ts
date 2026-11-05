import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  campaignStatusTerminal, type CampaignForgePullRequestObservation, type ControlPlaneToRunner, type OrchestratorCampaignStatus,
  type RunnerMetadata } from "@wollipog/protocol";
import { compatibleCampaignStatus, projectCampaignStatusForUi } from "./campaign-status-compatibility.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

/**
 * #4146: a campaign is Campaign Active only while work is actually running; an idle campaign reads
 * Complete, Needs Cleanup, Campaign Complete or Campaign Stuck, after the server tried once to settle
 * its leftovers. The real control plane and ledger over picoduck/wollipog#4146, whose one child
 * merged #4200 through an approved `pr_merge`; synthetic forge facts and runner answers only.
 */
async function fixture(options: { mode?: "full_control" | "custom"; verify?: boolean; approveDeletion?: boolean } = {}) {
  const mode = options.mode ?? "full_control";
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.behavior.completion = "retain";
  if (mode === "full_control") {
    policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [4146], revision: 1,
      authorizedByUserId: identity.userId, authorizedAt: 1 };
    policy.issueNumbers = [4146];
  }
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
  const runnerRequests: ControlPlaneToRunner[] = [];
  let forgeOutcome: "deleted" | "refused" = "deleted";
  hub.requestFromRunner = (async (_runnerId: string, _requestId: string, message: ControlPlaneToRunner) => {
    runnerRequests.push(message);
    if (message.type !== "forge_decision_action") throw new Error(`unexpected runner request ${message.type}`);
    return { type: "forge_decision_action_result", requestId: message.requestId, sessionId: message.sessionId,
      occurrenceId: message.occurrenceId, outcome: forgeOutcome,
      ...(forgeOutcome === "refused" ? { refusal: { reason: "forge_unavailable", summary: "The forge could not be reached." } } : {}) };
  }) as unknown as Hub["requestFromRunner"];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  if (mode === "full_control") {
    const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #4146",
      operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 1,
    { ...identity, kind: "human", actorId: identity.userId });
    assert.ok(enabled.ok, enabled.error ?? "admission failed");
  }
  svc.hydrateHistory = async () => {};
  const plan = svc.recordCampaignPlan("root", { planComplete: true, items: [
    { key: "original:4146:delivery", title: "Deliver #4146", issue: { repository: "picoduck/wollipog", number: 4146 } },
  ] });
  assert.ok(plan.ok, plan.error ?? "plan refused");
  const item = plan.data!.items[0]!.workItemId;
  // The child's approved merge of #4200, consumed when the forge read it merged.
  db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
    category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at,resolved_at,consumed_at)
    VALUES ('merge','merge-4200','child','root','pr_merge','picoduck/wollipog#4200',?,'digest',1,'orchestrator','consumed',3,4,5)`)
    .run(JSON.stringify({ category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 4200, headSha: "a".repeat(40),
      reviewResult: "merge", requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 2,
        checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }] } }));
  assert.ok(svc.assignCampaignWorkItem("root", { workItemId: item, childSessionId: "child" }).ok);
  assert.ok(svc.updateCampaignWorkItem("root", { workItemId: item,
    stage: { stage: "merged", pullRequests: [{ repository: "picoduck/wollipog", number: 4200 }] } }).ok);
  // The child asks to delete its merged branch, the owner approves it, and the child consumes it to
  // run its own deletion, which its provider refused (#4067), all before its final report.
  const deletion = options.approveDeletion ? await approveDeletion(svc, identity.userId) : null;
  db.updateSessionStatus("child", "idle", Date.now());
  const report = db.appendEvent("child", { kind: "agent_message", text: "Merged #4200.", final: true }, Date.now()).seq;
  if (options.verify !== false) {
    const verified = svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: item, outcome: "delivered" } });
    assert.ok(verified.ok, verified.error ?? "verification refused");
  }
  db.updateSessionStatus("root", "idle", Date.now());
  return { db, hub, svc, item, identity, deletion, runnerRequests, setForgeOutcome: (outcome: "deleted" | "refused") => { forgeOutcome = outcome; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const observed = (tipSha: string | null, overrides: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation => ({
  state: "merged", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
  checks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  mergeQueue: null, mergeCommitSha: "b".repeat(40), defaultBranch: "main",
  headBranch: { name: "agent/child", tipSha }, ...overrides,
});

const observe = (h: Fixture, observation: CampaignForgePullRequestObservation, at = Date.now()) =>
  h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 4200 }, observation }], at);

/** The child asks to delete its merged branch and the owner approves it, as the typed gate does. */
async function approveDeletion(svc: SessionsService, ownerId: string) {
  const snapshot = { category: "merged_branch_deletion" as const, repository: "picoduck/wollipog", branch: "agent/child", merged: true as const,
    mergeCommitSha: "b".repeat(40), pullRequest: 4200, headSha: "a".repeat(40), dependentPullRequests: { checkedAt: 10, open: [] } };
  const created = svc.createWorkflowDecision("child", { requestId: "delete-branch", resourceKey: "branch:agent/child",
    resourceSnapshot: snapshot });
  assert.ok(created.ok && created.data, created.error ?? "decision refused");
  const resolved = svc.resolveWorkflowDecision("root", "child", created.data.occurrenceId, { outcome: "approve" }, "human",
    { kind: "human", id: ownerId }, () => true);
  assert.ok(resolved.ok, resolved.error ?? "approval refused");
  const consumed = await svc.consumeWorkflowDecision("child", created.data.occurrenceId, { resourceSnapshot: snapshot });
  assert.equal(consumed.data?.status, "consumed", consumed.error ?? "consumption refused");
  return created.data;
}

/** Deliver the pending campaign continuation and let it end, as a root turn that changed nothing. */
function completeContinuation(h: Fixture, id: string) {
  const events = h.db.campaignContinuationEvents("root", Date.now() + 60_000);
  assert.ok(events.length > 0, "a continuation is owed");
  assert.ok(h.db.stageCampaignContinuation({
    continuationId: id, commandId: `${id}-cmd`, campaignSessionId: "root", runnerId: "r",
    eventFromSeq: events[0]!.seq, eventThroughSeq: events.at(-1)!.seq, payloadJson: "{}",
    payloadSha256: "a".repeat(64), expiresAt: Date.now() + 60_000, attemptCount: 1, now: Date.now(),
  }));
  h.db.updateCampaignContinuationForCommand(`${id}-cmd`, "completed", Date.now());
}

test("a delivered, idle campaign with its merged branch still on the remote reads Complete, Needs Cleanup, then Campaign Complete (#4146)", async () => {
  const h = await fixture();
  try {
    observe(h, observed("a".repeat(40)), 100);
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "complete_needs_cleanup", "never Active: nothing is running");
    assert.equal(h.db.campaignStatusOnly("root"), "complete_needs_cleanup", "the summary status agrees");
    assert.equal(campaignStatusTerminal(projection.status), true, "Campaign Elapsed and automatic turns end");
    assert.deepEqual(projection.activity, { live: [] });
    assert.deepEqual(projection.cleanup, { total: 1, items: [{ kind: "merged_branch", sessionId: "child",
      repository: "picoduck/wollipog", pullRequest: 4200, branch: "agent/child", state: "pending",
      reason: "The merged branch is still on the remote.",
      action: { kind: "command", command: "gh api -X DELETE 'repos/picoduck/wollipog/git/refs/heads/agent/child'" } }] },
    "without an approved deletion, the exact command a person runs");
    assert.equal(projection.stuck, undefined);

    // Once the branch is gone the campaign is complete, with no one's action beyond the cleanup.
    observe(h, observed(null), 200);
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "verified_complete");
    assert.equal(projection.cleanup, undefined);
  } finally { h.db.close(); }
});

test("an approved deletion is offered as Delete Merged Branches and performed through the existing forge action (#4146)", async () => {
  const h = await fixture({ approveDeletion: true });
  try {
    observe(h, observed("a".repeat(40)), 100);
    const decision = h.deletion!;
    const projection = h.db.campaignProjection("root")!;
    assert.deepEqual(projection.cleanup?.items.map((item) => item.action),
      [{ kind: "delete_merged_branches", occurrenceId: decision.occurrenceId }]);
    const pressed = await h.svc.deleteApprovedMergedBranches("root", () => true);
    assert.ok(pressed.ok, pressed.error ?? "deletion refused");
    assert.deepEqual([pressed.data?.performed, pressed.data?.refused], [1, 0]);
    assert.equal(pressed.data?.projection?.status, "verified_complete");
    const actions = h.runnerRequests.filter((message) => message.type === "forge_decision_action");
    assert.equal(actions.length, 1, "exactly the approved deletion, once");
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)?.status, "consumed");
    const again = await h.svc.deleteApprovedMergedBranches("root", () => true);
    assert.equal(again.status, 409, "nothing approved is left to perform");
    const outsider = await h.svc.deleteApprovedMergedBranches("root", () => false);
    assert.equal(outsider.status, 404, "a person who cannot read the campaign cannot ask");
  } finally { h.db.close(); }
});

test("an idle campaign with undelivered work and nothing scheduled reads Campaign Stuck, never Active (#4146)", async () => {
  const h = await fixture({ verify: false });
  try {
    observe(h, observed("a".repeat(40), { state: "open", mergeCommitSha: null }), 100);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "stuck");
    assert.equal(h.db.campaignStatusOnly("root"), "stuck");
    assert.equal(campaignStatusTerminal(projection.status), false);
    assert.deepEqual(projection.activity, { live: [] });
    assert.deepEqual(projection.stuck, { total: 1, items: [{ kind: "unverified_child", sessionId: "child", status: "idle",
      reason: "The child's latest report has not been verified." }] }, "Campaign Status names what is unfinished and why");
  } finally { h.db.close(); }
});

test("a pull request in the merge queue with a registered wake keeps an otherwise idle campaign Active (#4146)", async () => {
  const h = await fixture({ verify: false });
  try {
    h.db.pullRequestWatches.register({ watchId: "watch-1", sessionId: "child", runnerId: "r", repository: "picoduck/wollipog",
      number: 4200, headSha: "a".repeat(40), now: Date.now() });
    const projection = h.db.campaignProjection("root")!;
    assert.equal(h.db.getSession("root")?.status, "idle");
    assert.equal(h.db.getSession("child")?.status, "idle");
    assert.equal(projection.status, "active");
    assert.deepEqual(projection.activity?.live, ["merge_queue_wait"]);
    assert.equal(projection.stuck, undefined);
  } finally { h.db.close(); }
});

test("a running child, an unfinished background job or a pending continuation reads Campaign Active (#4146)", async () => {
  for (const kind of ["child_turn", "background_job", "continuation"] as const) {
    const h = await fixture({ verify: false });
    try {
      if (kind === "child_turn") h.db.updateSessionStatus("child", "running", Date.now());
      if (kind === "background_job") {
        h.db.raw().prepare(`INSERT INTO managed_background_jobs (session_id, job_id, parent_turn_id, runner_id, launch_type,
          registered_at, last_observed_at, source_present) VALUES ('child','job-1','turn-1','r','monitor',?,?,1)`).run(Date.now(), Date.now());
      }
      if (kind === "continuation") {
        h.db.recordCampaignContinuationEvent({ eventId: "child-ready:root:child", campaignSessionId: "root", kind: "child_ready",
          subjectSessionId: "child", now: Date.now() });
      }
      const projection = h.db.campaignProjection("root")!;
      assert.equal(projection.status, "active", kind);
      assert.deepEqual(projection.activity?.live, [kind], kind);
    } finally { h.db.close(); }
  }
});

test("cleanup the server can perform ends at Campaign Complete, and the campaign reads Active while it runs (#4146)", async () => {
  const h = await fixture({ approveDeletion: true });
  try {
    observe(h, observed("a".repeat(40)), 100);
    const attempt = h.svc.repairCampaign("root");
    const during = h.db.campaignProjection("root")!;
    assert.equal(during.status, "active", "the server's own repair is live work");
    assert.deepEqual([during.activity?.live, during.activity?.repair?.state], [["server_repair"], "running"]);
    assert.equal(await attempt, true);
    const after = h.db.campaignProjection("root")!;
    assert.equal(after.status, "verified_complete");
    assert.deepEqual([after.activity?.repair?.state, after.activity?.repair?.continuation], ["attempted", false],
      "nothing was left, so the Orchestrator is not woken");
    assert.equal(h.db.campaignContinuationEvents("root").filter((event) => event.kind === "campaign_idle").length, 0);
  } finally { h.db.close(); }
});

test("cleanup the server cannot perform wakes the root once, then reads Complete, Needs Cleanup (#4146)", async () => {
  const h = await fixture();
  try {
    observe(h, observed("a".repeat(40)), 100);
    assert.equal(await h.svc.repairCampaign("root"), true);
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active", "the wake-up naming what is left is pending");
    assert.deepEqual(projection.activity?.live, ["continuation"]);
    assert.deepEqual([projection.activity?.repair?.state, projection.activity?.repair?.continuation], ["attempted", true]);
    const [event] = h.db.campaignContinuationEvents("root");
    assert.equal(event?.kind, "campaign_idle");

    completeContinuation(h, "cleanup-wake");
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "complete_needs_cleanup");
    assert.equal(await h.svc.repairCampaign("root"), false, "the same leftovers are tried once");
    assert.equal(h.db.campaignContinuationEvents("root").length, 0, "and wake nobody again");
  } finally { h.db.close(); }
});

test("stuck work after a continuation that changes nothing ends at Campaign Stuck (#4146)", async () => {
  const h = await fixture({ verify: false });
  try {
    assert.equal(h.db.campaignProjection("root")!.status, "stuck");
    assert.equal(await h.svc.repairCampaign("root"), true);
    assert.equal(h.db.campaignProjection("root")!.status, "active", "the wake-up is pending");
    completeContinuation(h, "stuck-wake");
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "stuck");
    assert.equal(projection.stuck?.items[0]?.kind, "unverified_child");
    assert.equal(await h.svc.repairCampaign("root"), false);

    // Something changed: the child failed. Those leftovers get their own one attempt.
    h.db.updateSessionStatus("child", "failed", Date.now());
    assert.equal(await h.svc.repairCampaign("root"), true);
  } finally { h.db.close(); }
});

test("a Custom campaign gets the same projection (#4146)", async () => {
  const cleanup = await fixture({ mode: "custom" });
  try {
    observe(cleanup, observed("a".repeat(40)), 100);
    assert.equal(cleanup.db.campaignProjection("root")!.control?.mode, "custom");
    assert.equal(cleanup.db.campaignProjection("root")!.status, "complete_needs_cleanup");
    observe(cleanup, observed(null), 200);
    assert.equal(cleanup.db.campaignProjection("root")!.status, "verified_complete");
  } finally { cleanup.db.close(); }
  const stuck = await fixture({ mode: "custom", verify: false });
  try {
    assert.equal(stuck.db.campaignProjection("root")!.status, "stuck");
    stuck.db.updateSessionStatus("root", "running", Date.now());
    assert.equal(stuck.db.campaignProjection("root")!.status, "active", "the root's own turn is live work");
  } finally { stuck.db.close(); }
});

test("a Custom root asking its owner a question is Waiting for You, never complete (#4146)", async () => {
  const h = await fixture({ mode: "custom" });
  try {
    observe(h, observed(null), 100);
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");
    h.svc.onSessionEvent("root", { kind: "question_request", requestId: "ask-owner", occurrenceId: "request_ask_owner",
      questions: [{ id: "q", header: "Scope", question: "Should the follow-up ship too?", options: [{ label: "Yes" }, { label: "No" }] }] });
    h.db.updateSessionStatus("root", "input_required", Date.now());
    assert.equal(h.db.campaignProjection("root")!.status, "waiting_human");
    assert.equal(h.db.campaignStatusOnly("root"), "waiting_human");
    assert.equal(h.db.campaignWorkLedger.accounting.completedAt("root"), null, "Campaign Elapsed keeps running");
  } finally { h.db.close(); }
});

test("Delete Merged Branches reaches an approved deletion past the bounded cleanup list (#4146)", async () => {
  const h = await fixture({ approveDeletion: true });
  try {
    // Fifty-one more merged branches still on the remote, none with an approved deletion.
    const insert = h.db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
      category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at,resolved_at,consumed_at)
      VALUES (?,?,'child','root','pr_merge',?,?,'digest',1,'orchestrator','consumed',3,4,6)`);
    const refs = [];
    for (let number = 5000; number < 5051; number += 1) {
      insert.run(`merge-${number}`, `merge-${number}`, `picoduck/wollipog#${number}`, JSON.stringify({ category: "pr_merge",
        repository: "picoduck/wollipog", pullRequest: number, headSha: "c".repeat(40), reviewResult: "merge",
        requiredChecks: { headSha: "c".repeat(40), status: "passed", checkedAt: 2, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }] } }));
      refs.push({ ref: { repository: "picoduck/wollipog", number }, observation: observed("c".repeat(40), { headSha: "c".repeat(40),
        headBranch: { name: `agent/extra-${number}`, tipSha: "c".repeat(40) } }) });
    }
    h.db.campaignForgeObservations.record("root", "r", refs, 100);
    observe(h, observed("a".repeat(40)), 100);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "complete_needs_cleanup");
    assert.equal(projection.cleanup?.total, 52);
    assert.equal(projection.cleanup?.items.length, 50, "the projection stays bounded");
    assert.equal(projection.cleanup?.items[0]?.action.kind, "delete_merged_branches", "what Wollipog can delete is listed first");
    const pressed = await h.svc.deleteApprovedMergedBranches("root", () => true);
    assert.ok(pressed.ok, pressed.error ?? "deletion refused");
    assert.deepEqual([pressed.data?.performed, pressed.data?.refused], [1, 0]);
  } finally { h.db.close(); }
});

test("older dashboards receive an existing status for the new ones, never active work (#4146)", async () => {
  const cases: Array<[OrchestratorCampaignStatus, number | null, OrchestratorCampaignStatus]> = [
    ["complete_needs_cleanup", PROTOCOL_VERSION, "complete_needs_cleanup"],
    ["stuck", PROTOCOL_VERSION, "stuck"],
    ["complete_needs_cleanup", RUNNER_CAPABILITY_MIN_PROTOCOL.campaignActivityStatus - 1, "complete_with_handoffs"],
    ["stuck", RUNNER_CAPABILITY_MIN_PROTOCOL.campaignActivityStatus - 1, "blocked"],
    ["complete_needs_cleanup", RUNNER_CAPABILITY_MIN_PROTOCOL.campaignHandoffs - 1, "waiting_human"],
    ["stuck", null, "blocked"],
    ["active", null, "active"],
    ["verified_complete", null, "verified_complete"],
  ];
  for (const [status, version, expected] of cases) {
    const compatible = compatibleCampaignStatus(status, version);
    assert.equal(compatible, expected, `${status} at ${version}`);
    if (status !== "active") assert.notEqual(compatible, "active", "a new status never reads as active work");
  }
  const h = await fixture({ verify: false });
  try {
    const session = h.db.getSession("root")!;
    assert.equal(session.fullControlCampaignStatus, "stuck");
    const legacy = projectCampaignStatusForUi({ type: "session_upsert", session }, 296);
    assert.equal(legacy.session.fullControlCampaignStatus, "blocked");
    assert.equal(legacy.session.orchestratorCampaign?.status, "blocked");
    assert.equal(session.fullControlCampaignStatus, "stuck", "the projection copies, never mutates");
    const person = { ...h.identity, kind: "human" as const, actorId: h.identity.userId };
    const row = (version: number | null) => JSON.parse(h.db.sessionListJsonForPrincipal(person, false, true, version))
      .sessions.find((candidate: { id: string }) => candidate.id === "root");
    assert.equal(row(PROTOCOL_VERSION).fullControlCampaignStatus, "stuck");
    assert.equal(row(296).fullControlCampaignStatus, "blocked");
  } finally { h.db.close(); }
});
