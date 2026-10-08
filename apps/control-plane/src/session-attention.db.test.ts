import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "./identity.js";

function fixture(path = ":memory:") {
  const db = ControlPlaneDb.open(path);
  db.raw().prepare(`INSERT INTO runners(runner_id,hostname,os,version,status,created_at,updated_at)
    VALUES ('r','test','linux','test','online',1,1)`).run();
  db.createSession({ id: "s", runnerId: "r", workspaceId: null, agentId: null, title: "Result",
    useWorktree: false, driver: "codex-app-server", config: {}, now: 1,
    scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
  return db;
}

function completeResult(db: ControlPlaneDb, text: string, ts: number) {
  db.appendEvent("s", { kind: "agent_message", text, final: true }, ts);
  db.appendEvent("s", { kind: "agent_response_completed" }, ts);
}

test("completed message items wait for a successful response boundary; old peers stay conservative", () => {
  const db = fixture();
  try {
    db.updateSessionStatus("s", "running", 10);
    db.appendEvent("s", { kind: "agent_message", text: "Still investigating", final: true }, 20);
    assert.equal(db.getSession("s")!.attention!.result, null);
    assert.equal(db.getSession("s")!.attention!.meaningfulAt, 10);
    db.appendEvent("s", { kind: "tool_call", toolCallId: "check", title: "Check", status: "in_progress" }, 30);
    assert.equal(db.getSession("s")!.attention!.result, null);
    db.appendEvent("s", { kind: "agent_response_completed" }, 40);
    assert.equal(db.getSession("s")!.attention!.result!.at, 40);
  } finally { db.close(); }
});

test("live completion creates a result independently of lifecycle; chatter never changes meaningful time", () => {
  const db = fixture();
  try {
    db.updateSessionStatus("s", "running", 10);
    db.appendEvent("s", { kind: "agent_message", text: "Finding" }, 20);
    db.appendEvent("s", { kind: "stderr", text: "heartbeat" }, 30);
    assert.equal(db.getSession("s")!.attention!.result, null);
    assert.equal(db.getSession("s")!.attention!.meaningfulAt, 10);
    db.appendEvent("s", { kind: "agent_response_completed" }, 40);
    const result = db.getSession("s")!.attention!.result!;
    assert.equal(result.at, 40);
    assert.equal(db.getSession("s")!.status, "running");
    db.appendEvent("s", { kind: "agent_response_completed" }, 50);
    assert.deepEqual(db.getSession("s")!.attention!.result, result, "a duplicate completion without new output is quiet");
    db.appendEvent("s", { kind: "agent_message", text: "Worker chatter", final: true, parentToolUseId: "worker" }, 60);
    assert.equal(db.getSession("s")!.attention!.meaningfulAt, 40);
  } finally { db.close(); }
});

test("acknowledgment is exact and per user, and never consumes a concurrent newer result", () => {
  const db = fixture();
  try {
    completeResult(db, "First", 20);
    const first = db.getSession("s")!.attention!.result!.revision;
    assert.equal(db.acknowledgeSessionResult("s", LOCAL_OWNER_USER_ID, first, 21), true);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, first);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, null).attention!.acknowledgedRevision, null);
    db.raw().prepare("INSERT INTO identity_users(user_id,display_name,created_at,updated_at) VALUES ('other','Other',1,1)").run();
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, "other").attention!.acknowledgedRevision, null);
    assert.equal(db.acknowledgeSessionResult("s", "other", first, 21), true);
    completeResult(db, "Second", 22);
    const second = db.getSession("s")!.attention!.result!.revision;
    assert.notEqual(first, second);
    assert.equal(db.acknowledgeSessionResult("s", LOCAL_OWNER_USER_ID, first, 23), false);
    const current = db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!;
    assert.equal(current.acknowledgedRevision, first);
    assert.equal(current.result!.revision, second);
    assert.equal(db.acknowledgeSessionResult("s", LOCAL_OWNER_USER_ID, second, 24), true);
  } finally { db.close(); }
});

