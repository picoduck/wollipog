import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import {
  ArtifactVerificationError,
  classifyArtifactPreview,
  markdownWithoutTitle,
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

test("a host and port without a scheme is told to add one (#2854)", () => {
  assert.deepEqual(normalizeBrowserUrl("localhost:3000"), { ok: false, error: "Start the address with http:// or https://." });
  assert.deepEqual(normalizeBrowserUrl("ftp://example.com/"), { ok: false, error: "Only http:// and https:// URLs can be previewed." });
});

test("artifact preview classification is exact rather than MIME-sniffed", () => {
  const base = { kind: "html_preview", mimeType: "text/html", encoding: "utf8" } as const;
  assert.equal(classifyArtifactPreview(base), "html");
  assert.equal(classifyArtifactPreview({ ...base, kind: "test_log" }), "unsupported");
  assert.equal(classifyArtifactPreview({ kind: "screenshot", mimeType: "image/png", encoding: "base64" }), "image");
  assert.equal(classifyArtifactPreview({ kind: "video", mimeType: "video/webm", encoding: "base64" }), "video");
  assert.equal(classifyArtifactPreview({ kind: "video", mimeType: "text/html", encoding: "base64" }), "unsupported");
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

test("a report's leading H1 is dropped only when it repeats the artifact's title (#2855)", () => {
  assert.equal(markdownWithoutTitle("# Browser Review\n\n## Findings\n", "Browser Review"), "## Findings\n");
  assert.equal(markdownWithoutTitle("\n  # Browser Review #\r\n\r\nBody", " Browser Review "), "Body");
  assert.equal(markdownWithoutTitle("# Another Title\n\nBody", "Browser Review"), "# Another Title\n\nBody");
  assert.equal(markdownWithoutTitle("Intro\n# Browser Review\n", "Browser Review"), "Intro\n# Browser Review\n", "only a leading H1");
  assert.equal(markdownWithoutTitle("## Browser Review\nBody", "Browser Review"), "## Browser Review\nBody", "only an H1");
  assert.equal(markdownWithoutTitle("#Browser Review\nBody", "Browser Review"), "#Browser Review\nBody", "not a heading without its space");
  assert.equal(markdownWithoutTitle("   # Browser Review\nBody", "Browser Review"), "Body", "three spaces still make a heading");
  for (const code of ["\t# Browser Review\n\tkeep this code\n\nBody", "    # Browser Review\n    keep this code\n"]) {
    assert.equal(markdownWithoutTitle(code, "Browser Review"), code, "a tab or four spaces make indented code, which stays");
  }
});

test("bytes that are not the artifact's fail with a verification error a preview can name (#2855)", async () => {
  const bytes = new TextEncoder().encode("expected");
  const artifact = {
    artifactId: "a", kind: "test_log", name: "log", mimeType: "text/plain", encoding: "utf8",
    sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    createdBy: { kind: "system" }, createdAt: 1,
  } as WorkflowArtifactView;
  await assert.rejects(verifyArtifactPreviewBlob(artifact, new Blob(["tampered"], { type: "text/plain" })), ArtifactVerificationError);
  await assert.rejects(verifyArtifactPreviewBlob(artifact, new Blob(["expected"], { type: "text/html" })), ArtifactVerificationError);
  await assert.rejects(verifyArtifactPreviewBlob(artifact, new Blob(["expectee"], { type: "text/plain" })), ArtifactVerificationError);
});
