import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { HumanPrincipal } from "./identity.js";
import type { RunnerMetadata, WorkflowArtifact } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { buildAuthorizedWorkflowArtifactExport } from "./artifact-exports.js";
import { externalizeSessionEventPayload } from "./event-payloads.js";

const runner: RunnerMetadata = {
  runnerId: "artifact-export-runner",
  hostname: "host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [{ id: "artifact-export-workspace", name: "Workspace", path: "/repo" }],
};

function fixture(): { db: ControlPlaneDb; principal: HumanPrincipal } {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, 53);
  db.createSession({
    id: "artifact-export-session", runnerId: runner.runnerId, agentId: null,
    workspaceId: "artifact-export-workspace", title: "Session", useWorktree: false,
    driver: "acp", config: {}, now: 1,
  });
  db.createRun({
    id: "artifact-export-run", title: "Run", prompt: "Export", runnerId: runner.runnerId,
    workspaceId: "artifact-export-workspace", now: 1,
  });
  const identity = db.localIdentityContext();
  return { db, principal: { kind: "human", actorId: identity.userId, ...identity } };
}

function storeArtifact(
  db: ControlPlaneDb,
  input: Pick<WorkflowArtifact, "artifactId" | "kind" | "name" | "mimeType" | "encoding" | "data"> &
    { runOnly?: boolean; runWithSession?: boolean },
): WorkflowArtifact {
  const bytes = input.encoding === "base64" ? Buffer.from(input.data, "base64") : Buffer.from(input.data, "utf8");
  const artifact: WorkflowArtifact = {
    artifactId: input.artifactId,
    ...(input.runOnly
      ? { runId: "artifact-export-run" }
      : input.runWithSession
        ? { runId: "artifact-export-run", sessionId: "artifact-export-session" }
        : { sessionId: "artifact-export-session" }),
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    encoding: input.encoding,
    data: input.data,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdBy: { kind: "human", id: "creator" },
    createdAt: 10,
  };
  db.createWorkflowArtifact(artifact);
  return artifact;
}

function rawDb(db: ControlPlaneDb): DatabaseSync {
  return (db as unknown as { db: DatabaseSync }).db;
}

