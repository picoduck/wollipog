import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type CampaignBudgetAuthority, type CampaignForgePullRequestObservation, type PendingApproval, type RunnerMetadata,
  type SessionSnapshot } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";
import { STALLED_RECOVERY_WAKE_MAX_MS, stalledRecoveryWakeDelayMs } from "./campaign-recovery-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableCommandStore, isDurableSessionCommandMessage } from "../../runner/src/durable-command-store.js";

function fixture(budgetAuthority?: CampaignBudgetAuthority, completion?: "retain" | "stop_and_archive") {
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
  if (completion) policy.behavior.completion = completion;
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
  const reserve = (requestId: string, extra: Partial<typeof request> = {}) => {
    const result = h.svc.requestCampaignReviewJob("root", { ...request, requestId, ...extra });
    assert.ok(result.ok, result.error ?? "native fixture reservation refused");
    return h.db.campaignReviewJobs.command(result.data!.jobId)!;
  };
  return { ...h, reserve };
}

test("CP continuations pass the real runner journal admission and deduplicate in both control modes", () => {
  for (const mode of ["full_control", "custom"] as const) {
    const h = fixture();
    const directory = mkdtempSync(join(tmpdir(), "recovery-runner-journal-"));
    try {
      if (mode === "custom") assert.ok(h.svc.setCampaignControl("root", { mode }, 2,
        { ...h.identity, kind: "human", actorId: h.identity.userId }).ok);
      h.sent.length = 0;
      h.db.updateSessionStatus("root", "idle", 4);
      h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 5 });
      h.svc.retryDuePrompts(10000);
      const message = h.sent.find(m => (m as {type:string}).type === "durable_session_command");
      assert.ok(isDurableSessionCommandMessage(message), "actual runner allowlist must admit the CP-produced envelope");
      const journal = new DurableCommandStore(directory, { ownerId: "fixture-runner", now: () => 10000 });
      assert.equal(journal.claim(message).kind, "new", "wire shape and payload digest pass the real journal");
      assert.equal(journal.claim({ ...message, requestId: "reconnect" }).kind, "duplicate", "reconnect cannot create another effect");
    } finally { h.db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a queued Custom continuation keeps existing liveness after a human execution-preference change", () => {
  const h = fixture();
  try {
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2,
      { ...h.identity, kind: "human", actorId: h.identity.userId }).ok);
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "ready", kind: "child_ready", now: 5 });
    h.hub.isRunnerOnline = () => false;
    h.svc.retryDuePrompts(10000);
    const staged = h.db.latestCampaignContinuation("root")!;
    assert.ok(staged);
    h.db.updateSessionConfig("root", { effort: "high" }, 11000); // Fixture equivalent of a permitted human edit.
    h.hub.isRunnerOnline = () => true;
    h.svc.retryDuePrompts(20000);
    assert.ok(h.sent.some(m => (m as {commandId?:string}).commandId === staged.commandId));
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.control?.mode, "custom");
    assert.equal(h.db.campaignProjection("root")!.recovery, undefined);
  } finally { h.db.close(); }
});

test("an older unknown native job survives a newer epoch and its late running receipt", () => {
  const h = nativeRecoveryFixture();
  try {
    const original = h.reserve("older");
    h.reserve("newer_base", { baseSha: "d".repeat(40) }); // Both were admitted before usage became unknown.
    h.svc.onCampaignReviewJobUpdate("r", { type: "campaign_review_job_update", jobId: original.jobId,
      nonce: original.nonce, state: "accounting_unavailable", toolCalls: 1 });
    h.db.updateSessionStatus("root", "idle", 99); // A reconnect status is not an accounting settlement.
    h.recovery.maintain(100);
    const before = h.db.campaignRecovery.projection("root").records.find(r => r.resource.occurrenceId === original.jobId)!;
    assert.equal(before.reason, "uncertain_outcome");
    h.svc.onCampaignReviewJobUpdate("r", { type: "campaign_review_job_update", jobId: original.jobId,
      nonce: original.nonce, state: "running", costUsd: 1, toolCalls: 2 });
    h.recovery.maintain(200);
    const after = h.db.campaignRecovery.projection("root").records.find(r => r.resource.occurrenceId === original.jobId);
    assert.ok(after, "a newer base and a progress receipt cannot reconcile the older job's final outcome");
    assert.equal(after.reason, "uncertain_outcome");
    assert.equal(h.db.campaignBudgets.active(original.jobId), true);
    assert.equal(h.db.campaignBudgets.view("root")!.state, "accounting_unavailable");
    assert.equal(h.svc.campaignReviewJob("root", original.jobId).data!.costUsd, 1);
  } finally { h.db.close(); }
});

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
    h.db.raw().prepare("UPDATE orchestrator_campaign_continuations SET authority_digest=NULL WHERE command_id=?")
      .run(staged.commandId);
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

/** A child's runner snapshot, as the runner reports it, carrying or clearing a hold. */
function childSnapshot(extra: Partial<SessionSnapshot>): SessionSnapshot {
  return { id: "child", workspaceId: "w", agentId: "agent", status: "input_required", title: "child", driver: "codex-app-server",
    config: { model: "gpt-6.1-sol" }, costUsd: 0, tokensIn: 0, tokensOut: 0, useWorktree: true,
    worktreePath: "/repos/test/.agent-worktrees/child", preview: null, pendingApproval: null, seq: 0, historyEpoch: 0,
    createdAt: 1, updatedAt: 3, ...extra };
}

