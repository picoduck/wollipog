import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AutomationSpec,
  PendingApproval,
  RunnerMetadata,
  ReviewFinding,
  GitHubReviewSyncInfo,
  SessionConfig,
  SessionSnapshot,
  WorkflowArtifact,
  WorkflowArtifactView,
} from "@wollipog/protocol";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { archiveSessionPage } from "./archive-session-page.js";
import {
  ControlPlaneDb,
  GOVERNANCE_AUDIT_RETENTION_MS,
  TAIL_TURN_ALIGNMENT_MAX_EVENTS,
  type NewSessionInput,
} from "./db.js";
import type { HumanPrincipal } from "./identity.js";

/* ----------------------------- Fixtures -------------------------------- */

function acpAgent(): AgentDefinition {
  return {
    id: "acp-agent",
    name: "ACP Agent",
    command: "acp-bin",
    args: ["--stdio", "--foo"],
    env: { TOKEN: "abc", DEBUG: "1" },
    driver: "acp",
    acpTransport: "stdio",
    context: { kind: "native" },
    capabilities: {
      models: [{ id: "default", displayName: "Default", default: true }],
      effortLevels: ["low", "high"],
      slashCommands: [{ name: "help", source: "builtin" }],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes: ["default", "acceptEdits"],
    },
    source: "registry",
    version: "9.1.0",
    acp: { logout: true, loadSession: true, sessionList: true, sessionDelete: false, sessionResume: true, sessionClose: true },
    registry: {
      id: "acp-agent",
      schemaVersion: "1.0.0",
      adapterVersion: "9.1.0",
      description: "Registry test agent",
      transport: "stdio",
      distribution: "npx",
      installPreview: "npx --yes acp-agent@9.1.0",
      installStatus: "installed",
      authentication: "required-live-verification",
    },
  };
}

function claudeAgent(): AgentDefinition {
  return {
    id: "claude-agent",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "wsl", distro: "Ubuntu" },
    claudeCode: {
      status: "ready",
      installedVersion: "2.1.205",
      effortLevels: ["low", "high"],
      permissionModes: ["acceptEdits", "auto"],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      auth: { status: "authenticated", method: "claude.ai", provider: "firstParty", billingSource: "subscription", subscriptionType: "max" },
    },
    // no capabilities -> should round-trip as undefined
  };
}

function meta(overrides: Partial<RunnerMetadata> = {}): RunnerMetadata {
  return {
    runnerId: "runner-1",
    hostname: "host-1",
    os: "windows",
    version: "1.2.3",
    agents: [acpAgent(), claudeAgent()],
    workspaces: [
      { id: "ws-1", name: "Repo One", path: "C:/code/one", additionalDirectoryGrants: ["C:/code/shared"] },
      { id: "ws-2", name: "Repo Two", path: "C:/code/two" },
    ],
    ...overrides,
  };
}

function newSession(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    id: "sess-1",
    runnerId: "runner-1",
    workspaceId: "ws-1",
    agentId: "acp-agent",
    title: "My session",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 1000,
    ...overrides,
  };
}

/** Open an in-memory db with a runner already registered. */
function withRunner(): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(meta(), 500);
  return db;
}

function createScreenshotArtifact(
  db: ControlPlaneDb,
  owner: { sessionId: string; runId?: never } | { runId: string; sessionId?: never },
  artifactId: string,
  metadata: Record<string, unknown> = { purpose: "prompt_image" },
): WorkflowArtifactView {
  const bytes = Buffer.from("/9j/2Q==", "base64");
  const artifact: WorkflowArtifactView = {
    artifactId,
    ...owner,
    kind: "screenshot",
    name: `${artifactId}.jpg`,
    mimeType: "image/jpeg",
    encoding: "base64",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdBy: { kind: "system", id: "steering-test" },
    metadata,
    createdAt: 1,
  };
  return db.createWorkflowArtifactBytes(artifact, bytes);
}

function createSteeringPromptImage(db: ControlPlaneDb, sessionId: string, artifactId: string): WorkflowArtifactView {
  return createScreenshotArtifact(db, { sessionId }, artifactId);
}

test("steering attempts preserve idempotency, reconcile late receipts, compact, and cascade", () => {
  const db = withRunner();
  db.createSession(newSession());
  const input = {
    requestId: "steer-1",
    sessionId: "sess-1",
    submissionId: "submission-1",
    turnId: "turn-1",
    source: "direct" as const,
    requestSha256: "a".repeat(64),
    text: "Please inspect the failing check",
    images: [{ artifactId: "art-1", mimeType: "image/png", sizeBytes: 12, sha256: "b".repeat(64) }],
    config: { model: "default", effort: "high" },
    now: 1_000,
  };
  assert.equal(db.createSteeringAttempt(input).kind, "inserted");
  assert.equal(db.createSteeringAttempt({ ...input, requestId: "never-sent" }).kind, "duplicate");
  assert.equal(db.createSteeringAttempt({ ...input, requestId: "conflict", requestSha256: "c".repeat(64) }).kind, "conflict");
  const stored = db.raw().prepare(
    "SELECT images_json,disposition,receipt_json FROM session_steering_attempts WHERE request_id=?",
  ).get("steer-1") as unknown as { images_json: string; disposition: string; receipt_json: string | null };
  assert.equal(stored.images_json.includes("data"), false, "only externalized image metadata is durable");
  assert.equal(stored.disposition, "pending");
  assert.doesNotThrow(() => {
    assert.equal(db.recordSteeringResult("runner-1", {
      type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
      submissionId: "submission-1", turnId: "turn-1", disposition: "accepted",
      reason: "provider_rejected",
    } as unknown as Parameters<ControlPlaneDb["recordSteeringResult"]>[1], 1_500), null);
    assert.equal(db.recordSteeringResult("runner-1", {
      type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
      submissionId: "submission-1", turnId: "turn-1", disposition: "future_disposition",
      reason: "accepted",
    } as unknown as Parameters<ControlPlaneDb["recordSteeringResult"]>[1], 1_501), null);
    assert.equal(db.recordSteeringResult("runner-1", {
      type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
      submissionId: "submission-1", turnId: "turn-1", disposition: "converted_to_queue",
      reason: "provider_rejected",
    } as unknown as Parameters<ControlPlaneDb["recordSteeringResult"]>[1], 1_502), null);
    assert.equal(db.recordSteeringResult("runner-1", {
      type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
      submissionId: "submission-1", turnId: "turn-1", disposition: "uncertain",
      reason: "provider_rejected",
    } as unknown as Parameters<ControlPlaneDb["recordSteeringResult"]>[1], 1_503), null);
    assert.equal(db.recordSteeringResult("runner-1", {
      type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
      submissionId: "submission-1", turnId: "turn-1", disposition: "accepted", reason: "accepted",
      futureField: true,
    } as unknown as Parameters<ControlPlaneDb["recordSteeringResult"]>[1], 1_504), null);
  }, "malformed or future websocket input must fail closed before SQLite checks");
  assert.equal(db.getSteeringAttemptByRequestId("steer-1")?.state, "pending");

  assert.equal(db.markSteeringAttemptUncertain("steer-1", 2_000)?.state, "uncertain");
  assert.equal(db.recordSteeringResult("wrong-runner", {
    type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
    submissionId: "submission-1", turnId: "turn-1", disposition: "accepted", reason: "accepted",
  }, 3_000), null);
  assert.equal(db.recordSteeringResult("runner-1", {
    type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
    submissionId: "submission-1", turnId: "turn-1", disposition: "accepted", reason: "accepted",
  }, 3_000)?.state, "accepted", "a late authoritative receipt repairs CP-local uncertainty");
  assert.equal(db.recordSteeringResult("runner-1", {
    type: "steer_session_result", requestId: "steer-1", sessionId: "sess-1",
    submissionId: "submission-1", turnId: "turn-1", disposition: "rejected", reason: "provider_rejected",
  }, 4_000)?.state, "accepted", "a terminal runner receipt is immutable");

  db.createSteeringAttempt({
    ...input, requestId: "steer-unresolved", submissionId: "submission-unresolved",
    requestSha256: "e".repeat(64), text: "retain while uncertain", now: 1_500,
  });
  db.markSteeringAttemptUncertain("steer-unresolved", 2_500);

  assert.equal(db.compactSteeringAttempts(30 * 24 * 60 * 60_000 + 2_999), 0);
  assert.equal(db.compactSteeringAttempts(30 * 24 * 60 * 60_000 + 3_000), 1);
  const compact = db.raw().prepare(
    `SELECT text_snapshot,images_json,config_json,receipt_json,request_sha256,disposition
     FROM session_steering_attempts WHERE request_id='steer-1'`,
  ).get() as unknown as Record<string, unknown>;
  assert.equal(compact.text_snapshot, null);
  assert.equal(compact.images_json, null);
  assert.equal(compact.config_json, null);
  assert.equal(compact.receipt_json, null);
  assert.equal(compact.request_sha256, "a".repeat(64));
  assert.equal(compact.disposition, "accepted");

  const unresolved = db.raw().prepare(
    "SELECT text_snapshot,compacted_at FROM session_steering_attempts WHERE request_id='steer-unresolved'",
  ).get() as unknown as { text_snapshot: string | null; compacted_at: number | null };
  assert.equal(unresolved.text_snapshot, "retain while uncertain");
  assert.equal(unresolved.compacted_at, null, "unresolved uncertainty never enters retention");
  const resolvedAt = 40 * 24 * 60 * 60_000;
  assert.equal(db.resolveUncertainSteeringAttempt("sess-1", "submission-unresolved", resolvedAt), true);
  assert.equal(db.compactSteeringAttempts(resolvedAt + 30 * 24 * 60 * 60_000 - 1), 0);
  assert.equal(db.compactSteeringAttempts(resolvedAt + 30 * 24 * 60 * 60_000), 1);
  assert.equal(db.recordSteeringResult("runner-1", {
    type: "steer_session_result", requestId: "steer-unresolved", sessionId: "sess-1",
    submissionId: "submission-unresolved", turnId: "turn-1", disposition: "accepted", reason: "accepted",
  }, resolvedAt + 31 * 24 * 60 * 60_000)?.state, "uncertain",
  "a compact idempotency tombstone cannot be repopulated by a very late receipt");
  assert.equal((db.raw().prepare(
    "SELECT receipt_json FROM session_steering_attempts WHERE request_id='steer-unresolved'",
  ).get() as unknown as { receipt_json: string | null }).receipt_json, null);

  db.deleteSession("sess-1");
  assert.equal((db.raw().prepare("SELECT COUNT(*) AS count FROM session_steering_attempts").get() as
    unknown as { count: number }).count, 0);
});

test("a durable steered user message resolves a lost accepted receipt", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.createSteeringAttempt({
    requestId: "steer-history", sessionId: "sess-1", submissionId: "submission-history",
    turnId: "turn-1", source: "direct", requestSha256: "d".repeat(64), text: "continue", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-history", 2);
  assert.equal(db.resolveSteeringAttemptFromUserMessage("sess-1", "submission-history", "wrong-turn", 3), false);
  assert.equal(db.getSteeringAttemptByRequestId("steer-history")?.state, "uncertain");
  assert.equal(db.resolveSteeringAttemptFromUserMessage("sess-1", "submission-history", "turn-1", 4), true);
  assert.equal(db.getSteeringAttemptByRequestId("steer-history")?.state, "accepted");
  assert.equal(db.recordSteeringResult("runner-1", {
    type: "steer_session_result", requestId: "steer-history", sessionId: "sess-1",
    submissionId: "submission-history", turnId: "turn-1", disposition: "rejected",
    reason: "provider_rejected",
  }, 5)?.state, "accepted", "accepted history evidence cannot be downgraded by a later receipt");
  assert.equal(db.resolveSteeringAttemptFromUserMessage("sess-1", "unknown", "turn-1", 5), false);
});

test("startup indexes prompt-image references from previously committed user messages", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-steering-image-backfill-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(path);
    db.registerRunner(meta(), 1);
    db.createSession(newSession());
    const artifact = createSteeringPromptImage(db, "sess-1", "backfilled-prompt-image");
    db.raw().prepare(
      `INSERT INTO session_events (session_id,seq,ts,kind,payload) VALUES (?,?,?,?,?)`,
    ).run("sess-1", 1, 2, "user_message", JSON.stringify({
      kind: "user_message", text: "legacy accepted image", images: [{
        artifactId: artifact.artifactId,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      }],
    }));
    db.raw().prepare("UPDATE session_prompt_image_reference_state SET backfilled=0 WHERE id=1").run();
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(Number((db.raw().prepare(
      "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
    ).get(artifact.artifactId) as unknown as { count: number }).count), 1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy global event-artifact identity migrates to reusable event-scoped references", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-artifact-key-migration-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(path);
    db.registerRunner(meta(), 1);
    db.createSession(newSession());
    const artifact = createSteeringPromptImage(db, "sess-1", "legacy-shared-prompt-image");
    const reference = {
      artifactId: artifact.artifactId, mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes, sha256: artifact.sha256,
    };
    db.appendEvent("sess-1", { kind: "user_message", text: "first", images: [reference] }, 1);
    db.close();
    db = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(
      `PRAGMA foreign_keys=OFF;
       ALTER TABLE session_event_artifacts RENAME TO session_event_artifacts_current;
       CREATE TABLE session_event_artifacts (
         event_id INTEGER NOT NULL,
         artifact_id TEXT NOT NULL PRIMARY KEY,
         FOREIGN KEY (event_id) REFERENCES session_events(id) ON DELETE CASCADE,
         FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
       );
       INSERT INTO session_event_artifacts SELECT event_id,artifact_id FROM session_event_artifacts_current;
       DROP TABLE session_event_artifacts_current;`,
    );
    legacy.close();

    db = ControlPlaneDb.open(path);
    const primaryKey = db.raw().prepare(
      "SELECT name,pk FROM pragma_table_info('session_event_artifacts') WHERE name IN ('event_id','artifact_id') ORDER BY pk",
    ).all() as unknown as Array<{ name: string; pk: number }>;
    assert.deepEqual(primaryKey.map((column) => ({ ...column })), [
      { name: "event_id", pk: 1 },
      { name: "artifact_id", pk: 2 },
    ]);
    db.appendEvent("sess-1", { kind: "user_message", text: "second", images: [reference] }, 2);
    assert.equal(Number((db.raw().prepare(
      "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
    ).get(artifact.artifactId) as unknown as { count: number }).count), 2);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("steering projection prioritizes every bounded recovery obligation over newer receipts", () => {
  const db = withRunner();
  db.createSession(newSession());
  for (let index = 0; index < 50; index++) {
    db.createSteeringAttempt({
      requestId: `unresolved-${index}`, sessionId: "sess-1", submissionId: `unresolved-${index}`,
      turnId: "turn-1", source: "direct", requestSha256: index.toString(16).padStart(64, "0"),
      text: `recover ${index}`, now: index,
    });
    db.markSteeringAttemptUncertain(`unresolved-${index}`, 100 + index);
  }
  for (let index = 0; index < 20; index++) {
    const requestId = `terminal-${index}`;
    db.createSteeringAttempt({
      requestId, sessionId: "sess-1", submissionId: requestId, turnId: "turn-1", source: "direct",
      requestSha256: (100 + index).toString(16).padStart(64, "0"), text: `done ${index}`, now: 1_000 + index,
    });
    db.recordSteeringResult("runner-1", {
      type: "steer_session_result", requestId, sessionId: "sess-1", submissionId: requestId,
      turnId: "turn-1", disposition: "accepted", reason: "accepted",
    }, 2_000 + index);
  }
  const projected = db.getSession("sess-1")!.steeringAttempts!;
  assert.equal(projected.length, 50);
  assert.equal(projected.every((attempt) => attempt.state === "uncertain"), true);
  assert.equal(new Set(projected.map((attempt) => attempt.submissionId)).size, 50);
  assert.equal(projected.some((attempt) => attempt.submissionId === "unresolved-0"), true,
    "the oldest unresolved recovery remains visible behind newer terminal receipts");
  assert.equal(db.steeringRecoveryAdmissionCount("sess-1"), 50);
});

test("malformed queue snapshots fail closed without freezing a later valid overlay", () => {
  const db = withRunner();
  db.createSession(newSession());
  assert.equal(db.recordSteeringQueueSnapshot("sess-1", ["ordinary-queued"], 1), true);
  assert.equal(db.recordSteeringQueueSnapshot("sess-1", ["duplicate", "duplicate"], 2), false);
  assert.equal(db.recordSteeringQueueSnapshot(
    "sess-1", Array.from({ length: 101 }, (_, index) => `overflow-${index}`), 3,
  ), false);
  let snapshot = db.raw().prepare(
    "SELECT revision,prompt_ids_json FROM session_steering_queue_snapshots WHERE session_id='sess-1'",
  ).get() as unknown as { revision: number; prompt_ids_json: string };
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(JSON.parse(snapshot.prompt_ids_json), ["ordinary-queued"]);
  assert.equal(db.recordSteeringQueueSnapshot("sess-1", ["later-valid"], 4), true);
  snapshot = db.raw().prepare(
    "SELECT revision,prompt_ids_json FROM session_steering_queue_snapshots WHERE session_id='sess-1'",
  ).get() as unknown as { revision: number; prompt_ids_json: string };
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(JSON.parse(snapshot.prompt_ids_json), ["later-valid"]);
});

test("steering resolution results validate and correlate before resolving recovery", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.createSteeringAttempt({
    requestId: "steer-resolution-db", sessionId: "sess-1", submissionId: "submission-resolution-db",
    turnId: "turn-1", source: "direct", requestSha256: "7".repeat(64), text: "recover", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-resolution-db", 2);
  const staged = db.stageSteeringResolution(
    "sess-1", "submission-resolution-db", "dismiss", "resolve-db", 3,
  );
  assert.equal(staged.kind, "staged");
  assert.equal(db.recordSteeringResolutionResult("runner-1", {
    type: "resolve_steering_attempt_result", requestId: "resolve-db", sessionId: "sess-1",
    submissionId: "submission-resolution-db", action: "dismiss", applied: true,
    queuedPromptId: "illegal-for-dismiss",
  }, 4), null);
  assert.equal(db.recordSteeringResolutionResult("wrong-runner", {
    type: "resolve_steering_attempt_result", requestId: "resolve-db", sessionId: "sess-1",
    submissionId: "submission-resolution-db", action: "dismiss", applied: true,
  }, 5), null);
  assert.equal(db.steeringRecoveryAdmissionCount("sess-1"), 1);
  const resolved = db.recordSteeringResolutionResult("runner-1", {
    type: "resolve_steering_attempt_result", requestId: "resolve-db", sessionId: "sess-1",
    submissionId: "submission-resolution-db", action: "dismiss", applied: true,
  }, 6);
  assert.deepEqual(resolved?.resolution, { action: "dismiss", state: "applied" });
  assert.equal(db.steeringRecoveryAdmissionCount("sess-1"), 0);
});

test("pending steering resolution commands survive a control-plane database restart", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-steering-resolution-restart-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(path);
    db.registerRunner(meta(), 1);
    db.createSession(newSession());
    db.createSteeringAttempt({
      requestId: "steer-restart", sessionId: "sess-1", submissionId: "submission-restart",
      turnId: "turn-1", source: "direct", requestSha256: "e".repeat(64), text: "recover", now: 2,
    });
    db.markSteeringAttemptUncertain("steer-restart", 3);
    const staged = db.stageSteeringResolution(
      "sess-1", "submission-restart", "dismiss", "resolve-restart", 4,
    );
    assert.equal(staged.kind, "staged");
    db.close();

    db = ControlPlaneDb.open(path);
    assert.deepEqual(db.pendingSteeringResolutionMessages("runner-1"), [{
      type: "resolve_steering_attempt",
      requestId: "resolve-restart",
      sessionId: "sess-1",
      submissionId: "submission-restart",
      action: "dismiss",
    }]);
    assert.equal(db.steeringRecoveryAdmissionCount("sess-1"), 1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("converted steering retains owned images while queued and releases them after authoritative absence", () => {
  const db = withRunner();
  db.createSession(newSession());
  const artifact = createSteeringPromptImage(db, "sess-1", "converted-owned-image");
  assert.equal(db.recordSteeringQueueSnapshot("sess-1", [], 1), true);
  db.createSteeringAttempt({
    requestId: "steer-converted", sessionId: "sess-1", submissionId: "submission-converted",
    turnId: "turn-1", source: "direct", requestSha256: "8".repeat(64), text: "queue me",
    images: [artifact], ownedArtifactIds: [artifact.artifactId], now: 2,
  });
  assert.equal(db.recordSteeringQueueSnapshot("sess-1", ["queued-converted"], 3), true,
    "the authoritative queue frame may arrive before its steering receipt");
  assert.equal(db.recordSteeringResult("runner-1", {
    type: "steer_session_result", requestId: "steer-converted", sessionId: "sess-1",
    submissionId: "submission-converted", turnId: "turn-1", disposition: "converted_to_queue",
    reason: "stale_turn", queuedPromptId: "queued-converted",
  }, 4)?.state, "converted_to_queue");
  db.raw().prepare("UPDATE session_steering_attempts SET terminal_at=0 WHERE request_id='steer-converted'").run();
  const retention = 30 * 24 * 60 * 60_000;
  assert.equal(db.compactSteeringAttempts(retention), 0,
    "a converted image remains owned even after retention while its queue id is present");
  assert.ok(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(artifact.artifactId));

  assert.equal(db.recordSteeringQueueSnapshot("sess-1", [], retention + 1), true);
  assert.equal(db.compactSteeringAttempts(retention + 1), 1,
    "queue drain or cancellation authoritatively releases the converted attachment");
  assert.equal(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(artifact.artifactId), undefined);
});

test("hydrated history can reuse one prompt image across multiple committed events", () => {
  const db = withRunner();
  db.createRun({
    id: "hydrated-image-run", title: "Hydrated Images", prompt: "", workspaceId: "ws-1",
    runnerId: "runner-1", now: 1,
  });
  db.createSession(newSession({ id: "hydrated-image-session", runId: "hydrated-image-run" }));
  db.createSession(newSession({ id: "hydrated-image-outsider" }));
  const artifact = createScreenshotArtifact(
    db, { runId: "hydrated-image-run" }, "hydrated-shared-image", { contract: "workflow-screenshot" },
  );
  const outsiderArtifact = createScreenshotArtifact(
    db, { sessionId: "hydrated-image-outsider" }, "hydrated-outsider-image", { contract: "workflow-screenshot" },
  );
  const reference = {
    artifactId: artifact.artifactId,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  };
  const outsiderReference = {
    artifactId: outsiderArtifact.artifactId,
    mimeType: outsiderArtifact.mimeType,
    sizeBytes: outsiderArtifact.sizeBytes,
    sha256: outsiderArtifact.sha256,
  };
  db.reconcileRunnerHistory("hydrated-image-session", 11, 5);
  const applied = db.appendHydratedPage(
    "hydrated-image-session",
    { afterSeq: 0, historyEpoch: 11, eventEpoch: 0 },
    [
      { seq: 1, ts: 1, payload: { kind: "user_message", text: "first use", images: [reference] } },
      { seq: 2, ts: 2, payload: {
        kind: "user_message", text: "tampered", images: [{ ...reference, sha256: "0".repeat(64) }],
      } },
      { seq: 3, ts: 3, payload: {
        kind: "user_message", text: "malformed", images: [{ mimeType: "image/jpeg", data: "not-base64" }],
      } },
      { seq: 4, ts: 4, payload: {
        kind: "user_message", text: "cross scope", images: [outsiderReference],
      } },
      { seq: 5, ts: 5, payload: { kind: "user_message", text: "second use", images: [reference] } },
    ],
  );
  assert.equal(applied.applied, true);
  assert.equal(db.getHydratedSeq("hydrated-image-session"), 5);
  assert.equal(db.listEvents("hydrated-image-session").length, 5);
  assert.equal(Number((db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
  ).get(artifact.artifactId) as unknown as { count: number }).count), 2);
  assert.equal(Number((db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
  ).get(outsiderArtifact.artifactId) as unknown as { count: number }).count), 0);
});

test("user-message image linking matches exact session and fork screenshot ownership", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "image-owner" }));
  db.createSession(newSession({ id: "image-child" }));
  db.createSession(newSession({ id: "image-unrelated" }));
  db.recordSessionFork("image-child", "image-owner", 1, 1);
  const artifact = createScreenshotArtifact(
    db, { sessionId: "image-owner" }, "workflow-session-screenshot", { contract: "workflow-screenshot" },
  );
  const reference = {
    artifactId: artifact.artifactId, mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes, sha256: artifact.sha256,
  };
  assert.doesNotThrow(() => db.appendEvent(
    "image-owner", { kind: "user_message", text: "exact", images: [reference] }, 1,
  ));
  assert.doesNotThrow(() => db.appendEvent(
    "image-child", { kind: "user_message", text: "inherited", images: [reference] }, 2,
  ));
  assert.doesNotThrow(() => db.appendEvent(
    "image-unrelated", { kind: "user_message", text: "cross scope", images: [reference] }, 3,
  ));
  assert.doesNotThrow(() => db.appendEvent(
    "image-owner", {
      kind: "user_message", text: "tampered", images: [{ ...reference, sha256: "0".repeat(64) }],
    }, 4,
  ));
  assert.equal(db.listEvents("image-unrelated").length, 1);
  assert.equal(db.listEvents("image-owner").length, 2);
  assert.equal(Number((db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
  ).get(artifact.artifactId) as unknown as { count: number }).count), 2,
  "only the exact-session and recorded-fork events receive artifact reachability");
});