test("authenticated artifact export returns exact decoded bytes with hardened attachment headers", () => {
  const { db, principal } = fixture();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cases = [
    { artifactId: "art-patch", kind: "patch", name: "agent-authored-change.patch", mimeType: "text/x-diff", encoding: "utf8", data: "diff --git a/a b/a\n" },
    { artifactId: "art-report", kind: "review_report", name: "résumé (final).md", mimeType: "text/markdown", encoding: "utf8", data: "# Review\n" },
    { artifactId: "art-image", kind: "screenshot", name: "agent-authored-screen.png", mimeType: "image/png", encoding: "base64", data: png.toString("base64") },
    { artifactId: "art-log", kind: "test_log", name: "agent-authored-tests.log", mimeType: "text/plain", encoding: "utf8", data: "pass ✓\n" },
    { artifactId: "art-verdict", kind: "verdict", name: "agent-authored-verdict.json", mimeType: "application/json", encoding: "json", data: '{"outcome":"accepted"}', runOnly: true },
  ] as const;

  for (const item of cases) {
    const artifact = storeArtifact(db, item);
    const result = buildAuthorizedWorkflowArtifactExport(db, { ...principal, role: "viewer" }, artifact.artifactId);
    assert.equal(result.ok, true, artifact.artifactId);
    if (!result.ok) continue;
    const expected = artifact.encoding === "base64" ? Buffer.from(artifact.data, "base64") : Buffer.from(artifact.data, "utf8");
    assert.deepEqual(result.body, expected);
    assert.equal(result.body.byteLength, artifact.sizeBytes);
    assert.match(result.filename, /^workflow-artifact-/);
    assert.equal(result.headers["content-length"], String(expected.byteLength));
    assert.match(result.headers["content-disposition"]!, /^attachment; filename="workflow-artifact-/);
    assert.equal(result.headers["content-disposition"]!.includes(artifact.name), false);
    assert.equal(result.headers["cache-control"], "private, no-store");
    assert.equal(result.headers.pragma, "no-cache");
    assert.equal(result.headers.vary, "Authorization");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
    assert.match(result.headers["content-security-policy"]!, /sandbox/);
    assert.equal(JSON.stringify(result.body).includes(artifact.sha256), false, "body is raw bytes, not a metadata wrapper");
  }
});

test("large event chunks reuse session-scoped authorization and export exact source bytes", () => {
  const { db, principal } = fixture();
  const original = "event-output-".repeat(2_000);
  const prepared = externalizeSessionEventPayload(
    db,
    "artifact-export-session",
    { kind: "command_output", text: original },
    10,
    (index) => `event-export-${index}`,
  );
  assert.equal(prepared.artifactIds.length, 1);
  const exported = buildAuthorizedWorkflowArtifactExport(db, { ...principal, role: "viewer" }, prepared.artifactIds[0]!);
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  assert.deepEqual(exported.body, Buffer.from(original, "utf8"));
  assert.equal(exported.headers["content-type"], "text/plain; charset=utf-8");

  const outsider = { ...principal, actorId: "outsider", userId: "outsider", organizationId: "other-org" };
  const denied = buildAuthorizedWorkflowArtifactExport(db, outsider, prepared.artifactIds[0]!);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.deepEqual({ status: denied.status, code: denied.code }, { status: 404, code: "not_found" });
});

test("artifact export authorizes metadata before loading bodies and fails corrupt rows closed", () => {
  const { db, principal } = fixture();
  const artifact = storeArtifact(db, {
    artifactId: "art-corrupt", kind: "test_log", name: "tests.log",
    mimeType: "text/plain", encoding: "utf8", data: "safe",
  });
  let bodyReads = 0;
  const originalGet = db.getWorkflowArtifact.bind(db);
  db.getWorkflowArtifact = (artifactId) => { bodyReads += 1; return originalGet(artifactId); };

  const outsider = { ...principal, actorId: "outsider", userId: "outsider", organizationId: "other-org" };
  assert.deepEqual(buildAuthorizedWorkflowArtifactExport(db, outsider, artifact.artifactId), {
    ok: false, status: 404, error: "artifact not found", code: "not_found",
  });
  assert.equal(bodyReads, 0, "denied calls cannot load artifact content");
  assert.deepEqual(buildAuthorizedWorkflowArtifactExport(db, principal, "missing"), {
    ok: false, status: 404, error: "artifact not found", code: "not_found",
  });

  rawDb(db).prepare("UPDATE artifacts SET size_bytes=? WHERE id=?")
    .run(8 * 1024 * 1024 + 1, artifact.artifactId);
  const oversized = buildAuthorizedWorkflowArtifactExport(db, principal, artifact.artifactId);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "invalid_artifact");
  assert.equal(bodyReads, 0, "oversized stored text is rejected before body materialization");

  const missingBytes = Buffer.from("changed", "utf8");
  const missingKey = createHash("sha256").update(missingBytes).digest("hex");
  rawDb(db).prepare("UPDATE artifacts SET blob_key=?, size_bytes=?, sha256=? WHERE id=?")
    .run(missingKey, missingBytes.byteLength, missingKey, artifact.artifactId);
  const corrupt = buildAuthorizedWorkflowArtifactExport(db, principal, artifact.artifactId);
  assert.equal(corrupt.ok, false);
  if (!corrupt.ok) assert.deepEqual({ status: corrupt.status, code: corrupt.code }, { status: 422, code: "invalid_artifact" });
  assert.equal(bodyReads, 1);

  rawDb(db).prepare("UPDATE artifacts SET metadata=? WHERE id=?").run("{not-json", artifact.artifactId);
  const corruptMetadata = buildAuthorizedWorkflowArtifactExport(db, principal, artifact.artifactId);
  assert.equal(corruptMetadata.ok, false);
  if (!corruptMetadata.ok) {
    assert.deepEqual({ status: corruptMetadata.status, code: corruptMetadata.code }, { status: 422, code: "invalid_artifact" });
  }
});

test("run ownership survives deleted session provenance and noncanonical JSON fails integrity", () => {
  const { db, principal } = fixture();
  const surviving = storeArtifact(db, {
    artifactId: "art-run-survivor", kind: "test_log", name: "survivor.log",
    mimeType: "text/plain", encoding: "utf8", data: "survives", runWithSession: true,
  });
  db.deleteSession("artifact-export-session");
  const exported = buildAuthorizedWorkflowArtifactExport(db, { ...principal, role: "viewer" }, surviving.artifactId);
  assert.equal(exported.ok, true);
  if (exported.ok) assert.equal(exported.body.toString("utf8"), "survives");
  const outsider = { ...principal, actorId: "outsider", userId: "outsider", organizationId: "other-org", role: "viewer" as const };
  assert.equal(buildAuthorizedWorkflowArtifactExport(db, outsider, surviving.artifactId).ok, false);

  const noncanonicalData = '{ "outcome": "accepted" }';
  const noncanonicalBytes = Buffer.from(noncanonicalData, "utf8");
  const verdict: WorkflowArtifact = {
    artifactId: "art-noncanonical-json", runId: "artifact-export-run", kind: "verdict",
    name: "verdict.json", mimeType: "application/json", encoding: "json", data: noncanonicalData,
    sizeBytes: noncanonicalBytes.byteLength,
    sha256: createHash("sha256").update(noncanonicalBytes).digest("hex"),
    createdBy: { kind: "human", id: "creator" }, createdAt: 11,
  };
  db.createWorkflowArtifact(verdict);
  const noncanonical = buildAuthorizedWorkflowArtifactExport(db, principal, verdict.artifactId);
  assert.equal(noncanonical.ok, false);
  if (!noncanonical.ok) {
    assert.deepEqual({ status: noncanonical.status, code: noncanonical.code }, { status: 422, code: "invalid_artifact" });
  }
});