test("a held child is recovered through the real recovery wake, and clearing the hold resolves it (#2938 AC2)", () => {
  const h = fixture();
  try {
    const detail = "PRIVATE-HOLD-DETAIL the selected worktree could not be verified";
    h.svc.applySessionRuntimeUpdate("r", childSnapshot({ worktreeRecovery: { recoveryId: "worktree-recovery:child",
      detectedAt: 2, selectedPath: "/repos/test/.agent-worktrees/child", expectedBranch: "agent/child", detail } }));
    assert.ok(h.db.getSession("child")!.holds?.length, "the runner-reported hold is current");
    h.db.updateSessionStatus("root", "idle", 4);
    const now = Date.now();
    h.recovery.maintain(now);
    const held = h.db.campaignRecovery.projection("root").records.find(record => record.action === "recover_hold")!;
    assert.deepEqual([held.resource.kind, held.resource.sessionId, held.effectiveOwner, held.reason, held.requiredInput],
      ["hold", "child", "orchestrator", "transient_failure", "none"]);
    assert.equal(held.resource.occurrenceId, recoveryCoordinate(h.db.getSession("child")!.holds![0]!.holdId),
      "the hold is identified by digest, never by its runner text");
    h.recovery.maintain(now + 1_000); // Transient holds retain their bounded backoff before the wake.
    const woken = h.db.campaignRecovery.projection("root").records.find(record => record.id === held.id)!;
    assert.deepEqual([woken.state, woken.attempts], ["dispatched", 1]);
    h.svc.retryDuePrompts(now + 32_000);
    const continuation = h.db.latestCampaignContinuation("root")!;
    assert.ok(continuation, "the wake reaches the parent's single continuation lane");
    const text = JSON.parse(h.db.getSessionPromptCommand(continuation.commandId)!.payloadJson).text as string;
    assert.match(text, /Action needed: yes/u);
    assert.match(text, /"action":"recover_hold"/u);
    assert.ok(text.includes(held.id));
    assert.equal(text.includes("PRIVATE-HOLD-DETAIL") || text.includes(".agent-worktrees"), false,
      "the wake names the hold's record, not the runner's detail or paths");
    h.svc.retryDuePrompts(now + 33_000);
    assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, continuation.continuationId, "no duplicate turn");
    // The runner reports the hold cleared: the recovery is resolved, not left as automatic work.
    h.svc.applySessionRuntimeUpdate("r", childSnapshot({ status: "idle", worktreeRecovery: null, updatedAt: 5 }));
    assert.equal(h.db.getSession("child")!.holds?.length ?? 0, 0);
    h.recovery.maintain(now + 34_000);
    assert.equal(h.db.campaignRecovery.activeRecords("root").some(record => record.id === held.id), false);
    assert.equal((JSON.parse((h.db.raw().prepare("SELECT record_json FROM campaign_recovery WHERE id=?").get(held.id) as
      { record_json: string }).record_json) as { state: string }).state, "resolved");
  } finally { h.db.close(); }
});

test("a provider account switch hold waits for the Human and never wakes the parent (#2938 AC2)", () => {
  const h = fixture();
  try {
    h.svc.applySessionRuntimeUpdate("r", childSnapshot({ status: "queued", queueHold: { kind: "provider_account_switch",
      holdId: "account-switch:child", since: 2, target: "Fixture Account", queuedPrompts: 1, unfinishedBackgroundJobs: 1 } }));
    assert.ok(h.db.getSession("child")!.holds?.some(hold => hold.kind === "provider_account_switch"));
    h.db.updateSessionStatus("root", "idle", 4);
    const now = Date.now();
    for (const at of [now, now + 1_000, now + 31_000]) h.recovery.maintain(at);
    const record = h.db.campaignRecovery.projection("root").records.find(item => item.action === "recover_hold")!;
    assert.deepEqual([record.effectiveOwner, record.reason, record.state, record.requiredInput, record.attempts],
      ["human", "missing_access", "waiting_human", "restore_existing_access", 0]);
    assert.equal(JSON.stringify(record).includes("Fixture Account"), false);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE occurrence_id=?").get(record.id)!.n, 0,
      "a human-owned hold reserves no parent wake");
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

function completedPrFixture() {
  const h = fixture(), now = Date.now();
  const plan = h.db.campaignWorkLedger.recordPlan("root", "root", { items: [{ key: "original:2938",
    issue: { repository: "picoduck/wollipog", number: 2938 } }], planComplete: true }, now);
  assert.ok(plan.ok);
  const itemId = plan.data.items[0]!.workItemId, ref = { repository: "picoduck/wollipog", number: 42 };
  assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: itemId,
    stage: { stage: "awaiting_checks", pullRequests: [ref] } }, now).ok);
  const checks = { state: "failing" as const, failing: 1, passing: 0, pending: 0 };
  const observation: CampaignForgePullRequestObservation = { state: "open", draft: false, headSha: "a".repeat(40),
    baseRef: "main", reviewDecision: "approved", checks, requiredChecks: checks, mergeQueue: null, mergeCommitSha: null };
  h.db.campaignForgeObservations.record("root", "r", [{ ref, observation }], now);
  for (const child of ["child", "unaffected"]) {
    h.db.updateSessionStatus(child, "idle", now);
    const report = h.db.appendEvent(child, { kind: "agent_message", text: "Component fixture completed.", final: true }, now);
    h.db.verifyCampaignChildReport("root", child, report.seq, now);
    h.db.setSessionArchived(child, true, now);
  }
  h.db.updateSessionStatus("root", "idle", now);
  return { ...h, now, itemId, ref, observation };
}

