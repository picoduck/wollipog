import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type CampaignBudgetAuthority, type PendingApproval, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";
import { automationCommandDigest, canonicalAutomationCommandJson } from "./automation-command-outbox.js";

function fixture(budgetAuthority?: CampaignBudgetAuthority) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  // Synthetic prices are test-only; no provider request or live pricing assertion is made.
  db.setUsageRateTable(new Map([["gpt-6.1-sol", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]]));
  if (budgetAuthority?.controlledReview) {
    metadata.runtime = { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4,
      campaignReview: budgetAuthority.controlledReview };
    db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  }
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2938], revision: 1,
    authorizedByUserId: identity.userId, authorizedAt: 1 };
  policy.issueNumbers = [2938];
  for (const id of ["root", "child", "unaffected"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id,
      useWorktree: false, driver: "codex-app-server", config: { model: "gpt-6.1-sol" }, now: 1,
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      ...(id !== "root" ? { parentSessionId: "root" } : { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  const sent: unknown[] = [];
  hub.sendToRunner = (_id, message) => { sent.push(message); return true; };
  const logs: string[] = [];
  const log = { info(message: string) { logs.push(message); }, warn() {}, error() {} };
  const svc = new SessionsService(db, hub, log);
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2938",
    operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [],
    ...(budgetAuthority ? { budgetAuthority } : {}) }, 1,
  { ...identity, kind: "human", actorId: identity.userId });
  assert.ok(enabled.ok, enabled.error ?? "admission failed");
  const recovery = new CampaignRecoveryService(db, () => {}, log);
  return { db, svc, recovery, sent, logs, metadata, hub, identity };
}

// Component fixtures use the real CP authority and durable outbox, never live profile grants.
const recoveryBudget: CampaignBudgetAuthority = { version: 1, accounting: "managed_workers_only",
  unpriced: "stop", toolCalls: 120, concurrency: 2 };

function nativeRecoveryFixture() {
  // Stub runner metadata and receipts prove CP composition only, not live profile authenticity.
  const profile = { profile: "native_opus_5_5_high_read_only", controllerSha256: "a".repeat(64),
    executableSha256: "b".repeat(64), cliVersion: "2.1.296", accounting: "provider_list_estimate",
    account: "runner_default_claude", agentId: "reviewer" } as const;
  const h = fixture({ ...recoveryBudget, costUsd: 100, toolCalls: 3000, concurrency: 4, controlledReview: profile });
  h.db.setWorktreePath("child", "/fixture/worktrees/child");
  const planned = h.svc.recordCampaignPlan("root", { planComplete: true,
    items: [{ key: "original:2938", issue: { repository: "picoduck/wollipog", number: 2938 } }] });
  assert.ok(planned.ok, planned.error ?? "plan refused");
  const workItemId = planned.data!.items[0]!.workItemId;
  assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId, childSessionId: "child" }).ok);
  assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId, stage: { stage: "in_review",
    pullRequests: [{ repository: "picoduck/wollipog", number: 3068 }] } }).ok);
  const request = { requestId: "native_original", workItemId, pullRequest: { repository: "picoduck/wollipog", number: 3068 },
    baseSha: "a".repeat(40), headSha: "b".repeat(40), costUsd: 5, toolCalls: 20, brief: "Private CODE fixture brief" };
  const reserve = (requestId: string) => {
    const result = h.svc.requestCampaignReviewJob("root", { ...request, requestId });
    assert.ok(result.ok, result.error ?? "native fixture reservation refused");
    return h.db.campaignReviewJobs.command(result.data!.jobId)!;
  };
  return { ...h, reserve };
}