test("steering compaction rolls back artifact release and retries after a failed delete", () => {
  const db = withRunner();
  db.createSession(newSession());
  const artifact = createSteeringPromptImage(db, "sess-1", "crash-safe-owned-image");
  db.createSteeringAttempt({
    requestId: "steer-delete-failure", sessionId: "sess-1", submissionId: "submission-delete-failure",
    turnId: "turn-1", source: "direct", requestSha256: "9".repeat(64), text: "reject me",
    images: [artifact], ownedArtifactIds: [artifact.artifactId], now: 1,
  });
  db.recordSteeringResult("runner-1", {
    type: "steer_session_result", requestId: "steer-delete-failure", sessionId: "sess-1",
    submissionId: "submission-delete-failure", turnId: "turn-1", disposition: "rejected",
    reason: "provider_rejected",
  }, 2);
  db.raw().prepare("UPDATE session_steering_attempts SET terminal_at=0 WHERE request_id='steer-delete-failure'").run();
  db.raw().exec(
    `CREATE TRIGGER fail_owned_image_delete BEFORE DELETE ON artifacts
     WHEN OLD.id='crash-safe-owned-image' BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;`,
  );
  const retention = 30 * 24 * 60 * 60_000;
  assert.throws(() => db.compactSteeringAttempts(retention), /simulated delete failure/);
  const retained = db.raw().prepare(
    `SELECT attempt.compacted_at, COUNT(owned.artifact_id) AS owners
       FROM session_steering_attempts attempt
       LEFT JOIN session_steering_attempt_artifacts owned ON owned.request_id=attempt.request_id
      WHERE attempt.request_id='steer-delete-failure' GROUP BY attempt.request_id`,
  ).get() as unknown as { compacted_at: number | null; owners: number };
  assert.equal(retained.compacted_at, null);
  assert.equal(Number(retained.owners), 1);
  assert.ok(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(artifact.artifactId));

  db.raw().exec("DROP TRIGGER fail_owned_image_delete");
  assert.equal(db.compactSteeringAttempts(retention), 1);
  assert.equal(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(artifact.artifactId), undefined);
});

