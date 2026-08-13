import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowArtifact, WorkflowArtifactView } from "@wollipog/protocol";
import {
  FileArtifactBlobStore,
  artifactBlobFilePath,
  artifactBlobSha256,
  defaultArtifactBlobRoot,
} from "./artifact-blob-store.js";
import { ControlPlaneDb } from "./db.js";

function artifact(artifactId: string, sessionId: string, data = "shared artifact bytes"): WorkflowArtifact {
  const bytes = Buffer.from(data, "utf8");
  return {
    artifactId,
    sessionId,
    kind: "test_log",
    name: `${artifactId}.log`,
    mimeType: "text/plain",
    encoding: "utf8",
    data,
    sizeBytes: bytes.byteLength,
    sha256: artifactBlobSha256(bytes),
    createdBy: { kind: "system", id: "blob-test" },
    createdAt: 1,
  };
}

test("artifact rows keep metadata only while deduplicated blobs survive until their final reference is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-db-"));
  const path = join(root, "control-plane.db");
  try {
    const db = ControlPlaneDb.open(path);
    const first = artifact("artifact-one", "session-one");
    const second = artifact("artifact-two", "session-two");
    db.createWorkflowArtifact(first);
    db.createWorkflowArtifact(second);

    const rows = db.raw().prepare("SELECT id, data, blob_key, size_bytes, sha256 FROM artifacts ORDER BY id")
      .all() as unknown as Array<{ id: string; data: string; blob_key: string; size_bytes: number; sha256: string }>;
    assert.deepEqual(rows.map((row) => row.data), ["", ""]);
    assert.deepEqual(new Set(rows.map((row) => row.blob_key)), new Set([first.sha256]));
    assert.deepEqual(db.getWorkflowArtifact(first.artifactId), first);

    const blobPath = artifactBlobFilePath(defaultArtifactBlobRoot(path), first.sha256);
    assert.equal(existsSync(blobPath), true);
    writeFileSync(blobPath, Buffer.from("tampered shared bytes", "utf8"));
    assert.throws(() => db.getWorkflowArtifact(first.artifactId), /size|digest/);
    db.raw().prepare("DELETE FROM artifacts WHERE id=?").run(first.artifactId);
    assert.deepEqual(db.collectWorkflowArtifactBlobs(), { examined: 1, deleted: 0, retained: 1 });
    assert.equal(existsSync(blobPath), true, "a shared blob remains while another metadata row references it");

    db.raw().prepare("DELETE FROM artifacts WHERE id=?").run(second.artifactId);
    assert.deepEqual(db.collectWorkflowArtifactBlobs(), { examined: 1, deleted: 1, retained: 0 });
    assert.equal(existsSync(blobPath), false);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw prompt image insertion never creates an inline base64 body", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-raw-image-"));
  try {
    const db = ControlPlaneDb.open(join(root, "control-plane.db"));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const view: WorkflowArtifactView = {
      artifactId: "prompt-image", sessionId: "session-one", kind: "screenshot", name: "prompt.png",
      mimeType: "image/png", encoding: "base64", sizeBytes: bytes.length,
      sha256: artifactBlobSha256(bytes), createdBy: { kind: "system", id: "test" }, createdAt: 1,
    };
    db.createWorkflowArtifactBytes(view, bytes);
    const row = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id=?").get(view.artifactId) as unknown as
      { data: string; blob_key: string };
    assert.deepEqual({ ...row }, { data: "", blob_key: view.sha256 });
    assert.deepEqual(db.readWorkflowArtifactBytes(view.artifactId), bytes);
    assert.equal(db.getWorkflowArtifact(view.artifactId)?.data, bytes.toString("base64"));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed metadata inserts clean new blobs without removing shared content", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-rollback-"));
  const path = join(root, "control-plane.db");
  const blobRoot = join(root, "custom-artifact-root");
  try {
    const db = ControlPlaneDb.open(path, { artifactBlobDir: blobRoot });
    const original = artifact("duplicate-id", "session-one");
    db.createWorkflowArtifact(original);
    assert.equal(db.workflowArtifactBlobRoot(), blobRoot);

    const uniqueFailure = artifact("duplicate-id", "session-two", "new bytes that must be rolled back");
    assert.throws(() => db.createWorkflowArtifact(uniqueFailure), /UNIQUE/);
    assert.equal(existsSync(artifactBlobFilePath(blobRoot, uniqueFailure.sha256)), false);

    const sharedFailure = artifact("duplicate-id", "session-three");
    assert.throws(() => db.createWorkflowArtifact(sharedFailure), /UNIQUE/);
    assert.equal(existsSync(artifactBlobFilePath(blobRoot, original.sha256)), true);
    assert.deepEqual(db.getWorkflowArtifact(original.artifactId), original);
    assert.equal(
      Number((db.raw().prepare("SELECT COUNT(*) AS count FROM artifact_blob_pending").get() as unknown as { count: number }).count),
      0,
    );
    db.close();

    const reopened = ControlPlaneDb.open(path, { artifactBlobDir: blobRoot });
    assert.deepEqual(reopened.getWorkflowArtifact(original.artifactId), original);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup migrates valid inline artifacts without destroying corrupt legacy content", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-inline-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
      mime_type TEXT NOT NULL, encoding TEXT NOT NULL, data TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, created_by_kind TEXT NOT NULL, created_by_id TEXT, metadata TEXT,
      created_at INTEGER NOT NULL, CHECK (run_id IS NOT NULL OR session_id IS NOT NULL)
    )`);
    const validData = "legacy inline data";
    const validBytes = Buffer.from(validData, "utf8");
    const insert = raw.prepare(
      `INSERT INTO artifacts
       (id, run_id, session_id, kind, name, mime_type, encoding, data, size_bytes, sha256,
        created_by_kind, created_by_id, metadata, created_at)
       VALUES (?, NULL, 'legacy-session', 'test_log', ?, 'text/plain', 'utf8', ?, ?, ?, 'system', NULL, NULL, 1)`,
    );
    const validKey = createHash("sha256").update(validBytes).digest("hex");
    const emptyKey = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    insert.run("valid-inline", "valid.log", validData, validBytes.byteLength, validKey);
    insert.run("empty-inline", "empty.log", "", 0, emptyKey);
    insert.run("corrupt-inline", "corrupt.log", "only copy", 9, "0".repeat(64));
    raw.close();

    const db = ControlPlaneDb.open(path);
    const migrated = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id='valid-inline'")
      .get() as unknown as { data: string; blob_key: string };
    const corrupt = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id='corrupt-inline'")
      .get() as unknown as { data: string; blob_key: string | null };
    const empty = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id='empty-inline'")
      .get() as unknown as { data: string; blob_key: string };
    assert.deepEqual({ ...migrated }, { data: "", blob_key: validKey });
    assert.deepEqual({ ...empty }, { data: "", blob_key: emptyKey });
    assert.deepEqual({ ...corrupt }, { data: "only copy", blob_key: null });
    assert.equal(db.getWorkflowArtifact("valid-inline")?.data, validData);
    assert.equal(db.getWorkflowArtifact("empty-inline")?.data, "");
    assert.throws(() => db.getWorkflowArtifact("corrupt-inline"), /bytes do not match metadata/);
    assert.equal(existsSync(artifactBlobFilePath(defaultArtifactBlobRoot(path), validKey)), true);
    assert.equal(existsSync(artifactBlobFilePath(defaultArtifactBlobRoot(path), emptyKey)), true);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovers a crash-journaled unreferenced blob", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-pending-"));
  const path = join(root, "control-plane.db");
  try {
    ControlPlaneDb.open(path).close();
    const bytes = Buffer.from("orphan after rename before metadata commit", "utf8");
    const key = artifactBlobSha256(bytes);
    const blobRoot = defaultArtifactBlobRoot(path);
    new FileArtifactBlobStore(blobRoot).put(key, bytes);
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO artifact_blob_pending (blob_key, created_at) VALUES (?, 1)").run(key);
    raw.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(existsSync(artifactBlobFilePath(blobRoot, key)), false);
    assert.equal(
      Number((reopened.raw().prepare("SELECT COUNT(*) AS count FROM artifact_blob_pending").get() as unknown as { count: number }).count),
      0,
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