for (const kind of ["checks", "forge_review", "steering", "native_objection", "native_invalid"] as const) {
  test(`recovery-only ${kind} wake delivers an actionable parent prompt`, () => {
    const h = kind.startsWith("native") ? nativeRecoveryFixture() : fixture();
    const now = Date.now();
    try {
      if (kind.startsWith("native")) {
        const command = (h as ReturnType<typeof nativeRecoveryFixture>).reserve(kind);
        h.svc.onCampaignReviewJobUpdate("r", { type: "campaign_review_job_update", jobId: command.jobId,
          nonce: command.nonce, state: "completed", costUsd: 1, toolCalls: 2,
          attemptValid: kind === "native_objection", attemptConsumed: true,
          ...(kind === "native_objection" ? { vote: "DOWNVOTE" as const } : {}), receiptSha256: "c".repeat(64) });
      } else if (kind === "steering") {
        h.db.createSteeringAttempt({ requestId: "lost-steering", sessionId: "child", submissionId: "original-submission",
          turnId: "original-turn", source: "direct", requestSha256: "a".repeat(64), text: "private prompt", now });
        h.db.markSteeringAttemptUncertain("lost-steering", now);
      } else {
        const plan = h.db.campaignWorkLedger.recordPlan("root", "root", { items: [{ key: "original:2938" }], planComplete: true }, now);
        assert.ok(plan.ok);
        assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: plan.data.items[0]!.workItemId,
          stage: { stage: "awaiting_checks", pullRequests: [{ repository: "picoduck/wollipog", number: 42 }] } }, now).ok);
        const rollup = { state: kind === "checks" ? "failing" as const : "passing" as const,
          failing: kind === "checks" ? 1 : 0, passing: kind === "checks" ? 0 : 1, pending: 0 };
        h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 42 },
          observation: { state: "open", draft: false, headSha: "a".repeat(40), baseRef: "main",
            reviewDecision: kind === "forge_review" ? "changes_requested" : "approved", checks: rollup, requiredChecks: rollup,
            mergeQueue: null, mergeCommitSha: null } }], now);
      }
      h.db.updateSessionStatus("root", "idle", now);
      h.recovery.maintain(now);
      h.recovery.maintain(now + 1_000); // Invalid review attempts retain their bounded backoff.
      const record = h.db.campaignRecovery.projection("root").records[0]!;
      assert.equal(record.state, "dispatched", kind);
      h.svc.retryDuePrompts(now + 32_000);
      const continuation = h.db.latestCampaignContinuation("root");
      assert.ok(continuation, kind);
      const command = JSON.parse(h.db.getSessionPromptCommand(continuation.commandId)!.payloadJson);
      assert.match(command.text, /Action needed: yes/u, kind);
      assert.ok(command.text.includes(record.id), "prompt names the exact server-derived recovery record");
      assert.equal(command.text.includes("private prompt"), false);
      assert.equal(h.db.campaignRecovery.projection("root").records[0]!.attempts, 1);
      h.svc.retryDuePrompts(now + 33_000);
      assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, continuation.continuationId,
        "repeated recovery creates no duplicate parent turn");
    } finally { h.db.close(); }
  });
}

test("a repaired recovery-only wake is informational when its coalesced prompt is staged", () => {
  const h = fixture();
  const now = Date.now();
  try {
    const plan = h.db.campaignWorkLedger.recordPlan("root", "root", { items: [{ key: "original:2938" }], planComplete: true }, now);
    assert.ok(plan.ok);
    assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: plan.data.items[0]!.workItemId,
      stage: { stage: "awaiting_checks", pullRequests: [{ repository: "picoduck/wollipog", number: 42 }] } }, now).ok);
    const ref = { repository: "picoduck/wollipog", number: 42 };
    const checks = { state: "failing" as const, failing: 1, passing: 0, pending: 0 };
    const observation = { state: "open" as const, draft: false, headSha: "a".repeat(40), baseRef: "main",
      reviewDecision: "approved" as const, checks, requiredChecks: checks, mergeQueue: null, mergeCommitSha: null };
    h.db.campaignForgeObservations.record("root", "r", [{ ref, observation }], now);
    h.db.updateSessionStatus("root", "idle", now);
    h.recovery.maintain(now);
    const record = h.db.campaignRecovery.projection("root").records[0]!;
    assert.equal(record.state, "dispatched");
    const passing = { state: "passing" as const, failing: 0, passing: 1, pending: 0 };
    h.db.campaignForgeObservations.record("root", "r", [{ ref,
      observation: { ...observation, checks: passing, requiredChecks: passing } }], now + 1);
    h.svc.retryDuePrompts(now + 31_000);
    const continuation = h.db.latestCampaignContinuation("root")!;
    assert.ok(continuation);
    const command = JSON.parse(h.db.getSessionPromptCommand(continuation.commandId)!.payloadJson);
    assert.match(command.text, /Action needed: no/u, "settled work does not undo compact no-op turns");
    assert.equal(command.text.includes("Read get_campaign.recovery"), false, "settled-only turns do not require another sweep");
    assert.ok(command.text.includes(`"recoveryId":"${record.id}"`));
    assert.match(command.text, /"pending":false/u);
    assert.equal(h.db.campaignRecovery.projection("root").records.length, 0);
  } finally { h.db.close(); }
});