test("legacy session tombstones migrate to the durable pruning policy", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-tombstone-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(
      `CREATE TABLE session_tombstones (
         session_id TEXT PRIMARY KEY,
         runner_id TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    legacy.prepare(
      "INSERT INTO session_tombstones (session_id, runner_id, created_at) VALUES (?, ?, ?)",
    ).run("ordinary-delete", "runner-1", 100);
    legacy.close();

    const migrated = ControlPlaneDb.open(path);
    assert.deepEqual(migrated.prunableTombstoneIds("runner-1"), ["ordinary-delete"]);
    migrated.addTombstone("late-fork", "runner-1", 200, "retain");
    migrated.addTombstone("late-fork", "runner-1", 300);
    assert.deepEqual(
      migrated.tombstoneIds("runner-1").sort(),
      ["late-fork", "ordinary-delete"],
    );
    assert.deepEqual(
      migrated.prunableTombstoneIds("runner-1"),
      ["ordinary-delete"],
      "a retained cleanup tombstone cannot be downgraded by a later ordinary insert",
    );
    migrated.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.isTombstoned("late-fork"), true);
    assert.deepEqual(reopened.prunableTombstoneIds("runner-1"), ["ordinary-delete"]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session stop intents survive control-plane restart and cascade with their session", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-stop-intent-"));
  const path = join(root, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession());
    initial.addSessionStopIntent("sess-1", "runner-1", 1_100);
    assert.equal(initial.sessionArchiveStatus("sess-1"), undefined);
    initial.setSessionStopRestartLaunchId("sess-1", "launch-proof-1");
    initial.addSessionStopIntent("sess-1", "runner-1", 1_200, true);
    assert.equal(initial.listSessions()[0]?.archiveStatus, "stop_pending");
    assert.equal(initial.sessionStopRestartLaunchId("sess-1"), null);
    initial.setSessionStopRestartLaunchId("sess-1", "launch-proof-2");
    assert.deepEqual(initial.sessionStopIntentIds("runner-1"), ["sess-1"]);
    const operation = initial.getSession("sess-1")?.archiveOperation;
    assert.ok(operation?.operationId.startsWith("stop_"));
    assert.equal(operation?.attemptCount, 1);
    assert.equal(operation?.capacityReleased, false);
    initial.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.hasSessionStopIntent("sess-1"), true);
    assert.equal(reopened.getSession("sess-1")?.archiveStatus, "stop_pending");
    assert.deepEqual(reopened.getSession("sess-1")?.archiveOperation, operation);
    reopened.cancelSessionArchiveAfterStop("sess-1");
    assert.equal(reopened.getSession("sess-1")?.archiveStatus, undefined);
    assert.equal(reopened.sessionStopRestartLaunchId("sess-1"), "launch-proof-2");
    assert.deepEqual(reopened.sessionStopIntentIds("runner-1"), ["sess-1"]);
    reopened.deleteSession("sess-1");
    assert.equal(reopened.hasSessionStopIntent("sess-1"), false);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop Failed metadata and idempotent recovery survive control-plane restart", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-stop-failure-"));
  const path = join(root, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500, PROTOCOL_VERSION);
    initial.createSession(newSession());
    const intent = initial.addSessionStopIntent("sess-1", "runner-1", 1_100, true);
    assert.equal(initial.failSessionStopIntent(
      "sess-1",
      intent.operation.operationId,
      "runner_rejected",
      "The runner rejected the Stop request.",
      1_200,
    ), true);
    assert.equal(initial.getSession("sess-1")?.archiveStatus, "stop_failed");
    initial.close();

    const reopened = ControlPlaneDb.open(path);
    const failed = reopened.getSession("sess-1")?.archiveOperation;
    assert.equal(failed?.operationId, intent.operation.operationId);
    assert.equal(failed?.failure?.code, "runner_rejected");
    assert.equal(failed?.failure?.failedAt, 1_200);
    const retried = reopened.retrySessionStopIntent("sess-1", 1_300);
    assert.equal(retried?.operation.operationId, intent.operation.operationId);
    assert.equal(retried?.operation.status, "stop_pending");
    assert.equal(retried?.operation.attemptCount, 1, "explicit recovery receives a fresh retry budget");
    assert.equal(retried?.operation.requestedAt, 1_300, "explicit recovery receives a fresh timeout window");
    assert.equal(reopened.retrySessionStopIntent("sess-1", 1_400)?.operation.attemptCount, 1);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function localOwner(): HumanPrincipal {
  return {
    kind: "human",
    actorId: "usr_local_owner",
    userId: "usr_local_owner",
    userName: "Local owner",
    organizationId: "org_personal",
    organizationName: "Personal",
    role: "owner",
    deviceId: null,
    localBootstrap: true,
  };
}

/* ------------------------ Control-plane identity ------------------------ */

test("control-plane instance identity is a persistent UUID across database reopen", () => {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-instance-identity-"));
  const location = join(temp, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(location);
    const instanceId = initial.instanceId();
    assert.match(instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    initial.close();

    const reopened = ControlPlaneDb.open(location);
    assert.equal(reopened.instanceId(), instanceId);
    reopened.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("independent control-plane databases receive distinct instance identities", () => {
  const first = ControlPlaneDb.open(":memory:");
  const second = ControlPlaneDb.open(":memory:");
  try {
    assert.notEqual(first.instanceId(), second.instanceId());
  } finally {
    first.close();
    second.close();
  }
});

test("startup settlement waits for explicit ownership and still settles a genuine cold start", () => {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-startup-settlement-"));
  const location = join(temp, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(location);
    db.createBox({
      boxId: "box-1",
      runnerId: "runner-1",
      sshTarget: "test@host",
      sshPort: 22,
      workspaces: [],
      autoReconnect: false,
      runnerDataDir: null,
      now: 900,
    });
    db.registerRunner(meta(), 1_000);
    db.createSession(newSession());
    db.setBoxStatus("box-1", "online", 1_001);
    db.updateSessionStatus("sess-1", "running", 1_002);
    db.stageSessionPromptCommand({
      commandId: "cmd-startup-fence",
      sessionId: "sess-1",
      runnerId: "runner-1",
      payloadJson: JSON.stringify({ text: "undelivered" }),
      payloadSha256: "0".repeat(64),
      expiresAt: 100_000,
      now: 1_003,
    });
    db.close();
    db = undefined;

    db = ControlPlaneDb.open(location);
    assert.equal(db.getRunner("runner-1")?.status, "online", "opening SQLite alone does not claim the instance");
    assert.equal(db.getBox("box-1")?.status, "online");
    assert.equal(db.getSession("sess-1")?.status, "running");

    db.settleStartupState(2_000);
    assert.equal(db.getRunner("runner-1")?.status, "offline");
    assert.equal(db.getRunner("runner-1")?.connectedAt, null);
    assert.equal(db.getBox("box-1")?.status, "offline");
    assert.equal(db.getSession("sess-1")?.status, "stopped");
    assert.equal(db.getSession("sess-1")?.updatedAt, 2_000);
    const fenced = db.getSessionPromptCommand("cmd-startup-fence")!;
    assert.equal(fenced.state, "failed", "a never-sent prompt is fenced when settlement stops its session");
    assert.equal(fenced.errorCode, "COMMAND_CANCELLED");
    assert.deepEqual(db.dueSessionPromptCommands(100_000, "runner-1"), []);
  } finally {
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

/* ----------------------------- Runners --------------------------------- */

test("registerRunner + getRunner round-trips driver/context/capabilities via JSON columns", () => {
  const db = withRunner();
  const view = db.getRunner("runner-1");
  assert.ok(view, "runner exists");
  assert.equal(view!.runnerId, "runner-1");
  assert.equal(view!.hostname, "host-1");
  assert.equal(view!.os, "windows");
  assert.equal(view!.version, "1.2.3");
  assert.equal(view!.status, "online");
  assert.equal(view!.connectedAt, 500);
  assert.equal(view!.lastSeen, 500);

  // workspaces ordered by id
  assert.deepEqual(
    view!.workspaces,
    [
      { id: "ws-1", name: "Repo One", path: "C:/code/one", additionalDirectoryGrants: ["C:/code/shared"] },
      { id: "ws-2", name: "Repo Two", path: "C:/code/two" },
    ],
  );

  // agents ordered by agent_id -> acp-agent then claude-agent
  assert.equal(view!.agents.length, 2);
  const acp = view!.agents.find((a) => a.id === "acp-agent")!;
  assert.deepEqual(acp.args, ["--stdio", "--foo"]);
  assert.deepEqual(acp.env, {}, "runner views never expose launch environment values");
  assert.equal(acp.driver, "acp");
  assert.equal(acp.acpTransport, "stdio");
  assert.deepEqual(acp.context, { kind: "native" });
  assert.ok(acp.capabilities, "acp capabilities round-tripped");
  assert.deepEqual(acp.capabilities!.permissionModes, ["default", "acceptEdits"]);
  assert.deepEqual(acp.capabilities!.models, [
    { id: "default", displayName: "Default", default: true },
  ]);
  assert.equal(acp.source, "registry");
  assert.equal(acp.registry?.adapterVersion, "9.1.0");
  assert.equal(acp.registry?.installPreview, "npx --yes acp-agent@9.1.0");
  assert.equal(acp.acp?.sessionResume, true);

  const claude = view!.agents.find((a) => a.id === "claude-agent")!;
  assert.equal(claude.driver, "claude-code");
  assert.deepEqual(claude.context, { kind: "wsl", distro: "Ubuntu" });
  assert.equal(claude.capabilities, undefined, "missing caps -> undefined");
  assert.deepEqual(claude.args, []);
  assert.deepEqual(claude.env, {});
  assert.equal(claude.claudeCode?.status, "ready");
  assert.equal(claude.claudeCode?.auth.billingSource, "subscription");
});

test("runner runtime storage/admission diagnostics round-trip only for v32+", () => {
  const db = ControlPlaneDb.open(":memory:");
  const runtime = {
    dataDir: "C:/wollipog",
    worktreeRoot: "C:/wollipog/worktrees",
    maxConcurrentSessions: 6,
    admission: { agentLimits: { claude: 2 }, agentWeights: { claude: 2 } },
    executionIsolation: {
      mode: "bwrap" as const, network: "deny" as const,
      providerStateRetentionDays: 7, providerStateMaxBytes: 5 * 1024 ** 3,
    },
  };
  db.registerRunner(meta({ runtime }), 100, 32);
  assert.deepEqual(db.getRunner("runner-1")?.runtime, runtime);
  db.registerRunner(meta({ runtime }), 200, 31);
  assert.equal(db.getRunner("runner-1")?.runtime, undefined, "an older runner cannot advertise v32 diagnostics");
});

test("Codex app-server compatibility diagnostics round-trip and old rows may omit them", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(meta({
    agents: [{
      id: "codex",
      name: "Codex",
      command: "codex",
      args: [],
      env: {},
      driver: "codex",
      codexAppServer: {
        status: "unsupported",
        installedVersion: "0.142.3",
        appServerAvailable: true,
        transport: "stdio",
        failure: { code: "version_unverified", message: "Use the exec fallback." },
      },
    }, claudeAgent()],
  }), 500);
  const agents = db.getRunner("runner-1")!.agents;
  assert.equal(agents.find((a) => a.id === "codex")!.codexAppServer?.failure?.code, "version_unverified");
  assert.equal(agents.find((a) => a.id === "claude-agent")!.codexAppServer, undefined);
});

test("registerRunner is idempotent: re-register replaces workspaces/agents and updates fields", () => {
  const db = withRunner();
  db.registerRunner(
    meta({
      hostname: "host-renamed",
      version: "2.0.0",
      agents: [claudeAgent()],
      workspaces: [{ id: "ws-9", name: "Only", path: "/only" }],
    }),
    900,
  );
  const view = db.getRunner("runner-1")!;
  assert.equal(view.hostname, "host-renamed");
  assert.equal(view.version, "2.0.0");
  assert.equal(view.connectedAt, 900);
  assert.equal(view.agents.length, 1);
  assert.equal(view.agents[0].id, "claude-agent");
  assert.deepEqual(view.workspaces, [{ id: "ws-9", name: "Only", path: "/only" }]);
});

test("createWorkspace: CP-owned project is listed, path-resolvable, and survives re-register", () => {
  const db = withRunner();
  const ws = db.createWorkspace("runner-1", { name: "My Project", path: "C:/code/mine" });
  assert.match(ws.id, /^ws_/, "namespaced id avoids collision with runner-advertised ids");
  assert.equal(ws.name, "My Project");
  assert.equal(ws.path, "C:/code/mine");

  // Appears in the runner view (after the runner-reported workspaces) and resolves a path.
  const before = db.getRunner("runner-1")!.workspaces;
  assert.deepEqual(before.map((w) => w.id), ["ws-1", "ws-2", ws.id]);
  assert.equal(db.getWorkspacePath("runner-1", ws.id), "C:/code/mine");
  db.createSession(newSession({ id: "created-project-session", workspaceId: ws.id }));
  assert.equal(db.getSession("created-project-session")!.workspaceName, "My Project");
  db.createRun({
    id: "created-project-run",
    title: "Created project run",
    prompt: "Test the project name",
    workspaceId: ws.id,
    runnerId: "runner-1",
    now: 1_000,
  });
  assert.equal(db.getRun("created-project-run")!.workspaceName, "My Project");

  // Re-register wipes the runner-reported workspaces but the created project must persist.
  db.registerRunner(meta({ workspaces: [{ id: "ws-9", name: "Only", path: "/only" }] }), 900);
  const after = db.getRunner("runner-1")!.workspaces;
  assert.deepEqual(after.map((w) => w.id), ["ws-9", ws.id], "extras survive; reported list replaced");
  assert.equal(db.getWorkspacePath("runner-1", ws.id), "C:/code/mine");

  // A later rename override applies to the created project too.
  db.renameWorkspace("runner-1", ws.id, "Renamed");
  assert.equal(db.getRunner("runner-1")!.workspaces.find((w) => w.id === ws.id)!.name, "Renamed");
  assert.equal(db.getSession("created-project-session")!.workspaceName, "Renamed");
  assert.equal(db.getRun("created-project-run")!.workspaceName, "Renamed");
});

test("Machine names and Machine-scoped Workspaces survive re-register without creating a Project", () => {
  const db = withRunner();
  db.setMachineDisplayName("runner-1", "Primary Development Machine");
  const workspace = db.registerMachineWorkspace("runner-1", { name: "Repository", path: "/repos/example" });

  assert.equal(db.getRunner("runner-1")!.displayName, "Primary Development Machine");
  assert.equal(db.getWorkspacePath("runner-1", workspace.id), "/repos/example");
  assert.deepEqual(db.projectIdsForWorkspace("runner-1", workspace.id), []);

  db.registerRunner(meta({ hostname: "same-host", workspaces: [] }), 1_000);
  const next = db.getRunner("runner-1")!;
  assert.equal(next.displayName, "Primary Development Machine");
  assert.deepEqual(next.workspaces, [workspace]);

  db.deleteRunner("runner-1");
  db.registerRunner(meta(), 1_100);
  assert.equal(db.getRunner("runner-1")!.displayName, undefined);
  assert.equal(db.getWorkspacePath("runner-1", workspace.id), null);
});

test("deleteRunner clears CP-owned workspace_extras (no leak onto a reused runner id)", () => {
  const db = withRunner();
  const ws = db.createWorkspace("runner-1", { name: "Mine", path: "/mine" });
  db.deleteRunner("runner-1");
  // A fresh runner reusing the id must not inherit the old project.
  db.registerRunner(meta(), 1000);
  assert.equal(db.getWorkspacePath("runner-1", ws.id), null);
  assert.ok(!db.getRunner("runner-1")!.workspaces.some((w) => w.id === ws.id));
});

test("registerRunner round-trips the reported protocol version, and null means unknown (gap 5)", () => {
  const db = ControlPlaneDb.open(":memory:");
  // A pre-v15 runner reports nothing — the view says "unknown", not 0.
  db.registerRunner(meta(), 500);
  assert.equal(db.getRunner("runner-1")!.protocolVersion, null);

  // A current runner reports its build's PROTOCOL_VERSION; re-register updates it in place.
  db.registerRunner(meta(), 600, 15);
  assert.equal(db.getRunner("runner-1")!.protocolVersion, 15);
  assert.equal(db.listRunners()[0]!.protocolVersion, 15);

  // A downgrade back to an old runner must not leave the stale newer number behind.
  db.registerRunner(meta(), 700);
  assert.equal(db.getRunner("runner-1")!.protocolVersion, null);
});

test("protocol-v61 runner container targets persist, go unavailable offline, and clear on downgrade", () => {
  const db = ControlPlaneDb.open(":memory:");
  const image = `example/agent@sha256:${"1".repeat(64)}`;
  const container = {
    id: "runner:runner-1:container:offline-tools", runnerId: "runner-1", name: "host-1 · Offline tools",
    kind: "container" as const, workspaceStrategy: "worktree" as const, adapter: "container" as const,
    boundaries: { filesystem: "container" as const, network: "deny" as const, secrets: "none" as const, billing: "none" as const },
    environment: { id: "offline-tools", revision: 1, image, setupCheckDigest: "2".repeat(64) },
    compatibleAgentIds: ["acp-agent"], available: true,
  };
  db.registerRunner(meta({ executionTargets: [container] }), 500, PROTOCOL_VERSION);
  assert.deepEqual(db.getRunner("runner-1")!.executionTargets?.at(-1), container);

  db.markOffline("runner-1", 600);
  const offline = db.getRunner("runner-1")!.executionTargets?.at(-1)!;
  assert.equal(offline.available, false);
  assert.equal(offline.unavailableReason, "runner is offline");

  db.registerRunner(meta({ executionTargets: [container] }), 700, 60);
  assert.equal(db.getRunner("runner-1")!.executionTargets?.length, 2, "pre-v61 downgrade clears container claims");
});

test("protocol-v62 runner cloud targets persist policy and disappear on downgrade", () => {
  const db = ControlPlaneDb.open(":memory:");
  const cloud = {
    id: "runner:runner-1:cloud:metered-tools", runnerId: "runner-1", name: "host-1 · Metered tools",
    kind: "cloud" as const, workspaceStrategy: "snapshot" as const, adapter: "cloud" as const,
    boundaries: { filesystem: "snapshot" as const, network: "policy" as const, secrets: "references" as const, billing: "target_metered" as const },
    environment: {
      id: "metered-tools", revision: 1, image: `example/cloud@sha256:${"3".repeat(64)}`,
      setupCheckDigest: "4".repeat(64),
    },
    policy: {
      cost: { currency: "USD" as const, estimatedHourlyRateUsd: 1.25, minimumBudgetUsd: 0.5, maximumBudgetUsd: 20 },
      admission: { maxConcurrentSessions: 2, queue: "fifo" as const },
    },
    compatibleAgentIds: ["acp-agent"], available: true,
  };
  db.registerRunner(meta({ executionTargets: [cloud] }), 500, 62);
  assert.deepEqual(db.getRunner("runner-1")!.executionTargets?.at(-1), cloud);
  db.registerRunner(meta({ executionTargets: [] }), 600, 61);
  assert.equal(db.getRunner("runner-1")!.executionTargets?.some((target) => target.adapter === "cloud"), false);
});

test("editors: persist across a pre-discovery re-register, but hide when the runner is pre-v22", () => {
  const db = ControlPlaneDb.open(":memory:");
  const editors = [{ id: "code", name: "VS Code" }];

  // v22 runner registers with editors → visible.
  db.registerRunner(meta({ editors }), 500, 22);
  assert.deepEqual(db.getRunner("runner-1")!.editors, editors);

  // A reconnect whose register frame predates the discovery pass (no editors field) keeps
  // the previous list (COALESCE) — the button must not flicker away on every reconnect.
  db.registerRunner(meta(), 600, 22);
  assert.deepEqual(db.getRunner("runner-1")!.editors, editors);

  // Discovery pushes a fresh list → replaced.
  db.updateRunnerAgents("runner-1", [], 700, [{ id: "zed", name: "Zed" }]);
  assert.deepEqual(db.getRunner("runner-1")!.editors, [{ id: "zed", name: "Zed" }]);

  // Downgrade: an old (or version-less) runner reusing this id can't handle host_action —
  // the persisted column must not leak stale editors into the view.
  db.registerRunner(meta(), 800, 15);
  assert.equal(db.getRunner("runner-1")!.editors, undefined);
  db.registerRunner(meta(), 900);
  assert.equal(db.getRunner("runner-1")!.editors, undefined);

  // Upgrading back to v22 re-exposes the persisted list.
  db.registerRunner(meta(), 1000, 22);
  assert.deepEqual(db.getRunner("runner-1")!.editors, [{ id: "zed", name: "Zed" }]);
});

test("agentsRefreshed: register resets the marker, a discovery push sets it (gap 15 gating)", () => {
  const db = withRunner();
  // Fresh register: discovery hasn't reported yet — an empty agent list means "probing", so the
  // UI must not show install guidance off it.
  assert.equal(db.getRunner("runner-1")!.agentsRefreshed, false);

  // agents_updated (a completed discovery pass) flips it — even for an EMPTY result, which is
  // exactly the "no agent CLIs installed" case the install hints exist for.
  db.updateRunnerAgents("runner-1", [], 800);
  assert.equal(db.getRunner("runner-1")!.agentsRefreshed, true);
  assert.equal(db.listRunners()[0]!.agentsRefreshed, true);

  // A re-register (reconnect / runner restart) resets it until the next agents_updated.
  db.registerRunner(meta(), 900);
  assert.equal(db.getRunner("runner-1")!.agentsRefreshed, false);
});

test("getAgentLaunch returns command/args/env/driver/context/version", () => {
  const db = withRunner();
  const launch = db.getAgentLaunch("runner-1", "acp-agent");
  assert.ok(launch);
  assert.equal(launch!.command, "acp-bin");
  assert.deepEqual(launch!.args, ["--stdio", "--foo"]);
  assert.deepEqual(launch!.env, { TOKEN: "abc", DEBUG: "1" });
  assert.equal(launch!.driver, "acp");
  assert.deepEqual(launch!.context, { kind: "native" });
  assert.equal(launch!.version, "9.1.0");

  const wsl = db.getAgentLaunch("runner-1", "claude-agent")!;
  assert.equal(wsl.driver, "claude-code");
  assert.deepEqual(wsl.context, { kind: "wsl", distro: "Ubuntu" });

  assert.equal(db.getAgentLaunch("runner-1", "nope"), null);
  assert.equal(db.getAgentLaunch("nope", "acp-agent"), null);
});

test("protocol-v54 runner agent environment is never persisted by the control plane", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(meta(), 500, 54);
  assert.deepEqual(db.getAgentLaunch("runner-1", "acp-agent")?.env, {});
  assert.deepEqual(db.getRunner("runner-1")?.agents.find((agent) => agent.id === "acp-agent")?.env, {});

  db.updateRunnerAgents("runner-1", [acpAgent()], 600);
  assert.deepEqual(db.getAgentLaunch("runner-1", "acp-agent")?.env, {});
  db.close();
});

test("side-chat relationships persist separately from provider forks and cascade on child deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-side-chat-"));
  const path = join(dir, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession({ id: "primary" }));
    initial.createSession(newSession({ id: "auxiliary", archived: true, useWorktree: true }));
    initial.recordSideChat("primary", "auxiliary", 1_234);
    assert.equal(initial.sessionForkIncludesAncestor("auxiliary", "primary"), false);
    initial.close();

    const reopened = ControlPlaneDb.open(path);
    assert.deepEqual(reopened.getSideChat("primary"), {
      parentSessionId: "primary",
      childSessionId: "auxiliary",
      createdAt: 1_234,
    });
    assert.equal(reopened.sideChatParent("auxiliary"), "primary");
    reopened.deleteSession("auxiliary");
    assert.equal(reopened.getSideChat("primary"), null);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup scrub clears legacy agent env and settles durable commands containing values", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-secret-scrub-"));
  const path = join(dir, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500, 53);
    initial.close();

    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.prepare(
      `INSERT INTO automation_executions
       (execution_id, automation_id, idempotency_key, scheduled_for, action_kind, status, actor_kind, created_at)
       VALUES ('exec_secret', 'legacy', 'secret-key', 1, 'create_session', 'running', 'system', 1)`,
    ).run();
    const payload = JSON.stringify({ type: "start_session", spec: { env: { TOKEN: "durable-secret-sentinel" } } });
    const insert = raw.prepare(
      `INSERT INTO automation_commands
       (command_id, execution_id, ordinal, runner_id, session_id, kind, payload_json, payload_sha256,
        state, created_at, updated_at)
       VALUES (?, 'exec_secret', ?, 'runner-1', ?, 'start_session', ?, ?, ?, 1, 1)`,
    );
    insert.run("cmd_pending", 0, "session-pending", payload, "a".repeat(64), "pending");
    insert.run("cmd_started", 1, "session-started", payload, "b".repeat(64), "started");
    raw.close();

    const reopened = ControlPlaneDb.open(path);
    assert.deepEqual(reopened.scrubLegacyAgentSecrets(1_000), { agentRows: 1, commands: 2 });
    assert.deepEqual(reopened.getAgentLaunch("runner-1", "acp-agent")?.env, {});
    reopened.close();

    const checked = new DatabaseSync(path);
    const commands = checked.prepare(
      "SELECT command_id, state, payload_json FROM automation_commands ORDER BY command_id",
    ).all() as unknown as Array<{ command_id: string; state: string; payload_json: string }>;
    checked.close();
    assert.deepEqual(commands.map((command) => ({ ...command })), [
      { command_id: "cmd_pending", state: "rejected", payload_json: "null" },
      { command_id: "cmd_started", state: "uncertain", payload_json: "null" },
    ]);
    assert.equal(readFileSync(path).includes(Buffer.from("durable-secret-sentinel")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driver telemetry stores content-free hourly aggregates and clamps durations", () => {
  const db = withRunner();
  const event = {
    type: "driver_telemetry" as const,
    metric: "launch" as const,
    driver: "codex-app-server" as const,
    version: "0.144.1",
    context: "native" as const,
    outcome: "success" as const,
    durationMs: 250,
    reason: "fresh" as const,
  };
  db.recordDriverTelemetry(event, false, 3_700_000);
  db.recordDriverTelemetry({ ...event, durationMs: 400 }, false, 3_799_000);
  db.recordDriverTelemetry({ ...event, durationMs: Number.MAX_SAFE_INTEGER }, true, 7_300_000);

  const rows = db.listDriverTelemetry(0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    bucketTs: 3_600_000,
    driver: "codex-app-server",
    version: "0.144.1",
    context: "native",
    remote: false,
    metric: "launch",
    outcome: "success",
    reason: "fresh",
    count: 2,
    totalMs: 650,
    maxMs: 400,
  });
  assert.equal(rows[1]!.totalMs, 86_400_000, "one observation is capped at 24 hours");
  const summary = db.summarizeDriverTelemetry(0);
  assert.equal(summary.length, 2, "local and remote dimensions remain distinct");
  assert.deepEqual(summary[0], {
    driver: "codex-app-server",
    version: "0.144.1",
    context: "native",
    remote: false,
    metric: "launch",
    outcome: "success",
    reason: "fresh",
    count: 2,
    totalMs: 650,
    maxMs: 400,
  });
  db.recordDriverTelemetry({ ...event, durationMs: Number.NaN, outcome: "failure" }, false, 3_800_000);
  const nonFinite = db.listDriverTelemetry(0).find((row) => row.outcome === "failure");
  assert.equal(nonFinite?.totalMs, 0, "direct DB callers cannot persist a non-finite duration");
});

test("driver telemetry prunes hourly buckets older than 180 days while the control plane stays up", () => {
  const db = withRunner();
  const event = {
    type: "driver_telemetry" as const,
    metric: "crash" as const,
    driver: "claude-code" as const,
    context: "native" as const,
    outcome: "failure" as const,
    reason: "agent_exit" as const,
  };
  db.recordDriverTelemetry(event, false, 86_400_000);
  db.recordDriverTelemetry(event, false, 182 * 86_400_000);
  const rows = db.listDriverTelemetry(0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.bucketTs, 182 * 86_400_000);
});

test("usage accounting is exact, parentless-only, and transactionally follows accepted events", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 10, outputTokens: 2, costUsd: 0.1 }, 3_600_100, { accrueUsage: true });
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 5, outputTokens: 1, costUsd: 0.2 }, 3_600_200, { accrueUsage: true });
  db.appendEvent("sess-1", {
    kind: "token_usage", inputTokens: 999, outputTokens: 999, costUsd: 99, parentToolUseId: "subagent",
  }, 3_600_300, { accrueUsage: true });

  const usage = db.queryUsageAggregation(localOwner(), {
    since: 0, through: 10_000_000, granularity: "hour",
  });
  assert.deepEqual(usage.totals, { inputTokens: 15, outputTokens: 3, costUsd: 0.3 });
  assert.deepEqual(usage.series, [{ bucketTs: 3_600_000, inputTokens: 15, outputTokens: 3, costUsd: 0.3 }]);
  assert.equal(db.getSession("sess-1")!.costUsd, 0.3, "the session total moves in the same transaction");
  assert.equal(db.raw().prepare("SELECT cost_microusd FROM usage_hourly").get()!.cost_microusd, 300_000);
});

test("usage aggregation returns newest buckets first across hourly and daily boundaries", () => {
  const db = withRunner();
  db.createSession(newSession());
  const olderHour = Date.UTC(2025, 11, 31, 23);
  const newerHour = Date.UTC(2026, 0, 1, 0);
  const partialHour = Date.UTC(2026, 0, 1, 1);
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 2 }, newerHour + 1, { accrueUsage: true });
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 1 }, olderHour + 1, { accrueUsage: true });
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 4 }, partialHour + 1, { accrueUsage: true });
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 8 }, newerHour + 2, { accrueUsage: true });

  const hourly = db.queryUsageAggregation(localOwner(), {
    since: olderHour, through: partialHour + 3_600_000, granularity: "hour",
  });
  assert.deepEqual(hourly.series.map((bucket) => bucket.bucketTs), [partialHour, newerHour, olderHour]);
  assert.equal(hourly.series[1]!.inputTokens, 10);

  const daily = db.queryUsageAggregation(localOwner(), {
    since: olderHour, through: partialHour + 3_600_000, granularity: "day",
  });
  assert.deepEqual(daily.series.map((bucket) => bucket.bucketTs), [Date.UTC(2026, 0, 1), Date.UTC(2025, 11, 31)]);
});

test("sub-micro event costs accumulate without exceeding an authoritative cumulative snapshot", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.appendEvent("sess-1", { kind: "token_usage", costUsd: 0.0000006 }, 1_000, { accrueUsage: true });
  db.appendEvent("sess-1", { kind: "token_usage", costUsd: 0.0000006 }, 2_000, { accrueUsage: true });
  assert.equal(db.getSession("sess-1")!.costUsd, 0.0000012);
  db.updateSessionFromSnapshot("sess-1", snapshot({ id: "sess-1", costUsd: 0.0000012, seq: 2 }), 3_000);
  assert.equal(db.getSession("sess-1")!.costUsd, 0.0000012, "authoritative cumulative truth cannot be exceeded by per-event rounding");
  assert.equal(db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" }).totals.costUsd, 0.000001);
});

test("a stale snapshot cannot replace a newer fractional cost within the same rounded micro-USD", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({ id: "fractional-stale", costUsd: 0.0000014 }), "runner-1", 1_000);
  db.updateSessionFromSnapshot("fractional-stale", snapshot({ id: "fractional-stale", costUsd: 0.0000011 }), 2_000);
  assert.equal(db.getSession("fractional-stale")!.costUsd, 0.0000014);
  db.appendEvent("fractional-stale", { kind: "token_usage", costUsd: 0.0000002 }, 3_000, { accrueUsage: true });
  assert.ok(Math.abs(db.getSession("fractional-stale")!.costUsd - 0.0000016) < 1e-15);
  assert.equal(db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" }).totals.costUsd, 0.000002);
});

test("snapshot fractional cost becomes the baseline for later sub-micro events", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({ id: "fractional-snapshot", costUsd: 0.0000012 }), "runner-1", 1_000);
  db.appendEvent("fractional-snapshot", { kind: "token_usage", costUsd: 0.0000008 }, 2_000, { accrueUsage: true });
  const usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.equal(usage.totals.costUsd, 0.000002);
  assert.equal(db.getSession("fractional-snapshot")!.costUsd, 0.000002);
});

test("snapshot residuals and indexed source coverage prevent cold-history and replay double counting", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({
    id: "usage-history", historyEpoch: 7, seq: 2, tokensIn: 10, tokensOut: 4, costUsd: 1,
  }), "runner-1", 2_000);

  const cold = db.appendHydratedPage(
    "usage-history",
    { afterSeq: 0, historyEpoch: 7, eventEpoch: 0 },
    [
      { seq: 1, ts: 100, payload: { kind: "token_usage", inputTokens: 10, outputTokens: 4, costUsd: 1 } },
      { seq: 2, ts: 101, payload: { kind: "agent_message", text: "already covered" } },
    ],
  );
  assert.equal(cold.applied, true);
  let usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.deepEqual(usage.totals, { inputTokens: 10, outputTokens: 4, costUsd: 1 });

  db.reconcileRunnerHistory("usage-history", 7, 3);
  db.appendHydratedPage(
    "usage-history",
    { afterSeq: 2, historyEpoch: 7, eventEpoch: 0 },
    [{ seq: 3, ts: 3_000, payload: { kind: "token_usage", inputTokens: 5, outputTokens: 1, costUsd: 0.5 } }],
  );
  db.updateSessionFromSnapshot("usage-history", snapshot({
    id: "usage-history", historyEpoch: 7, seq: 3, tokensIn: 15, tokensOut: 5, costUsd: 1.5,
  }), 4_000);
  db.updateSessionFromSnapshot("usage-history", snapshot({
    id: "usage-history", historyEpoch: 7, seq: 3, tokensIn: 12, tokensOut: 4, costUsd: 1,
  }), 4_100);
  db.updateSessionFromSnapshot("usage-history", snapshot({
    id: "usage-history", historyEpoch: 7, seq: 3, tokensIn: 20, tokensOut: 6, costUsd: 2,
  }), 5_000);

  usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.deepEqual(usage.totals, { inputTokens: 20, outputTokens: 6, costUsd: 2 });
  assert.equal(db.getSession("usage-history")!.costUsd, 2, "a stale lower snapshot cannot roll the session back");

  db.updateSessionFromSnapshot("usage-history", snapshot({
    id: "usage-history", historyEpoch: 8, seq: 1, tokensIn: 20, tokensOut: 6, costUsd: 2,
  }), 6_000);
  db.appendHydratedPage(
    "usage-history",
    { afterSeq: 0, historyEpoch: 8, eventEpoch: 1 },
    [{ seq: 1, ts: 50, payload: { kind: "token_usage", inputTokens: 20, outputTokens: 6, costUsd: 2 } }],
  );
  usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.deepEqual(usage.totals, { inputTokens: 20, outputTokens: 6, costUsd: 2 }, "reissued history in a new epoch is covered by the snapshot");
});

test("the first known history epoch preserves legacy coverage and accrues its first uncovered event", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({
    id: "usage-adopt", historyEpoch: undefined, seq: 1, tokensIn: 10, costUsd: 1,
  }), "runner-1", 1_000);
  db.raw().prepare("UPDATE sessions SET runner_history_epoch=7, hydrated_seq=1, runner_history_tail_seq=2 WHERE id='usage-adopt'").run();
  const applied = db.appendHydratedPage(
    "usage-adopt",
    { afterSeq: 1, historyEpoch: 7, eventEpoch: 0 },
    [{ seq: 2, ts: 2_000, payload: { kind: "token_usage", inputTokens: 5, costUsd: 0.5 } }],
  );
  assert.equal(applied.applied, true);
  const usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.deepEqual(usage.totals, { inputTokens: 15, outputTokens: 0, costUsd: 1.5 });
});

test("legacy unknown-epoch hydration cannot claim a known generation was replaced", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({
    id: "usage-downgrade", historyEpoch: 7, seq: 1, tokensIn: 10, costUsd: 1,
  }), "runner-1", 1_000);
  db.appendEvent(
    "usage-downgrade",
    { kind: "token_usage", inputTokens: 5, costUsd: 0.5 },
    2_000,
    { accrueUsage: true, runnerSeq: 2, historyEpoch: null },
  );
  const usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.deepEqual(usage.totals, { inputTokens: 15, outputTokens: 0, costUsd: 1.5 });
});

test("a page-first replacement epoch covers the whole replay page before usage accounting", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({
    id: "usage-page-first-reset", historyEpoch: 7, seq: 2, tokensIn: 10, costUsd: 1,
  }), "runner-1", 1_000);
  db.reconcileRunnerHistory("usage-page-first-reset", 8, 2);
  const applied = db.appendHydratedPage(
    "usage-page-first-reset",
    { afterSeq: 0, historyEpoch: 8, eventEpoch: 1 },
    [
      { seq: 1, ts: 2_000, payload: { kind: "token_usage", inputTokens: 6, costUsd: 0.6 } },
      { seq: 2, ts: 2_001, payload: { kind: "token_usage", inputTokens: 4, costUsd: 0.4 } },
    ],
  );
  assert.equal(applied.applied, true);
  const usage = db.queryUsageAggregation(localOwner(), { since: 0, through: 10_000, granularity: "hour" });
  assert.deepEqual(usage.totals, { inputTokens: 10, outputTokens: 0, costUsd: 1 });
  assert.equal(db.getSession("usage-page-first-reset")!.costUsd, 1);
});

test("retention rolls hourly usage into UTC days before deletion and late rows remain idempotent", () => {
  const db = withRunner();
  assert.throws(() => db.setUsageRetentionPolicy("org_personal", { hourlyDays: 7.5, dailyDays: 30 }), /hourlyDays/);
  db.createSession(newSession());
  const day = 86_400_000;
  const now = 40 * day;
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 3, costUsd: 0.125001 }, 10 * day + 3_599_999, { accrueUsage: true });
  db.appendEvent("sess-1", { kind: "token_usage", outputTokens: 4, costUsd: 0.25 }, 10 * day + 3_600_000, { accrueUsage: true });
  db.setUsageRetentionPolicy("org_personal", { hourlyDays: 1, dailyDays: 30 }, now);
  assert.equal(db.raw().prepare("SELECT COUNT(*) AS count FROM usage_hourly").get()!.count, 0);
  assert.equal(db.raw().prepare("SELECT COUNT(*) AS count FROM usage_daily").get()!.count, 1, "both UTC hours roll into one day");

  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 2, costUsd: 0.000001 }, 10 * day + 7_200_000, { accrueUsage: true });
  let usage = db.queryUsageAggregation(localOwner(), { since: 9 * day, through: 11 * day, granularity: "day" });
  assert.deepEqual(usage.totals, { inputTokens: 5, outputTokens: 4, costUsd: 0.375002 });
  db.maintainUsageAggregation(now, "org_personal");
  usage = db.queryUsageAggregation(localOwner(), { since: 9 * day, through: 11 * day, granularity: "day" });
  assert.deepEqual(usage.totals, { inputTokens: 5, outputTokens: 4, costUsd: 0.375002 }, "rerolling a late hour adds it once");
  assert.equal(db.listEvents("sess-1").length, 3, "aggregate retention never touches transcripts");
  assert.equal(db.getSession("sess-1")!.costUsd, 0.375002, "aggregate retention never changes session budget totals");

  db.setUsageRetentionPolicy("org_personal", { hourlyDays: 30, dailyDays: 30 }, now);
  usage = db.queryUsageAggregation(localOwner(), { since: 9 * day, through: 11 * day, granularity: "hour" });
  assert.equal(usage.granularity, "day", "rolled rows force a complete daily response after hourly retention expands");
  assert.deepEqual(usage.totals, { inputTokens: 5, outputTokens: 4, costUsd: 0.375002 });
});

test("runner timestamps cannot trigger retention maintenance for another organization", () => {
  const db = withRunner();
  db.createSession(newSession());
  const currentDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  db.raw().prepare("INSERT INTO usage_retention_policy VALUES ('org_other', 1, 30, ?, ?)").run(currentDay - 86_400_000, Date.now());
  db.raw().prepare(
    `INSERT INTO usage_daily
       (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
        input_tokens, output_tokens, cost_microusd)
     VALUES (?, 'org_other', 'organization', 'org_other', 'other-runner', '', '', 'acp', '', 1, 0, 1)`,
  ).run(currentDay - 86_400_000);
  const farFuture = Date.now() + 10 * 365 * 86_400_000;
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 1 }, farFuture, { accrueUsage: true });
  assert.throws(() => db.appendHydratedPage(
    "sess-1",
    { afterSeq: 0, historyEpoch: 1, eventEpoch: 0 },
    [{ seq: 2, ts: farFuture, payload: { kind: "agent_message", text: "invalid gap" } }],
  ), /contiguous/);
  assert.equal(db.raw().prepare("SELECT COUNT(*) AS count FROM usage_daily WHERE organization_id='org_other'").get()!.count, 1);
});

test("daily pruning advances the advertised aggregate coverage frontier", () => {
  const db = withRunner();
  const day = 86_400_000;
  const now = Date.now();
  db.raw().prepare("UPDATE usage_retention_policy SET coverage_started_at=? WHERE organization_id='org_personal'")
    .run(now - 200 * day);
  db.raw().prepare(
    `INSERT INTO usage_daily
       (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
        input_tokens, output_tokens, cost_microusd)
     VALUES (?, 'org_personal', 'organization', 'org_personal', 'runner-1', '', '', 'acp', '', 1, 0, 1)`,
  ).run(Math.floor((now - 100 * day) / day) * day);
  db.setUsageRetentionPolicy("org_personal", { hourlyDays: 7, dailyDays: 30 }, now);
  const shortened = db.getUsageRetentionPolicy("org_personal");
  assert.ok(shortened.coverageStartedAt >= Math.floor((now - 30 * day) / day) * day);
  db.setUsageRetentionPolicy("org_personal", { hourlyDays: 30, dailyDays: 365 }, now + 1);
  assert.equal(db.getUsageRetentionPolicy("org_personal").coverageStartedAt, shortened.coverageStartedAt,
    "re-expansion cannot advertise data that shortening permanently deleted");
});

test("usage migration seeds an unbucketed lifetime baseline exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-usage-baseline-"));
  const file = join(root, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(file);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession());
    initial.raw().prepare("UPDATE sessions SET input_tokens=100, output_tokens=20, cost_usd=3.25 WHERE id='sess-1'").run();
    // Model a pre-feature database at cutover: usage tables exist only because this test runs the
    // current schema, so remove the marker/state the upgrader would not have seen yet.
    initial.raw().prepare("DELETE FROM usage_session_state").run();
    initial.raw().prepare("DELETE FROM usage_aggregation_meta").run();
    initial.raw().prepare("DELETE FROM usage_retention_policy").run();
    initial.close();

    const upgraded = ControlPlaneDb.open(file);
    let usage = upgraded.queryUsageAggregation(localOwner(), { since: 0, through: Date.now() + 1, granularity: "hour" });
    assert.deepEqual(usage.totals, { inputTokens: 0, outputTokens: 0, costUsd: 0 }, "lifetime totals are not fabricated into a historical bucket");
    upgraded.updateSessionFromSnapshot("sess-1", snapshot({
      id: "sess-1", tokensIn: 100, tokensOut: 20, costUsd: 3.25, seq: 4,
    }), Date.now());
    usage = upgraded.queryUsageAggregation(localOwner(), { since: 0, through: Date.now() + 1, granularity: "hour" });
    assert.deepEqual(usage.totals, { inputTokens: 0, outputTokens: 0, costUsd: 0 }, "the first matching reconnect cannot charge the baseline again");
    upgraded.updateSessionFromSnapshot("sess-1", snapshot({
      id: "sess-1", tokensIn: 105, tokensOut: 22, costUsd: 3.5, seq: 5,
    }), Date.now());
    usage = upgraded.queryUsageAggregation(localOwner(), { since: 0, through: Date.now() + 1, granularity: "hour" });
    assert.deepEqual(usage.totals, { inputTokens: 5, outputTokens: 2, costUsd: 0.25 });
    upgraded.close();

    const reopened = ControlPlaneDb.open(file);
    reopened.updateSessionFromSnapshot("sess-1", snapshot({
      id: "sess-1", tokensIn: 105, tokensOut: 22, costUsd: 3.5, seq: 5,
    }), Date.now());
    usage = reopened.queryUsageAggregation(localOwner(), { since: 0, through: Date.now() + 1, granularity: "hour" });
    assert.deepEqual(usage.totals, { inputTokens: 5, outputTokens: 2, costUsd: 0.25 }, "reopen does not silently re-baseline or duplicate usage");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------- Sessions -------------------------------- */

test("createSession persists driver + config and sessionView reflects them", () => {
  const db = withRunner();
  const config: SessionConfig = {
    model: "opus",
    effort: "high",
    permissionMode: "acceptEdits",
  };
  const view = db.createSession(
    newSession({ driver: "claude-code", config, useWorktree: true, now: 1234 }),
  );

  assert.equal(view.id, "sess-1");
  assert.equal(view.runnerId, "runner-1");
  assert.equal(view.status, "queued");
  assert.equal(view.driver, "claude-code");
  assert.equal(view.model, "opus");
  assert.equal(view.effort, "high");
  assert.equal(view.permissionMode, "acceptEdits");
  assert.equal(view.useWorktree, true);
  assert.equal(view.archived, false);
  assert.equal(view.createdAt, 1234);
  assert.equal(view.updatedAt, 1234);
  assert.equal(view.messageCount, 0);
  assert.equal(view.lastEventAt, null);

  // denormalised names resolved from definitions/workspaces
  assert.equal(view.agentName, "ACP Agent");
  assert.equal(view.workspaceName, "Repo One");

  // column derived from status when not manually filed
  assert.equal(view.column, "queued");

  // getSession returns the same shape
  assert.deepEqual(db.getSession("sess-1"), view);
});

test("policy hook credentials are hash-only, exact-session, runner-bound, replaceable, and cascading", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "hook-session", agentId: "claude-agent", driver: "claude-code" }));
  const first = createHash("sha256").update("hook-secret-1").digest("hex");
  const second = createHash("sha256").update("hook-secret-2").digest("hex");
  assert.equal(db.setPolicyHookCredential("hook-session", "runner-1", first, 1_000), true);
  assert.equal(db.policyHookCredentialValid("hook-session", "runner-1", first), true);
  assert.equal(db.policyHookCredentialValid("hook-session", "runner-other", first), false);
  assert.equal(db.setPolicyHookCredential("hook-session", "runner-other", second, 2_000), false);
  assert.equal(db.setPolicyHookCredential("missing", "runner-1", second, 2_000), false);
  assert.equal(db.setPolicyHookCredential("hook-session", "runner-1", second, 2_000), true);
  assert.equal(db.policyHookCredentialValid("hook-session", "runner-1", first), false);
  assert.equal(db.policyHookCredentialValid("hook-session", "runner-1", second), true);
  db.deleteSession("hook-session");
  assert.equal(db.policyHookCredentialValid("hook-session", "runner-1", second), false);
});

test("policy hook reconciliation queries use session/status indexes instead of optional-filter scans", () => {
  const db = withRunner();
  const plans = [
    db.raw().prepare(
      `EXPLAIN QUERY PLAN SELECT request_id, session_id FROM policy_hook_approvals
       WHERE status IN ('queued','pending') AND expires_at IS NOT NULL AND expires_at<=?`,
    ).all(1_000),
    db.raw().prepare(
      `EXPLAIN QUERY PLAN SELECT request_id, session_id FROM policy_hook_approvals
       WHERE session_id=? AND status IN ('queued','pending') AND expires_at IS NOT NULL AND expires_at<=?`,
    ).all("sess-1", 1_000),
    db.raw().prepare(
      `EXPLAIN QUERY PLAN SELECT request_id, session_id FROM policy_hook_approvals
       WHERE status IN ('queued','pending') AND last_polled_at<=?`,
    ).all(1_000),
    db.raw().prepare(
      `EXPLAIN QUERY PLAN SELECT request_id, session_id FROM policy_hook_approvals
       WHERE session_id=? AND status IN ('queued','pending') AND last_polled_at<=?`,
    ).all("sess-1", 1_000),
    db.raw().prepare(
      `EXPLAIN QUERY PLAN SELECT DISTINCT session_id FROM policy_hook_approvals
       WHERE session_id=? AND status='queued'`,
    ).all("sess-1"),
  ].flat() as unknown as Array<{ detail: string }>;
  assert.match(plans[0]!.detail, /idx_policy_hook_approvals_status_expiry/);
  assert.match(plans[1]!.detail, /idx_policy_hook_approvals_(?:session|status_expiry)/);
  assert.match(plans[2]!.detail, /idx_policy_hook_approvals_status_polled/);
  assert.match(plans[3]!.detail, /idx_policy_hook_approvals_(?:session|status_polled)/);
  assert.match(plans[4]!.detail, /idx_policy_hook_approvals_session/);
  assert.ok(plans.every((row) => !/\bSCAN policy_hook_approvals\b/.test(row.detail)));
});

test("policy hook heartbeat migration gives legacy open approvals a fresh liveness horizon", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-policy-hook-heartbeat-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession({
      id: "legacy-hook",
      agentId: "claude-agent",
      driver: "claude-code",
    }));
    initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE policy_hook_approvals;
      CREATE TABLE policy_hook_approvals (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        governance_policy_id TEXT NOT NULL,
        approval_json TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
    legacy.prepare(
      `INSERT INTO policy_hook_approvals
       (request_id, session_id, request_fingerprint, governance_policy_id, approval_json, status,
        expires_at, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    ).run(
      "legacy-request",
      "legacy-hook",
      "a".repeat(64),
      "legacy-policy",
      JSON.stringify({
        requestId: "legacy-request",
        title: "Legacy Approval",
        kind: "policy_hook",
        options: [],
      }),
      1_234,
    );
    legacy.close();

    const migrationStarted = Date.now();
    const migrated = ControlPlaneDb.open(path);
    const lastPolledAt = migrated.getPolicyHookApproval("legacy-hook", "legacy-request")?.lastPolledAt;
    assert.ok(lastPolledAt != null && lastPolledAt >= migrationStarted);
    assert.deepEqual(migrated.listAbandonedPolicyHookApprovals(lastPolledAt - 1, "legacy-hook"), []);
    assert.deepEqual(
      migrated.listAbandonedPolicyHookApprovals(lastPolledAt, "legacy-hook")
        .map((approval) => approval.requestId),
      ["legacy-request"],
    );
    migrated.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy hook approval slot, queue, and terminal decisions survive a database restart", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-policy-hook-restart-"));
  const path = join(root, "control-plane.db");
  const artifactBlobDir = join(tmpdir(), `wollipog-policy-hook-artifacts-${randomUUID()}`);
  try {
    const dbModule = pathToFileURL(join(process.cwd(), "apps/control-plane/src/db.ts")).href;
    const child = (phase: "seed" | "verify") => spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", `
        const { ControlPlaneDb } = await import(process.env.WOLLIPOG_DB_MODULE);
        const db = ControlPlaneDb.open(process.env.WOLLIPOG_DB_PATH, {
          artifactBlobDir: process.env.WOLLIPOG_ARTIFACT_DIR,
        });
        const approval = (requestId) => ({
          requestId,
          title: "Approve Tool?",
          kind: "policy_hook",
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
          governancePolicyId: "ask-tool",
        });
        if (process.env.WOLLIPOG_RESTART_PHASE === "seed") {
          db.registerRunner({
            runnerId: "runner-1",
            hostname: "host-1",
            os: "windows",
            version: "test",
            agents: [],
            workspaces: [{ id: "ws-1", name: "Repo", path: "C:/repo" }],
          }, 500, Number(process.env.WOLLIPOG_PROTOCOL_VERSION));
          db.createSession({
            id: "hook-restart",
            runnerId: "runner-1",
            workspaceId: "ws-1",
            agentId: "claude-agent",
            title: "Hook restart",
            useWorktree: false,
            driver: "claude-code",
            config: {},
            now: 1_000,
          });
          db.updateSessionStatus("hook-restart", "running", 1_000);
          if (db.beginPolicyHookApproval({
            sessionId: "hook-restart",
            requestId: "hook-1",
            requestFingerprint: "a".repeat(64),
            governancePolicyId: "ask-tool",
            approval: approval("hook-1"),
            now: 1_100,
          }).approval.status !== "pending") throw new Error("first ask was not pending");
          if (db.beginPolicyHookApproval({
            sessionId: "hook-restart",
            requestId: "hook-2",
            requestFingerprint: "b".repeat(64),
            governancePolicyId: "ask-tool",
            approval: approval("hook-2"),
            now: 1_200,
          }).approval.status !== "queued") throw new Error("second ask was not queued");
        } else {
          if (db.getSession("hook-restart")?.pendingApproval?.requestId !== "hook-1") {
            throw new Error("pending ask did not survive restart");
          }
          if (db.getPolicyHookApproval("hook-restart", "hook-2")?.status !== "queued") {
            throw new Error("queued ask did not survive restart");
          }
          // Startup conservatively marks an unconfirmed runner process stopped. Its registration
          // snapshot restores the live session before the durable queue is promoted.
          db.updateSessionStatus("hook-restart", "running", 1_290);
          if (!db.resolvePolicyHookApproval("hook-restart", "hook-1", "allowed", 1_300)?.changed) {
            throw new Error("terminal decision could not be recorded");
          }
          const promoted = db.promoteNextPolicyHookApproval("hook-restart", 1_300);
          if (promoted?.requestId !== "hook-2") {
            throw new Error("queued ask was not promoted: " + JSON.stringify({
              promoted,
              session: db.getSession("hook-restart"),
              queued: db.getPolicyHookApproval("hook-restart", "hook-2"),
            }));
          }
          if (db.getSession("hook-restart")?.pendingApproval?.requestId !== "hook-2") {
            throw new Error("promoted card was not restored");
          }
        }
        db.close();
      `],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          WOLLIPOG_DB_MODULE: dbModule,
          WOLLIPOG_DB_PATH: path,
          WOLLIPOG_ARTIFACT_DIR: artifactBlobDir,
          WOLLIPOG_RESTART_PHASE: phase,
          WOLLIPOG_PROTOCOL_VERSION: String(PROTOCOL_VERSION),
        },
      },
    );
    for (const phase of ["seed", "verify"] as const) {
      const result = child(phase);
      assert.equal(result.status, 0, `${phase} child failed: ${result.stderr || result.stdout}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(artifactBlobDir, { recursive: true, force: true });
  }
});