test("native unknown usage retains the exact job and capacity without review replay or fabricated spend", () => {
  const h = nativeRecoveryFixture();
  try {
    const command = h.reserve("unknown");
    h.svc.onCampaignReviewJobUpdate("r", { type: "campaign_review_job_update", jobId: command.jobId,
      nonce: command.nonce, state: "accounting_unavailable", toolCalls: 1 });
    h.db.updateSessionStatus("root", "idle", 10);
    h.sent.length = 0;
    const before = h.db.campaignBudgets.view("root")!;
    h.recovery.maintain(100); h.svc.retryDuePrompts(10000);
    const record = h.db.campaignProjection("root")!.recovery!.records.find(r => r.resource.kind === "review_job")!;
    assert.equal(record.resource.occurrenceId, command.jobId);
    assert.equal(record.action, "reconcile_outcome");
    assert.equal(record.requiredInput, "reconcile_original_outcome");
    assert.equal(record.attempts, 0, "unknown accounting permits no new paid recovery wake");
    assert.equal(h.sent.length, 0);
    assert.equal(h.db.campaignBudgets.active(command.jobId), true);
    assert.deepEqual(h.db.campaignBudgets.view("root")!.outstanding, before.outstanding);
    assert.equal(h.svc.campaignReviewJob("root", command.jobId).data!.costUsd, null);
    assert.equal(JSON.stringify(record).includes("Private CODE"), false);
    assert.equal(JSON.stringify(record).includes(command.nonce), false);
    h.db.registerRunner(h.metadata, 20000, 217);
    h.svc.onCampaignReviewJobUpdate("r", { type: "campaign_review_job_update", jobId: command.jobId,
      nonce: command.nonce, state: "running", costUsd: 1, toolCalls: 2 });
    assert.equal(h.db.campaignBudgets.view("root")!.state, "accounting_unavailable");
    assert.equal(h.db.campaignBudgets.active(command.jobId), true);
    assert.equal(h.svc.campaignReviewJob("root", command.jobId).data!.costUsd, 1, "owned late usage stays charged");
    assert.equal(h.sent.some(m => (m as {type:string}).type === "cancel_campaign_review_job"), false,
      "unsupported peers receive no v218 cancellation frame");
    h.recovery.maintain(20001);
    assert.equal(h.db.campaignRecovery.projection("root").records.find(r => r.resource.kind === "review_job")!.reason,
      "uncertain_outcome", "a late running receipt cannot settle an unknown terminal outcome");
  } finally { h.db.close(); }
});

test("native invalid attempts and fourth valid objection remain blocked without resetting review ceilings", () => {
  for (const outcome of ["invalid", "objection"] as const) {
    const h = nativeRecoveryFixture();
    try {
      let command;
      for (let n = 1; n <= (outcome === "invalid" ? 2 : 4); n++) {
        command = h.reserve(`attempt_${n}`);
        h.svc.onCampaignReviewJobUpdate("r", { type: "campaign_review_job_update", jobId: command.jobId,
          nonce: command.nonce, state: "completed", costUsd: 1, toolCalls: 2,
          attemptValid: outcome === "objection", attemptConsumed: true,
          ...(outcome === "objection" ? { vote: "DOWNVOTE" as const } : {}), receiptSha256: "c".repeat(64),
          report: "Private reviewer report" });
      }
      h.sent.length = 0;
      h.recovery.maintain(100);
      const record = h.db.campaignProjection("root")!.recovery!.records.find(r => r.resource.kind === "review_job")!;
      assert.equal(record.resource.occurrenceId, command!.jobId);
      assert.equal(record.reason, "attempts_exhausted");
      assert.equal(record.state, "blocked");
      assert.equal(record.requiredInput, "none");
      assert.equal(JSON.stringify(record).includes("Private reviewer"), false);
      h.recovery.maintain(200);
      assert.equal(h.sent.length, 0);
      assert.equal(h.db.campaignProjection("root")!.recovery!.unattendedReady, false);
    } finally { h.db.close(); }
  }
});