test("verified children with an unfinished original scoped PR admit exactly one real runner repair turn", () => {
  const h = fixture();
  const now = Date.now();
  try {
    const plan = h.db.campaignWorkLedger.recordPlan("root", "root", { items: [{ key: "original:2938",
      issue: { repository: "picoduck/wollipog", number: 2938 } }], planComplete: true }, now);
    assert.ok(plan.ok);
    assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: plan.data.items[0]!.workItemId,
      stage: { stage: "awaiting_checks", pullRequests: [{ repository: "picoduck/wollipog", number: 42 }] } }, now).ok);
    const checks = { state: "failing" as const, failing: 1, passing: 0, pending: 0 };
    h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 42 },
      observation: { state: "open", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
        checks, requiredChecks: checks, mergeQueue: null, mergeCommitSha: null } }], now);
    for (const child of ["child", "unaffected"]) {
      h.db.updateSessionStatus(child, "idle", now);
      const report = h.db.appendEvent(child, { kind: "agent_message", text: "Component fixture completed.", final: true }, now);
      h.db.verifyCampaignChildReport("root", child, report.seq, now);
      h.db.setSessionArchived(child, true, now);
    }
    h.db.updateSessionStatus("root", "idle", now);
    assert.equal(h.db.campaignProjection("root")!.status, "blocked", "child reports alone cannot finish an original open PR");
    h.recovery.maintain(now);
    h.svc.retryDuePrompts(now + 31_000);
    const continuation = h.db.latestCampaignContinuation("root")!;
    assert.ok(continuation);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "active");
    assert.equal(projection.children.verified, 2);
    const message = h.sent.find(m => (m as {type:string}).type === "durable_session_command");
    assert.ok(isDurableSessionCommandMessage(message));
    assert.equal(message.command.type, "prompt_session");
    if (message.command.type !== "prompt_session") assert.fail("repair must use the original parent continuation lane");
    assert.match(message.command.text, /Action needed: yes/u);
    assert.match(message.command.text, /"action":"repair_checks"/u);
    const directory = mkdtempSync(join(tmpdir(), "verified-repair-journal-"));
    try {
      const journal = new DurableCommandStore(directory, { ownerId: "fixture-runner", now: () => now + 31_000 });
      assert.equal(journal.claim(message).kind, "new");
      assert.equal(journal.claim({ ...message, requestId: "reconnect" }).kind, "duplicate");
    } finally { rmSync(directory, { recursive: true, force: true }); }
    h.svc.retryDuePrompts(now + 32_000);
    assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, continuation.continuationId);
    assert.equal(h.db.campaignRecovery.projection("root").records[0]!.attempts, 1);
    assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_result", requestId: message.requestId,
      commandId: message.commandId, sessionId: "root", state: "accepted", revision: 1, duplicate: false }));
    assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update",
      commandId: message.commandId, sessionId: "root", state: "completed", revision: 2 }));
    h.db.campaignForgeObservations.record("root", "r", [{ ref: { repository: "picoduck/wollipog", number: 42 },
      observation: { state: "merged", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
        checks: { state: "passing", failing: 0, passing: 1, pending: 0 },
        requiredChecks: { state: "passing", failing: 0, passing: 1, pending: 0 },
        mergeQueue: null, mergeCommitSha: "b".repeat(40) } }], now + 33_000);
    h.recovery.maintain(now + 33_000);
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete", "actual merged fact and existing verified cleanup finish the obligation");
    assert.equal(h.db.campaignRecovery.projection("root").records.length, 0);
  } finally { h.db.close(); }
});

// Real service verification and ledger records; synthetic forge facts only, never native delivery proof.
function mergedWorkVerificationFixture(outcome: "incomplete" | "delivered", completion: "retain" | "stop_and_archive" = "retain") {
  const h = fixture(undefined, completion), now = Date.now();
  const plan = h.svc.recordCampaignPlan("root", { planComplete: true,
    items: [{ key: "original:2938", issue: { repository: "picoduck/wollipog", number: 2938 } }] });
  assert.ok(plan.ok, plan.error ?? "plan refused");
  const workItemId = plan.data!.items[0]!.workItemId;
  assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId, childSessionId: "child" }).ok);
  const ref = { repository: "picoduck/wollipog", number: 3068 };
  assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId, stage: { stage: "merged", pullRequests: [ref] } }).ok);
  const checks = { state: "passing" as const, failing: 0, passing: 1, pending: 0 };
  const observation: CampaignForgePullRequestObservation = { state: "merged", draft: false,
    headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved", checks, requiredChecks: checks,
    mergeQueue: null, mergeCommitSha: "b".repeat(40) };
  h.db.campaignForgeObservations.record("root", "r", [{ ref, observation }], now);
  for (const id of ["child", "unaffected"]) {
    // Already-terminal fixture children let the real archive service settle without any live stop.
    h.db.updateSessionStatus(id, completion === "retain" ? "idle" : "completed", now);
    const report = h.db.appendEvent(id, { kind: "agent_message", final: true,
      text: "Source merged; the explicit work-item attestation determines delivery." }, now);
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: id, reportEventSeq: report.seq,
      followUpsAccounted: true, ...(id === "child" ? { workItem: { id: workItemId, outcome } } : {}) });
    assert.ok(verified.ok, verified.error ?? "verification refused");
  }
  h.db.updateSessionStatus("root", "idle", now);
  return { ...h, now, workItemId, ref, observation };
}

for (const completion of ["retain", "stop_and_archive"] as const) {
  test(`explicit incomplete original work stays held after source merge with ${completion}`, () => {
    const h = mergedWorkVerificationFixture("incomplete", completion);
    try {
      assert.equal(h.db.campaignProjection("root")!.children.verified, 2);
      if (completion === "stop_and_archive") {
        for (const id of ["child", "unaffected"]) {
          assert.equal(h.db.getSession(id)!.archived, true);
          assert.equal(h.db.campaignWorktreeCleanup(id).length, 0);
        }
      }
      assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "recovery_held");
      assert.equal(h.db.campaignProjection("root")!.status, "blocked");
      assert.equal(h.db.campaignContinuationAdmission("root").state, "lifecycle_held");
      assert.equal(h.db.campaignRecovery.activeRecords("root").length, 0, "incomplete is not authority to invent a repair");
    } finally { h.db.close(); }
  });

  test(`explicit delivered original work completes after source merge with ${completion}`, () => {
    const h = mergedWorkVerificationFixture("delivered", completion);
    try {
      assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "complete");
      assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");
    } finally { h.db.close(); }
  });
}