test("createSession with empty config persists nulls", () => {
  const db = withRunner();
  const view = db.createSession(newSession());
  assert.equal(view.model, null);
  assert.equal(view.effort, null);
  assert.equal(view.permissionMode, null);
  assert.equal(view.runId, null);
});

test("updateSessionStatus updates status and derived column", () => {
  const db = withRunner();
  db.createSession(newSession());

  db.updateSessionStatus("sess-1", "running", 2000);
  let v = db.getSession("sess-1")!;
  assert.equal(v.status, "running");
  assert.equal(v.column, "running");
  assert.equal(v.updatedAt, 2000);

  db.updateSessionStatus("sess-1", "completed", 3000);
  v = db.getSession("sess-1")!;
  assert.equal(v.status, "completed");
  assert.equal(v.column, "done");
});

test("updateSessionStatus clears pending approval when leaving input_required", () => {
  const db = withRunner();
  db.createSession(newSession());

  const approval: PendingApproval = {
    requestId: "req-1",
    title: "Allow edit?",
    options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
  };
  db.updateSessionStatus("sess-1", "input_required", 2000);
  db.setPendingApproval("sess-1", approval);
  assert.deepEqual(db.getSession("sess-1")!.pendingApproval, approval);

  // staying in input_required keeps it
  db.updateSessionStatus("sess-1", "input_required", 2100);
  assert.deepEqual(db.getSession("sess-1")!.pendingApproval, approval);

  // leaving clears it
  db.updateSessionStatus("sess-1", "running", 2200);
  assert.equal(db.getSession("sess-1")!.pendingApproval, null);
});

test("updateSessionConfig persists changes and sessionView shows them", () => {
  const db = withRunner();
  db.createSession(
    newSession({ config: { model: "opus", effort: "low", permissionMode: "plan" } }),
  );
  db.raw().prepare("UPDATE sessions SET resolved_model=? WHERE id=?")
    .run("claude-opus-5[1m]", "sess-1");

  db.updateSessionConfig(
    "sess-1",
    { model: "sonnet", effort: "high", permissionMode: "default" },
    5000,
  );
  const v = db.getSession("sess-1")!;
  assert.equal(v.model, "sonnet");
  assert.equal(v.resolvedModel, null);
  assert.equal(v.effort, "high");
  assert.equal(v.permissionMode, "default");
  assert.equal(v.updatedAt, 5000);

  db.raw().prepare("UPDATE sessions SET resolved_model=? WHERE id=?")
    .run("claude-sonnet-5", "sess-1");
  db.updateSessionConfig(
    "sess-1",
    { model: "sonnet", effort: "low", permissionMode: "default" },
    5200,
  );
  assert.equal(db.getSession("sess-1")?.resolvedModel, "claude-sonnet-5");

  // partial config nulls out the omitted fields (update writes ?? null)
  db.updateSessionConfig("sess-1", { model: "haiku" }, 5500);
  const v2 = db.getSession("sess-1")!;
  assert.equal(v2.model, "haiku");
  assert.equal(v2.effort, null);
  assert.equal(v2.permissionMode, null);
});

test("governance thresholds retain a fixed step across repeated re-arms", () => {
  const db = withRunner();
  db.createSession(newSession());

  db.updateSessionCostBudget("sess-1", 5, 1000);
  assert.equal(db.rearmSessionCostBudget("sess-1", 6, 1100), 11);
  assert.equal(db.rearmSessionCostBudget("sess-1", 12, 1200), 17);
  let view = db.getSession("sess-1")!;
  assert.equal(view.costBudgetUsd, 17);
  assert.equal(view.costBudgetStepUsd, 5);

  db.updateSessionMaxToolCalls("sess-1", 3, 1300);
  assert.equal(db.rearmSessionMaxToolCalls("sess-1", 3, 1400), 6);
  assert.equal(db.rearmSessionMaxToolCalls("sess-1", 7, 1500), 10);
  view = db.getSession("sess-1")!;
  assert.equal(view.maxToolCalls, 10);
  assert.equal(view.maxToolCallsStep, 3);
});

test("legacy raw NULL guardrail steps fall back to the current threshold when re-armed", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.updateSessionCostBudget("sess-1", 5, 1000);
  db.updateSessionMaxToolCalls("sess-1", 3, 1000);
  db.raw().prepare("UPDATE sessions SET cost_budget_step_usd=NULL, max_tool_calls_step=NULL WHERE id=?").run("sess-1");

  assert.equal(db.rearmSessionCostBudget("sess-1", 6, 1100), 11);
  assert.equal(db.rearmSessionMaxToolCalls("sess-1", 4, 1100), 7);
});

test("setSessionColumn overrides the derived column", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.setSessionColumn("sess-1", "review", 2000);
  assert.equal(db.getSession("sess-1")!.column, "review");
  // clearing falls back to derived
  db.setSessionColumn("sess-1", null, 2100);
  assert.equal(db.getSession("sess-1")!.column, "queued");
});

test("setSessionArchived hides from default listSessions but visible with includeArchived", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.setSessionArchived("sess-1", true, 2000);
  assert.equal(db.getSession("sess-1")!.archived, true);
  assert.equal(db.listSessions().length, 0);
  assert.equal(db.listSessions({ includeArchived: true }).length, 1);
});

/* ----------------------------- Events ---------------------------------- */

test("appendEvent + listEvents return events in seq order with stable ids", () => {
  const db = withRunner();
  db.createSession(newSession());

  const e1 = db.appendEvent("sess-1", { kind: "user_message", text: "hi" }, 100);
  const e2 = db.appendEvent("sess-1", { kind: "agent_message", text: "hello" }, 200);
  const e3 = db.appendEvent("sess-1", { kind: "agent_thought", text: "hmm" }, 300);

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.equal(e1.sessionId, "sess-1");
  assert.equal(typeof e1.id, "number");
  // ids are stable + increasing (autoincrement)
  assert.ok(e2.id > e1.id);
  assert.ok(e3.id > e2.id);

  const events = db.listEvents("sess-1");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(events.map((e) => e.id), [e1.id, e2.id, e3.id]);
  assert.deepEqual(events[1].payload, { kind: "agent_message", text: "hello" });
  assert.equal(events[2].ts, 300);

  // afterSeq filter
  const after = db.listEvents("sess-1", 1);
  assert.deepEqual(after.map((e) => e.seq), [2, 3]);
});

test("event export snapshots retain an immutable sequence boundary", () => {
  const db = withRunner();
  db.createSession(newSession());
  const before = { kind: "user_message", text: "before" } as const;
  const answer = { kind: "agent_message", text: "answer" } as const;
  const future = { kind: "agent_message", text: "future" } as const;
  db.appendEvent("sess-1", before, 100);
  db.appendEvent("sess-1", answer, 200);
  const snapshot = db.sessionEventSnapshot("sess-1");
  const firstBytes = Buffer.byteLength(JSON.stringify(before)) + Buffer.byteLength(JSON.stringify(answer));
  assert.deepEqual(snapshot, { throughSeq: 2, eventCount: 2, sourceBytes: firstBytes });

  db.appendEvent("sess-1", future, 300);
  assert.deepEqual(
    db.listEventsThrough("sess-1", snapshot.throughSeq, snapshot.eventCount).map((event) => event.seq),
    [1, 2],
  );
  assert.deepEqual(
    db.listTranscriptEventsThrough("sess-1", snapshot.throughSeq, snapshot.eventCount).map((event) => event.payload),
    [before, answer],
  );
  assert.deepEqual(db.sessionEventSnapshot("sess-1"), {
    throughSeq: 3,
    eventCount: 3,
    sourceBytes: firstBytes + Buffer.byteLength(JSON.stringify(future)),
  });
});

test("transcript snapshot reads leave excluded large payload members inside SQLite", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.appendEvent("sess-1", {
    kind: "user_message",
    text: "visible",
    images: [{ mimeType: "image/png", data: "SU1BR0VfREFUQQ==" }],
  }, 100);
  db.appendEvent("sess-1", {
    kind: "tool_call",
    toolCallId: "tool",
    title: "hidden",
    status: "completed",
    text: "TOOL_DATA",
  }, 200);
  const snapshot = db.sessionEventSnapshot("sess-1");
  assert.deepEqual(db.listTranscriptEventsThrough("sess-1", snapshot.throughSeq, snapshot.eventCount).map((event) => event.payload), [
    { kind: "user_message", text: "visible" },
    { kind: "tool_call" },
  ]);
});

test("bounded transcript reads round-trip string message identity and reject malformed identity", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.appendEvent("sess-1", { kind: "agent_message", text: "first", messageId: "provider-message" }, 100);
  assert.deepEqual(db.listTranscriptEventsThrough("sess-1", 1, 1).map((event) => event.payload), [
    { kind: "agent_message", text: "first", messageId: "provider-message" },
  ]);

  db.raw().prepare(
    "UPDATE session_events SET payload=json_set(payload, '$.messageId', 17) WHERE session_id=? AND seq=?",
  ).run("sess-1", 1);
  assert.equal(db.listTranscriptEventsThrough("sess-1", 1, 1)[0]?.payload.kind, "__invalid_transcript_source");
});

test("token_usage persistence accepts both pre-v31 totals and v31 subagent attribution", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.appendEvent("sess-1", { kind: "token_usage", inputTokens: 10, outputTokens: 2 }, 100);
  db.appendEvent("sess-1", {
    kind: "token_usage",
    inputTokens: 4,
    outputTokens: 1,
    cachedInputTokens: 3,
    parentToolUseId: "task-1",
    durationMs: 1500,
  }, 200);

  assert.deepEqual(db.listEvents("sess-1").map((event) => event.payload), [
    { kind: "token_usage", inputTokens: 10, outputTokens: 2 },
    { kind: "token_usage", inputTokens: 4, outputTokens: 1, cachedInputTokens: 3, parentToolUseId: "task-1", durationMs: 1500 },
  ]);
});

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "snap-1",
    workspaceId: null,
    agentId: null,
    title: "Adopted",
    status: "idle",
    driver: "codex",
    useWorktree: false,
    worktreePath: null,
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test("the provider-resolved model round-trips through create and update snapshots", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(
    snapshot({ id: "resolved-model", config: { model: "opus" }, resolvedModel: "claude-opus-5[1m]" }),
    "runner-1",
    2_000,
  );
  assert.equal(db.getSession("resolved-model")?.model, "opus");
  assert.equal(db.getSession("resolved-model")?.resolvedModel, "claude-opus-5[1m]");

  db.updateSessionFromSnapshot(
    "resolved-model",
    snapshot({ id: "resolved-model", config: { model: "opus" }, resolvedModel: "claude-opus-5-20260701" }),
    3_000,
  );
  assert.equal(db.getSession("resolved-model")?.resolvedModel, "claude-opus-5-20260701");
});

test("the adopted marker round-trips through create/update snapshot into SessionView", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({ id: "ad", adopted: true }), "runner-1", 2000);
  db.createSessionFromSnapshot(snapshot({ id: "no", adopted: false }), "runner-1", 2000);
  assert.equal(db.getSession("ad")?.adopted, true);
  assert.equal(db.getSession("no")?.adopted, false);
  // a manager-created session defaults to not-adopted
  db.createSession(newSession({ id: "mgr" }));
  assert.equal(db.getSession("mgr")?.adopted, false);
  // adopted is runner-authoritative — an updated snapshot carries it through
  db.updateSessionFromSnapshot("no", snapshot({ id: "no", adopted: true }), 3000);
  assert.equal(db.getSession("no")?.adopted, true);
});

test("background work state round-trips through runner snapshot create and update", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(
    snapshot({ id: "background-work", driver: "claude_code", backgroundWorkState: "running", backgroundWorkTracking: "managed" }),
    "runner-1",
    2_000,
  );
  assert.equal(db.getSession("background-work")?.backgroundWorkState, "running");
  assert.equal(db.getSession("background-work")?.backgroundWorkTracking, "managed");

  db.updateSessionFromSnapshot(
    "background-work",
    snapshot({ id: "background-work", driver: "claude_code", backgroundWorkState: "continuation_pending" }),
    2_500,
  );
  assert.equal(db.getSession("background-work")?.backgroundWorkState, "continuation_pending");
  assert.equal(db.getSession("background-work")?.backgroundWorkTracking, "managed",
    "an old-runner snapshot cannot erase the explicit tracking boundary");

  db.updateSessionFromSnapshot(
    "background-work",
    snapshot({ id: "background-work", driver: "claude_code", backgroundWorkState: "orphaned" }),
    3_000,
  );
  assert.equal(db.getSession("background-work")?.backgroundWorkState, "orphaned");

  db.updateSessionFromSnapshot(
    "background-work",
    snapshot({ id: "background-work", driver: "claude_code", backgroundWorkState: "resumed" }),
    4_000,
  );
  assert.equal(db.getSession("background-work")?.backgroundWorkState, "resumed");
});