test("recovery cannot stage or deliver a continuation under stale authority even with no human request", () => {
  const h = fixture();
  try {
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.updateSessionStatus("child", "failed", 5);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", subjectSessionId: "unaffected",
      eventId: "unrelated-ready", kind: "child_ready", now: 6 });
    h.db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=parent_control_policy_revision+1 WHERE id='root'").run();
    h.svc.retryDuePrompts(10000);
    assert.equal(h.db.latestCampaignContinuation("root"), null, "stale authority fences the scheduler itself");
    assert.equal(h.sent.length, 0, "there is no human-wait status to incidentally hold this turn");
  } finally { h.db.close(); }
});

test("recovery preserves budget exhaustion and allocation ceilings before staging a provider effect", () => {
  for (const failure of ["exhausted", "allocation", "accounting_unavailable"] as const) {
    const h = fixture(recoveryBudget);
    try {
      h.sent.length = 0;
      h.db.updateSessionStatus("root", "idle", 4);
      h.db.updateSessionStatus("child", "failed", 5);
      h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 6 });
      if (failure === "allocation") {
        const limit = h.db.campaignBudgets.allocation("root")!.toolCalls!;
        h.db.raw().prepare("UPDATE campaign_budget_members SET tools=? WHERE session_id='root'").run(limit);
      } else h.db.campaignBudgets.stop("root", failure, "Fixture admission stop");
      const before = h.db.campaignBudgets.dispatchState("root");
      h.svc.retryDuePrompts(10000);
      assert.equal(h.db.latestCampaignContinuation("root"), null, failure);
      assert.equal(h.sent.some(m => (m as {type:string}).type === "durable_session_command"), false, failure);
      assert.deepEqual(h.db.campaignBudgets.dispatchState("root"), before, "recovery cannot refund or replace a reservation");
      assert.equal(h.db.campaignProjection("root")!.recovery!.unattendedReady, false, failure);
      assert.equal(h.db.campaignRecovery.projection("root").records[0]!.attempts, 0, "blocked admission spends no recovery wake");
    } finally { h.db.close(); }
  }
});

test("a continuation staged before budget loss is fenced again at delivery", () => {
  const h = fixture(recoveryBudget);
  try {
    h.sent.length = 0;
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 5 });
    h.hub.isRunnerOnline = () => false;
    h.svc.retryDuePrompts(10000);
    const staged = h.db.latestCampaignContinuation("root")!;
    assert.ok(staged);
    h.db.campaignBudgets.stop("root", "accounting_unavailable", "Unknown final usage fixture");
    h.hub.isRunnerOnline = () => true;
    h.svc.retryDuePrompts(20000);
    assert.equal(h.sent.some(m => (m as {type:string}).type === "durable_session_command"), false);
    assert.equal(h.db.getSessionPromptCommand(staged.commandId)!.state, "pending", "known non-delivery is retained");
  } finally { h.db.close(); }
});

test("automatic recovery respects existing session checkpoints and organization daily limits", () => {
  for (const guard of ["session", "checkpoint", "daily"] as const) {
    const h = fixture();
    try {
      h.db.updateSessionStatus("root", "idle", 4);
      h.db.appendEvent("root", { kind: "token_usage", inputTokens: 1, costUsd: 2 }, Date.now(), { accrueUsage: true });
      if (guard === "session") h.db.updateSessionCostBudget("root", 1, 5);
      if (guard === "checkpoint") h.db.updateSessionCostCheckpoints("root", [1], 5);
      if (guard === "daily") h.db.setUsageDailyBudget(h.identity.organizationId, 1, 5);
      h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 6 });
      h.svc.retryDuePrompts(10000);
      assert.equal(h.sent.length, 0, guard);
      assert.equal(h.db.latestCampaignContinuation("root"), null, guard);
      assert.equal(h.db.getSession("root")!.pendingApproval, null, "recovery cannot create an override prompt");
      assert.equal(h.db.campaignProjection("root")!.recovery!.automation!.state, "budget_held", guard);
    } finally { h.db.close(); }
  }
});