test("incomplete original work survives replacement and a new head until current-attempt delivery", () => {
  const h = mergedWorkVerificationFixture("incomplete");
  try {
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.workItemId, childSessionId: "unaffected" }).ok);
    h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
      observation: { ...h.observation, headSha: "c".repeat(40), mergeCommitSha: "d".repeat(40) } }], h.now);
    assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "recovery_held");
    const oldReport = h.db.durableFinalReportSeq("child")!;
    const staleDelivery = h.svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: oldReport,
      followUpsAccounted: true, workItem: { id: h.workItemId, outcome: "delivered" } });
    assert.equal(staleDelivery.ok, false, "the superseded worker cannot resolve incomplete work");
    assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "recovery_held");
    const report = h.db.appendEvent("unaffected", { kind: "agent_message", final: true, text: "Current attempt delivered." }, h.now);
    const delivered = h.svc.verifyCampaignChild("root", { childSessionId: "unaffected", reportEventSeq: report.seq,
      followUpsAccounted: true, workItem: { id: h.workItemId, outcome: "delivered" } });
    assert.ok(delivered.ok, delivered.error ?? "delivery refused");
    assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "complete");
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");
  } finally { h.db.close(); }
});

test("verification insertion chronology preserves incomplete work with equal timestamps and reversed UUID order", () => {
  const h = mergedWorkVerificationFixture("delivered");
  try {
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.workItemId, childSessionId: "unaffected" }).ok);
    const report = h.db.appendEvent("unaffected", { kind: "agent_message", final: true, text: "New attempt remains incomplete." }, h.now);
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: "unaffected", reportEventSeq: report.seq,
      followUpsAccounted: true, workItem: { id: h.workItemId, outcome: "incomplete" } });
    assert.ok(verified.ok, verified.error ?? "verification refused");
    // Only test-row identifiers/timestamps change; exact service-validated campaign/attempt/report bindings remain.
    h.db.raw().prepare("UPDATE campaign_work_verifications SET verified_at=?, id=CASE outcome WHEN 'delivered' THEN ? ELSE ? END WHERE work_item_id=?")
      .run(h.now, "cver_zzzz_older_delivered", "cver_aaaa_newer_incomplete", h.workItemId);
    assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "recovery_held");
    assert.equal(h.db.campaignProjection("root")!.status, "blocked");
  } finally { h.db.close(); }
});

test("explicit incomplete work still admits an independently eligible failed-check repair", () => {
  const h = mergedWorkVerificationFixture("incomplete");
  try {
    const checks = { state: "failing" as const, failing: 1, passing: 0, pending: 0 };
    h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
      observation: { ...h.observation, state: "open", mergeCommitSha: null, checks, requiredChecks: checks } }], h.now);
    h.recovery.maintain(h.now);
    const completion = h.db.campaignRecoveryCompletion("root", h.now);
    assert.equal(completion.state, "recovery_ready");
    assert.equal(completion.recoveryIds.length, 1);
    assert.equal(h.db.campaignRecovery.activeRecords("root").find(record => record.id === completion.recoveryIds[0])!.action, "repair_checks");
  } finally { h.db.close(); }
});

test("Custom completion retains its existing report-based compatibility with explicit incomplete work", () => {
  const h = mergedWorkVerificationFixture("incomplete");
  try {
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2,
      { ...h.identity, kind: "human", actorId: h.identity.userId }).ok);
    assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, "complete");
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");
  } finally { h.db.close(); }
});


for (const outcome of ["incomplete", "delivered"] as const) {
  test(`stale Full Control authority preserves explicit ${outcome} completion truth without repair`, () => {
    const h = mergedWorkVerificationFixture(outcome);
    try {
      const policy = h.db.parentControlPolicy("root")!;
      assert.ok(h.db.updateSessionParentControlPolicy("root", { ...policy.decisions }, h.now + 1, policy.revision));
      assert.equal(h.db.getSession("root")!.orchestratorPolicy!.control!.mode, "full_control");
      assert.equal(h.db.campaignContinuationAdmission("root").state, "authority_unavailable");
      assert.equal(h.db.campaignRecoveryCompletion("root", h.now).state, outcome === "incomplete" ? "recovery_held" : "complete");
      assert.equal(h.db.campaignProjection("root")!.status, outcome === "incomplete" ? "blocked" : "verified_complete");
      const checks = { state: "failing" as const, failing: 1, passing: 0, pending: 0 };
      h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
        observation: { ...h.observation, state: "open", mergeCommitSha: null, checks, requiredChecks: checks } }], h.now);
      h.sent.length = 0;
      h.recovery.maintain(h.now);
      h.svc.retryDuePrompts(h.now + 31_000);
      assert.deepEqual(h.db.campaignRecoveryCompletion("root", h.now).recoveryIds, []);
      assert.equal(h.db.latestCampaignContinuation("root"), null);
      assert.equal(h.sent.some(message => (message as { type: string }).type === "durable_session_command"), false);
    } finally { h.db.close(); }
  });
}

