import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type PendingApproval, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2938], revision: 1,
    authorizedByUserId: identity.userId, authorizedAt: 1 };
  policy.issueNumbers = [2938];
  for (const id of ["root", "child", "unaffected"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id,
      useWorktree: false, driver: "codex-app-server", config: {}, now: 1,
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
    operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 1,
  { ...identity, kind: "human", actorId: identity.userId });
  assert.ok(enabled.ok, enabled.error ?? "admission failed");
  const recovery = new CampaignRecoveryService(db, () => {}, log);
  return { db, svc, recovery, sent, logs, metadata };
}

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

test("uncertain steering keeps its original occurrence and requests reconciliation, never prompt replay", () => {
  const h = fixture();
  try {
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