test("fresh Full Control grants cannot rebind an old queued continuation", () => {
  const h = fixture();
  try {
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 5 });
    h.hub.isRunnerOnline = () => false;
    h.svc.retryDuePrompts(10000);
    const staged = h.db.latestCampaignContinuation("root")!;
    assert.ok(staged);
    const payload = h.db.getSessionPromptCommand(staged.commandId)!.payloadJson;
    const principal = { ...h.identity, kind: "human" as const, actorId: h.identity.userId };
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2, principal).ok);
    assert.ok(h.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2938",
      operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 3, principal).ok);
    h.hub.isRunnerOnline = () => true;
    h.svc.retryDuePrompts(20000);
    assert.equal(h.sent.some(m => (m as {type:string}).type === "durable_session_command"), false);
    assert.equal(h.db.campaignProjection("root")!.recovery!.automation!.state, "authority_unavailable");
    assert.equal(h.db.getSessionPromptCommand(staged.commandId)!.payloadJson, payload);
    assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, staged.continuationId);
  } finally { h.db.close(); }
});

test("Full Control cannot deliver a legacy queued continuation without its authority binding", () => {
  const h = fixture();
  try {
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 5 });
    h.hub.isRunnerOnline = () => false;
    h.svc.retryDuePrompts(10000);
    const staged = h.db.latestCampaignContinuation("root")!;
    const command = h.db.getSessionPromptCommand(staged.commandId)!;
    const payload = JSON.parse(command.payloadJson);
    delete payload.campaignContinuation.authorityDigest;
    h.db.raw().prepare("UPDATE session_prompt_commands SET payload_json=?,payload_sha256=? WHERE command_id=?")
      .run(canonicalAutomationCommandJson(payload), automationCommandDigest(payload), staged.commandId);
    h.hub.isRunnerOnline = () => true;
    h.svc.retryDuePrompts(20000);
    assert.equal(h.sent.length, 0);
    assert.equal(h.db.campaignProjection("root")!.recovery!.unattendedReady, false);
  } finally { h.db.close(); }
});

test("human exceptions retain exact resource, owner and smallest input without duplicate requests or content leakage", () => {
  const h = fixture();
  try {
    const secret = "https://private.example/token?bearer=secret";
    const pending: PendingApproval = { requestId: "auth", occurrenceId: secret, title: "Sign In", kind: "authentication", options: [] };
    h.db.setPendingApproval("child", pending);
    h.db.updateSessionStatus("child", "input_required", 3);
    h.recovery.maintain(100);
    const before = h.db.campaignProjection("root")!.recovery!;
    assert.equal(before.waitingHuman, 1); assert.equal(before.unattendedReady, false);
    const record = before.records[0]!;
    assert.equal(record.resource.occurrenceId, recoveryCoordinate(secret));
    assert.equal(record.reason, "missing_access");
    assert.equal(record.requiredInput, "restore_existing_access");
    assert.equal(record.effectiveOwner, "human");
    assert.equal(JSON.stringify(before).includes("private.example"), false);
    assert.equal(h.db.getSession("child")!.pendingApproval!.campaignRecovery?.id, record.id);
    const requests = h.svc.descendantRequests("root", () => true, "human").data!.requests;
    assert.equal(requests.length, 1); assert.equal(requests[0]!.request.campaignRecovery!.id, record.id);
    h.recovery.maintain(200); h.recovery.maintain(300);
    assert.deepEqual(h.db.campaignProjection("root")!.recovery, before);
    assert.equal(h.sent.length, 0);
    h.db.setPendingApproval("child", null);
    h.db.updateSessionStatus("child", "idle", 400);
    h.recovery.maintain(400);
    assert.equal(h.db.campaignProjection("root")!.recovery!.waitingHuman, 0);
  } finally { h.db.close(); }
});