test("stale-boundary report-only legacy and intentional Custom completion retain compatibility", () => {
  const legacy = completedPrFixture();
  const explicit = mergedWorkVerificationFixture("incomplete");
  try {
    const passing = { state: "passing" as const, failing: 0, passing: 1, pending: 0 };
    legacy.db.campaignForgeObservations.record("root", "r", [{ ref: legacy.ref,
      observation: { ...legacy.observation, state: "merged", mergeCommitSha: "b".repeat(40),
        checks: passing, requiredChecks: passing } }], legacy.now);
    const policy = legacy.db.parentControlPolicy("root")!;
    assert.ok(legacy.db.updateSessionParentControlPolicy("root", { ...policy.decisions }, legacy.now + 1, policy.revision));
    assert.equal(legacy.db.campaignContinuationAdmission("root").state, "authority_unavailable");
    assert.equal(legacy.db.campaignRecoveryCompletion("root", legacy.now).state, "complete");
    assert.equal(legacy.db.campaignProjection("root")!.status, "verified_complete");
    const previous = explicit.db.parentControlPolicy("root")!;
    const updated = explicit.db.updateSessionParentControlPolicy("root", { ...previous.decisions }, explicit.now + 1, previous.revision);
    assert.ok(updated);
    assert.ok(explicit.svc.setCampaignControl("root", { mode: "custom" }, updated.revision,
      { ...explicit.identity, kind: "human", actorId: explicit.identity.userId }).ok);
    assert.equal(explicit.db.campaignRecoveryCompletion("root", explicit.now).state, "complete");
    assert.equal(explicit.db.campaignProjection("root")!.status, "verified_complete");
  } finally { legacy.db.close(); explicit.db.close(); }
});

test("an original unknown outcome cannot reopen a child-verified campaign or spend a recovery turn", () => {
  const h = completedPrFixture();
  try {
    const passing = { state: "passing" as const, failing: 0, passing: 1, pending: 0 };
    h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
      observation: { ...h.observation, checks: passing, requiredChecks: passing } }], h.now);
    h.db.createSteeringAttempt({ requestId: "lost-original", sessionId: "child", submissionId: "original-submission",
      turnId: "original-turn", source: "direct", requestSha256: "a".repeat(64), text: "private prompt", now: h.now });
    h.db.markSteeringAttemptUncertain("lost-original", h.now);
    h.svc.retryDuePrompts(h.now + 31_000);
    const record = h.db.campaignRecovery.projection("root").records.find(r => r.resource.kind === "steering")!;
    assert.equal(record.reason, "uncertain_outcome");
    assert.equal(record.attempts, 0);
    assert.equal(record.resource.occurrenceId, recoveryCoordinate("original-submission"));
    assert.equal(h.db.listSteeringAttempts("child")[0]!.state, "uncertain");
    assert.equal(h.db.latestCampaignContinuation("root"), null);
    assert.equal(h.db.campaignProjection("root")!.status, "blocked");
  } finally { h.db.close(); }
});

test("a child-verified repair staged before forge freshness loss remains fenced at delivery", () => {
  const h = completedPrFixture();
  try {
    h.hub.isRunnerOnline = () => false;
    h.recovery.maintain(h.now);
    h.svc.retryDuePrompts(h.now + 31_000);
    const staged = h.db.latestCampaignContinuation("root")!;
    assert.ok(staged);
    h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref, observation: h.observation }], h.now - 700_000);
    h.hub.isRunnerOnline = () => true;
    h.sent.length = 0;
    h.svc.retryDuePrompts(h.now + 32_000);
    assert.equal(h.sent.some(m => (m as {type:string}).type === "durable_session_command"), false);
    assert.equal(h.db.getSessionPromptCommand(staged.commandId)!.state, "pending", "known unsent original command remains intact");
    assert.equal(h.db.latestCampaignContinuation("root")!.commandId, staged.commandId);
    assert.equal(h.db.campaignRecovery.projection("root").records[0]!.attempts, 1);
  } finally { h.db.close(); }
});

test("all four scoped repair reservations deliver; a fifth head cannot reset their ceiling", () => {
  const h = completedPrFixture();
  const delivered = new Set<string>();
  try {
    for (let n = 1; n <= 4; n++) {
      const at = h.now + (n - 1) * 40_000;
      h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
        observation: { ...h.observation, headSha: n.toString().repeat(40) } }], at);
      h.db.updateSessionStatus("root", "idle", at);
      h.recovery.maintain(at);
      h.svc.retryDuePrompts(at + 31_000);
      const continuation = h.db.latestCampaignContinuation("root")!;
      assert.ok(continuation);
      assert.equal(delivered.has(continuation.commandId), false, "each reserved repair reaches its own new turn");
      delivered.add(continuation.commandId);
      assert.ok(h.sent.some(m => (m as {commandId?:string}).commandId === continuation.commandId), "the turn actually reaches the runner");
      const command = JSON.parse(h.db.getSessionPromptCommand(continuation.commandId)!.payloadJson);
      assert.match(command.text, /Action needed: yes/u, `repair ${n} is delivered, not retired before coalescing`);
      assert.ok(command.text.includes(n.toString().repeat(40)), "the delivered metadata carries this exact repaired head");
      assert.equal(h.db.campaignRecovery.projection("root").records[0]!.attempts, n);
      assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update",
        commandId: continuation.commandId, sessionId: "root", state: "completed", revision: 1 }));
    }
    const latest = h.db.latestCampaignContinuation("root")!;
    h.db.updateSessionStatus("root", "idle", h.now + 160_000);
    h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
      observation: { ...h.observation, headSha: "5".repeat(40) } }], h.now + 160_000);
    h.recovery.maintain(h.now + 160_000);
    h.svc.retryDuePrompts(h.now + 191_000);
    assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, latest.continuationId);
    const exhausted = h.db.campaignRecovery.projection("root").records[0]!;
    assert.equal(exhausted.reason, "attempts_exhausted");
    assert.equal(exhausted.attempts, 4);
    assert.equal(h.db.campaignProjection("root")!.status, "blocked");
  } finally { h.db.close(); }
});

