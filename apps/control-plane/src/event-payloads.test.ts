import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EVENT_PAYLOAD_CHUNK_BYTES,
  EVENT_PAYLOAD_MAX_BYTES,
  EVENT_PAYLOAD_PREVIEW_BYTES,
  type WorkflowArtifactView,
} from "@wollipog/protocol";
import {
  eventPayloadPreview,
  externalizeSessionEventPayload,
  splitEventPayloadBytes,
} from "./event-payloads.js";

class ArtifactDb {
  created: Array<{ artifact: WorkflowArtifactView; bytes: Buffer }> = [];
  deleted: string[] = [];
  failAt = -1;

  createWorkflowArtifactBytes(artifact: WorkflowArtifactView, bytes: Buffer): void {
    if (this.created.length === this.failAt) throw new Error("blob store unavailable");
    this.created.push({ artifact, bytes: Buffer.from(bytes) });
  }

  deleteWorkflowArtifact(artifactId: string): void {
    this.deleted.push(artifactId);
  }
}

test("event payload externalization leaves bounded inline values unchanged", () => {
  const db = new ArtifactDb();
  const payload = { kind: "command_output" as const, text: "x".repeat(EVENT_PAYLOAD_PREVIEW_BYTES) };
  assert.deepEqual(externalizeSessionEventPayload(db, "s1", payload, 10), { payload, artifactIds: [] });
  assert.equal(db.created.length, 0);
});

test("bounded inline values discard malformed untrusted references", () => {
  const db = new ArtifactDb();
  const result = externalizeSessionEventPayload(db, "s1", {
    kind: "stderr",
    text: "bounded",
    textRefs: [],
  }, 10);
  assert.deepEqual(result.payload, { kind: "stderr", text: "bounded" });
  assert.equal(db.created.length, 0);
});

test("untrusted reference-shaped metadata cannot bypass large-body externalization", () => {
  const db = new ArtifactDb();
  const result = externalizeSessionEventPayload(db, "s1", {
    kind: "command_output",
    text: "x".repeat(EVENT_PAYLOAD_PREVIEW_BYTES + 1),
    textRefs: [],
  }, 10, (index) => `event_${index}`);
  assert.equal(db.created.length, 1);
  assert.equal(result.payload.kind, "command_output");
  assert.ok(result.payload.kind === "command_output" && result.payload.textRefs?.length === 1);
});

test("event payload externalization stores UTF-8 chunks and a bounded reconstructable contract", () => {
  const db = new ArtifactDb();
  const original = `${"a".repeat(EVENT_PAYLOAD_CHUNK_BYTES - 2)}€${"z".repeat(32)}`;
  const result = externalizeSessionEventPayload(
    db,
    "s1",
    { kind: "file_edit", path: "src/a.ts", diff: original },
    10,
    (index) => `event_${index}`,
  );
  assert.equal(result.artifactIds.length, 2);
  assert.equal(db.created.length, 2);
  assert.equal(Buffer.concat(db.created.map(({ bytes }) => bytes)).toString("utf8"), original);
  assert.ok(Buffer.byteLength((result.payload as { diff: string }).diff, "utf8") <= EVENT_PAYLOAD_PREVIEW_BYTES);
  const refs = (result.payload as { diffRefs: Array<{ artifactId: string; sizeBytes: number; sha256: string }> }).diffRefs;
  assert.deepEqual(refs.map(({ artifactId }) => artifactId), ["event_0", "event_1"]);
  for (let index = 0; index < refs.length; index++) {
    assert.equal(refs[index]!.sizeBytes, db.created[index]!.bytes.byteLength);
    assert.equal(refs[index]!.sha256, createHash("sha256").update(db.created[index]!.bytes).digest("hex"));
    assert.equal(db.created[index]!.artifact.metadata?.purpose, "session_event_payload");
  }
});

test("event payload splitting preserves UTF-8 boundaries and enforces the aggregate limit", () => {
  assert.equal(splitEventPayloadBytes(Buffer.alloc(EVENT_PAYLOAD_CHUNK_BYTES)).length, 1, "exact chunk stays single");
  const original = Buffer.from(`${"x".repeat(EVENT_PAYLOAD_CHUNK_BYTES - 1)}€-tail`, "utf8");
  const chunks = splitEventPayloadBytes(original);
  assert.ok(chunks.every((chunk) => chunk.byteLength <= EVENT_PAYLOAD_CHUNK_BYTES));
  assert.equal(Buffer.concat(chunks).compare(original), 0);
  assert.ok(chunks.every((chunk) => !chunk.toString("utf8").includes("�")));
  const maximum = splitEventPayloadBytes(Buffer.alloc(EVENT_PAYLOAD_MAX_BYTES));
  assert.equal(maximum.length, 4);
  assert.ok(maximum.every((chunk) => chunk.byteLength === EVENT_PAYLOAD_CHUNK_BYTES));
  assert.throws(() => splitEventPayloadBytes(Buffer.alloc(EVENT_PAYLOAD_MAX_BYTES + 1)), /1-/);
  assert.throws(() => splitEventPayloadBytes(Buffer.alloc(0)), /1-/);
  assert.ok(Buffer.byteLength(eventPayloadPreview(original, chunks.length), "utf8") <= EVENT_PAYLOAD_PREVIEW_BYTES);
});

test("partial artifact creation is cleaned and the original payload is not mutated", () => {
  const db = new ArtifactDb();
  db.failAt = 1;
  const payload = { kind: "stderr" as const, text: "x".repeat(EVENT_PAYLOAD_CHUNK_BYTES + 1) };
  assert.throws(() => externalizeSessionEventPayload(db, "s1", payload, 10, (index) => `event_${index}`), /unavailable/);
  assert.deepEqual(db.deleted, ["event_0"]);
  assert.equal(payload.text.length, EVENT_PAYLOAD_CHUNK_BYTES + 1);
  assert.equal("textRefs" in payload, false);
});