test("an idle Full Control parent continues unrelated work while a child waits for a human", () => {
  const h = fixture();
  try {
    h.db.setPendingApproval("child", { requestId: "auth", occurrenceId: "auth-occ", title: "Sign In", kind: "authentication", options: [] });
    h.db.updateSessionStatus("child", "input_required", 3);
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", subjectSessionId: "unaffected",
      eventId: "unaffected-ready", kind: "child_ready", now: 5 });
    h.svc.retryDuePrompts(10_000);
    const continuation = h.db.latestCampaignContinuation("root");
    assert.ok(continuation, "human-owned child does not starve unrelated work");
    const command = h.db.getSessionPromptCommand(continuation.commandId)!;
    assert.ok(h.sent.some(message => (message as { type: string }).type === "durable_session_command"),
      "continuation reaches the runner rather than remaining held in the outbox");
    assert.match(command.payloadJson, /Reconcile unknown outcomes/);
    assert.match(command.payloadJson, /Hard denials and exhausted ceilings remain blocked/);
    h.svc.retryDuePrompts(20_000);
    assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, continuation.continuationId);
    assert.equal(h.db.getSession("child")!.pendingApproval!.kind, "authentication");
  } finally { h.db.close(); }
});

test("stop, archive and authority revocation fence old recovery work", () => {
  for (const end of ["stop", "archive", "revoke"] as const) {
    const h = fixture();
    try {
      h.db.updateSessionStatus("child", "failed", 3);
      h.recovery.maintain(100);
      assert.equal(h.db.campaignProjection("root")!.recovery!.automatic, 1);
      if (end === "stop") h.svc.stop("root");
      if (end === "archive") h.db.setSessionArchived("root", true, 4);
      if (end === "revoke") h.db.updateSessionCampaignControl("root", { mode: "custom" }, 2, 4);
      h.recovery.maintain(2000);
      assert.equal(h.db.campaignRecovery.projection("root").automatic, 0);
      assert.equal(h.db.hasPendingCampaignContinuationEvents("root"), false);
    } finally { h.db.close(); }
  }
});

test("hard denied typed occurrences stay blocked without asking for an override", () => {
  const h = fixture();
  try {
    const created = h.svc.createWorkflowDecision("child", { requestId: "choice", resourceKey: "choice",
      resourceSnapshot: { category: "implementation_question", question: "Which test fixture should we implement?",
        options: [{ optionId: "a", label: "Fixture A" }, { optionId: "b", label: "Fixture B" }] } });
    assert.ok(created.ok, created.error ?? "decision creation failed");
    const decision = created.data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", decision.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "deny" }, () => true).ok);
    h.recovery.maintain(100);
    const records = h.db.campaignProjection("root")!.recovery!.records;
    assert.equal(records.find(record => record.reason === "hard_denial")!.requiredInput, "none");
    h.recovery.maintain(10000);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "denied");
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 1);
  } finally { h.db.close(); }
});

test("a settled denial retires when its child report is verified and archived", () => {
  const h = fixture();
  try {
    const decision = h.svc.createWorkflowDecision("child", { requestId: "denied-choice", resourceKey: "choice",
      resourceSnapshot: { category: "implementation_question", question: "Which approach should we use?",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } }).data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", decision.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "deny" }, () => true).ok);
    h.recovery.maintain(100);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 1, "live hard denial stays blocked");
    h.db.updateSessionStatus("child", "completed", 110);
    h.recovery.maintain(111);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 1, "status alone does not establish completed delivery");
    h.db.setSessionArchived("child", true, 112);
    h.recovery.maintain(113);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 1, "unverified archive is still incomplete");
    h.db.setSessionArchived("child", false, 114);
    h.db.updateSessionStatus("child", "idle", 200);
    const report = h.db.appendEvent("child", { kind: "agent_message", text: "Completed using another approach.", final: true }, 201);
    h.db.verifyCampaignChildReport("root", "child", report.seq, 202);
    assert.equal(h.db.campaignChildReportVerified("root", "child"), true);
    h.recovery.maintain(203);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 0, "verified report makes the denied operation historical");
    h.db.setSessionArchived("child", true, 204);
    h.recovery.maintain(205);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 0);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "denied", "original denial is never reopened");
    h.db.setSessionArchived("child", false, 206);
    h.db.appendEvent("child", { kind: "user_message", text: "Implement the next authorized work item." }, 207);
    h.db.updateSessionStatus("child", "running", 208);
    assert.equal(h.db.campaignChildReportVerified("root", "child"), false, "new work needs its own verification");
    h.recovery.maintain(209);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 0, "historical denial does not reappear for new work");
    const next = h.svc.createWorkflowDecision("child", { requestId: "next-choice", resourceKey: "choice",
      resourceSnapshot: { category: "implementation_question", question: "Which new approach should we use?",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } }).data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", next.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "deny" }, () => true).ok);
    h.recovery.maintain(210);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 1, "historical proof does not clear the new denial");
  } finally { h.db.close(); }
});

