import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";
import { ControlPlaneVideoFrameStorage, createControlPlaneVideoReviewStore } from "./video-evidence-artifacts.js";
import type { VideoReviewRecord } from "./video-evidence-runtime.js";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
/** Actual referenced Session rows in an in-memory CODE fixture, never managed provider work. */
function fixtureDb(): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "synthetic-runner", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [{ id: "synthetic-workspace", name: "Synthetic Workspace", path: "/synthetic-workspace" }], agents: [] }, 1);
  for (const id of ["root", "child", "reviewer"]) db.createSession({ id, runnerId: "synthetic-runner",
    workspaceId: "synthetic-workspace", agentId: "synthetic-agent", title: "Synthetic Storage Session",
    driver: "codex-app-server", useWorktree: false, config: {}, now: 1 });
  return db;
}
/** Metadata/blob boundary test only. Actual valid complete PNG derivation uses the real decoder
 * in runtime tests; this tiny fixture is not evidence or live model validation. */
function review(): VideoReviewRecord {
  const criteria = [{ criterionId: "test", description: "Synthetic storage test" }];
  const manifest = {
    schemaVersion: 1 as const, purpose: "trusted_temporal_derivation" as const,
    profile: "paced-silent-complete-frames-v1" as const, sourceSha256: hash("source"),
    sourceSizeBytes: 1, sourceMediaType: "video/webm" as const, width: 1280, height: 720, durationUs: 66_000,
    frames: [0, 1].map((index) => ({ index, ptsUs: index * 33_000, durationUs: 33_000,
      sha256: hash(image), sizeBytes: image.length })),
    segments: [{ index: 0, firstFrame: 0, frameCount: 2, startUs: 0, endUs: 66_000 }],
  };
  return {
    reviewId: "video_storage_test", binding: {
      rootSessionId: "root", childSessionId: "child", occurrenceId: "occurrence", resourceDigest: hash("decision"),
      policyRevision: 1, boundaryRevision: 1, evidenceAuthorityRevision: 1, reviewerSessionId: "reviewer",
      reviewerDriver: "codex-app-server", reviewerModelId: "synthetic", providerId: "synthetic",
      audienceSha256: hash("audience"), capabilitiesSha256: hash("capability"), sourceEvidenceId: "source_evidence", sourceArtifactId: "source",
      sourceSha256: hash("source"), workerAdmissionSha256: hash("admission"), criteriaSha256: hash(JSON.stringify(criteria)),
    }, manifest, manifestSha256: hash(JSON.stringify(manifest)), criteria, criteriaSha256: hash(JSON.stringify(criteria)),
    createdAt: 1_000, expiresAt: 3_601_000, status: "pending",
  };
}
test("concrete private artifact writer stages complete frames without nested SQLite transactions or inline bytes", (t) => {
  const db = fixtureDb(); t.after(() => db.close());
  const record = review();
  const store = createControlPlaneVideoReviewStore(db);
  store.saveDerived(record, [image, image]);
  assert.equal(store.getReview(record.reviewId)?.manifest.frames.length, 2);
  assert.deepEqual(store.readFrame(record.reviewId, 0), image);
  const rows = db.raw().prepare("SELECT data,created_by_kind,created_by_id,metadata FROM artifacts").all() as
    Array<{ data: string; created_by_kind: string; created_by_id: string; metadata: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.data === "" && row.created_by_kind === "system" && row.created_by_id === "video-review-v2"));
  assert.doesNotMatch(JSON.stringify(rows), /base64|bearer|token|PRIVATE_PIXELS/iu);
  assert.throws(() => store.saveDerived(record, [image, image]), /already exists/u);
  assert.deepEqual(store.readFrame(record.reviewId, 0), image);
});
test("failed concrete derivation removes only its created frames and never publishes a partial review", (t) => {
  const db = fixtureDb(); t.after(() => db.close());
  const record = review();
  record.manifest.frames[1]!.sha256 = hash("wrong expected bytes");
  const store = createControlPlaneVideoReviewStore(db);
  assert.throws(() => store.saveDerived(record, [image, image]), /identity is invalid/u);
  assert.equal(store.getReview(record.reviewId), null);
  assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM artifacts").get()!.n, 0);
});
test("artifact author, manifest metadata and timing tampering fail closed; colliding artifacts survive rollback", (t) => {
  const db = fixtureDb(); t.after(() => db.close());
  const record = review();
  const store = createControlPlaneVideoReviewStore(db);
  store.saveDerived(record, [image, image]);
  const id = record.reviewId + ":frame:0";
  db.raw().prepare("UPDATE artifacts SET created_by_kind='agent' WHERE id=?").run(id);
  assert.equal(store.readFrame(record.reviewId, 0), null);
  db.raw().prepare("UPDATE artifacts SET created_by_kind='system' WHERE id=?").run(id);
  db.raw().prepare("UPDATE artifacts SET metadata=json_set(metadata,'$.ptsUs',1) WHERE id=?").run(id);
  assert.equal(store.readFrame(record.reviewId, 0), null);
  const frames = new ControlPlaneVideoFrameStorage(db);
  assert.throws(() => frames.writeFrame(record, 0, image), /identity is invalid/u);
  frames.deleteFrame(record, 0);
  assert.ok(db.workflowArtifactExportPreflight(id)?.artifact, "unowned collision is never deleted by cleanup");
});

