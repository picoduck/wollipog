import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeShortSilentWebm, shortVideoDecoderAvailable, SHORT_VIDEO_PROFILE } from "./video-frame-decode.js";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url));

test("the isolated decoder preserves every frame and a one-frame transient", async (t) => {
  if (!await shortVideoDecoderAvailable()) return t.skip("no isolated video decoder on this host");
  const source = fixture("video-review-one-frame-transient.webm");
  const decoded = await decodeShortSilentWebm(source);
  assert.ok(decoded.ok, decoded.ok ? "expected a complete decode" : decoded.reason);
  if (!decoded.ok) return;
  assert.equal(decoded.sourceSha256, createHash("sha256").update(source).digest("hex"));
  assert.deepEqual(decoded.frames.map((frame) => frame.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(decoded.frames.map((frame) => frame.ptsMs), [0, 500, 1000, 1500, 2000, 2500]);
  assert.equal(new Set(decoded.frames.map((frame) => frame.sha256)).size, 2);
  assert.equal(decoded.frames[2]!.sha256 !== decoded.frames[0]!.sha256, true,
    "the short-lived red frame must be preserved");
  assert.equal(decoded.frames.filter((frame) => frame.sha256 === decoded.frames[2]!.sha256).length, 1);
  for (const frame of decoded.frames) {
    assert.equal(frame.sha256, createHash("sha256").update(frame.bytes).digest("hex"));
    assert.ok(frame.bytes.length <= SHORT_VIDEO_PROFILE.frameBytes);
  }
});

test("the strict profile rejects audio, excess duration, excess source frames, and malformed media", async (t) => {
  if (!await shortVideoDecoderAvailable()) return t.skip("no isolated video decoder on this host");
  for (const name of ["video-review-has-audio.webm", "video-review-too-long.webm",
    "video-review-too-many-frames.webm"] as const) {
    const decoded = await decodeShortSilentWebm(fixture(name));
    assert.equal(decoded.ok, false, name);
  }
  const malformed = Buffer.concat([fixture("video-review-one-frame-transient.webm").subarray(0, 30)]);
  assert.equal((await decodeShortSilentWebm(malformed)).ok, false);
});

test("the full 16-frame, 640×360 profile is complete and remains inside derived-byte limits", async (t) => {
  if (!await shortVideoDecoderAvailable()) return t.skip("no isolated video decoder on this host");
  const decoded = await decodeShortSilentWebm(fixture("video-review-max-profile.webm"));
  assert.ok(decoded.ok, decoded.ok ? "expected a complete decode" : decoded.reason);
  assert.equal(decoded.frames.length, SHORT_VIDEO_PROFILE.frames);
  assert.deepEqual(decoded.frames.map((frame) => frame.ptsMs),
    Array.from({ length: SHORT_VIDEO_PROFILE.frames }, (_, index) => index * 250));
  assert.ok(decoded.frames.reduce((sum, frame) => sum + frame.bytes.length, 0)
    <= SHORT_VIDEO_PROFILE.totalFrameBytes);
});

test("the source-byte limit fails before a decoder or artifact write", async () => {
  const oversized = Buffer.alloc(SHORT_VIDEO_PROFILE.sourceBytes + 1);
  const decoded = await decodeShortSilentWebm(oversized);
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.match(decoded.reason, /size limit/);
});

test("a third simultaneous decode fails closed at the process resource bound", async (t) => {
  if (!await shortVideoDecoderAvailable()) return t.skip("no isolated video decoder on this host");
  const source = fixture("video-review-one-frame-transient.webm");
  const results = await Promise.all(Array.from({ length: 3 }, () => decodeShortSilentWebm(source)));
  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  const rejected = results.find((result) => !result.ok);
  if (rejected && !rejected.ok) assert.match(rejected.reason, /decoder is busy/);
});