test("a report verified before a fresh denial cannot settle that new occurrence", () => {
  const h = fixture();
  try {
    h.db.updateSessionStatus("child", "idle", 10);
    const report = h.db.appendEvent("child", { kind: "agent_message", text: "Earlier work completed.", final: true }, 11);
    h.db.verifyCampaignChildReport("root", "child", report.seq, 12);
    const decision = h.svc.createWorkflowDecision("child", { requestId: "fresh-denial", resourceKey: "new-choice",
      resourceSnapshot: { category: "implementation_question", question: "May I use this new approach?",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } }).data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", decision.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "deny" }, () => true).ok);
    h.db.updateSessionStatus("child", "idle", 20);
    assert.equal(h.db.campaignChildReportVerified("root", "child"), false, "new decision invalidates the prior report proof");
    h.recovery.maintain(30);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 1, "older accounting proof grants no settlement for a new denial");
  } finally { h.db.close(); }
});

test("human-wait continuation projection uses the same current authority admission as delivery", () => {
  for (const failure of ["stale_boundary", "unsupported_runner"] as const) {
    const h = fixture();
    try {
      h.db.setPendingApproval("child", { requestId: "auth", occurrenceId: "auth-occ", title: "Sign In", kind: "authentication", options: [] });
      h.db.updateSessionStatus("child", "input_required", 3);
      h.db.updateSessionStatus("root", "idle", 4);
      h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", subjectSessionId: "unaffected",
        eventId: "unaffected-ready", kind: "child_ready", now: 5 });
      if (failure === "stale_boundary") h.db.raw().prepare(
        "UPDATE sessions SET parent_control_policy_revision=parent_control_policy_revision+1 WHERE id='root'").run();
      else h.db.registerRunner(h.metadata, 10, 214);
      assert.equal(h.db.campaignMayContinueWhileHumanWaiting("root"), false);
      assert.equal(h.db.campaignProjection("root")!.continuation!.state, "held", failure);
      h.svc.retryDuePrompts(10000);
      assert.equal(h.sent.some(message => (message as { type: string }).type === "durable_session_command"), false);
    } finally { h.db.close(); }
  }
});

test("routine forge staleness leaves refresh to the background reader without spending recovery attempts", () => {
  const h = fixture();
  try {
    const planned = h.db.campaignWorkLedger.recordPlan("root", "root", { items: [{ key: "original:2938" }], planComplete: true }, 10);
    assert.ok(planned.ok);
    assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: planned.data.items[0]!.workItemId,
      stage: { stage: "awaiting_checks", pullRequests: [{ repository: "picoduck/wollipog", number: 42 }] } }, 20).ok);
    h.db.updateSessionStatus("root", "idle", 21);
    const passing = { state: "passing" as const, failing: 0, passing: 1, pending: 0 };
    for (let episode = 0; episode < 5; episode++) {
      const now = 100 + episode * 1000000;
      h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 42 },
        observation: { state: "open", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
          checks: passing, requiredChecks: passing, mergeQueue: null, mergeCommitSha: null } }], now);
      h.recovery.maintain(now);
      h.recovery.maintain(now + 700000);
      h.recovery.maintain(now + 730000);
      assert.equal(h.db.campaignProjection("root")!.recovery!.records.length, 0, "a stale read is not an uncertain external effect");
      assert.equal(h.db.hasPendingCampaignContinuationEvents("root"), false, "background refresh needs no parent turn");
    }
  } finally { h.db.close(); }
});