test("source deletion and attachment retention remove only server-authored same-source temporal frames", (t) => {
  for (const retention of [false, true]) {
    const db = fixtureDb(); t.after(() => db.close());
    const record = review();
    const source = Buffer.from("source");
    db.createWorkflowArtifactBytes({
      artifactId: "source", sessionId: "child", kind: "video", name: "Synthetic.webm",
      mimeType: "video/webm", encoding: "base64", sizeBytes: source.length, sha256: hash(source),
      createdBy: { kind: "agent", id: "child" }, metadata: { purpose: "session_attachment" }, createdAt: 1_000,
    }, source);
    const store = createControlPlaneVideoReviewStore(db);
    store.saveDerived(record, [image, image]);
    const owned = db.workflowArtifactExportPreflight(record.reviewId + ":frame:0")!.artifact;
    for (const [id, sessionId, createdBy] of [
      ["agent_copy", "child", { kind: "agent" as const, id: "child" }],
      ["other_child", "another", { kind: "system" as const, id: "video-review-v2" }],
    ] as const) db.createWorkflowArtifactBytes({ ...owned, artifactId: id, sessionId, createdBy }, image);
    if (retention) assert.equal(db.pruneExpiredSessionAttachments(2_000), 1);
    else assert.equal(db.deleteWorkflowArtifact("source"), true);
    assert.equal(store.readFrame(record.reviewId, 0), null);
    assert.equal(store.readFrame(record.reviewId, 1), null);
    assert.ok(db.workflowArtifactExportPreflight("agent_copy"));
    assert.ok(db.workflowArtifactExportPreflight("other_child"));
  }
});

test("bounded expiry sweep removes crashed staging and expired frames without trusting agent metadata", (t) => {
  const db = fixtureDb(); t.after(() => db.close());
  const record = review(), frames = new ControlPlaneVideoFrameStorage(db);
  // A crash before review publication leaves private rows without any usable review grant.
  frames.writeFrame(record, 0, image);
  const owned = db.workflowArtifactExportPreflight(record.reviewId + ":frame:0")!.artifact;
  db.createWorkflowArtifactBytes({ ...owned, artifactId: "agent_copy", createdBy: { kind: "agent", id: "child" } }, image);
  db.createWorkflowArtifactBytes({ ...owned, artifactId: "invalid_expiry",
    metadata: { ...owned.metadata, expiresAt: "1" } }, image);
  assert.equal(db.pruneExpiredTemporalVideoFrames(record.expiresAt - 1), 0);
  assert.equal(db.pruneExpiredTemporalVideoFrames(record.expiresAt, 1), 1);
  assert.equal(db.pruneExpiredTemporalVideoFrames(record.expiresAt, 1), 0);
  assert.ok(db.workflowArtifactExportPreflight("agent_copy"));
  assert.ok(db.workflowArtifactExportPreflight("invalid_expiry"));
  assert.equal(db.workflowArtifactExportPreflight(record.reviewId + ":frame:0"), null);
});