test("managed background delivery stages survive reconnect, hydration, acknowledgement, and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-background-delivery-"));
  const dbPath = join(root, "control-plane.db");
  try {
    let db = ControlPlaneDb.open(dbPath);
    db.registerRunner(meta(), 500, PROTOCOL_VERSION);
    const baseJob = {
      id: "job-1",
      parentTurnId: "turn-1",
      runnerId: "runner-1",
      workspaceId: null,
      launchType: "agent" as const,
      registeredAt: 1_000,
      terminalStatus: "completed" as const,
      terminalObservedAt: 1_100,
      continuationRequired: true,
    };
    db.createSessionFromSnapshot(snapshot({
      id: "background-delivery",
      driver: "claude_code",
      historyEpoch: 4,
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [baseJob],
    }), "runner-1", 2_000);
    assert.deepEqual({ ...db.raw().prepare(
      `SELECT runner_id, workspace_id, project_location_id
         FROM managed_background_jobs WHERE session_id=? AND job_id=?`,
    ).get("background-delivery", "job-1") }, {
      runner_id: "runner-1",
      workspace_id: null,
      project_location_id: null,
    });
    assert.deepEqual(db.getSession("background-delivery")?.backgroundDeliveries, [{
      parentTurnId: "turn-1",
      jobCount: 1,
      terminalCount: 1,
      watchdogState: "terminal_without_continuation",
    }]);

    db.updateSessionFromSnapshot("background-delivery", snapshot({
      id: "background-delivery",
      driver: "claude_code",
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [{
        ...baseJob,
        continuationId: "bgcont-1",
        continuationQueuedAt: 1_200,
        continuationSubmittedAt: 1_300,
        continuationAcceptedAt: 1_400,
      }],
    }), 2_100);
    assert.equal(
      db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.watchdogState,
      "accepted_without_result",
    );

    db.updateSessionFromSnapshot("background-delivery", snapshot({
      id: "background-delivery",
      driver: "claude_code",
      backgroundWorkState: "resumed",
      backgroundJobs: [{
        ...baseJob,
        continuationId: "bgcont-1",
        continuationQueuedAt: 1_200,
        continuationSubmittedAt: 1_300,
        continuationAcceptedAt: 1_400,
        assistantResultPersistedAt: 1_500,
      }],
    }), 2_200);
    assert.equal(
      db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.watchdogState,
      "result_not_projected",
    );

    db.appendEvent("background-delivery", {
      kind: "background_continuation_delivered",
      continuationId: "bgcont-1",
      parentTurnId: "turn-1",
    }, 1_500);
    const projected = db.getSession("background-delivery")?.backgroundDeliveries?.[0];
    assert.equal(projected?.transcriptProjectedAt, 1_500);
    assert.equal(projected?.notificationQueuedAt, 1_500);
    assert.equal(projected?.watchdogState, "dashboard_observation_pending");
    assert.equal(db.acknowledgeBackgroundDelivery("background-delivery", "bgcont-1", 1_600), true);
    assert.equal(db.acknowledgeBackgroundDelivery("background-delivery", "bgcont-1", 1_700), false);
    assert.equal(db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.watchdogState, undefined);

    // A pre-v78 reconnect omits the inventory; it must not erase already-acknowledged evidence.
    db.updateSessionFromSnapshot("background-delivery", snapshot({
      id: "background-delivery",
      driver: "claude_code",
      backgroundWorkState: "resumed",
    }), 2_300);
    assert.equal(db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.dashboardObservedAt, 1_600);

    const reset = db.reconcileRunnerHistory("background-delivery", 5, 1);
    assert.equal(reset?.reset, true);
    assert.equal(
      db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.watchdogState,
      "result_not_projected",
    );
    assert.equal(
      db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.dashboardObservedAt,
      1_600,
      "history replacement invalidates projection without inventing a second notification",
    );
    assert.equal(db.appendHydratedPage(
      "background-delivery",
      { afterSeq: 0, historyEpoch: 5, eventEpoch: reset!.eventEpoch },
      [{
        seq: 1,
        ts: 1_500,
        payload: {
          kind: "background_continuation_delivered",
          continuationId: "bgcont-1",
          parentTurnId: "turn-1",
        },
      }],
    ).applied, true);
    assert.equal(db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.watchdogState, undefined);

    db.createSessionFromSnapshot(snapshot({
      id: "background-required-promotion",
      backgroundJobs: [{
        id: "job-promote",
        parentTurnId: "turn-promote",
        runnerId: "runner-1",
        workspaceId: null,
        launchType: "unknown",
        registeredAt: 10,
        continuationRequired: false,
      }],
    }), "runner-1", 2_350);
    db.updateSessionFromSnapshot("background-required-promotion", snapshot({
      id: "background-required-promotion",
      backgroundJobs: [{
        id: "job-promote",
        parentTurnId: "turn-promote",
        runnerId: "runner-1",
        workspaceId: null,
        launchType: "agent",
        registeredAt: 10,
        terminalStatus: "completed",
        terminalObservedAt: 20,
        continuationRequired: true,
        continuationId: "bgcont-promote",
        continuationAcceptedAt: 30,
      }],
    }), 2_360);
    assert.equal(
      db.getSession("background-required-promotion")?.backgroundDeliveries?.[0]?.watchdogState,
      "accepted_without_result",
      "runner facts advance monotonically from provisional false/unknown values",
    );

    assert.doesNotThrow(() => db.createSessionFromSnapshot(snapshot({
      id: "background-malformed",
      backgroundJobs: [
        null,
        { ...baseJob, id: null },
        { ...baseJob, workspaceId: undefined },
        { ...baseJob, continuationAcceptedAt: "not-a-timestamp" },
      ] as never,
    }), "runner-1", 2_370));
    assert.equal(Number(db.raw().prepare(
      "SELECT COUNT(*) AS count FROM managed_background_jobs WHERE session_id=?",
    ).get("background-malformed")?.count), 0, "malformed runtime JSON is ignored instead of throwing");

    db.createSessionFromSnapshot(snapshot({
      id: "background-stopped",
      status: "running",
      backgroundJobs: [{
        ...baseJob,
        id: "job-stopped",
        continuationId: "bgcont-stopped",
        continuationAcceptedAt: 40,
      }],
    }), "runner-1", 2_380);
    assert.equal(
      db.getSession("background-stopped")?.backgroundDeliveries?.[0]?.watchdogState,
      "accepted_without_result",
    );
    db.updateSessionFromSnapshot("background-stopped", snapshot({
      id: "background-stopped",
      status: "stopped",
      backgroundJobs: [],
    }), 2_390);
    assert.equal(
      db.getSession("background-stopped")?.backgroundDeliveries?.[0]?.watchdogState,
      undefined,
      "a deliberately stopped session retains evidence without a permanent incomplete-stage alarm",
    );
    assert.equal(Number((db.raw().prepare(
      "SELECT source_present FROM managed_background_jobs WHERE session_id=? AND job_id=?",
    ).get("background-stopped", "job-stopped") as { source_present: number }).source_present), 0);
    db.updateSessionFromSnapshot("background-stopped", snapshot({
      id: "background-stopped",
      status: "starting",
      backgroundJobs: [],
    }), 2_400);
    assert.equal(
      db.getSession("background-stopped")?.backgroundDeliveries?.[0]?.watchdogState,
      undefined,
      "same-session restart cannot resurrect evidence retired by the authoritative empty inventory",
    );
    db.close();

    db = ControlPlaneDb.open(dbPath);
    assert.equal(db.getSession("background-delivery")?.backgroundDeliveries?.[0]?.dashboardObservedAt, 1_600);

    db.createSessionFromSnapshot(snapshot({
      id: "background-indexed",
      driver: "claude_code",
      historyEpoch: 4,
      seq: 1,
      backgroundJobs: [{
        ...baseJob,
        id: "job-2",
        parentTurnId: "turn-2",
        continuationId: "bgcont-2",
        continuationAcceptedAt: 2_400,
        assistantResultPersistedAt: 2_500,
      }],
    }), "runner-1", 2_400);
    const applied = db.appendHydratedPage(
      "background-indexed",
      { afterSeq: 0, historyEpoch: 4, eventEpoch: 0 },
      [{
        seq: 1,
        ts: 2_500,
        payload: {
          kind: "background_continuation_delivered",
          continuationId: "bgcont-2",
          parentTurnId: "turn-2",
        },
      }],
    );
    assert.equal(applied.applied, true);
    assert.equal(
      db.getSession("background-indexed")?.backgroundDeliveries?.[0]?.watchdogState,
      "dashboard_observation_pending",
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background push receipts are per-endpoint, retryable, capability-authenticated, and restart durable", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-background-push-"));
  const dbPath = join(root, "control-plane.db");
  try {
    let db = ControlPlaneDb.open(dbPath);
    db.registerRunner(meta(), 500, PROTOCOL_VERSION);
    db.createSessionFromSnapshot(snapshot({
      id: "background-push",
      driver: "claude_code",
      backgroundWorkTracking: "managed",
    }), "runner-1", 1_000);
    db.upsertPushSubscription({
      endpoint: "https://push.example/capability/secret",
      p256dh: "public-key",
      auth: "auth-key",
      deviceId: null,
      now: 1_010,
    });
    const stagedBefore = Date.now();
    db.appendEvent("background-push", {
      kind: "background_continuation_delivered",
      continuationId: "bgcont-push",
      parentTurnId: "turn-push",
      results: [{ id: "job-push", launchType: "shell", status: "completed", terminalAt: 1_020 }],
    }, 1_020);
    const stagedAfter = Date.now();

    let receipts = db.getSession("background-push")?.backgroundDeliveries?.[0]?.notifications ?? [];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.state, "pending");
    assert.equal(JSON.stringify(receipts).includes("capability/secret"), false, "endpoint capability is never projected");

    const schedule = db.raw().prepare(
      "SELECT next_attempt_at, expires_at FROM background_push_deliveries WHERE continuation_id=?",
    ).get("bgcont-push") as { next_attempt_at: number; expires_at: number };
    assert.ok(schedule.next_attempt_at >= stagedBefore && schedule.next_attempt_at <= stagedAfter,
      "delivery is scheduled from the control-plane observation clock, not stale runner time");
    assert.equal(schedule.expires_at - schedule.next_attempt_at, 7 * 24 * 60 * 60_000);
    const first = db.claimDueBackgroundPushDeliveries(stagedAfter);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.message.ts, 1_020, "the runner timestamp remains informational evidence");
    assert.match(first[0]!.ackToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(db.settleBackgroundPushDelivery(first[0]!.deliveryId, {
      kind: "retry", status: 503, error: "push_service_rejected",
    }, stagedAfter + 10), true);
    assert.deepEqual(db.claimDueBackgroundPushDeliveries(stagedAfter + 5_009), []);
    const retry = db.claimDueBackgroundPushDeliveries(stagedAfter + 5_010);
    assert.equal(retry.length, 1);
    assert.equal(db.settleBackgroundPushDelivery(retry[0]!.deliveryId, {
      kind: "service_accepted", status: 201,
    }, stagedAfter + 5_020), true);
    assert.equal(db.settleBackgroundPushDelivery(retry[0]!.deliveryId, {
      kind: "retry", error: "stale_response_lost",
    }, stagedAfter + 5_021), false, "a stale settle cannot regress terminal push-service evidence");
    assert.equal(
      db.getSession("background-push")?.backgroundDeliveries?.[0]?.notifications?.[0]?.state,
      "service_accepted",
    );
    assert.equal(db.acknowledgeBackgroundPushReceipt(
      retry[0]!.deliveryId, "wrong", "shown", stagedAfter + 5_030,
    ), false);
    assert.equal(db.acknowledgeBackgroundPushReceipt(
      retry[0]!.deliveryId, retry[0]!.ackToken, "shown", stagedAfter + 5_030,
    ), true);
    assert.equal(db.acknowledgeBackgroundPushReceipt(
      retry[0]!.deliveryId, retry[0]!.ackToken, "clicked", stagedAfter + 5_040,
    ), true);
    assert.equal((db.raw().prepare(
      "SELECT endpoint FROM background_push_deliveries WHERE delivery_id=?",
    ).get(retry[0]!.deliveryId) as { endpoint: string | null }).endpoint, null,
    "terminal receipt evidence no longer retains the push endpoint capability");

    db.appendEvent("background-push", {
      kind: "background_continuation_delivered",
      continuationId: "bgcont-race",
      parentTurnId: "turn-race",
    }, 7_000);
    const racedAt = Date.now();
    const raced = db.claimDueBackgroundPushDeliveries(racedAt).find((delivery) =>
      delivery.continuationId === "bgcont-race");
    assert.ok(raced);
    assert.equal(db.acknowledgeBackgroundPushReceipt(
      raced.deliveryId, raced.ackToken, "shown", racedAt + 10,
    ), true);
    assert.equal(db.settleBackgroundPushDelivery(raced.deliveryId, {
      kind: "retry", error: "response_lost",
    }, racedAt + 20), false);
    assert.equal(
      db.getSession("background-push")?.backgroundDeliveries
        ?.find((delivery) => delivery.continuationId === "bgcont-race")
        ?.notifications?.[0]?.state,
      "shown",
      "a display receipt wins a race with a lost push-service response",
    );
    assert.equal(db.claimDueBackgroundPushDeliveries(racedAt + 100_000).some((delivery) =>
      delivery.deliveryId === raced.deliveryId), false, "shown notifications are never resent");
    db.close();

    db = ControlPlaneDb.open(dbPath);
    receipts = db.getSession("background-push")?.backgroundDeliveries
      ?.find((delivery) => delivery.continuationId === "bgcont-push")?.notifications ?? [];
    assert.deepEqual(receipts.map(({ endpointKey, ...receipt }) => receipt), [{
      deliveryId: retry[0]!.deliveryId,
      state: "clicked",
      attemptCount: 2,
      serviceAcceptedAt: stagedAfter + 5_020,
      shownAt: stagedAfter + 5_030,
      clickedAt: stagedAfter + 5_040,
      lastStatus: 201,
    }]);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret-free ACP context hydrates from runner snapshots and survives an old-runner update", () => {
  const db = withRunner();
  const acpSessionContext = {
    mcpServers: [{ type: "http" as const, name: "docs", url: "https://mcp.example/rpc", headers: { Authorization: { fromEnv: "MCP_AUTH" } } }],
    additionalDirectories: ["C:/code/shared"],
  };
  db.createSessionFromSnapshot(snapshot({ id: "acp-context", driver: "acp", acpSessionContext }), "runner-1", 2000);
  assert.deepEqual(db.getAcpSessionContext("acp-context"), acpSessionContext);
  db.updateSessionFromSnapshot("acp-context", snapshot({ id: "acp-context", driver: "acp" }), 3000);
  assert.deepEqual(db.getAcpSessionContext("acp-context"), acpSessionContext);
});

test("execution targets persist immutably and only a newer target-bearing snapshot replaces them", () => {
  const db = withRunner();
  const target = {
    id: "runner:runner-1:host:worktree", runnerId: "runner-1", kind: "ssh" as const,
    workspaceStrategy: "worktree" as const, adapter: "host" as const,
    boundaries: { filesystem: "worktree" as const, network: "inherit" as const,
      secrets: "runner_local" as const, billing: "agent_account" as const },
  };
  db.createSession(newSession({ id: "targeted", useWorktree: true, executionTarget: target }));
  assert.deepEqual(db.getSession("targeted")?.executionTarget, target);

  db.updateSessionFromSnapshot("targeted", snapshot({ id: "targeted", useWorktree: true }), 2_000);
  assert.deepEqual(db.getSession("targeted")?.executionTarget, target, "pre-v60 snapshots preserve launch provenance");

  const changed = { ...target, boundaries: { ...target.boundaries, network: "deny" as const } };
  db.updateSessionFromSnapshot("targeted", snapshot({ id: "targeted", useWorktree: true, executionTarget: changed }), 3_000);
  assert.deepEqual(db.getSession("targeted")?.executionTarget, changed);
});

test("cloud handoff receipts round-trip only with their exact target and remain durable", () => {
  const db = withRunner();
  const target = {
    id: "runner:runner-1:cloud:metered-tools", runnerId: "runner-1", kind: "cloud" as const,
    workspaceStrategy: "snapshot" as const, adapter: "cloud" as const,
    boundaries: { filesystem: "snapshot" as const, network: "policy" as const,
      secrets: "references" as const, billing: "target_metered" as const },
    environment: { id: "metered-tools", revision: 1, image: `example/cloud@sha256:${"5".repeat(64)}`, setupCheckDigest: "6".repeat(64) },
    policy: {
      cost: { currency: "USD" as const, estimatedHourlyRateUsd: 1, minimumBudgetUsd: 0.5, maximumBudgetUsd: 10 },
      admission: { maxConcurrentSessions: 1, queue: "fifo" as const },
    },
  };
  const receipt = {
    targetId: target.id, manifestDigest: "7".repeat(64), adapterHandoffIdHash: "8".repeat(64),
    git: { headCommit: "9".repeat(40), headTree: "a".repeat(40), workingTreeDigest: "b".repeat(64), dirty: false, untrackedFiles: 0 },
    artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 2_000,
  };
  db.createSessionFromSnapshot(snapshot({
    id: "cloud-session", useWorktree: true, executionTarget: target, executionHandoff: receipt,
  }), "runner-1", 2_000);
  assert.deepEqual(db.getSession("cloud-session")?.executionHandoff, receipt);
  db.updateSessionFromSnapshot("cloud-session", snapshot({ id: "cloud-session", useWorktree: true }), 3_000);
  assert.deepEqual(db.getSession("cloud-session")?.executionHandoff, receipt, "older snapshots cannot erase accepted provenance");
  assert.throws(() => db.updateSessionFromSnapshot("cloud-session", snapshot({
    id: "cloud-session", useWorktree: true, executionTarget: target,
    executionHandoff: { ...receipt, quotedCostUsd: 6, budgetUsd: 5 },
  }), 4_000), /invalid cloud handoff/);
});

test("cloud handoff requests survive pre-acceptance restart and bind the later receipt", () => {
  const db = withRunner();
  const target = {
    id: "runner:runner-1:cloud:metered-tools", runnerId: "runner-1", kind: "cloud" as const,
    workspaceStrategy: "snapshot" as const, adapter: "cloud" as const,
    boundaries: { filesystem: "snapshot" as const, network: "policy" as const,
      secrets: "references" as const, billing: "target_metered" as const },
    environment: { id: "metered-tools", revision: 1, image: `example/cloud@sha256:${"5".repeat(64)}`, setupCheckDigest: "6".repeat(64) },
    policy: {
      cost: { currency: "USD" as const, estimatedHourlyRateUsd: 1, minimumBudgetUsd: 0.5, maximumBudgetUsd: 10 },
      admission: { maxConcurrentSessions: 1, queue: "fifo" as const },
    },
  };
  const request = {
    sourceSessionId: "source-session",
    artifacts: [{ artifactId: "artifact-1", kind: "patch" as const, sizeBytes: 12, sha256: "c".repeat(64) }],
  };
  db.createSession(newSession({
    id: "cloud-request", useWorktree: true, executionTarget: target, executionHandoffRequest: request,
  }));
  db.updateSessionCostBudget("cloud-request", 5, 1_500);
  assert.deepEqual(db.getExecutionHandoffRequest("cloud-request"), request);

  const receipt = {
    targetId: target.id, sourceSessionId: request.sourceSessionId,
    manifestDigest: "7".repeat(64), adapterHandoffIdHash: "8".repeat(64),
    git: { headCommit: "9".repeat(40), headTree: "a".repeat(40), workingTreeDigest: "b".repeat(64), dirty: false, untrackedFiles: 0 },
    artifacts: request.artifacts, budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 2_000,
  };
  db.updateSessionFromSnapshot("cloud-request", snapshot({
    id: "cloud-request", useWorktree: true, executionTarget: target, executionHandoff: receipt,
  }), 2_000);
  assert.deepEqual(db.getSession("cloud-request")?.executionHandoff, receipt);

  assert.equal(db.rearmSessionCostBudget("cloud-request", 5, 2_500), 10);
  assert.doesNotThrow(() => db.updateSessionFromSnapshot("cloud-request", snapshot({
    id: "cloud-request", useWorktree: true, executionTarget: target, executionHandoff: receipt,
    costUsd: 6, status: "running",
  }), 2_600));
  assert.equal(db.getSession("cloud-request")?.costBudgetUsd, 10, "runner snapshots preserve the rearmed control-plane budget");
  assert.equal(db.getSession("cloud-request")?.costUsd, 6, "runtime reconciliation continues after a budget rearm");
  assert.deepEqual(db.getSession("cloud-request")?.executionHandoff, receipt, "the accepted receipt keeps its original budget");

  assert.throws(() => db.updateSessionFromSnapshot("cloud-request", snapshot({
    id: "cloud-request", useWorktree: true, executionTarget: target,
    executionHandoff: { ...receipt, sourceSessionId: "another-source" },
  }), 3_000), /does not match its durable request/);
  assert.throws(() => db.updateSessionFromSnapshot("cloud-request", snapshot({
    id: "cloud-request", useWorktree: true, executionTarget: target,
    executionHandoff: { ...receipt, budgetUsd: 6 },
  }), 3_000), /invalid cloud handoff/);
});

test("legacy execution-target projection is bounded per runner when listing sessions", () => {
  const db = withRunner();
  db.registerRunner(meta(), 600, PROTOCOL_VERSION);
  for (let index = 0; index < 25; index += 1) {
    db.createSession(newSession({ id: `legacy-target-${index}`, now: 1_000 + index }));
  }

  const internals = db as unknown as {
    legacyExecutionTargets(runnerId: string): unknown;
  };
  const original = internals.legacyExecutionTargets.bind(db);
  let projections = 0;
  internals.legacyExecutionTargets = (runnerId: string): unknown => {
    projections += 1;
    return original(runnerId);
  };

  const sessions = db.listSessions();
  assert.equal(sessions.length, 25);
  assert.equal(projections, 1, "legacy target metadata is loaded once per distinct runner");
  assert.ok(sessions.every((session) => session.executionTarget?.runnerId === "runner-1"));
});

test("snapshot context gauges round-trip while a user title resists provider replacement", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({
    id: "owned-title",
    title: "Provider generated",
    titleSource: "provider",
    providerUpdatedAt: "2026-07-11T00:00:00.000Z",
    contextTokensUsed: 12_000,
    contextWindow: 200_000,
  }), "runner-1", 2000);
  let session = db.getSession("owned-title")!;
  assert.equal(session.titleSource, "provider");
  assert.equal(session.providerUpdatedAt, "2026-07-11T00:00:00.000Z");
  assert.equal(session.contextTokensUsed, 12_000);
  assert.equal(session.contextWindow, 200_000);

  db.setSessionTitle("owned-title", "My explicit name", 2100, "user");
  db.updateSessionFromSnapshot("owned-title", snapshot({
    id: "owned-title",
    title: "Provider replacement",
    titleSource: "provider",
    providerUpdatedAt: "2026-07-12T00:00:00.000Z",
    contextTokensUsed: 20_000,
    contextWindow: 250_000,
  }), 2200);
  session = db.getSession("owned-title")!;
  assert.equal(session.title, "My explicit name");
  assert.equal(session.titleSource, "user");
  assert.equal(session.providerUpdatedAt, "2026-07-12T00:00:00.000Z");
  assert.equal(session.contextTokensUsed, 20_000);
  assert.equal(session.contextWindow, 250_000);

  db.updateSessionFromSnapshot("owned-title", snapshot({
    id: "owned-title",
    title: "Older runner-side user title",
    titleSource: "user",
    providerUpdatedAt: "2026-07-13T00:00:00.000Z",
  }), 2300);
  session = db.getSession("owned-title")!;
  assert.equal(session.title, "My explicit name", "a stale runner user title cannot undo the CP rename");
  assert.equal(session.titleSource, "user");
  assert.equal(session.providerUpdatedAt, "2026-07-13T00:00:00.000Z");
});

test("semantic titles survive stale generated snapshots but yield to provider metadata", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({
    id: "semantic-title", title: "Initial fallback", titleSource: "generated",
  }), "runner-1", 2_000);
  db.setSemanticSessionTitle("semantic-title", "Semantic objective", 2_100, "generated");

  db.updateSessionFromSnapshot("semantic-title", snapshot({
    id: "semantic-title", title: "Initial fallback", titleSource: "generated",
  }), 2_200);
  assert.equal(db.getSession("semantic-title")?.title, "Semantic objective");
  assert.equal(db.getSession("semantic-title")?.titleSource, "generated");

  db.updateSessionFromSnapshot("semantic-title", snapshot({
    id: "semantic-title", title: "Provider objective", titleSource: "provider",
  }), 2_300);
  assert.equal(db.getSession("semantic-title")?.title, "Provider objective");
  assert.equal(db.getSession("semantic-title")?.titleSource, "provider");
});

test("session title context queries keep the original objective and a bounded semantic tail", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "title-context" }));
  db.appendEvent("title-context", { kind: "user_message", text: "Original", final: true }, 1);
  db.appendEvent("title-context", { kind: "agent_thought", text: "Excluded", final: true }, 2);
  db.appendEvent("title-context", { kind: "user_message", text: "Partial", final: false }, 3);
  for (let index = 0; index < 5; index += 1) {
    db.appendEvent("title-context", { kind: "agent_message", text: `Answer ${index}`, final: true }, 4 + index);
  }

  assert.equal(db.hasCompletedUserMessage("title-context"), true);
  assert.deepEqual(
    db.listSessionTitleContextEvents("title-context", 2).map((entry) => entry.payload.kind === "user_message"
      ? entry.payload.text
      : entry.payload.kind === "agent_message" ? entry.payload.text : "excluded"),
    ["Original", "Answer 3", "Answer 4"],
  );
});

test("createSessionFromSnapshot auto-files an adopted session by its workspacePath", () => {
  const db = withRunner();
  // Adopted from ANOTHER dashboard (or delete-then-rehydrate): the snapshot carries no workspaceId
  // — the path match assigns the project. Windows drive-letter paths compare case-insensitively
  // with either separator.
  db.createSessionFromSnapshot(
    snapshot({ id: "ad", adopted: true, workspacePath: "c:\\CODE\\one\\packages" }),
    "runner-1",
    2000,
  );
  const v = db.getSession("ad")!;
  assert.equal(v.workspaceId, "ws-1");
  assert.equal(v.workspaceName, "Repo One");
});

