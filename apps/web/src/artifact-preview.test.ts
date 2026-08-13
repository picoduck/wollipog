import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import {
  classifyArtifactPreview,
  normalizeBrowserUrl,
  sandboxHtmlDocument,
  verifyArtifactPreviewBlob,
} from "./artifact-preview.js";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

test("browser URL admission accepts explicit web URLs and rejects credentials or active schemes", () => {
  assert.deepEqual(normalizeBrowserUrl(" https://example.com/a?b=1 "), { ok: true, url: "https://example.com/a?b=1" });
  assert.equal(normalizeBrowserUrl("example.com").ok, false);
  assert.equal(normalizeBrowserUrl("javascript:alert(1)").ok, false);
  assert.equal(normalizeBrowserUrl(["https://name:", "secret@example.com/"].join("")).ok, false);
  assert.equal(normalizeBrowserUrl(`https://example.com/${"a".repeat(2_100)}`).ok, false);
});

test("artifact preview classification is exact rather than MIME-sniffed", () => {
  const base = { kind: "html_preview", mimeType: "text/html", encoding: "utf8" } as const;
  assert.equal(classifyArtifactPreview(base), "html");
  assert.equal(classifyArtifactPreview({ ...base, kind: "test_log" }), "unsupported");
  assert.equal(classifyArtifactPreview({ kind: "screenshot", mimeType: "image/png", encoding: "base64" }), "image");
  assert.equal(classifyArtifactPreview({ kind: "review_report", mimeType: "text/markdown", encoding: "utf8" }), "markdown");
});

function artifact(bytes: Uint8Array, overrides: Partial<WorkflowArtifactView> = {}): WorkflowArtifactView {
  return {
    artifactId: "artifact_1",
    sessionId: "session_1",
    kind: "test_log",
    name: "test.log",
    mimeType: "text/plain",
    encoding: "utf8",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdBy: { kind: "system" },
    createdAt: 1,
    ...overrides,
  };
}

test("artifact preview verification rejects length, MIME, and digest mismatches", async () => {
  const bytes = new TextEncoder().encode("hello");
  await verifyArtifactPreviewBlob(artifact(bytes), new Blob([bytes], { type: "text/plain; charset=utf-8" }));
  await assert.rejects(() => verifyArtifactPreviewBlob(artifact(bytes, { sizeBytes: 4 }), new Blob([bytes], { type: "text/plain" })), /length/);
  await assert.rejects(() => verifyArtifactPreviewBlob(artifact(bytes), new Blob([bytes], { type: "application/json" })), /MIME/);
  await assert.rejects(() => verifyArtifactPreviewBlob(artifact(bytes, { sha256: "0".repeat(64) }), new Blob([bytes], { type: "text/plain" })), /digest/);
});

test("HTML artifact wrapper installs a no-network policy before untrusted markup", () => {
  const wrapped = sandboxHtmlDocument('<script src="https://example.com/x.js"></script><img src="https://example.com/x.png">');
  assert.ok(wrapped.indexOf("Content-Security-Policy") < wrapped.indexOf("<script"));
  assert.match(wrapped, /default-src 'none'/);
  assert.match(wrapped, /form-action 'none'/);
  assert.doesNotMatch(wrapped, /allow-scripts/);
});
