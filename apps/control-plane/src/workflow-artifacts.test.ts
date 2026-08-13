import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkflowArtifact } from "./workflow-artifacts.js";

test("validates and content-addresses each workflow artifact contract", () => {
  const cases = [
    { kind: "html_preview", encoding: "utf8", mimeType: "text/html", data: "<!doctype html><title>Preview</title>" },
    { kind: "patch", encoding: "utf8", mimeType: "text/x-diff", data: "--- a\n+++ b\n" },
    { kind: "review_report", encoding: "utf8", mimeType: "text/markdown", data: "# Review" },
    { kind: "test_log", encoding: "utf8", mimeType: "text/plain", data: "12 passed" },
    { kind: "verdict", encoding: "json", mimeType: "application/json", data: "{\n  \"verdict\": \"upvote\"\n}" },
    { kind: "screenshot", encoding: "base64", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") },
  ] as const;
  for (const input of cases) {
    const result = validateWorkflowArtifact({ runId: "r1", ...input, name: `${input.kind}.artifact`, metadata: { attempt: 1 } });
    assert.equal(result.ok, true, input.kind);
    if (!result.ok) continue;
    assert.match(result.value.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.value.sizeBytes > 0);
    if (input.kind === "verdict") assert.equal(result.value.data, '{"verdict":"upvote"}');
  }
});

test("artifact validation rejects ambiguous encodings, spoofed images, invalid JSON, and oversized data", () => {
  const base = { sessionId: "s1", name: "artifact.txt" };
  assert.match((validateWorkflowArtifact({ ...base, kind: "patch", encoding: "base64", mimeType: "text/x-diff", data: "eA==" }) as { error: string }).error, /utf8/);
  assert.match((validateWorkflowArtifact({ ...base, kind: "screenshot", encoding: "base64", mimeType: "image/png", data: "eA==" }) as { error: string }).error, /bytes/);
  assert.match((validateWorkflowArtifact({ ...base, kind: "screenshot", encoding: "base64", mimeType: "image/png", data: "not base64" }) as { error: string }).error, /base64/);
  assert.match((validateWorkflowArtifact({ ...base, kind: "verdict", encoding: "json", mimeType: "application/json", data: "[]" }) as { error: string }).error, /JSON object/);
  assert.match((validateWorkflowArtifact({ ...base, kind: "html_preview", encoding: "utf8", mimeType: "image/svg+xml", data: "<svg/>" }) as { error: string }).error, /MIME/);
  assert.match((validateWorkflowArtifact({ ...base, kind: "html_preview", encoding: "utf8", mimeType: "text/html", data: "x".repeat(2 * 1024 * 1024 + 1) }) as { error: string }).error, /size/);
  assert.match((validateWorkflowArtifact({ ...base, kind: "test_log", encoding: "utf8", mimeType: "text/plain", data: "x".repeat(8 * 1024 * 1024 + 1) }) as { error: string }).error, /size/);
});

test("patch and test-log artifacts accept one maximum-sized event payload chunk", () => {
  const data = "x".repeat(8 * 1024 * 1024);
  assert.equal(validateWorkflowArtifact({ sessionId: "s1", kind: "test_log", name: "event.txt", encoding: "utf8", mimeType: "text/plain", data }).ok, true);
  assert.equal(validateWorkflowArtifact({ sessionId: "s1", kind: "patch", name: "event.diff", encoding: "utf8", mimeType: "text/x-diff", data }).ok, true);
});

test("artifact validation rejects missing ownership, path-like names, unknown fields, and unsafe metadata", () => {
  const valid = { sessionId: "s1", kind: "test_log", name: "tests.log", mimeType: "text/plain", encoding: "utf8", data: "ok" };
  assert.match((validateWorkflowArtifact({ ...valid, sessionId: undefined }) as { error: string }).error, /runId or sessionId/);
  assert.match((validateWorkflowArtifact({ ...valid, name: "../tests.log" }) as { error: string }).error, /name/);
  assert.match((validateWorkflowArtifact({ ...valid, extra: true }) as { error: string }).error, /unsupported/);
  assert.match((validateWorkflowArtifact({ ...valid, metadata: { bad_key: { nested: true } } }) as { error: string }).error, /metadata/);
  assert.match((validateWorkflowArtifact({ ...valid, metadata: { constructor: "pollute" } }) as { error: string }).error, /metadata/);
});