test("adopted cold hydration prefers an exact managed Project Location over a reported parent", () => {
  const db = withRunner();
  const project = db.createProject({ name: "Nested Project" });
  const workspace = db.createProjectWorkspace(project.id, "runner-1", {
    name: "Nested Repo",
    path: "C:/code/one/nested",
  }, 1_500);

  db.createSessionFromSnapshot(
    snapshot({
      id: "managed-exact",
      adopted: true,
      workspacePath: "C:/code/one/nested/packages/core",
    }),
    "runner-1",
    2_000,
  );

  const session = db.getSession("managed-exact")!;
  assert.equal(session.workspaceId, workspace.id);
  assert.equal(session.projectId, project.id);
  assert.equal(session.projectLocationId, db.findProjectLocationForProject(
    project.id,
    "runner-1",
    workspace.id,
  )!.id);
});

test("legacy adopted promotion never pairs a snapshot Workspace with another Location", () => {
  const db = withRunner();
  const nestedProject = db.createProject({ name: "Nested Import" });
  db.createProjectWorkspace(nestedProject.id, "runner-1", {
    name: "Nested Import",
    path: "C:/code/one/nested-import",
  }, 1_500);
  db.createSessionFromSnapshot(snapshot({
    id: "legacy-import-placeholder",
    adopted: true,
    workspaceId: null,
    workspacePath: null,
  }), "runner-1", 1_600);

  db.updateSessionFromSnapshot("legacy-import-placeholder", snapshot({
    id: "legacy-import-placeholder",
    adopted: true,
    workspaceId: "ws-2",
    workspacePath: "C:/code/one/nested-import/packages/core",
  }), 1_700);

  const promoted = db.getSession("legacy-import-placeholder")!;
  const workspaceLocation = db.findProjectLocation("runner-1", "ws-2");
  assert.equal(promoted.workspaceId, "ws-2");
  assert.equal(promoted.projectLocationId, workspaceLocation?.id ?? null);
  assert.equal(promoted.projectId, workspaceLocation?.projectId ?? null);
});

test("an exact shared imported Location retains its workspace but declines Project inference", () => {
  const db = withRunner();
  const first = db.createProject({ name: "First Project" });
  const second = db.createProject({ name: "Second Project" });
  const workspace = db.createProjectWorkspace(first.id, "runner-1", {
    name: "Shared Nested Repo",
    path: "C:/code/one/shared-nested",
  }, 1_500);
  db.addProjectLocation(second.id, { runnerId: "runner-1", workspaceId: workspace.id }, 1_600);

  db.createSessionFromSnapshot(
    snapshot({
      id: "managed-shared",
      adopted: true,
      workspacePath: "C:/code/one/shared-nested/src",
    }),
    "runner-1",
    2_000,
  );

  const session = db.getSession("managed-shared")!;
  assert.equal(session.workspaceId, workspace.id);
  assert.equal(session.projectId, null);
  assert.equal(session.projectLocationId, null);
});

test("adopted cold hydration prefers a more-specific unlinked managed Workspace over a Project parent", () => {
  const db = withRunner();
  const local = db.localIdentityContext();
  const managedScope = {
    organizationId: local.organizationId,
    owner: { kind: "user" as const, userId: local.userId },
  };
  const managed = db.registerMachineWorkspace("runner-1", {
    name: "Private Nested Workspace",
    path: "C:/code/one/private-nested",
  }, managedScope, 1_500);

  db.createSessionFromSnapshot(snapshot({
    id: "managed-unlinked",
    adopted: true,
    workspacePath: "C:/code/one/private-nested/src",
  }), "runner-1", 2_000);

  const session = db.getSession("managed-unlinked")!;
  assert.equal(session.workspaceId, managed.id);
  assert.equal(session.projectId, null, "an unlinked Machine Workspace must not inherit its reported parent Project");
  assert.deepEqual(db.sessionScope(session.id), managedScope);
});

test("adopted cold hydration declines canonically identical Workspace identities", () => {
  const db = withRunner();
  db.registerMachineWorkspace("runner-1", {
    name: "Alias One",
    path: "C:/code/one/ambiguous",
  }, undefined, 1_500);
  db.registerMachineWorkspace("runner-1", {
    name: "Alias Two",
    path: "c:\\CODE\\one\\ambiguous\\",
  }, undefined, 1_600);

  db.createSessionFromSnapshot(snapshot({
    id: "managed-ambiguous",
    adopted: true,
    workspacePath: "C:/code/one/ambiguous/src",
  }), "runner-1", 2_000);

  const session = db.getSession("managed-ambiguous")!;
  assert.equal(session.workspaceId, null);
  assert.equal(session.projectId, null);
});

test("createSessionFromSnapshot leaves a non-adopted null workspaceId alone (ad-hoc stays Chats)", () => {
  const db = withRunner();
  // An ad-hoc browsed directory was a deliberate "no workspace" choice — even inside ws-1's path.
  db.createSessionFromSnapshot(snapshot({ id: "adhoc", workspacePath: "C:/code/one/sub" }), "runner-1", 2000);
  assert.equal(db.getSession("adhoc")!.workspaceId, null);
});

test("clearSessionEvents drops the cached log and resets the hydration high-water (reprocess)", () => {
  const db = withRunner();
  db.createSession(newSession());
  assert.equal(db.getSession("sess-1")!.eventEpoch, 0);
  db.appendEvent("sess-1", { kind: "agent_message", text: "a" }, 100);
  db.appendEvent("sess-1", { kind: "agent_message", text: "b" }, 200);
  db.setHydratedSeq("sess-1", 2);
  assert.equal(db.listEvents("sess-1").length, 2);
  assert.equal(db.getHydratedSeq("sess-1"), 2);

  db.clearSessionEvents("sess-1");
  assert.deepEqual(db.listEvents("sess-1"), []);
  assert.equal(db.getHydratedSeq("sess-1"), 0); // so hydrateHistory re-pulls the whole log
  assert.equal(db.getSession("sess-1")!.eventEpoch, 1);

  db.appendEvent("sess-1", { kind: "agent_message", text: "replacement" }, 300);
  assert.equal(db.getSession("sess-1")!.eventEpoch, 1, "ordinary appends stay in the current generation");
  db.clearSessionEvents("sess-1");
  assert.equal(db.getSession("sess-1")!.eventEpoch, 2, "each complete replacement gets a new generation");
});

test("legacy session rows add event_epoch at zero before the first replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-epoch-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession());
    initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE sessions DROP COLUMN event_epoch");
    legacy.close();

    const upgraded = ControlPlaneDb.open(path);
    assert.equal(upgraded.getSession("sess-1")!.eventEpoch, 0);
    upgraded.clearSessionEvents("sess-1");
    assert.equal(upgraded.getSession("sess-1")!.eventEpoch, 1);
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendEvent maintains lastEventAt and preview", () => {
  const db = withRunner();
  db.createSession(newSession());

  db.appendEvent("sess-1", { kind: "agent_message", text: "first " }, 100);
  db.appendEvent("sess-1", { kind: "agent_message", text: "second" }, 250);
  let v = db.getSession("sess-1")!;
  assert.equal(v.lastEventAt, 250);
  assert.equal(v.messageCount, 2);
  assert.equal(v.preview, "first second"); // concatenated

  // a user_message resets the preview to empty
  db.appendEvent("sess-1", { kind: "user_message", text: "ignored" }, 300);
  v = db.getSession("sess-1")!;
  assert.equal(v.preview, "");
  assert.equal(v.lastEventAt, 300);
});

test("appendEvent seq is per-session", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "sess-1" }));
  db.createSession(newSession({ id: "sess-2" }));
  db.appendEvent("sess-1", { kind: "agent_message", text: "a" }, 100);
  const s2e1 = db.appendEvent("sess-2", { kind: "agent_message", text: "b" }, 100);
  assert.equal(s2e1.seq, 1, "sess-2 starts its own seq at 1");
  assert.equal(db.listEvents("sess-1").length, 1);
  assert.equal(db.listEvents("sess-2").length, 1);
});

test("legacy runner event append atomically persists provenance and advances hydration", () => {
  const db = withRunner();
  db.createSession(newSession());

  db.appendEvent(
    "sess-1",
    { kind: "agent_message", text: "committed once" },
    100,
    { runnerSeq: 1, historyEpoch: null },
  );

  assert.equal(db.getHydratedSeq("sess-1"), 1);
  const persisted = db.raw().prepare(
    "SELECT seq, runner_seq FROM session_events WHERE session_id=?",
  ).get("sess-1") as unknown as { seq: number; runner_seq: number | null };
  assert.equal(persisted.seq, 1);
  assert.equal(persisted.runner_seq, 1);

  db.raw().exec(
    `CREATE TRIGGER fail_legacy_cursor_update BEFORE UPDATE OF hydrated_seq ON sessions
     WHEN NEW.id='sess-1' AND NEW.hydrated_seq=2
     BEGIN SELECT RAISE(ABORT, 'simulated cursor failure'); END;`,
  );
  assert.throws(() => db.appendEvent(
    "sess-1",
    { kind: "agent_message", text: "must roll back" },
    200,
    { runnerSeq: 2, historyEpoch: null },
  ), /simulated cursor failure/);
  assert.equal(db.getHydratedSeq("sess-1"), 1);
  assert.equal(db.listEvents("sess-1").length, 1, "cursor failure rolls back the event row");

  db.raw().exec("DROP TRIGGER fail_legacy_cursor_update");
  db.raw().prepare("UPDATE sessions SET hydrated_seq=0 WHERE id=?").run("sess-1");
  assert.throws(() => db.appendEvent(
    "sess-1",
    { kind: "agent_message", text: "replayed after crash" },
    300,
    { runnerSeq: 1, historyEpoch: null },
  ), /UNIQUE/);
  assert.equal(db.listEvents("sess-1").length, 1, "runner provenance rejects a replay despite a stale cursor");
});

test("runner history snapshots persist epoch/tail and replace cache only on a known epoch change", () => {
  const db = withRunner();
  db.createSessionFromSnapshot(snapshot({ id: "history", historyEpoch: 4, seq: 2 }), "runner-1", 2_000);
  assert.deepEqual(db.getRunnerHistoryState("history"), {
    historyEpoch: 4,
    tailSeq: 2,
    hydratedSeq: 0,
    eventEpoch: 0,
    complete: false,
  });

  const first = db.appendHydratedPage("history", { afterSeq: 0, historyEpoch: 4, eventEpoch: 0 }, [
    { seq: 1, ts: 10, payload: { kind: "user_message", text: "hello" } },
    { seq: 2, ts: 11, payload: { kind: "agent_message", text: "world" } },
  ]);
  assert.equal(first.applied, true);
  assert.equal(db.getRunnerHistoryState("history")?.complete, true);

  db.updateSessionFromSnapshot("history", snapshot({ id: "history", historyEpoch: 4, seq: 3 }), 3_000);
  assert.equal(db.listEvents("history").length, 2, "same generation preserves the cache");
  assert.equal(db.getRunnerHistoryState("history")?.complete, false);

  db.updateSessionFromSnapshot("history", snapshot({
    id: "history",
    historyEpoch: 5,
    seq: 1,
    preview: "new generation",
  }), 4_000);
  assert.deepEqual(db.listEvents("history"), []);
  assert.deepEqual(db.getRunnerHistoryState("history"), {
    historyEpoch: 5,
    tailSeq: 1,
    hydratedSeq: 0,
    eventEpoch: 1,
    complete: false,
  });
  assert.equal(db.getSession("history")?.messageCount, 0);
  assert.equal(db.getSession("history")?.preview, "new generation", "the fresh snapshot replaces cleared preview state");
  assert.equal(db.searchEvents("world").length, 0, "epoch replacement clears transcript FTS rows");
});

test("appendHydratedPage is atomic, crash-idempotent, stale-safe, and keeps CP seq independent", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "history-page" }));
  const synthetic = db.appendEvent("history-page", { kind: "stderr", text: "CP notice" }, 5);
  assert.equal(synthetic.seq, 1);
  assert.equal(db.reconcileRunnerHistory("history-page", 9, 2)?.reset, false);

  const applied = db.appendHydratedPage(
    "history-page",
    { afterSeq: 0, historyEpoch: 9, eventEpoch: 0 },
    [
      { seq: 1, ts: 10, payload: { kind: "user_message", text: "indexed prompt" } },
      { seq: 2, ts: 11, payload: { kind: "agent_message", text: "indexed answer" } },
    ],
  );
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.events.map((event) => event.seq), [2, 3], "CP sequence remains local and includes synthetic rows");
  assert.deepEqual(db.listEvents("history-page").map((event) => event.seq), [1, 2, 3]);
  assert.equal(db.getHydratedSeq("history-page"), 2);
  assert.equal(db.getSession("history-page")?.messageCount, 3);
  assert.equal(db.getSession("history-page")?.preview, "indexed answer");
  assert.equal(db.searchEvents("indexed").length, 1, "hydrated pages maintain FTS in the same commit");

  const retry = db.appendHydratedPage(
    "history-page",
    { afterSeq: 0, historyEpoch: 9, eventEpoch: 0 },
    [{ seq: 1, ts: 10, payload: { kind: "user_message", text: "duplicate" } }],
  );
  assert.deepEqual(retry, { applied: false, events: [] });
  assert.equal(db.listEvents("history-page").length, 3, "a committed page retry cannot duplicate source events");

  assert.throws(
    () => db.appendHydratedPage(
      "history-page",
      { afterSeq: 2, historyEpoch: 9, eventEpoch: 0 },
      [{ seq: 4, ts: 12, payload: { kind: "agent_message", text: "gap" } }],
    ),
    /contiguous/,
  );
  assert.equal(db.getHydratedSeq("history-page"), 2, "invalid input fails before opening a transaction");

  const staleEpoch = db.appendHydratedPage(
    "history-page",
    { afterSeq: 2, historyEpoch: 8, eventEpoch: 0 },
    [{ seq: 3, ts: 12, payload: { kind: "agent_message", text: "stale" } }],
  );
  assert.equal(staleEpoch.applied, false);
  assert.equal(db.getHydratedSeq("history-page"), 2);

  db.createSession(newSession({ id: "history-rollback" }));
  db.reconcileRunnerHistory("history-rollback", 3, 2);
  // Seed an impossible future source seq without advancing the cursor. The second page insert hits
  // the partial unique index after the first succeeded, proving the whole page rolls back.
  db.raw().prepare(
    `INSERT INTO session_events (session_id, seq, runner_seq, ts, kind, payload)
     VALUES ('history-rollback', 1, 2, 1, 'stderr', ?)`,
  ).run(JSON.stringify({ kind: "stderr", text: "preexisting corruption" }));
  assert.throws(() => db.appendHydratedPage(
    "history-rollback",
    { afterSeq: 0, historyEpoch: 3, eventEpoch: 0 },
    [
      { seq: 1, ts: 20, payload: { kind: "agent_message", text: "must roll back" } },
      { seq: 2, ts: 21, payload: { kind: "agent_message", text: "conflict" } },
    ],
  ), /UNIQUE/);
  assert.equal(db.listEvents("history-rollback").length, 1);
  assert.equal(db.getHydratedSeq("history-rollback"), 0);
  assert.equal(db.getSession("history-rollback")?.messageCount, 0);
  assert.equal(db.searchEvents("must roll back").length, 0);
});

test("listCachedEventPage uses a limit-plus-one boundary and stable CP cursors", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "paged-cache" }));
  for (let index = 1; index <= 5; index++) {
    db.appendEvent("paged-cache", { kind: "agent_message", text: String(index) }, index);
  }
  const first = db.listCachedEventPage("paged-cache", 0, 2);
  assert.deepEqual(first.events.map((event) => event.seq), [1, 2]);
  assert.equal(first.nextAfterSeq, 2);
  assert.equal(first.hasMore, true);
  const last = db.listCachedEventPage("paged-cache", first.nextAfterSeq, 10);
  assert.deepEqual(last.events.map((event) => event.seq), [3, 4, 5]);
  assert.equal(last.nextAfterSeq, 5);
  assert.equal(last.hasMore, false);
  assert.deepEqual(db.listCachedEventPage("paged-cache", 5, 2), {
    events: [], nextAfterSeq: 5, hasMore: false,
  });
  assert.throws(() => db.listCachedEventPage("paged-cache", 0, 0), /positive safe integer/);
});

test("listCachedEventTailPage reads the newest rows first and pages older below a cursor", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "windowed-cache" }));
  for (let index = 1; index <= 5; index++) {
    db.appendEvent("windowed-cache", { kind: "agent_message", text: String(index) }, index);
  }
  // The opening window is the TAIL, whatever the session's length: never seq 1 first.
  const newest = db.listCachedEventTailPage("windowed-cache", undefined, 2);
  assert.deepEqual(newest.events.map((event) => event.seq), [4, 5]);
  assert.equal(newest.nextBeforeSeq, 4);
  assert.equal(newest.hasMoreOlder, true);
  const older = db.listCachedEventTailPage("windowed-cache", newest.nextBeforeSeq, 2);
  assert.deepEqual(older.events.map((event) => event.seq), [2, 3]);
  assert.equal(older.nextBeforeSeq, 2);
  assert.equal(older.hasMoreOlder, true);
  const oldest = db.listCachedEventTailPage("windowed-cache", older.nextBeforeSeq, 2);
  assert.deepEqual(oldest.events.map((event) => event.seq), [1]);
  assert.equal(oldest.nextBeforeSeq, 1);
  assert.equal(oldest.hasMoreOlder, false);
  // Paging below the first event yields an empty page with no cursor to follow.
  assert.deepEqual(db.listCachedEventTailPage("windowed-cache", 1, 2), {
    events: [], hasMoreOlder: false,
  });
  // A window wider than the log reports no older rows rather than an unreachable cursor.
  const whole = db.listCachedEventTailPage("windowed-cache", undefined, 200);
  assert.deepEqual(whole.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.equal(whole.hasMoreOlder, false);
  assert.deepEqual(db.listCachedEventTailPage("no-such-session", undefined, 5), {
    events: [], hasMoreOlder: false,
  });
  assert.throws(() => db.listCachedEventTailPage("windowed-cache", undefined, 0), /positive safe integer/);
  assert.throws(() => db.listCachedEventTailPage("windowed-cache", -1, 2), /non-negative safe integer/);
});

test("a turn-aligned tail page begins at an invocation rather than orphaned updates", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "aligned-cache" }));
  db.appendEvent("aligned-cache", { kind: "user_message", text: "first" }, 1);
  db.appendEvent("aligned-cache", { kind: "user_message", text: "second" }, 2);
  for (let index = 3; index <= 6; index++) {
    db.appendEvent("aligned-cache", { kind: "agent_message", text: String(index) }, index);
  }
  // A count-bounded window of 2 starts at seq 5 — mid-turn, with updates whose invocation is gone.
  const unaligned = db.listCachedEventTailPage("aligned-cache", undefined, 2);
  assert.deepEqual(unaligned.events.map((event) => event.seq), [5, 6]);
  assert.equal(unaligned.turnAligned, undefined, "alignment is opt-in");

  const aligned = db.listCachedEventTailPage("aligned-cache", undefined, 2, { alignToTurn: true });
  assert.deepEqual(aligned.events.map((event) => event.seq), [2, 3, 4, 5, 6],
    "the page extends down to its own turn's user message");
  assert.equal(aligned.turnAligned, true);
  assert.equal(aligned.nextBeforeSeq, 2);
  assert.equal(aligned.hasMoreOlder, true, "seq 1 remains below the aligned page");

  // A page whose own first row is a user message is already aligned: reaching past it would drag
  // in the previous turn.
  const atBoundary = db.listCachedEventTailPage("aligned-cache", undefined, 5, { alignToTurn: true });
  assert.deepEqual(atBoundary.events.map((event) => event.seq), [2, 3, 4, 5, 6]);
  assert.equal(atBoundary.turnAligned, true);
  assert.equal(atBoundary.hasMoreOlder, true, "seq 1 is still below it");

  // Reaching the session's first turn leaves nothing older to ask for.
  const whole = db.listCachedEventTailPage("aligned-cache", undefined, 6, { alignToTurn: true });
  assert.deepEqual(whole.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(whole.hasMoreOlder, false);
});

test("a page already starting at a user message is left as it is", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "boundary-cache" }));
  db.appendEvent("boundary-cache", { kind: "user_message", text: "first" }, 1);
  db.appendEvent("boundary-cache", { kind: "agent_message", text: "reply" }, 2);
  db.appendEvent("boundary-cache", { kind: "user_message", text: "second" }, 3);
  db.appendEvent("boundary-cache", { kind: "agent_message", text: "reply" }, 4);
  // The count boundary already lands on seq 3, so alignment must not reach back to seq 1 and drag
  // in a whole extra turn the reader did not ask for.
  const page = db.listCachedEventTailPage("boundary-cache", undefined, 2, { alignToTurn: true });
  assert.deepEqual(page.events.map((event) => event.seq), [3, 4]);
  assert.equal(page.turnAligned, true);
  assert.equal(page.nextBeforeSeq, 3);
  assert.equal(page.hasMoreOlder, true);
});

test("turn alignment stops at its cap and never extends a page without bound", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "verbose-turn" }));
  db.appendEvent("verbose-turn", { kind: "user_message", text: "go" }, 1);
  const total = TAIL_TURN_ALIGNMENT_MAX_EVENTS + 60;
  for (let seq = 2; seq <= total; seq++) {
    db.appendEvent("verbose-turn", { kind: "agent_message", text: String(seq) }, seq);
  }
  // The invocation is beyond the cap, so the count boundary stands rather than the page growing to
  // swallow an arbitrarily long turn.
  const page = db.listCachedEventTailPage("verbose-turn", undefined, 10, { alignToTurn: true });
  assert.equal(page.events.length, 10);
  assert.equal(page.turnAligned, false);
  assert.equal(page.hasMoreOlder, true);
});

test("a transcript with no user message keeps its count boundary and reports it unaligned", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "adopted-cache" }));
  for (let seq = 1; seq <= 6; seq++) {
    db.appendEvent("adopted-cache", { kind: "agent_message", text: String(seq) }, seq);
  }
  const page = db.listCachedEventTailPage("adopted-cache", undefined, 2, { alignToTurn: true });
  assert.deepEqual(page.events.map((event) => event.seq), [5, 6]);
  assert.equal(page.turnAligned, false);
});