/** Delivers the latest staged parent continuation and reports its turn finished, as the runner does. */
function completeLatestContinuation(h: ReturnType<typeof completedPrFixture>, at: number) {
  h.svc.retryDuePrompts(at);
  const continuation = h.db.latestCampaignContinuation("root")!;
  assert.ok(continuation);
  const text = JSON.parse(h.db.getSessionPromptCommand(continuation.commandId)!.payloadJson).text as string;
  assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update",
    commandId: continuation.commandId, sessionId: "root", state: "completed", revision: 1 }));
  const settled = h.db.latestCampaignContinuation("root")!;
  assert.equal(settled.state, "completed");
  h.db.updateSessionStatus("root", "idle", at);
  return { ...continuation, text, settledAt: settled.updatedAt };
}
const recoveryEvents = (h: ReturnType<typeof completedPrFixture>) =>
  (h.db.raw().prepare("SELECT event_id FROM orchestrator_campaign_events WHERE campaign_session_id='root' ORDER BY seq").all() as
    Array<{ event_id: string }>).map(row => row.event_id);

test("an unanswered dispatched wake is woken again with backoff, then exhausts instead of staying automatic (#2938 AC8)", () => {
  const h = completedPrFixture();
  try {
    h.recovery.maintain(h.now);
    const original = h.db.campaignRecovery.projection("root").records[0]!;
    assert.deepEqual([original.state, original.attempts], ["dispatched", 1]);
    const first = completeLatestContinuation(h, h.now + 31_000);
    let settledAt = first.settledAt;
    const delivered = new Set([first.commandId]);
    for (let attempts = 1; attempts <= 3; attempts++) {
      const delay = stalledRecoveryWakeDelayMs(attempts);
      // Within its delay a finished wake is still owed an answer: no new wake, no new event.
      const events = recoveryEvents(h).length;
      h.recovery.maintain(settledAt + delay - 1);
      h.recovery.maintain(settledAt + delay - 1);
      assert.deepEqual([h.db.campaignRecovery.projection("root").records[0]!.state, recoveryEvents(h).length],
        ["dispatched", events], `attempt ${attempts} waits for its delay`);
      // After it, the same record and occurrence is woken once more under a fresh event identity.
      h.recovery.maintain(settledAt + delay);
      h.recovery.maintain(settledAt + delay);
      const record = h.db.campaignRecovery.projection("root").records[0]!;
      assert.deepEqual([record.id, record.resource, record.state, record.attempts],
        [original.id, original.resource, "dispatched", attempts + 1]);
      assert.deepEqual(recoveryEvents(h).slice(-1), [`${original.id}:${attempts + 1}`], "exactly one new wake event, single-flight");
      const continuation = completeLatestContinuation(h, settledAt + delay + 31_000);
      settledAt = continuation.settledAt;
      assert.equal(delivered.has(continuation.commandId), false, "each re-wake reaches its own parent turn");
      delivered.add(continuation.commandId);
      assert.match(continuation.text, /Action needed: yes/u);
      assert.ok(continuation.text.includes(original.id), "the re-wake names the same recovery record");
    }
    // The fourth wake also went unanswered: the ceiling is spent, so the record is blocked as an
    // exhausted exception and unattended readiness is withdrawn rather than counted as automatic.
    const before = h.db.latestCampaignContinuation("root")!.continuationId;
    h.recovery.maintain(settledAt + stalledRecoveryWakeDelayMs(4));
    h.svc.retryDuePrompts(settledAt + stalledRecoveryWakeDelayMs(4) + 31_000);
    const exhausted = h.db.campaignRecovery.projection("root");
    assert.deepEqual([exhausted.records[0]!.reason, exhausted.records[0]!.state, exhausted.records[0]!.attempts,
      exhausted.records[0]!.requiredInput], ["attempts_exhausted", "blocked", 4, "none"]);
    assert.deepEqual([exhausted.unattendedReady, exhausted.automatic, exhausted.blocked], [false, 0, 1]);
    assert.equal(h.db.latestCampaignContinuation("root")!.continuationId, before, "an exhausted record is never woken again");
    assert.equal(h.db.campaignProjection("root")!.status, "blocked");
    assert.equal(JSON.stringify(exhausted).includes("Component fixture"), false, "the exception carries no transcript content");
  } finally { h.db.close(); }
});

test("a wake is not re-sent while the parent is busy, a descendant works, or its turn's outcome is unknown", () => {
  for (const hold of ["root_running", "descendant_running", "root_background", "descendant_background", "missing_result"] as const) {
    const h = completedPrFixture();
    try {
      h.recovery.maintain(h.now);
      const original = h.db.campaignRecovery.projection("root").records[0]!;
      h.svc.retryDuePrompts(h.now + 31_000);
      const continuation = h.db.latestCampaignContinuation("root")!;
      assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId: continuation.commandId,
        sessionId: "root", state: hold === "missing_result" ? "uncertain" : "completed", revision: 1 }));
      h.db.updateSessionStatus("root", hold === "root_running" ? "running" : "idle", h.now + 31_000);
      if (hold === "descendant_running" || hold === "descendant_background") {
        h.db.setSessionArchived("child", false, h.now + 31_000);
        h.db.updateSessionStatus("child", hold === "descendant_running" ? "running" : "idle", h.now + 31_000);
      }
      // At rest in the foreground while detached work still returns, as the runner's snapshot records it.
      if (hold === "root_background") h.db.raw().prepare("UPDATE sessions SET background_work_state='running' WHERE id='root'").run();
      if (hold === "descendant_background") {
        h.db.raw().prepare("UPDATE sessions SET background_work_state='continuation_pending' WHERE id='child'").run();
      }
      const events = recoveryEvents(h).length;
      for (const at of [h.now + 31_000 + stalledRecoveryWakeDelayMs(1), h.now + 31_000 + STALLED_RECOVERY_WAKE_MAX_MS * 4]) {
        h.recovery.maintain(at);
      }
      const record = h.db.campaignRecovery.projection("root").records.find(r => r.id === original.id)!;
      assert.deepEqual([record.state, record.attempts, recoveryEvents(h).length], ["dispatched", 1, events], hold);
    } finally { h.db.close(); }
  }
});