test("uncertain steering keeps its original occurrence and requests reconciliation, never prompt replay", () => {
  const h = fixture();
  try {
    h.logs.length = 0; // Exclude the fixture service's initial grant, then observe this recovery sweep.
    h.db.createSteeringAttempt({ requestId: "steer-1", sessionId: "child", submissionId: "original-submission",
      turnId: "original-turn", source: "direct", requestSha256: "a".repeat(64), text: "private prompt", now: 10 });
    h.db.markSteeringAttemptUncertain("steer-1", 20);
    h.db.updateSessionStatus("root", "idle", 21);
    h.recovery.maintain(100);
    const record = h.db.campaignProjection("root")!.recovery!.records.find(item => item.resource.kind === "steering")!;
    assert.equal(record.action, "reconcile_outcome");
    assert.equal(record.resource.occurrenceId, recoveryCoordinate("original-submission"));
    assert.equal(record.state, "dispatched");
    assert.equal(h.db.listSteeringAttempts("child")[0]!.state, "uncertain");
    assert.equal(h.sent.length, 0, "recovery event does not resend a prompt");
    h.recovery.maintain(200);
    assert.equal(h.db.campaignProjection("root")!.recovery!.records[0]!.attempts, 1);
    h.db.setSessionArchived("child", true, 201);
    h.recovery.maintain(202);
    assert.equal(h.db.campaignProjection("root")!.recovery!.records.find(item => item.resource.kind === "steering")!.reason,
      "uncertain_outcome", "archival does not reconcile an external prompt outcome");
    const admissionLogs = h.logs.filter(message => JSON.parse(message).event === "campaign_recovery_admission");
    assert.equal(admissionLogs.length, 1, "unchanged admission emits no repeated sweep log");
    assert.ok(h.logs.every(message => !message.includes("private prompt")));
  } finally { h.db.close(); }
});

test("an input-required parent never dispatches held work or changes fixed execution preferences", () => {
  const h = fixture();
  try {
    h.db.updateSessionStatus("root", "input_required", 10);
    h.db.updateSessionStatus("child", "failed", 10);
    const before = h.db.getSession("root")!.orchestratorPolicy!.behavior;
    h.recovery.maintain(20); h.recovery.maintain(5000);
    assert.equal(h.db.hasPendingCampaignContinuationEvents("root"), false);
    assert.equal(h.db.campaignProjection("root")!.recovery!.records[0]!.attempts, 0);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.behavior, before);
    assert.equal(h.db.getSession("root")!.status, "input_required");
  } finally { h.db.close(); }
});

test("missing recovery capability explicitly prevents unattended readiness and admission", () => {
  const h = fixture();
  try {
    h.db.registerRunner(h.metadata, 10, 214);
    h.db.updateSessionStatus("root", "idle", 11);
    h.db.updateSessionStatus("child", "failed", 11);
    h.recovery.maintain(20); h.recovery.maintain(5000);
    const recovery = h.db.campaignProjection("root")!.recovery!;
    assert.equal(recovery.unattendedReady, false);
    assert.equal(recovery.automation!.state, "unsupported_capability");
    assert.equal(recovery.records[0]!.attempts, 0);
    assert.equal(h.db.hasPendingCampaignContinuationEvents("root"), false);
  } finally { h.db.close(); }
});