test("history columns/index migrate additively and an unknown epoch adopts without clearing", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-history-v54-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession());
    initial.appendEvent("sess-1", { kind: "agent_message", text: "legacy one" }, 1);
    initial.appendEvent("sess-1", { kind: "agent_message", text: "legacy two" }, 2);
    initial.setHydratedSeq("sess-1", 2);
    initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("DROP INDEX idx_session_events_runner_seq");
    legacy.exec("ALTER TABLE session_events DROP COLUMN runner_seq");
    legacy.exec("ALTER TABLE sessions DROP COLUMN runner_history_epoch");
    legacy.exec("ALTER TABLE sessions DROP COLUMN runner_history_tail_seq");
    legacy.close();

    const upgraded = ControlPlaneDb.open(path);
    assert.deepEqual(upgraded.getRunnerHistoryState("sess-1"), {
      historyEpoch: null,
      tailSeq: 0,
      hydratedSeq: 2,
      eventEpoch: 0,
      complete: false,
    });
    const adopted = upgraded.reconcileRunnerHistory("sess-1", 7, 3)!;
    assert.equal(adopted.reset, false);
    assert.equal(upgraded.listEvents("sess-1").length, 2, "first known epoch preserves migrated cache");
    const page = upgraded.appendHydratedPage(
      "sess-1",
      { afterSeq: 2, historyEpoch: 7, eventEpoch: 0 },
      [{ seq: 3, ts: 3, payload: { kind: "agent_message", text: "current" } }],
    );
    assert.equal(page.applied, true);
    assert.equal(upgraded.getRunnerHistoryState("sess-1")?.complete, true);
    upgraded.close();

    const raw = new DatabaseSync(path);
    const columns = raw.prepare("PRAGMA table_info(session_events)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "runner_seq"));
    assert.throws(() => raw.prepare(
      "INSERT INTO session_events (session_id, seq, runner_seq, ts, kind, payload) VALUES ('sess-1', 4, 3, 4, 'agent_message', ?)",
    ).run(JSON.stringify({ kind: "agent_message", text: "duplicate source" })), /UNIQUE/);
    raw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- Runs ---------------------------------- */

test("review findings persist anchors, enforce stale-safe triage, summarize completion, and cascade", () => {
  const db = withRunner();
  db.createSession(newSession());
  const finding = {
    findingId: "rf_abcdefgh1234",
    sessionId: "sess-1",
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    filePath: "src/example.ts",
    side: "right",
    line: 12,
    body: "Preserve the invariant.",
    severity: "major",
    required: true,
    status: "open",
    source: "local",
    author: { kind: "human", id: "device-1" },
    createdAt: 1_100,
    updatedAt: 1_100,
  } satisfies ReviewFinding;
  db.createReviewFinding(finding);
  assert.deepEqual(db.listReviewFindings("sess-1"), [finding]);
  assert.deepEqual(db.reviewFindingSummary("sess-1"), {
    total: 1, unresolved: 1, requiredUnresolved: 1, sent: 0, resolved: 0, dismissed: 0, completion: "blocked",
  });

  assert.deepEqual(db.updateReviewFindingStatus({
    sessionId: "sess-1", findingId: finding.findingId, status: "resolved",
    expectedUpdatedAt: 1_099, now: 1_200, actor: { kind: "human", id: "device-2" },
  }), { kind: "stale" });
  const resolved = db.updateReviewFindingStatus({
    sessionId: "sess-1", findingId: finding.findingId, status: "resolved",
    expectedUpdatedAt: 1_100, now: 1_200, actor: { kind: "human", id: "device-2" },
  });
  assert.equal(resolved.kind, "ok");
  if (resolved.kind === "ok") {
    assert.equal(resolved.finding.status, "resolved");
    assert.deepEqual(resolved.finding.resolvedBy, { kind: "human", id: "device-2" });
  }
  assert.equal(db.reviewFindingSummary("sess-1").completion, "complete");

  const reopened = db.updateReviewFindingStatus({
    sessionId: "sess-1", findingId: finding.findingId, status: "open",
    expectedUpdatedAt: 1_200, now: 1_300, actor: { kind: "human", id: "device-2" },
  });
  assert.equal(reopened.kind, "ok");
  const sent = db.markReviewFindingsSent("sess-1", [{ findingId: finding.findingId, expectedUpdatedAt: 1_300 }], 1_400);
  assert.equal(sent?.[0]?.status, "sent");
  assert.equal(sent?.[0]?.sentAt, 1_400);
  assert.equal(db.markReviewFindingsSent("sess-1", [{ findingId: finding.findingId, expectedUpdatedAt: 1_300 }], 1_500), null);

  db.deleteSession("sess-1");
  assert.deepEqual(db.listReviewFindings("sess-1"), []);
});

test("GitHub review reconciliation is idempotent, remote-owned, and dismisses only after a complete sync", () => {
  const db = withRunner();
  db.createSession(newSession());
  const thread = {
    threadId: "PRRT_1",
    commentId: 101,
    url: "https://github.com/acme/repo/pull/7#discussion_r101",
    path: "src/retry.ts",
    side: "right",
    line: 12,
    body: "Preserve the retry invariant.",
    author: "octocat",
    createdAt: 1_000,
    updatedAt: 1_100,
    commitId: "b".repeat(40),
    subjectType: "line",
    resolved: false,
    outdated: false,
  } as const;
  const sync = {
    repository: "acme/repo",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/acme/repo/pull/7",
    pullRequestHeadOid: "a".repeat(40),
    pullRequestBaseOid: "e".repeat(40),
    localHeadOid: "a".repeat(40),
    diffHash: "d".repeat(64),
    threads: [thread],
    synchronizedAt: 1_200,
  } satisfies GitHubReviewSyncInfo;

  assert.deepEqual(db.reconcileGitHubReviewFindings("sess-1", sync), {
    imported: 1, updated: 0, resolved: 0, reopened: 0, dismissedMissing: 0,
  });
  let findings = db.listReviewFindings("sess-1");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.diffHash, sync.diffHash, "exact PR head uses the visible all-branch identity");
  assert.equal(findings[0]?.required, true);
  assert.equal(findings[0]?.status, "open");
  assert.deepEqual(findings[0]?.remote, {
    provider: "github", repository: "acme/repo", pullRequestNumber: 7, threadId: "PRRT_1",
    commentId: 101, url: thread.url, commitId: thread.commitId, outdated: false, subjectType: "line", synchronizedAt: 1_200,
  });

  assert.deepEqual(db.reconcileGitHubReviewFindings("sess-1", { ...sync, synchronizedAt: 1_300 }), {
    imported: 0, updated: 0, resolved: 0, reopened: 0, dismissedMissing: 0,
  }, "a repeated authoritative snapshot does not create or revise the finding");

  const resolved = {
    ...sync,
    localHeadOid: "c".repeat(40),
    synchronizedAt: 1_500,
    threads: [{ ...thread, body: "Updated remotely.", updatedAt: 1_400, resolved: true, outdated: true }],
  } satisfies GitHubReviewSyncInfo;
  assert.deepEqual(db.reconcileGitHubReviewFindings("sess-1", resolved), {
    imported: 0, updated: 1, resolved: 1, reopened: 0, dismissedMissing: 0,
  });
  findings = db.listReviewFindings("sess-1");
  assert.equal(findings[0]?.status, "resolved");
  assert.equal(findings[0]?.body, "Updated remotely.");
  assert.equal(findings[0]?.remote?.outdated, true);
  assert.notEqual(findings[0]?.diffHash, sync.diffHash, "outdated or mismatched heads cannot attach to the current diff");

  assert.deepEqual(db.reconcileGitHubReviewFindings("sess-1", { ...resolved, threads: [], synchronizedAt: 1_600 }), {
    imported: 0, updated: 0, resolved: 0, reopened: 0, dismissedMissing: 1,
  });
  assert.equal(db.listReviewFindings("sess-1")[0]?.status, "dismissed");
});

test("createRun + run members reflected in runView via getRun/listRuns", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "sess-1" }));
  db.createSession(newSession({ id: "sess-2" }));

  db.createRun({
    id: "run-1",
    title: "Parallel",
    prompt: "do the thing",
    workspaceId: "ws-1",
    runnerId: "runner-1",
    now: 1000,
  });
  db.addRunMember("run-1", "sess-1", "acp-agent");
  db.addRunMember("run-1", "sess-2", "claude-agent");
  // duplicate ignored
  db.addRunMember("run-1", "sess-1", "acp-agent");

  const run = db.getRun("run-1")!;
  assert.equal(run.title, "Parallel");
  assert.equal(run.prompt, "do the thing");
  assert.equal(run.workspaceId, "ws-1");
  assert.equal(run.workspaceName, "Repo One");
  assert.deepEqual(run.sessionIds, ["sess-1", "sess-2"]);

  assert.equal(db.getRun("nope"), null);
  const all = db.listRuns();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "run-1");
});

test("pods persist independent membership, lifecycle, and session ownership", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "sess-1" }));
  db.createSession(newSession({ id: "sess-2" }));
  db.createSession(newSession({ id: "sess-3" }));

  const pod = db.createPod({
    id: "pod-1",
    title: "Implementation huddle",
    objective: "Converge on one patch",
    sessionIds: ["sess-1", "sess-2"],
    now: 1_000,
  })!;
  assert.equal(pod.status, "active");
  assert.deepEqual(pod.members.map((member) => member.sessionId), ["sess-1", "sess-2"]);
  assert.deepEqual(pod.members.map((member) => member.role), ["lead", "worker"]);
  assert.equal(pod.orchestration?.policy.mode, "manual");
  assert.equal(db.activePodForSession("sess-1")?.id, "pod-1");
  assert.equal(db.createPod({
    id: "pod-overlap",
    title: "Overlap",
    objective: "",
    sessionIds: ["sess-1", "sess-3"],
    now: 1_500,
  }), null, "database transaction enforces one active pod per session");
  assert.equal(db.getPod("pod-overlap"), null, "failed ownership claim rolls back the pod row");

  const expanded = db.addPodMember("pod-1", "sess-3", 2_000)!;
  assert.deepEqual(expanded.members.map((member) => member.sessionId), ["sess-1", "sess-2", "sess-3"]);
  assert.equal(expanded.updatedAt, 2_000);
  const assigned = db.updatePodMember("pod-1", "sess-3", { role: "reviewer", contextTokenBudget: 4_096 }, 2_100)!;
  assert.deepEqual(assigned.members.at(-1), {
    sessionId: "sess-3", joinedAt: 2_000, role: "reviewer", contextTokenBudget: 4_096, lastContextSeq: 0,
  });
  const configured = db.updatePodOrchestrationPolicy("pod-1", {
    mode: "round_robin", contextTokenBudget: 4_096, summaryTokenBudget: 512, maxTurns: 3, maxRepeatedOutputs: 2,
  }, 2_200)!;
  assert.equal(configured.orchestration?.policy.maxTurns, 3);
  assert.ok(db.startPodOrchestration("pod-1", "run-1", 2_300));
  const step = db.beginPodOrchestrationStep({
    stepId: "step-1", podId: "pod-1", runId: "run-1", targetSessionId: "sess-1",
    selectedEntryIds: [], estimatedTokens: 80, now: 2_301,
  })!;
  assert.equal(step.status, "dispatching");
  assert.equal(db.markPodOrchestrationStepRunning("step-1", "pod-1", "sess-1", 4, 2_302), true);
  assert.equal(db.getPod("pod-1")!.members[0]!.lastContextSeq, 4);
  assert.equal(db.settlePodOrchestrationStep("pod-1", "sess-1", "entry-1", "hash-1", 2_303)?.status, "settled");
  assert.equal(db.countPodOrchestrationOutputHash("pod-1", "run-1", "hash-1"), 1);
  assert.equal(db.stopPodOrchestration("pod-1", "test_complete", 2_304)?.orchestration?.state.stopReason, "test_complete");

  const reduced = db.removePodMember("pod-1", "sess-2", 3_000)!;
  assert.deepEqual(reduced.members.map((member) => member.sessionId), ["sess-1", "sess-3"]);
  assert.equal(db.activePodForSession("sess-2"), null);

  db.deleteSession("sess-1");
  assert.deepEqual(db.getPod("pod-1")!.members.map((member) => member.sessionId), ["sess-3"]);
  assert.equal(db.reconcilePodAfterMembershipLoss("pod-1", 4_000)?.status, "closed");
  assert.equal(db.addPodMember("pod-1", "sess-2", 4_500), null, "database refuses membership changes on a closed pod");
  assert.equal(db.listPods()[0]?.id, "pod-1");
});

test("pod reconciliation receipts are durable, exclusive, attributable, and fail closed on restart", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "sess-1" }));
  db.createSession(newSession({ id: "sess-2" }));
  db.createPod({ id: "pod-1", title: "Pod", objective: "", sessionIds: ["sess-1", "sess-2"], now: 100 });

  const running = db.beginPodReconciliation({
    reconciliationId: "reconcile-1",
    podId: "pod-1",
    sourceSessionId: "sess-2",
    targetSessionId: "sess-1",
    actorId: "device-1",
    now: 200,
  });
  assert.equal(running?.status, "running");
  assert.equal(running?.actorId, "device-1");
  assert.equal(db.activePodReconciliationForSession("sess-1")?.reconciliationId, "reconcile-1");
  assert.equal(db.activePodReconciliationForSession("sess-2")?.reconciliationId, "reconcile-1");
  assert.equal(db.getPod("pod-1")?.reconciliations?.[0]?.status, "running");
  assert.equal(db.beginPodReconciliation({
    reconciliationId: "reconcile-overlap",
    podId: "pod-1",
    sourceSessionId: "sess-1",
    targetSessionId: "sess-2",
    actorId: "device-2",
    now: 201,
  }), null, "only one merge may own a pod at a time");

  const settled = db.settlePodReconciliation("reconcile-1", {
    status: "applied",
    sourceHead: "1".repeat(40),
    targetHead: "2".repeat(40),
    mergeBase: "3".repeat(40),
    resultHead: "4".repeat(40),
  }, 300);
  assert.equal(settled?.status, "applied");
  assert.equal(settled?.resultHead, "4".repeat(40));
  assert.equal(db.activePodReconciliationForSession("sess-1"), null);
  assert.equal(db.settlePodReconciliation("reconcile-1", { status: "failed", error: "late" }, 301), null,
    "a terminal receipt cannot be rewritten by a late runner result");

  assert.ok(db.beginPodReconciliation({
    reconciliationId: "reconcile-2",
    podId: "pod-1",
    sourceSessionId: "sess-2",
    targetSessionId: "sess-1",
    actorId: "device-1",
    now: 400,
  }));
  db.failInterruptedPodReconciliations(500);
  const interrupted = db.getPodReconciliation("reconcile-2");
  assert.equal(interrupted?.status, "failed");
  assert.match(interrupted?.error ?? "", /restart.*uncertain/);
  assert.equal(interrupted?.completedAt, 500);

  assert.ok(db.beginPodReconciliation({
    reconciliationId: "reconcile-0",
    podId: "pod-1",
    sourceSessionId: "sess-2",
    targetSessionId: "sess-1",
    actorId: "device-1",
    now: 400,
  }));
  assert.ok(db.settlePodReconciliation("reconcile-0", { status: "failed", error: "test" }, 501));
  assert.deepEqual(db.listPodReconciliations("pod-1", 2).map((receipt) => receipt.reconciliationId),
    ["reconcile-0", "reconcile-2"], "same-millisecond receipts retain newest-insertion-first ordering");
});

test("automation schedules claim each occurrence once and retain actor-attributed terminal audit", () => {
  const db = withRunner();
  const spec: AutomationSpec = {
    name: "Morning builder",
    cron: "0 9 * * 1-5",
    timezone: "America/Chicago",
    enabled: true,
    misfirePolicy: { kind: "fire_once" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "skip",
    limits: { maxCostUsd: 2, maxToolCalls: 20 },
    notifications: { pushEvents: ["failed"] },
    action: {
      kind: "create_session",
      request: { runnerId: "runner-1", workspaceId: "ws-1", agentId: "acp-agent", prompt: "Build" },
    },
  };
  const created = db.createAutomation({
    automationId: "auto-1", spec, nextFireAt: 1_000,
    actor: { kind: "human", id: "device-1" }, now: 100,
  });
  assert.equal(created.nextFireAt, 1_000);
  assert.equal(created.revision, 1);
  assert.equal(db.dueAutomations(999).length, 0);
  assert.equal(db.dueAutomations(1_000)[0]?.automationId, "auto-1");

  const claimed = db.claimAutomationExecution({
    executionId: "execution-1", automationId: "auto-1", expectedNextFireAt: 1_000,
    scheduledFor: 1_000, nextFireAt: 2_000, actionKind: "create_session", status: "dispatching",
    actor: { kind: "system", id: "automation:auto-1" }, now: 1_001,
  });
  assert.equal(claimed?.idempotencyKey, "auto-1:1000");
  assert.equal(claimed?.automationRevision, 1);
  assert.equal(claimed?.specSnapshot?.name, "Morning builder");
  assert.equal(db.claimAutomationExecution({
    executionId: "duplicate", automationId: "auto-1", expectedNextFireAt: 1_000,
    scheduledFor: 1_000, nextFireAt: 2_000, actionKind: "create_session", status: "dispatching",
    actor: { kind: "system", id: "automation:auto-1" }, now: 1_002,
  }), null, "the next-fire CAS rejects a duplicate scheduler wake");
  assert.equal(db.settleAutomationExecution({
    executionId: "execution-1", status: "running", runnerId: "runner-1", sessionId: "sess-auto",
    actor: { kind: "system", id: "automation:auto-1" }, now: 1_010,
  })?.status, "running");
  assert.equal(db.settleAutomationExecution({
    executionId: "execution-1", status: "succeeded",
    actor: { kind: "system", id: "automation:auto-1" }, now: 1_100,
  })?.completedAt, 1_100);
  assert.equal(db.settleAutomationExecution({
    executionId: "execution-1", status: "failed", error: "late",
    actor: { kind: "system", id: "late" }, now: 1_200,
  }), null, "terminal execution history is immutable");

  const updated = db.updateAutomation({
    automationId: "auto-1", spec: { ...spec, name: "Renamed builder" }, nextFireAt: 2_000,
    actor: { kind: "human", id: "device-1" }, now: 1_500,
  });
  assert.equal(updated?.revision, 2);

  const second = db.claimAutomationExecution({
    executionId: "execution-2", automationId: "auto-1", expectedNextFireAt: 2_000,
    scheduledFor: 2_000, nextFireAt: 3_000, actionKind: "create_session", status: "dispatching",
    actor: { kind: "system", id: "automation:auto-1" }, now: 2_000,
  });
  assert.equal(second?.automationRevision, 2);
  assert.equal(second?.specSnapshot?.name, "Renamed builder");
  assert.equal(claimed?.specSnapshot?.name, "Morning builder", "later edits cannot rewrite claimed provenance");
  assert.equal(db.failInterruptedAutomationExecutions(2_100), 1);
  assert.match(db.getAutomationExecution("execution-2")?.error ?? "", /delivery uncertain.*not replayed/);
  assert.deepEqual(db.listAutomationExecutions("auto-1").map((entry) => entry.executionId),
    ["execution-2", "execution-1"]);
  assert.ok(db.listAutomationEvents("auto-1").some((event) =>
    event.kind === "execution_status_changed" && event.actor.id === "scheduler-recovery"));

  assert.equal(db.deleteAutomation("auto-1", { kind: "human", id: "device-1" }, 3_000), true);
  assert.equal(db.getAutomation("auto-1"), null);
  assert.equal(db.listAutomationExecutions("auto-1").length, 2, "soft deletion retains execution audit");
  assert.equal(db.listAutomationEvents("auto-1")[0]?.kind, "deleted");
});

test("automation delivery plans stage atomically, gate dependencies, and apply receipts monotonically", () => {
  const db = withRunner();
  const spec: AutomationSpec = {
    name: "Receipted workflow", cron: "* * * * *", timezone: "UTC", enabled: true,
    misfirePolicy: { kind: "fire_once" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "wait",
    limits: { maxCostUsd: 1, maxToolCalls: 10 }, notifications: { pushEvents: [] },
    action: { kind: "workflow_run", request: {
      runnerId: "runner-1", workspaceId: "ws-1", workflowId: "wf-1", task: "Build",
    } },
  };
  db.createAutomation({ automationId: "auto-receipt", spec, nextFireAt: 1_000,
    actor: { kind: "human", id: "device" }, now: 100 });
  db.claimAutomationExecution({
    executionId: "exec-receipt", automationId: "auto-receipt", expectedNextFireAt: 1_000,
    scheduledFor: 1_000, nextFireAt: 2_000, actionKind: "workflow_run", status: "dispatching",
    deliveryMode: "receipted_v53", actor: { kind: "system", id: "scheduler" }, now: 1_000,
  });
  const firstPayload = JSON.stringify({ type: "start_session", spec: { sessionId: "worker" } });
  const secondPayload = JSON.stringify({ type: "start_session", spec: { sessionId: "orchestrator" } });
  const staged = db.stageAutomationDeliveryPlan({
    executionId: "exec-receipt", runnerId: "runner-1", runId: "run-1", workflowInstanceId: "instance-1",
    planJson: JSON.stringify({ kind: "workflow_run", runId: "run-1" }), now: 1_001,
    commands: [
      { commandId: "cmd-worker", ordinal: 0, runnerId: "runner-1", sessionId: "worker",
        kind: "start_session", payloadJson: firstPayload, payloadSha256: "a".repeat(64), expiresAt: 9_000 },
      { commandId: "cmd-orchestrator", ordinal: 1, runnerId: "runner-1", sessionId: "orchestrator",
        kind: "start_session", payloadJson: secondPayload, payloadSha256: "b".repeat(64), expiresAt: 9_000,
        dependencyCommandId: "cmd-worker" },
    ],
  });
  assert.deepEqual(staged.map((command) => [command.commandId, command.state]), [
    ["cmd-worker", "staged"], ["cmd-orchestrator", "staged"],
  ]);
  assert.equal(db.hasActiveAutomationCommandForSession("worker"), true);
  assert.equal(db.hasActiveAutomationCommandForSession("orchestrator"), true);
  assert.equal(db.hasActiveAutomationCommandForSession("unowned"), false);
  assert.equal(db.getAutomationExecution("exec-receipt")?.deliveryMode, "receipted_v53");
  assert.equal(db.failInterruptedAutomationExecutions(1_002), 0, "receipted plans survive CP restart recovery");

  db.activateAutomationCommands("exec-receipt", 1_010);
  assert.deepEqual(db.dueAutomationCommands(1_010).map((command) => command.commandId), ["cmd-worker"]);
  assert.equal(db.markAutomationCommandSent("cmd-worker", "req-worker-1", 1_011, 1_100)?.attemptCount, 1);
  assert.equal(db.dueAutomationCommands(1_050).length, 0);
  const accepted = db.recordAutomationCommandReceipt({
    commandId: "cmd-worker", runnerId: "runner-1", state: "accepted", revision: 1, now: 1_020,
  });
  assert.equal(accepted?.executionId, "exec-receipt");
  assert.equal(accepted?.advanced, true);
  assert.equal(accepted?.command.acceptedAt, 1_020);
  db.recordAutomationCommandReceipt({
    commandId: "cmd-worker", runnerId: "runner-1", state: "started", revision: 2, userEventSeq: 7, now: 1_030,
  });
  db.recordAutomationCommandReceipt({
    commandId: "cmd-worker", runnerId: "runner-1", state: "completed", revision: 3, duplicate: false, now: 1_040,
  });
  assert.equal(db.hasActiveAutomationCommandForSession("worker"), false);
  assert.equal(db.getAutomationCommand("cmd-worker")?.payloadJson, "null", "terminal outbox rows redact launch content");
  assert.deepEqual(db.dueAutomationCommands(1_040).map((command) => command.commandId), ["cmd-orchestrator"]);
  const stale = db.recordAutomationCommandReceipt({
    commandId: "cmd-worker", runnerId: "runner-1", state: "accepted", revision: 1, now: 1_050,
  });
  assert.equal(stale?.command.state, "completed", "a delayed receipt cannot regress terminal state");
  assert.equal(stale?.advanced, false, "a delayed receipt is recognized without triggering reconciliation");
  assert.equal(db.recordAutomationCommandReceipt({
    commandId: "cmd-worker", runnerId: "runner-2", state: "completed", revision: 4, now: 1_060,
  }), null, "a receipt from the wrong runner cannot mutate the outbox");
  db.markAutomationCommandSent("cmd-orchestrator", "req-orchestrator-1", 1_061, 1_100);
  const validationFailure = db.recordAutomationCommandReceipt({
    commandId: "cmd-orchestrator", runnerId: "runner-1", state: "rejected", revision: 0,
    code: "INVALID_COMMAND", error: "runner rejected the envelope before journaling", now: 1_062,
  });
  assert.equal(validationFailure?.command.state, "rejected",
    "a pre-journal revision-zero rejection must not be mistaken for a stale receipt");
  assert.deepEqual(db.getAutomationExecution("exec-receipt")?.commands?.map((command) => command.commandId),
    ["cmd-worker", "cmd-orchestrator"]);
  const publicCommand = db.getAutomationExecution("exec-receipt")?.commands?.[1] as unknown as Record<string, unknown>;
  assert.equal("payloadJson" in publicCommand, false, "public execution views must not expose the durable payload");
  assert.equal("payloadSha256" in publicCommand, false, "public execution views must not expose the payload digest");
  assert.equal("nextAttemptAt" in publicCommand, false, "public execution views must not expose retry metadata");
});

test("prerelease automation tables migrate revision provenance columns additively", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-automation-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE automations (
        automation_id TEXT PRIMARY KEY, name TEXT NOT NULL, cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL, enabled INTEGER NOT NULL, next_fire_at INTEGER, last_fired_at INTEGER,
        misfire_policy TEXT NOT NULL, runner_policy TEXT NOT NULL, concurrency_policy TEXT NOT NULL,
        limits_json TEXT NOT NULL, notifications_json TEXT NOT NULL, action_json TEXT NOT NULL,
        created_by_kind TEXT NOT NULL, created_by_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE automation_executions (
        execution_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        scheduled_for INTEGER NOT NULL, action_kind TEXT NOT NULL, status TEXT NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT, runner_id TEXT, session_id TEXT, run_id TEXT,
        workflow_instance_id TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
        completed_at INTEGER, UNIQUE (automation_id, scheduled_for)
      );
      CREATE TABLE automation_triggers (
        trigger_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, secret_key TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
        created_by_kind TEXT NOT NULL, created_by_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE automation_trigger_invocations (
        invocation_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, automation_id TEXT NOT NULL,
        event_id TEXT NOT NULL, body_sha256 TEXT NOT NULL, sender_hash TEXT,
        automation_revision INTEGER NOT NULL, spec_json TEXT NOT NULL, state TEXT NOT NULL,
        execution_id TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (trigger_id, event_id)
      );
    `);
    raw.prepare(`INSERT INTO automations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "legacy-auto", "Legacy", "* * * * *", "UTC", 1, 1_000, null,
      JSON.stringify({ kind: "fire_once" }), JSON.stringify({ kind: "wait" }), "wait",
      JSON.stringify({ maxCostUsd: 1, maxToolCalls: 1 }), JSON.stringify({ pushEvents: [] }),
      JSON.stringify({ kind: "create_session", request: { runnerId: "r", workspaceId: "w", agentId: "a" } }),
      "human", "local", 1, 1, null,
    );
    raw.prepare(`INSERT INTO automation_executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "legacy-execution", "legacy-auto", "legacy-auto:1000", 1_000, "create_session", "failed",
      "system", "legacy", null, null, null, null, "legacy", 1_000, null, 1_001,
    );
    raw.prepare(`INSERT INTO automation_triggers VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      "legacy-trigger", "legacy-auto", "webhook", "Legacy hook", "legacy-secret", 1,
      "human", "local", 1, 1, null,
    );
    const insertInvocation = raw.prepare(
      `INSERT INTO automation_trigger_invocations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insertInvocation.run(
      "legacy-invocation-1", "legacy-trigger", "legacy-auto", "delivery-1", "a".repeat(64), null,
      1, "{}", "rejected", null, 10, 10,
    );
    insertInvocation.run(
      "legacy-invocation-2", "legacy-trigger", "legacy-auto", "delivery-2", "b".repeat(64), null,
      1, "{}", "rejected", null, 20, 20,
    );
    raw.close();

    const db = ControlPlaneDb.open(path);
    assert.equal(db.getAutomation("legacy-auto")?.revision, 1);
    const execution = db.getAutomationExecution("legacy-execution");
    assert.equal(execution?.automationRevision, 1);
    assert.equal(execution?.specSnapshot, undefined, "legacy history stays readable without invented provenance");
    const trigger = db.listAutomationTriggers("legacy-auto")[0]!;
    assert.equal(trigger.invocationCount, 2);
    assert.equal(trigger.lastInvokedAt, 20);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pod context allocates durable per-pod sequence numbers and paginates without reordering", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "sess-1" }));
  db.createSession(newSession({ id: "sess-2" }));
  db.createPod({ id: "pod-1", title: "Pod", objective: "", sessionIds: ["sess-1", "sess-2"], now: 100 });
  for (let index = 1; index <= 4; index += 1) {
    const result = db.appendPodContextEntry({
      id: `ctx-${index}`,
      podId: "pod-1",
      ts: 100 + index,
      source: { kind: "human", actorId: "local" },
      content: `entry ${index}`,
    });
    assert.equal(result.entry.seq, index);
  }
  assert.deepEqual(db.listPodContextEntries("pod-1", undefined, 2).map((entry) => entry.seq), [3, 4]);
  assert.deepEqual(db.listPodContextEntries("pod-1", 3, 2).map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(db.getPodContextEntries("pod-1", ["ctx-4", "ctx-2"]).map((entry) => entry.seq), [4, 2]);
  assert.deepEqual(db.podContextSelectionWindow("pod-1", 1, 2), {
    entries: db.listPodContextEntries("pod-1", undefined, 2), totalCount: 3, minSeq: 2, maxSeq: 4,
  });
});

test("legacy pod tables migrate roles, cursors, budgets, and orchestration state additively", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pod-migration-"));
  const path = join(root, "cp.db");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE pods (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE pod_members (
        pod_id TEXT NOT NULL, session_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
        PRIMARY KEY (pod_id, session_id)
      );
      INSERT INTO pods VALUES ('legacy-pod', 'Legacy', '', 'active', 10, 20);
      INSERT INTO pod_members VALUES ('legacy-pod', 'second', 12);
      INSERT INTO pod_members VALUES ('legacy-pod', 'first', 11);
    `);
    raw.close();

    const migrated = ControlPlaneDb.open(path);
    const pod = migrated.getPod("legacy-pod")!;
    assert.deepEqual(pod.members, [
      { sessionId: "first", joinedAt: 11, role: "lead", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "second", joinedAt: 12, role: "worker", contextTokenBudget: null, lastContextSeq: 0 },
    ]);
    assert.equal(pod.orchestration?.policy.mode, "manual");
    assert.equal(pod.orchestration?.state.status, "idle");
    assert.ok(migrated.updatePodMember("legacy-pod", "first", { role: "worker" }, 30));
    migrated.close();

    const reopened = ControlPlaneDb.open(path);
    assert.deepEqual(
      reopened.getPod("legacy-pod")!.members.map((member) => member.role),
      ["worker", "worker"],
      "the one-time legacy backfill must not overwrite an intentional lead-less configuration",
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------- Deletion -------------------------------- */

test("deleteSession removes its events and run members (no orphans)", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "sess-1" }));
  db.appendEvent("sess-1", { kind: "agent_message", text: "x" }, 100);
  db.appendEvent("sess-1", { kind: "agent_message", text: "y" }, 200);

  db.createRun({
    id: "run-1",
    title: "R",
    prompt: "p",
    workspaceId: "ws-1",
    runnerId: "runner-1",
    now: 1000,
  });
  db.addRunMember("run-1", "sess-1", "acp-agent");

  assert.equal(db.listEvents("sess-1").length, 2);
  assert.deepEqual(db.getRun("run-1")!.sessionIds, ["sess-1"]);

  db.deleteSession("sess-1");

  assert.equal(db.getSession("sess-1"), null);
  // events cascade-deleted (FK) — no orphans
  assert.equal(db.listEvents("sess-1").length, 0);
  // run member explicitly removed — run keeps no dangling id
  assert.deepEqual(db.getRun("run-1")!.sessionIds, []);
});

test("governance audit is query-bounded, retention-bounded, and survives session deletion", () => {
  const db = withRunner();
  db.createSession(newSession());
  const first = db.appendGovernanceAudit({
    requestId: "perm-1",
    approvalKind: "permission",
    stage: "request",
    outcome: "pending",
    actor: { kind: "agent", id: "acp-agent" },
    scope: { sessionId: "sess-1", runnerId: "runner-1", workspaceId: "ws-1", toolName: "shell" },
    contentDigest: "a".repeat(64),
    timestamp: 1001,
  });
  const second = db.appendGovernanceAudit({
    requestId: "perm-1",
    approvalKind: "permission",
    stage: "resolution",
    outcome: "allowed",
    actor: { kind: "human", id: "device-1" },
    scope: { sessionId: "sess-1", runnerId: "runner-1", workspaceId: "ws-1", toolName: "shell" },
    optionId: "allow-once",
    governancePolicyId: "policy-shell",
    timestamp: 1002,
  });

  assert.notEqual(first.auditId, second.auditId);
  assert.deepEqual(db.listGovernanceAudit("sess-1", 1), [second]);
  assert.deepEqual(db.listGovernanceAudit("sess-1", 2), [first, second]);
  assert.deepEqual(db.governanceRequestProvenance("sess-1", "perm-1"), {
    source: "audit",
    requestedAt: 1001,
    actor: { kind: "agent", id: "acp-agent" },
    scope: { sessionId: "sess-1", runnerId: "runner-1", workspaceId: "ws-1", toolName: "shell" },
    auditId: first.auditId,
    contentDigest: "a".repeat(64),
  });
  assert.equal(db.governanceRequestProvenance("sess-1", "missing"), null);
  assert.deepEqual(db.listGovernanceAudit("sess-1", Number.NaN), [first, second]);

  db.deleteSession("sess-1");
  assert.equal(db.getSession("sess-1"), null);
  assert.deepEqual(db.listGovernanceAudit("sess-1", 2), [first, second], "audit has no cascading session FK");
  const plan = db.raw().prepare(
    `EXPLAIN QUERY PLAN SELECT row_id FROM governance_audit
     WHERE created_at<? ORDER BY created_at, row_id LIMIT ?`,
  ).all(2_000, 1) as unknown as Array<{ detail: string }>;
  assert.ok(plan.some((row) => /idx_governance_audit_created/.test(row.detail)));
  const maintenanceNow = GOVERNANCE_AUDIT_RETENTION_MS + 2_000;
  const retentionCutoff = maintenanceNow - GOVERNANCE_AUDIT_RETENTION_MS;
  assert.equal(retentionCutoff, 2_000, "maintenance uses the shared exact 90-day horizon");
  assert.equal(db.pruneGovernanceAudit(retentionCutoff, 1), 1, "each maintenance pass is bounded");
  assert.deepEqual(db.listGovernanceAudit("sess-1", 2), [second]);
  assert.equal(db.pruneGovernanceAudit(retentionCutoff, 1), 1);
  assert.deepEqual(db.listGovernanceAudit("sess-1", 2), []);
});

test("governance policies persist ordered selectors/conditions and support update/delete", () => {
  const db = withRunner();
  const first = db.upsertGovernancePolicy({
    policyId: "workspace-shell",
    name: "Workspace shell",
    effect: "ask",
    priority: 10,
    enabled: true,
    askTimeout: 30,
    scope: { organizationId: "local", runnerId: "runner-1", workspaceId: "ws-1", toolName: "Bash", path: "/repo/*", network: "*.example.com", branch: "feature/*" },
    conditions: { statuses: ["running"], minCostUsd: 1, minToolCalls: 2, escalated: true },
  }, 1000);
  assert.equal(first.createdAt, 1000);
  assert.equal(first.updatedAt, 1000);
  assert.equal(first.askTimeout, 30);
  const updated = db.upsertGovernancePolicy({ ...first, effect: "deny", priority: 20, askTimeout: undefined }, 2000);
  assert.equal(updated.effect, "deny");
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.updatedAt, 2000);
  assert.deepEqual(db.listGovernancePolicies(), [updated]);
  assert.equal(db.deleteGovernancePolicy("workspace-shell"), true);
  assert.equal(db.deleteGovernancePolicy("workspace-shell"), false);
});