test("restarting a Full Control root cancels its outstanding recovery, so the old wake cannot continue (#2938 AC9)", () => {
  const h = completedPrFixture();
  try {
    h.recovery.maintain(h.now);
    const original = h.db.campaignRecovery.projection("root").records[0]!;
    assert.deepEqual([original.state, original.attempts], ["dispatched", 1]);
    // A current host advertises the independent Orchestrator role the restart relaunches with.
    h.metadata.agents[0]!.capabilities = { models: [{ id: "gpt-6.1-sol", displayName: "Fixture", default: true }],
      effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default"],
      orchestratorAdditive: true };
    h.db.registerRunner(h.metadata, h.now, PROTOCOL_VERSION);
    const restarted = h.svc.restart("root");
    assert.ok(restarted.ok, restarted.error ?? "restart refused");
    const stored = JSON.parse((h.db.raw().prepare("SELECT record_json FROM campaign_recovery WHERE id=?")
      .get(original.id) as { record_json: string }).record_json);
    assert.deepEqual([stored.state, stored.dispatchFenced, stored.attempts], ["cancelled", true, 1],
      "the restart cancels the reservation rather than rebinding it to the new run");
    // The restarted root comes back idle and the same failing check is observed again: the old
    // reservation stays fenced until a fresh occurrence exists, and its ceiling is not reset.
    h.db.updateSessionStatus("root", "idle", h.now + 1_000);
    const events = recoveryEvents(h);
    for (const at of [h.now + 1_000, h.now + 31_000, h.now + 31_000 + STALLED_RECOVERY_WAKE_MAX_MS]) {
      h.recovery.maintain(at);
      h.svc.retryDuePrompts(at);
    }
    const after = h.db.campaignRecovery.projection("root");
    assert.deepEqual([after.records[0]!.id, after.records[0]!.state, after.records[0]!.reason, after.records[0]!.attempts],
      [original.id, "blocked", "authority_changed", 1]);
    assert.equal(after.unattendedReady, false);
    assert.deepEqual(recoveryEvents(h), events, "no new wake is reserved for the fenced record");
    const continuation = h.db.latestCampaignContinuation("root");
    if (continuation) {
      const text = JSON.parse(h.db.getSessionPromptCommand(continuation.commandId)!.payloadJson).text as string;
      assert.match(text, /Action needed: no/u, "the pre-restart wake is delivered only as settled information");
      assert.match(text, /"pending":false/u);
    }
  } finally { h.db.close(); }
});

for (const fence of ["stale", "out_of_scope", "wrong_subject", "hard_denial", "exhausted", "unsupported", "budget", "stop", "archive", "pause", "revoke"] as const) {
  test(`verified children cannot admit original PR recovery through the ${fence} fence`, () => {
    const h = completedPrFixture();
    try {
      h.db.updateSessionStatus("root", "running", h.now);
      h.recovery.maintain(h.now); // Derive the record without spending or staging a turn.
      const original = h.db.campaignRecovery.projection("root").records[0]!;
      h.db.updateSessionStatus("root", "idle", h.now);
      if (fence === "stale") h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref, observation: h.observation }], h.now - 700_000);
      if (fence === "out_of_scope") assert.ok(h.db.campaignWorkLedger.updateItem("root", "root", { workItemId: h.itemId,
        issue: { repository: "picoduck/wollipog", number: 999 } }, h.now).ok); // Untrusted ledger claim cannot expand current scope.
      if (fence === "wrong_subject" || fence === "hard_denial" || fence === "exhausted") {
        const record = { ...original, ...(fence === "wrong_subject" ? { resource: { ...original.resource, sessionId: "foreign-campaign" } } : {}),
          ...(fence === "hard_denial" ? { reason: "hard_denial", state: "blocked" } : {}),
          ...(fence === "exhausted" ? { attempts: 4, reason: "attempts_exhausted", state: "blocked" } : {}) };
        h.db.raw().prepare("UPDATE campaign_recovery SET record_json=? WHERE id=?").run(JSON.stringify(record), original.id);
      }
      if (fence === "wrong_subject") {
        assert.equal(h.db.campaignRecoveryCompletion("root").state, "recovery_held", "a foreign subject cannot supply repair authority");
        const passing = { state: "passing" as const, failing: 0, passing: 1, pending: 0 };
        h.db.campaignForgeObservations.record("root", "r", [{ ref: h.ref,
          observation: { ...h.observation, checks: passing, requiredChecks: passing } }], h.now);
      }
      if (fence === "unsupported") h.db.registerRunner(h.metadata, h.now, 1);
      if (fence === "budget") {
        h.db.updateSessionCostBudget("root", 1, h.now);
        h.db.appendEvent("root", { kind: "token_usage", inputTokens: 1, costUsd: 2 }, h.now, { accrueUsage: true });
      }
      if (fence === "stop") h.svc.stop("root");
      if (fence === "archive") h.db.setSessionArchived("root", true, h.now);
      if (fence === "pause") h.db.updateSessionStatus("root", "input_required", h.now);
      if (fence === "revoke") h.db.updateSessionCampaignControl("root", { mode: "custom" }, 2, h.now);
      h.sent.length = 0;
      h.svc.retryDuePrompts(h.now + 31_000);
      assert.equal(h.db.latestCampaignContinuation("root"), null);
      assert.equal(h.sent.some(m => (m as {type:string}).type === "durable_session_command"), false);
      assert.ok(h.db.campaignRecovery.activeRecords("root").every(record => record.attempts === (fence === "exhausted" ? 4 : 0)),
        "the fence cannot spend or reset retained ceilings");
    } finally { h.db.close(); }
  });
}

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