test("historical hydration and old idle history do not manufacture results; live replay is idempotent", () => {
  const db = fixture();
  try {
    db.appendEvent("s", { kind: "agent_message", text: "Old", final: true }, 20, { runnerSeq: 1, historyEpoch: 1 });
    assert.equal(db.getSession("s")!.attention!.result, null);
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Live", final: true }, 30, "runner:1:2");
    db.observeSessionAttentionEvent("s", { kind: "agent_response_completed" }, 30, "runner:1:20");
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Newer", final: true }, 40, "runner:1:3");
    db.observeSessionAttentionEvent("s", { kind: "agent_response_completed" }, 40, "runner:1:30");
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Live", final: true }, 30, "runner:1:2");
    assert.equal(db.getSession("s")!.attention!.result!.revision, "runner:1:30");
  } finally { db.close(); }
});

test("the summary and per-user acknowledgment survive reopen without backfilling old transcript results", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-db-"));
  const path = join(dir, "state.db");
  const db = fixture(path);
  completeResult(db, "Report", 20);
  const revision = db.getSession("s")!.attention!.result!.revision;
  db.acknowledgeSessionResult("s", LOCAL_OWNER_USER_ID, revision, 21);
  db.close();
  const reopened = ControlPlaneDb.open(path);
  try {
    const facts = reopened.sessionAttentionForUser(reopened.getSession("s")!, LOCAL_OWNER_USER_ID).attention!;
    assert.equal(facts.result!.revision, revision);
    assert.equal(facts.acknowledgedRevision, revision);
    reopened.raw().prepare("DROP TABLE session_result_acknowledgments").run();
    reopened.raw().prepare("DROP TABLE session_attention_results").run();
    reopened.raw().prepare("DROP TABLE session_attention").run();
  } finally { reopened.close(); }
  const migrated = ControlPlaneDb.open(path);
  try { assert.equal(migrated.getSession("s")!.attention!.result, null); }
  finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("request occurrence timestamps survive reconnects and change for new occurrences", () => {
  const db = fixture();
  try {
    db.setPendingApproval("s", { requestId: "question", kind: "question", title: "Choose", options: [] });
    const original = db.getSession("s")!.pendingApproval!;
    db.setPendingApproval("s", { ...original, requestedAt: 999 });
    assert.equal(db.getSession("s")!.pendingApproval!.requestedAt, original.requestedAt);
    db.setPendingApproval("s", null);
    db.setPendingApproval("s", { requestId: "question", kind: "question", title: "Choose again", options: [] });
    assert.notEqual(db.getSession("s")!.pendingApproval!.occurrenceId, original.occurrenceId);
    assert.equal(db.getSession("s")!.attention!.humanActions.length, 1);
  } finally { db.close(); }
});

test("authoritative recovery actions have stable occurrence times without manufacturing results", () => {
  const db = fixture();
  try {
    db.raw().prepare("UPDATE sessions SET worktree_recovery=?,updated_at=999 WHERE id='s'")
      .run(JSON.stringify({ recoveryId: "worktree-1", detectedAt: 25, selectedPath: "/tmp/s", expectedBranch: "s", detail: "Restore branch" }));
    const facts = db.getSession("s")!.attention!;
    assert.deepEqual(facts.humanActions, [{ requestId: "worktree-recovery:worktree-1", rank: 0, requestedAt: 25 }]);
    assert.equal(facts.result, null);
  } finally { db.close(); }
});

test("child results belong to their Orchestrator until an exact handoff, and new results need a new handoff", () => {
  const db = fixture();
  try {
    db.createSession({ id: "parent", runnerId: "r", workspaceId: null, agentId: null, title: "Parent",
      useWorktree: false, driver: "codex-app-server", config: {}, role: "orchestrator", now: 1,
      orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default"),
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
    db.createSession({ id: "helper", parentSessionId: "parent", runnerId: "r", workspaceId: null, agentId: null,
      title: "Nested helper", useWorktree: false, driver: "codex-app-server", config: {}, now: 2,
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
    db.raw().prepare("UPDATE sessions SET parent_session_id='helper' WHERE id='s'").run();
    assert.equal(db.sessionResultOrchestrator("s"), "parent");
    completeResult(db, "Child report", 20);
    const first = db.getSession("s")!.attention!.result!;
    assert.equal(first.owner, "orchestrator");
    assert.equal(db.handoffSessionResult("s", "stale"), false);
    assert.equal(db.handoffSessionResult("s", first.revision), true);
    assert.equal(db.getSession("s")!.attention!.result!.owner, "human");
    completeResult(db, "New report", 30);
    assert.equal(db.getSession("s")!.attention!.result!.owner, "orchestrator");
  } finally { db.close(); }
});

test("duplicate live output receipts cannot rearm a completed response or move meaningful time", () => {
  const db = fixture();
  try {
    const text = { kind: "agent_message" as const, text: "Finding" };
    db.observeSessionAttentionEvent("s", text, 20, "runner:1:1");
    db.observeSessionAttentionEvent("s", { kind: "agent_response_completed" }, 30, "runner:1:2");
    const before = db.getSession("s")!.attention!;
    db.observeSessionAttentionEvent("s", text, 40, "runner:1:1");
    db.observeSessionAttentionEvent("s", { kind: "agent_response_completed" }, 50, "runner:1:3");
    assert.deepEqual(db.getSession("s")!.attention, before);
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Next", final: true }, 60, "runner:1:4");
    db.observeSessionAttentionEvent("s", { kind: "agent_response_completed" }, 60, "runner:1:5");
    const latest = db.getSession("s")!.attention!;
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Next", final: true }, 70, "runner:1:4");
    assert.deepEqual(db.getSession("s")!.attention, latest);
  } finally { db.close(); }
});

test("attention fences survive timestamp ties, acknowledgments, reprocessing, and older projection schemas", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-fences-"));
  const path = join(dir, "state.db");
  const db = fixture(path);
  completeResult(db, "First", 20);
  const first = db.getSession("s")!.attention!;
  db.acknowledgeSessionResult("s", LOCAL_OWNER_USER_ID, first.result!.revision, 20);
  const reviewed = db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!;
  completeResult(db, "Second", 20);
  assert.ok(db.getSession("s")!.attention!.revision! > first.revision!);
  db.clearSessionEvents("s");
  const cleared = db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!;
  assert.ok(cleared.revision! > first.revision!);
  assert.ok(cleared.acknowledgmentRevision! > reviewed.acknowledgmentRevision!);
  assert.equal(cleared.acknowledgedRevision, null);
  db.raw().exec("ALTER TABLE session_attention DROP COLUMN revision; ALTER TABLE session_result_acknowledgments DROP COLUMN revision");
  db.close();
  const migrated = ControlPlaneDb.open(path);
  try {
    assert.equal(migrated.getSession("s")!.attention!.revision, 0);
    assert.equal(migrated.sessionAttentionForUser(migrated.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgmentRevision, 1);
  } finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("uncertain steering reviews wait for durable acceptance and never consume a later result", () => {
  const db = fixture();
  const request = (id: string) => ({ requestId: id, sessionId: "s", submissionId: id, turnId: "turn",
    source: "direct" as const, requestSha256: "a".repeat(64), text: "Continue", now: 1 });
  const accepted = (id: string) => ({ type: "steer_session_result" as const, requestId: id, sessionId: "s",
    submissionId: id, turnId: "turn", disposition: "accepted" as const, reason: "accepted" as const });
  try {
    completeResult(db, "First", 20);
    const first = db.getSession("s")!.attention!.result!.revision;
    db.createSteeringAttempt(request("one"));
    db.markSteeringAttemptUncertain("one", 21);
    assert.equal(db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "one", first), false);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, null);
    db.recordSteeringResult("r", accepted("one"), 22);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, first);
    db.createSteeringAttempt(request("two"));
    db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "two", first);
    completeResult(db, "Second", 23);
    const second = db.getSession("s")!.attention!.result!.revision;
    db.resolveSteeringAttemptFromUserMessage("s", "two", "turn", 24);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, first);
    db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "two", second);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, first,
      "replaying the same submission cannot substitute a new addressed result");
    db.createSteeringAttempt(request("rejected"));
    db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "rejected", second);
    db.recordSteeringResult("r", { ...accepted("rejected"), disposition: "rejected", reason: "provider_rejected" }, 25);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, first);
    db.createSteeringAttempt(request("confirmed"));
    db.recordSteeringResult("r", accepted("confirmed"), 26);
    assert.equal(db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "confirmed", second), true);
  } finally { db.close(); }
});