test("workflow artifacts persist immutable content, provenance, metadata, and run/session indexes", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.createRun({ id: "run-artifacts", title: "Artifacts", prompt: "p", workspaceId: "ws-1", runnerId: "runner-1", now: 1000 });
  db.addRunMember("run-artifacts", "sess-1", "acp-agent");
  const artifact: WorkflowArtifact = {
    artifactId: "art-1",
    runId: "run-artifacts",
    sessionId: "sess-1",
    kind: "review_report",
    name: "review.md",
    mimeType: "text/markdown",
    encoding: "utf8",
    data: "# Review\nUPVOTE",
    sizeBytes: 15,
    sha256: createHash("sha256").update(Buffer.from("# Review\nUPVOTE", "utf8")).digest("hex"),
    createdBy: { kind: "agent", id: "reviewer" },
    metadata: { round: 1, accepted: true },
    createdAt: 2000,
  };
  db.createWorkflowArtifact(artifact);
  const stored = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id=?").get(artifact.artifactId) as unknown as
    { data: string; blob_key: string };
  assert.deepEqual({ ...stored }, { data: "", blob_key: artifact.sha256 }, "SQLite retains metadata but not artifact bytes");
  assert.deepEqual(db.getWorkflowArtifact("art-1"), artifact);
  const runList = db.listRunWorkflowArtifacts("run-artifacts");
  assert.equal(runList.length, 1);
  assert.equal("data" in runList[0]!, false, "list endpoints never copy artifact bodies");
  assert.deepEqual(db.listSessionWorkflowArtifacts("sess-1"), runList);
  assert.equal(db.getRun("run-artifacts")!.updatedAt, 2000);
  db.createWorkflowArtifact({ ...artifact, artifactId: "art-session-only", runId: undefined, createdAt: 2001 });
  db.deleteSession("sess-1");
  assert.equal(db.getWorkflowArtifact("art-session-only"), null, "session-only artifact follows explicit session deletion");
  assert.ok(db.getWorkflowArtifact("art-1"), "run-owned artifact survives member-session deletion");
  db.raw().prepare("DELETE FROM multi_agent_runs WHERE id=?").run("run-artifacts");
  assert.equal(db.getWorkflowArtifact("art-1"), null, "run-owned artifacts cascade with the run");
});

test("legacy dead artifact rows migrate content-safely into the workflow artifact schema", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-migration-"));
  const path = join(root, "cp.db");
  try {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, data TEXT, created_at INTEGER NOT NULL)");
    raw.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)").run("legacy-1", "gone-session", "unknown", "logs/old.txt", "legacy data", 1234);
    raw.close();
    const db = ControlPlaneDb.open(path);
    const artifact = db.getWorkflowArtifact("legacy-1")!;
    assert.deepEqual([artifact.kind, artifact.name, artifact.data, artifact.createdBy], [
      "test_log", "old.txt", "legacy data", { kind: "system", id: "legacy-migration" },
    ]);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    const migrated = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id='legacy-1'").get() as unknown as
      { data: string; blob_key: string };
    assert.deepEqual({ ...migrated }, { data: "", blob_key: artifact.sha256 });
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup migrates legacy inline large event bodies once and preserves exact artifact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-payload-migration-"));
  const path = join(root, "cp.db");
  const original = `start-${"large-event-body-".repeat(2_000)}-end`;
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession());
    initial.appendEvent("sess-1", { kind: "command_output", text: original }, 1_000);
    assert.deepEqual(initial.listSessionWorkflowArtifacts("sess-1"), []);
    initial.close();

    const migrated = ControlPlaneDb.open(path);
    const event = migrated.listEvents("sess-1")[0]!;
    assert.equal(event.payload.kind, "command_output");
    if (event.payload.kind !== "command_output") return;
    assert.notEqual(event.payload.text, original);
    assert.ok(event.payload.textRefs?.length);
    const artifactIds = event.payload.textRefs!.map((ref) => ref.artifactId);
    assert.equal(
      (migrated.raw().prepare("SELECT COUNT(*) AS n FROM session_event_artifacts WHERE event_id=?")
        .get(event.id) as { n: number }).n,
      artifactIds.length,
    );
    assert.equal(
      Buffer.concat(artifactIds.map((artifactId) => migrated.readWorkflowArtifactBytes(artifactId)!)).toString("utf8"),
      original,
    );
    migrated.close();

    // Simulate a pre-reference-table database that already stored externalized payload refs.
    const legacyRefs = new DatabaseSync(path);
    legacyRefs.exec("DROP TABLE session_event_artifacts; DROP TABLE session_event_artifact_reference_state;");
    legacyRefs.close();

    const reopened = ControlPlaneDb.open(path);
    const again = reopened.listEvents("sess-1")[0]!;
    assert.equal(again.payload.kind, "command_output");
    if (again.payload.kind !== "command_output") return;
    assert.deepEqual(again.payload.textRefs?.map((ref) => ref.artifactId), artifactIds, "migration is idempotent");
    assert.equal(reopened.listSessionWorkflowArtifacts("sess-1").length, artifactIds.length);
    assert.equal(
      (reopened.raw().prepare("SELECT backfilled FROM session_event_artifact_reference_state WHERE id=1")
        .get() as { backfilled: number }).backfilled,
      1,
    );
    assert.equal(reopened.collectOrphanedEventPayloadArtifacts(), 0, "one-time backfill protects legacy refs");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup removes crash-window event payload artifacts that no committed event references", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-payload-orphan-"));
  const path = join(root, "cp.db");
  try {
    const initial = ControlPlaneDb.open(path);
    initial.registerRunner(meta(), 500);
    initial.createSession(newSession());
    const data = "orphaned event body";
    initial.createWorkflowArtifact({
      artifactId: "orphan-event-artifact",
      sessionId: "sess-1",
      kind: "test_log",
      name: "event.txt",
      mimeType: "text/plain",
      encoding: "utf8",
      data,
      sizeBytes: Buffer.byteLength(data),
      sha256: createHash("sha256").update(data).digest("hex"),
      createdBy: { kind: "system", id: "event-payload" },
      metadata: { purpose: "session_event_payload" },
      createdAt: 1_000,
    });
    initial.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.getWorkflowArtifact("orphan-event-artifact"), null);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------- Misc lifecycle ---------------------------- */

test("setWorktreePath persists onto the session view", () => {
  const db = withRunner();
  db.createSession(newSession({ useWorktree: true }));
  db.setWorktreePath("sess-1", "C:/wt/sess-1");
  assert.equal(db.getSession("sess-1")!.worktreePath, "C:/wt/sess-1");
  db.setWorktreePath("sess-1", null);
  assert.equal(db.getSession("sess-1")!.worktreePath, null);
});

test("touch and markOffline update runner status", () => {
  const db = withRunner();
  db.touch("runner-1", 700);
  assert.equal(db.getRunner("runner-1")!.lastSeen, 700);
  assert.equal(db.getRunner("runner-1")!.status, "online");

  db.markOffline("runner-1", 800);
  const v = db.getRunner("runner-1")!;
  assert.equal(v.status, "offline");
  assert.equal(v.connectedAt, null);
  assert.equal(v.lastSeen, 800);
});

test("setPendingApproval tolerates being set and cleared", () => {
  const db = withRunner();
  db.createSession(newSession());
  const approval: PendingApproval = {
    requestId: "r",
    title: "t",
    options: [{ optionId: "o", name: "O" }],
  };
  db.setPendingApproval("sess-1", approval);
  assert.deepEqual(db.getSession("sess-1")!.pendingApproval, approval);
  db.setPendingApproval("sess-1", null);
  assert.equal(db.getSession("sess-1")!.pendingApproval, null);
});

test("getRunner/getSession return null for unknown ids", () => {
  const db = withRunner();
  assert.equal(db.getRunner("ghost"), null);
  assert.equal(db.getSession("ghost"), null);
});

test("messageCount is a maintained counter: increments per event, resets on clearSessionEvents", () => {
  const db = withRunner();
  db.createSession(newSession());
  const id = newSession().id;
  assert.equal(db.getSession(id)!.messageCount, 0);

  db.appendEvent(id, { kind: "user_message", text: "hi" }, 1);
  db.appendEvent(id, { kind: "agent_message", text: "hello" }, 2);
  db.appendEvent(id, { kind: "token_usage", inputTokens: 1, outputTokens: 1 }, 3);
  assert.equal(db.getSession(id)!.messageCount, 3);
  // preview still maintained through the merged UPDATE
  assert.equal(db.getSession(id)!.preview, "hello");

  db.clearSessionEvents(id);
  assert.equal(db.getSession(id)!.messageCount, 0);
  db.appendEvent(id, { kind: "agent_message", text: "again" }, 4);
  assert.equal(db.getSession(id)!.messageCount, 1);
});

test("transcript FTS: indexed on append, searchable with snippets, dropped on session delete", () => {
  const db = withRunner();
  db.createSession(newSession());
  const id = newSession().id;
  db.appendEvent(id, { kind: "user_message", text: "please fix the flux capacitor" }, 1);
  db.appendEvent(id, { kind: "agent_message", text: "the flux capacitor is now aligned" }, 2);
  db.appendEvent(id, { kind: "token_usage", inputTokens: 1 }, 3); // not indexed

  const hits = db.searchEvents("flux capacitor");
  assert.equal(hits.length, 1, "hits group to distinct sessions — both rows are one session");
  assert.ok(hits[0]!.snippet.includes("⟪flux⟫"));
  // Operators/quotes in user input must not be FTS syntax errors.
  assert.doesNotThrow(() => db.searchEvents('AND OR NEAR( "unbalanced'));

  db.deleteSession(id);
  assert.equal(db.searchEvents("flux").length, 0, "deleted sessions leave no stale hits");
});

test("FTS catch-up is idempotent: events written past the cursor are indexed at next open", () => {
  const path = join(mkdtempSync(join(tmpdir(), "wollipog-fts-")), "cp.db");
  try {
    // Build 1 writes an indexed event, then an out-of-band writer (an "older build") appends
    // a session_events row WITHOUT maintaining FTS or the cursor.
    const db1 = ControlPlaneDb.open(path);
    db1.registerRunner(meta(), 500);
    db1.createSession(newSession());
    const id = newSession().id;
    db1.appendEvent(id, { kind: "user_message", text: "first indexed" }, 1);
    db1.raw().prepare(
      "INSERT INTO session_events (session_id, seq, ts, kind, payload) VALUES (?, 2, 2, 'agent_message', ?)",
    ).run(id, JSON.stringify({ kind: "agent_message", text: "drifted unindexed row" }));
    db1.close();

    const db2 = ControlPlaneDb.open(path); // catch-up runs here
    assert.equal(db2.searchEvents("drifted").length, 1, "the drifted row is searchable after reopen");
    assert.equal(db2.searchEvents("first").length, 1, "already-indexed rows are not duplicated");
    const rows = db2.raw().prepare("SELECT COUNT(*) AS c FROM session_events_fts").get() as { c: number };
    assert.equal(rows.c, 2);
    db2.close(); // Windows: rmSync fails on open db handles
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("searchEvents groups hits to distinct sessions and indexes stderr/thought text", () => {
  const db = withRunner();
  db.createSession(newSession());
  db.createSession(newSession({ id: "s_other" }));
  const id = newSession().id;
  for (let i = 0; i < 30; i++) db.appendEvent(id, { kind: "agent_message", text: `needle chunk ${i}` }, i);
  db.appendEvent("s_other", { kind: "stderr", text: "needle in stderr" }, 99);

  const hits = db.searchEvents("needle", 20);
  const sessions = new Set(hits.map((h) => h.sessionId));
  assert.equal(hits.length, sessions.size, "one hit per session");
  assert.ok(sessions.has("s_other"), "a chatty session must not crowd out other sessions");
});

test("searchEvents applies authorized session scope before its ranking window and limit", () => {
  const db = withRunner();
  db.createSession(newSession({ id: "authorized" }));
  db.createSession(newSession({ id: "inaccessible" }));
  for (let i = 0; i < 30; i++) {
    db.appendEvent("inaccessible", { kind: "agent_message", text: `needle inaccessible ${i}` }, i);
  }
  db.appendEvent("authorized", { kind: "agent_message", text: "needle authorized result" }, 100);

  assert.deepEqual(
    db.searchEvents("needle", 1, ["authorized"]).map((hit) => hit.sessionId),
    ["authorized"],
    "inaccessible higher-ranked rows cannot consume the authorized result bound",
  );
  assert.deepEqual(db.searchEvents("needle", 1, []), []);
  assert.deepEqual(
    new Set(db.searchEventsForPrincipal("needle", 20, localOwner()).map((hit) => hit.sessionId)),
    new Set(["authorized", "inaccessible"]),
    "principal authorization runs inside the ranked FTS query without a catalog-id materialization",
  );
});

test("archive page SQL bounds candidate materialization before cursor hydration", () => {
  const db = withRunner();
  for (let index = 0; index < 60; index++) {
    const id = `archive-${String(index).padStart(2, "0")}`;
    db.createSession(newSession({ id, title: `Archive ${index}`, now: 1_000 + index }));
    db.setSessionArchived(id, true, 2_000 + index);
  }
  const firstCandidates = db.archiveSessionCandidatePageForPrincipal(localOwner(), {});
  assert.ok(!("error" in firstCandidates));
  if ("error" in firstCandidates) throw new Error(firstCandidates.error);
  assert.equal(firstCandidates.sessions.length, 51, "SQLite returns one bounded page plus lookahead");
  const first = archiveSessionPage({ sessions: firstCandidates.sessions, query: {} });
  assert.ok(!("error" in first));
  if ("error" in first) throw new Error(first.error);
  assert.equal(first.sessionIds.length, 50);
  assert.ok(first.nextCursor);

  const secondQuery = { cursor: first.nextCursor! };
  const secondCandidates = db.archiveSessionCandidatePageForPrincipal(localOwner(), secondQuery);
  assert.ok(!("error" in secondCandidates));
  if ("error" in secondCandidates) throw new Error(secondCandidates.error);
  assert.equal(secondCandidates.sessions.length, 10);
  const second = archiveSessionPage({ sessions: secondCandidates.sessions, query: secondQuery });
  assert.ok(!("error" in second));
  if ("error" in second) throw new Error(second.error);
  assert.equal(second.sessionIds.length, 10);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.sessionIds, ...second.sessionIds]).size, 60);
});
