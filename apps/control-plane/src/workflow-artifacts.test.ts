import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkflowArtifact, videoBytesMatchMime } from "./workflow-artifacts.js";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(8)]);

test("validates and content-addresses each workflow artifact contract", () => {
  const cases = [
    { kind: "html_preview", encoding: "utf8", mimeType: "text/html", data: "<!doctype html><title>Preview</title>" },
    { kind: "patch", encoding: "utf8", mimeType: "text/x-diff", data: "--- a\n+++ b\n" },
    { kind: "review_report", encoding: "utf8", mimeType: "text/markdown", data: "# Review" },
    { kind: "test_log", encoding: "utf8", mimeType: "text/plain", data: "12 passed" },
    { kind: "verdict", encoding: "json", mimeType: "application/json", data: "{\n  \"verdict\": \"upvote\"\n}" },
    { kind: "screenshot", encoding: "base64", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") },
    { kind: "video", encoding: "base64", mimeType: "video/mp4", data: mp4.toString("base64") },
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

test("video validation accepts MP4 and WebM signatures and rejects spoofed or oversized media", () => {
  const make = (mimeType: string, data: Buffer) => validateWorkflowArtifact({
    sessionId: "session", kind: "video", name: "clip", mimeType, encoding: "base64", data: data.toString("base64"),
  });
  assert.equal(make("video/mp4", mp4).ok, true);
  assert.equal(make("video/webm", webm).ok, true);
  assert.match((make("video/mp4", webm) as { error: string }).error, /declared MIME type/u);
  assert.match((make("video/webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("matroska")])) as { error: string }).error, /declared MIME type/u);
  assert.match((make("video/mp4", Buffer.concat([mp4, Buffer.alloc(32 * 1024 * 1024 + 1 - mp4.length)])) as { error: string }).error, /size limit/u);
});

test("WebM validation reads the bounded EBML DocType element", () => {
  const signature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const docType = (value: string) => Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | value.length]), Buffer.from(value)]);
  const header = (...elements: Buffer[]) => {
    const content = Buffer.concat(elements);
    assert.ok(content.length < 127);
    return Buffer.concat([signature, Buffer.from([0x80 | content.length]), content]);
  };
  const accepts = (bytes: Buffer) => videoBytesMatchMime("video/webm", bytes);
  const version = Buffer.from([0x42, 0x86, 0x81, 0x01]);

  assert.equal(accepts(header(version, docType("webm"))), true, "DocType may follow another EBML header element");
  assert.equal(accepts(Buffer.concat([header(docType("matroska")), Buffer.from("webm")])), false,
    "a WebM string after the Matroska header is not the DocType");
  assert.equal(accepts(header(Buffer.from([0xec, 0x84]), Buffer.from("webm"))), false,
    "a WebM string in another header element is not the DocType");
  assert.equal(accepts(header(version)), false, "DocType is required");
  assert.equal(accepts(header(Buffer.from([0x42, 0x82, 0x84, 0xf7, 0xe5, 0xe2, 0xed]))), false,
    "the DocType bytes must exactly match webm");
  assert.equal(accepts(header(docType("webm"), docType("matroska"))), false, "duplicate DocTypes are ambiguous");
  assert.equal(accepts(Buffer.concat([signature, Buffer.from([0xff]), docType("webm")])), false,
    "an unknown-sized header cannot bound DocType parsing");
  assert.equal(accepts(Buffer.concat([signature, Buffer.from([0x89]), docType("webm")])), false,
    "a header that claims bytes beyond the upload is truncated");
  assert.equal(accepts(Buffer.concat([signature, Buffer.from([0x87, 0x42, 0x82, 0x85]), Buffer.from("webm")])), false,
    "a DocType that extends past its parent is invalid");
  assert.equal(accepts(Buffer.concat([signature, Buffer.from([0x87, 0x00]), docType("webm")])), false,
    "an invalid child ID is rejected");
  assert.equal(accepts(Buffer.concat([signature, Buffer.from([0x87, 0xec, 0xff]), Buffer.from("webm")])), false,
    "an unknown-sized child cannot hide a WebM string");

  const size2 = (size: number) => Buffer.from([0x40 | (size >> 8), size & 0xff]);
  const largeHeader = Buffer.concat([
    signature, size2(4090), Buffer.from([0xec]), size2(4080), Buffer.alloc(4080), docType("webm"),
  ]);
  assert.equal(largeHeader.length, 4096);
  assert.equal(accepts(largeHeader), true, "a valid DocType at the header bound is accepted");
  assert.equal(accepts(Buffer.concat([signature, size2(4091), largeHeader.subarray(6), Buffer.alloc(1)])), false,
    "an EBML header beyond the bounded scan is rejected");
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