test("role-only legacy parents keep results human-owned without a durable campaign policy", () => {
  const db = fixture();
  try {
    db.createSession({ id: "legacy", runnerId: "r", workspaceId: null, agentId: null, title: "Parent",
      useWorktree: false, driver: "codex-app-server", config: {}, role: "orchestrator", now: 1,
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
    db.raw().prepare("UPDATE sessions SET parent_session_id='legacy' WHERE id='s'").run();
    completeResult(db, "Report", 20);
    assert.equal(db.getSession("s")!.attention!.result!.owner, "human");
    assert.equal(db.sessionResultOrchestrator("s"), null);
  } finally { db.close(); }
});

test("steering review intents survive reload and settle only confirmed queue conversion or Queue Again", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-steering-"));
  const path = join(dir, "state.db");
  let db = fixture(path);
  completeResult(db, "Report", 20);
  const revision = db.getSession("s")!.attention!.result!.revision;
  const create = (id: string) => db.createSteeringAttempt({ requestId: id, sessionId: "s", submissionId: id,
    turnId: "turn", source: "direct", requestSha256: "a".repeat(64), text: "Continue", now: 21 });
  create("converted");
  db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "converted", revision);
  db.close();
  db = ControlPlaneDb.open(path);
  try {
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, null);
    db.recordSteeringResult("r", { type: "steer_session_result", requestId: "converted", sessionId: "s",
      submissionId: "converted", turnId: "turn", disposition: "converted_to_queue", reason: "stale_turn", queuedPromptId: "queued" }, 22);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, revision);
    completeResult(db, "Next", 23);
    const next = db.getSession("s")!.attention!.result!.revision;
    create("again");
    db.markSteeringAttemptUncertain("again", 24);
    db.reviewSessionResultAfterSteering("s", LOCAL_OWNER_USER_ID, "again", next);
    db.stageSteeringResolution("s", "again", "queue_again", "resolution", 25);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, revision);
    db.recordSteeringResolutionResult("r", { type: "resolve_steering_attempt_result", requestId: "resolution",
      sessionId: "s", submissionId: "again", action: "queue_again", applied: true, queuedPromptId: "queued-again" }, 26);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, next);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("policy approval sort time comes from its durable occurrence rather than session creation", () => {
  const db = fixture();
  try {
    db.beginPolicyHookApproval({ sessionId: "s", requestId: "policy", requestFingerprint: "f".repeat(64),
      governancePolicyId: "ask", approval: { requestId: "policy", title: "Run?", kind: "policy_hook", options: [] }, now: 50 });
    assert.equal(db.getSession("s")!.attention!.humanActions[0]!.requestedAt, 50);
    db.touchPolicyHookApproval("s", "policy", 70);
    assert.equal(db.getSession("s")!.attention!.humanActions[0]!.requestedAt, 50);
  } finally { db.close(); }
});
