import { webmHeaderCorpus } from "@wollipog/test-support/webm-header-corpus";
import assert from "node:assert/strict";
import { test } from "node:test";
import { screenshotBytesMatchMime, validateWorkflowArtifact, videoBytesMatchMime } from "./workflow-artifacts.js";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(8)]);

test("GIF and WebP validation compares every signature byte exactly", () => {
  const cases: Array<[string, Buffer, number[]]> = [
    ["image/gif", Buffer.from("GIF87a"), [0, 1, 2, 3, 4, 5]],
    ["image/gif", Buffer.from("GIF89a"), [0, 1, 2, 3, 4, 5]],
    ["image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
      [0, 1, 2, 3, 8, 9, 10, 11]],
  ];
  for (const [mimeType, bytes, offsets] of cases) {
    const validate = (data: Buffer) => validateWorkflowArtifact({
      sessionId: "session", kind: "screenshot", name: "image", mimeType, encoding: "base64", data: data.toString("base64"),
    });
    assert.equal(screenshotBytesMatchMime(mimeType, bytes), true);
    assert.equal(validate(bytes).ok, true);
    assert.equal(screenshotBytesMatchMime(mimeType, bytes.subarray(0, bytes.length - 1)), false);
    for (const offset of offsets) {
      const mismatching = Buffer.from(bytes);
      mismatching[offset] = mismatching[offset]! | 0x80;
      const label = `${mimeType} high bit at byte ${offset}`;
      assert.equal(screenshotBytesMatchMime(mimeType, mismatching), false, label);
      assert.deepEqual(validate(mismatching), { ok: false, error: "screenshot bytes do not match the declared MIME type" }, label);
    }
  }
});

test("MP4 validation compares the signature and every supported major brand byte exactly", () => {
  for (const brand of ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"]) {
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);
    const validate = (data: Buffer) => validateWorkflowArtifact({
      sessionId: "session", kind: "video", name: "clip", mimeType: "video/mp4", encoding: "base64", data: data.toString("base64"),
    });
    assert.equal(videoBytesMatchMime("video/mp4", bytes), true, brand);
    assert.equal(validate(bytes).ok, true, brand);
    assert.equal(videoBytesMatchMime("video/mp4", bytes.subarray(0, 15)), false, "truncated MP4");
    for (let offset = 4; offset < 12; offset++) {
      const mismatching = Buffer.from(bytes);
      mismatching[offset] = mismatching[offset]! | 0x80;
      const label = `${brand} high bit at byte ${offset}`;
      assert.equal(videoBytesMatchMime("video/mp4", mismatching), false, label);
      assert.deepEqual(validate(mismatching), { ok: false, error: "video bytes do not match the declared MIME type" }, label);
    }
  }
});

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

test("WebM validation uses the common bounded-header corpus", () => {
  for (const { name, bytes, accepted } of webmHeaderCorpus()) {
    assert.equal(videoBytesMatchMime("video/webm", bytes), accepted, name);
    assert.equal(validateWorkflowArtifact({
      sessionId: "session", kind: "video", name: "clip", mimeType: "video/webm",
      encoding: "base64", data: bytes.toString("base64"),
    }).ok, accepted, name);
    assert.equal(videoBytesMatchMime("video/mp4", bytes), false, name);
    assert.equal(videoBytesMatchMime("application/octet-stream", bytes), false, name);
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