test("derived recovery metadata is stripped from stored and runner-originated requests", () => {
  const h = fixture();
  try {
    const request: PendingApproval = { requestId: "auth", occurrenceId: "auth-occ", title: "Sign In", kind: "authentication", options: [] };
    h.db.setPendingApproval("child", request);
    h.recovery.maintain(10);
    const decorated = h.db.getSession("child")!.pendingApproval!;
    assert.ok(decorated.campaignRecovery);
    h.db.setPendingApproval("child", { ...decorated, additionalRequests: [{ ...decorated, requestId: "other", occurrenceId: "other-occ" }] });
    const raw = h.db.raw().prepare("SELECT pending_approval FROM sessions WHERE id='child'").get() as { pending_approval: string };
    assert.equal(raw.pending_approval.includes('"campaignRecovery"'), false, "derived metadata is not persisted, including sibling requests");
    h.db.raw().prepare("UPDATE sessions SET pending_approval=? WHERE id='child'").run(JSON.stringify(decorated));
    h.db.updateSessionCampaignControl("root", { mode: "custom" }, 2, 20);
    h.recovery.maintain(30);
    assert.equal(h.db.getSession("child")!.pendingApproval!.campaignRecovery, undefined, "legacy stored metadata cannot survive the live mapper");
  } finally { h.db.close(); }
});

test("same-millisecond replacement decisions supersede stale denied recovery", () => {
  const h = fixture();
  try {
    const snapshot = { category: "implementation_question" as const, question: "Which test fixture should we implement?",
      options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] };
    const first = h.svc.createWorkflowDecision("child", { requestId: "old", resourceKey: "same", resourceSnapshot: snapshot }).data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", first.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "deny" }, () => true).ok);
    const second = h.svc.createWorkflowDecision("child", { requestId: "new", resourceKey: "same", resourceSnapshot: snapshot }).data!;
    assert.ok(second);
    h.db.raw().prepare("UPDATE workflow_decisions SET created_at=100 WHERE occurrence_id IN (?,?)")
      .run(first.occurrenceId, second.occurrenceId);
    assert.equal(h.db.campaignRecoverySettledDecisions("root").length, 0);
    h.recovery.maintain(1000);
    assert.equal(h.db.campaignProjection("root")!.recovery!.blocked, 0);
  } finally { h.db.close(); }
});

test("fresh check/review failures route to repair; stale facts cannot resolve their exceptions", () => {
  const h = fixture();
  try {
    const planned = h.db.campaignWorkLedger.recordPlan("root", "root", { items: [{ key: "original:2938" }], planComplete: true }, 10);
    assert.ok(planned.ok);
    const itemId = planned.data.items[0]!.workItemId;
    assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: itemId,
      stage: { stage: "awaiting_checks", pullRequests: [{ repository: "picoduck/wollipog", number: 42 }] } }, 20).ok);
    const rollup = (state: "failing" | "passing") => ({ state, failing: state === "failing" ? 1 : 0,
      passing: state === "passing" ? 1 : 0, pending: 0 });
    const observation = { state: "open" as const, draft: false, headSha: "a".repeat(40), baseRef: "main",
      reviewDecision: "changes_requested" as const, checks: rollup("failing"), requiredChecks: rollup("failing"),
      mergeQueue: null, mergeCommitSha: null };
    h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 42 }, observation }], 100);
    h.recovery.maintain(100);
    const first = h.db.campaignProjection("root")!.recovery!;
    assert.deepEqual(first.records.map(record => record.reason).sort(), ["failed_checks", "reviewer_objection"]);
    assert.equal(first.waitingHuman, 0);
    h.recovery.maintain(700_000);
    const stale = h.db.campaignProjection("root")!.recovery!;
    assert.ok(stale.records.some(record => record.reason === "failed_checks"));
    assert.ok(stale.records.some(record => record.reason === "reviewer_objection"));
    h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 42 },
      observation: { ...observation, reviewDecision: "approved", checks: rollup("passing"), requiredChecks: rollup("passing") } }], 700_001);
    h.recovery.maintain(700_001);
    assert.equal(h.db.campaignProjection("root")!.recovery!.records.length, 0);
  } finally { h.db.close(); }
});
