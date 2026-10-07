import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    db.appendEvent("s", { kind: "agent_message", text: "First", final: true }, 20);
    const first = db.getSession("s")!.attention!.result!.revision;
    assert.equal(db.acknowledgeSessionResult("s", LOCAL_OWNER_USER_ID, first, 21), true);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, LOCAL_OWNER_USER_ID).attention!.acknowledgedRevision, first);
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, null).attention!.acknowledgedRevision, null);
    db.raw().prepare("INSERT INTO identity_users(user_id,display_name,created_at,updated_at) VALUES ('other','Other',1,1)").run();
    assert.equal(db.sessionAttentionForUser(db.getSession("s")!, "other").attention!.acknowledgedRevision, null);
    assert.equal(db.acknowledgeSessionResult("s", "other", first, 21), true);
    db.appendEvent("s", { kind: "agent_message", text: "Second", final: true }, 22);
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
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Newer", final: true }, 40, "runner:1:3");
    db.observeSessionAttentionEvent("s", { kind: "agent_message", text: "Live", final: true }, 30, "runner:1:2");
    assert.equal(db.getSession("s")!.attention!.result!.revision, "runner:1:3");
  } finally { db.close(); }
});

test("the summary and per-user acknowledgment survive reopen without backfilling old transcript results", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-db-"));
  const path = join(dir, "state.db");
  const db = fixture(path);
  db.appendEvent("s", { kind: "agent_message", text: "Report", final: true }, 20);
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
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
    db.createSession({ id: "helper", parentSessionId: "parent", runnerId: "r", workspaceId: null, agentId: null,
      title: "Nested helper", useWorktree: false, driver: "codex-app-server", config: {}, now: 2,
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
    db.raw().prepare("UPDATE sessions SET parent_session_id='helper' WHERE id='s'").run();
    assert.equal(db.sessionResultOrchestrator("s"), "parent");
    db.appendEvent("s", { kind: "agent_message", text: "Child report", final: true }, 20);
    const first = db.getSession("s")!.attention!.result!;
    assert.equal(first.owner, "orchestrator");
    assert.equal(db.handoffSessionResult("s", "stale"), false);
    assert.equal(db.handoffSessionResult("s", first.revision), true);
    assert.equal(db.getSession("s")!.attention!.result!.owner, "human");
    db.appendEvent("s", { kind: "agent_message", text: "New report", final: true }, 30);
    assert.equal(db.getSession("s")!.attention!.result!.owner, "orchestrator");
  } finally { db.close(); }
});
