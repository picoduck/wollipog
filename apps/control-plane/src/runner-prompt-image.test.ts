import assert from "node:assert/strict";
import { test } from "node:test";
import { runnerPromptImage } from "./runner-prompt-image.js";

function harness(scope: { sessionId?: string; runId?: string } = { sessionId: "s1" }, forkAncestor = false) {
  const bytes = Buffer.from("exact-image");
  let active = true;
  const db = {
    verifyActiveRunnerCredential: (runnerId: string, hash: string) => active && runnerId === "r1" && hash === "valid-hash",
    getSession: (sessionId: string) => sessionId === "s1" ? { id: "s1", runnerId: "r1", runId: "run1" } : null,
    sessionForkIncludesAncestor: (_target: string, source: string) => forkAncestor && source === scope.sessionId,
    workflowArtifactExportPreflight: () => ({
      artifact: {
        artifactId: "art1", kind: "screenshot", encoding: "base64", mimeType: "image/png",
        name: "image", sizeBytes: bytes.length, sha256: "a".repeat(64), createdBy: { kind: "system" }, createdAt: 1,
        ...scope,
      },
      storedDataBytes: bytes.length,
    }),
    readWorkflowArtifactBytes: () => bytes,
  };
  return { db: db as never, bytes, revoke: () => { active = false; } };
}

test("runner prompt-image read binds active credential, runner, and session", () => {
  const { db, bytes, revoke } = harness();
  assert.deepEqual(runnerPromptImage(db, "r1", "s1", "art1", "valid-hash"), {
    ok: true, body: bytes, mimeType: "image/png",
  });
  assert.equal(runnerPromptImage(db, "r2", "s1", "art1", "valid-hash").status, 401);
  assert.equal(runnerPromptImage(db, "r1", "s2", "art1", "valid-hash").status, 404);
  revoke();
  assert.equal(runnerPromptImage(db, "r1", "s1", "art1", "valid-hash").status, 401);
});

test("runner prompt-image read permits same-run workflow output but denies foreign scope", () => {
  assert.equal(runnerPromptImage(harness({ runId: "run1", sessionId: "source" }).db, "r1", "s1", "art1", "valid-hash").ok, true);
  assert.equal(runnerPromptImage(harness({ runId: "other", sessionId: "source" }).db, "r1", "s1", "art1", "valid-hash").status, 404);
  assert.equal(runnerPromptImage(harness({ sessionId: "source" }, true).db, "r1", "s1", "art1", "valid-hash").ok, true);
});
