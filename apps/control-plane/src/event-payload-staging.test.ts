import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type SessionEventPayload } from "@wollipog/protocol";
import { artifactBlobFilePath, artifactBlobSha256, defaultArtifactBlobRoot } from "./artifact-blob-store.js";
import { ControlPlaneDb } from "./db.js";
import { stageSessionEventPayload } from "./event-payloads.js";

const SESSION = "session-staging";

function openDb(path: string): ControlPlaneDb {
  const db = ControlPlaneDb.open(path);
  if (!db.getSession(SESSION)) {
    db.registerRunner({
      runnerId: "runner-staging",
      hostname: "staging",
      os: "linux",
      version: "test",
      workspaces: [{ id: "workspace-1", name: "Workspace", path: "/tmp" }],
      agents: [{
        id: "agent-1", name: "Agent", command: "agent", args: [], env: {},
        driver: "claude-code", available: true, context: { kind: "native" },
      }],
    }, Date.now(), PROTOCOL_VERSION);
    db.createSession({
      id: SESSION, runnerId: "runner-staging", workspaceId: "workspace-1", agentId: "agent-1",
      title: SESSION, useWorktree: false, driver: "claude-code", config: {}, now: Date.now(),
    });
  }
  return db;
}

function count(db: ControlPlaneDb, table: string): number {
  return Number((db.raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function blobFiles(root: string): string[] {
  const content = join(root, "sha256");
  if (!existsSync(content)) return [];
  return readdirSync(content).flatMap((prefix) =>
    readdirSync(join(content, prefix)).filter((name) => !name.startsWith(".")));
}

/** What a process crash at this instant leaves on disk: the database, its WAL, and every blob
 * file the OS has accepted. (An OS crash can also lose unflushed writes; the ordering test below
 * pins the flushes that rule that out.) */
function crashCopy(root: string, path: string, label: string): string {
  const copyRoot = join(root, `crash-${label}`);
  mkdirSync(copyRoot);
  const copy = join(copyRoot, "control-plane.db");
  cpSync(path, copy);
  if (existsSync(`${path}-wal`)) cpSync(`${path}-wal`, `${copy}-wal`);
  const blobs = defaultArtifactBlobRoot(path);
  if (existsSync(blobs)) cpSync(blobs, defaultArtifactBlobRoot(copy), { recursive: true });
  return copy;
}

/** Reopen a crash copy (running startup recovery) and assert the invariant of #2794: every
 * committed artifact row has its complete blob, every event reference has its artifact row, no
 * pending blob survives recovery, and no blob is left without a referencing row. */
function assertRecoveredConsistently(copy: string): { events: number; artifacts: number } {
  const db = ControlPlaneDb.open(copy);
  try {
    const artifacts = db.raw().prepare("SELECT id, blob_key FROM artifacts").all() as Array<{ id: string; blob_key: string }>;
    for (const artifact of artifacts) {
      assert.ok(db.readWorkflowArtifactBytes(artifact.id), `artifact ${artifact.id} reads back verified`);
    }
    const events = db.listEvents(SESSION);
    for (const event of events) {
      const refs = (event.payload as { textRefs?: Array<{ artifactId: string }> }).textRefs ?? [];
      for (const ref of refs) assert.ok(db.getWorkflowArtifact(ref.artifactId), "event reference has its artifact row");
    }
    assert.equal(count(db, "artifact_blob_pending"), 0, "startup recovery settles every pending blob");
    const referenced = new Set(artifacts.map((artifact) => artifact.blob_key));
    assert.deepEqual(blobFiles(defaultArtifactBlobRoot(copy)).filter((key) => !referenced.has(key)), [],
      "no unreferenced blob survives recovery");
    return { events: events.length, artifacts: artifacts.length };
  } finally {
    db.close();
  }
}

test("a crash at every step of staged event ingestion recovers without a dangling reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-staging-crash-"));
  const path = join(root, "control-plane.db");
  try {
    const db = openDb(path);
    const payload: SessionEventPayload = { kind: "command_output", text: "crash-point-".repeat(4_000) };
    const copies: Record<string, string> = {};
    const internals = db as unknown as { flushWal: () => Promise<void> };
    const flushWal = internals.flushWal.bind(db);
    internals.flushWal = async () => {
      await flushWal();
      copies.beforePublish = crashCopy(root, path, "before-publish");
    };
    const staged = await stageSessionEventPayload(db, SESSION, payload, 1_000);
    copies.durableBeforeRows = crashCopy(root, path, "durable-before-rows");
    const externalized = staged.commit();
    copies.artifactRowsBeforeEvent = crashCopy(root, path, "artifact-rows-before-event");
    db.appendEvent(SESSION, externalized.payload, 1_000, {
      runnerSeq: 1, historyEpoch: null, searchPayload: payload, artifactIds: externalized.artifactIds,
    });
    staged.release();
    copies.committed = crashCopy(root, path, "committed");
    db.close();

    assert.deepEqual(Object.keys(copies), ["beforePublish", "durableBeforeRows", "artifactRowsBeforeEvent", "committed"]);
    assert.deepEqual(assertRecoveredConsistently(copies.beforePublish!), { events: 0, artifacts: 0 });
    assert.deepEqual(assertRecoveredConsistently(copies.durableBeforeRows!), { events: 0, artifacts: 0 });
    assert.deepEqual(assertRecoveredConsistently(copies.artifactRowsBeforeEvent!), { events: 0, artifacts: 0 },
      "artifact rows without their event are collected as crash-window orphans");
    assert.deepEqual(assertRecoveredConsistently(copies.committed!), { events: 1, artifacts: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging flushes the pending row before publishing and writes rows only after the blob is durable", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-staging-order-"));
  const path = join(root, "control-plane.db");
  try {
    const db = openDb(path);
    const text = "ordering-".repeat(4_000);
    const key = artifactBlobSha256(Buffer.from(text, "utf8"));
    const blobPath = artifactBlobFilePath(defaultArtifactBlobRoot(path), key);
    const steps: string[] = [];
    const internals = db as unknown as { flushWal: () => Promise<void> };
    const flushWal = internals.flushWal.bind(db);
    internals.flushWal = async () => {
      assert.equal(count(db, "artifact_blob_pending"), 1, "the pending row is committed before the WAL flush");
      await flushWal();
      assert.equal(existsSync(blobPath), false, "the blob is published only after the pending row is flushed");
      steps.push("pending row flushed");
    };
    const createRows = db.createStagedEventPayloadArtifacts.bind(db);
    const raw = db.raw();
    const synchronousLevel = () => Number(Object.values(raw.prepare("PRAGMA synchronous").get()!)[0]);
    const commitLevels: number[] = [];
    db.createStagedEventPayloadArtifacts = (artifacts) => {
      assert.ok(existsSync(blobPath), "the blob is published before any row references it");
      steps.push("artifact rows");
      const exec = raw.exec.bind(raw);
      raw.exec = (sql: string) => {
        if (sql === "COMMIT") commitLevels.push(synchronousLevel());
        return exec(sql);
      };
      try {
        createRows(artifacts);
      } finally {
        raw.exec = exec;
      }
    };
    const staged = await stageSessionEventPayload(db, SESSION, { kind: "stderr", text }, 1_000);
    steps.push("staged");
    assert.equal(count(db, "artifacts"), 0, "staging alone writes no artifact row");
    const externalized = staged.commit();
    staged.release();
    assert.deepEqual(steps, ["pending row flushed", "staged", "artifact rows"]);
    assert.deepEqual(commitLevels, [1], "the artifact rows of a durable blob commit without a flush on the event loop");
    assert.equal(synchronousLevel(), 2, "the connection returns to FULL");
    assert.equal(count(db, "artifact_blob_pending"), 0, "the artifact commit retires the pending row");
    assert.equal(db.readWorkflowArtifactBytes(externalized.artifactIds[0]!)?.toString("utf8"), text);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a staged blob survives cleanup and collection until every staging of its key releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-staging-shared-"));
  const path = join(root, "control-plane.db");
  try {
    const db = openDb(path);
    const payload: SessionEventPayload = { kind: "command_output", text: "shared-content-".repeat(4_000) };
    const key = artifactBlobSha256(Buffer.from(payload.text, "utf8"));
    const blobPath = artifactBlobFilePath(defaultArtifactBlobRoot(path), key);

    // An earlier event holds the same content; deleting it queues the blob for collection.
    const earlier = await stageSessionEventPayload(db, SESSION, payload, 1_000);
    const earlierIds = earlier.commit().artifactIds;
    earlier.release();

    const first = await stageSessionEventPayload(db, SESSION, payload, 2_000);
    const second = await stageSessionEventPayload(db, SESSION, payload, 2_000);
    for (const artifactId of earlierIds) db.deleteWorkflowArtifact(artifactId);
    assert.ok(existsSync(blobPath), "collection skips a key with a staging in flight");
    first.release();
    assert.ok(existsSync(blobPath), "releasing one staging keeps the blob for the other");

    const externalized = second.commit();
    second.release();
    assert.equal(db.readWorkflowArtifactBytes(externalized.artifactIds[0]!)?.toString("utf8"), payload.text);
    assert.equal(count(db, "artifact_blob_pending"), 0);

    const abandoned = await stageSessionEventPayload(db, SESSION, { kind: "stderr", text: "abandoned-".repeat(4_000) }, 3_000);
    abandoned.release();
    assert.throws(() => abandoned.commit(), /already released/);
    assert.equal(blobFiles(defaultArtifactBlobRoot(path)).length, 1, "an abandoned staging removes its own blob");
    assert.equal(count(db, "artifact_blob_pending"), 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed chunk staging releases every chunk and leaves nothing pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-staging-failure-"));
  const path = join(root, "control-plane.db");
  try {
    const db = openDb(path);
    const stage = db.stageArtifactBlob.bind(db);
    let calls = 0;
    db.stageArtifactBlob = async (key, bytes, createdAt) => {
      calls += 1;
      await stage(key, bytes, createdAt);
      if (calls === 2) throw new Error("disk full");
    };
    // Two chunks: the second fails after its own blob was written.
    const text = "a".repeat(8 * 1024 * 1024) + "b".repeat(1024);
    await assert.rejects(stageSessionEventPayload(db, SESSION, { kind: "stderr", text }, 1_000), /disk full/);
    assert.equal(calls, 2);
    assert.equal(count(db, "artifact_blob_pending"), 0);
    assert.deepEqual(blobFiles(defaultArtifactBlobRoot(path)), []);
    assert.throws(
      () => db.createStagedEventPayloadArtifacts([{
        artifactId: "never-staged", sessionId: SESSION, kind: "test_log", name: "x.txt", mimeType: "text/plain",
        encoding: "utf8", sizeBytes: 1, sha256: artifactBlobSha256(Buffer.from("x")),
        createdBy: { kind: "system", id: "event-payload" }, metadata: { purpose: "session_event_payload" }, createdAt: 1,
      }]),
      /not a staged durable blob/,
      "rows can reference only a blob whose staging is still held",
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
