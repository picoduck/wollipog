import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import fc from "fast-check";
import { PACED_VIDEO_PREPARATION_PROFILE as profile, prepareVideoEvidence, prepareCandidateVideoEvidence,
  videoPreparationDecoderAvailable, videoPresentationTimeUs } from "./video-evidence-preparation.js";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url));
const paced = () => fixture("video-preparation-paced.webm");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

test("candidate derives all 16 explicit native frames and cannot borrow the paced envelope", async (t) => {
  if (!await requireDecoder(t)) return;
  const source = fixture("video-review-max-profile.webm");
  const result = await prepareCandidateVideoEvidence(source, "video/webm");
  assert.ok(result.ok, result.ok ? "complete candidate" : result.reason);
  if (!result.ok) return;
  assert.equal(result.manifest.profile, "candidate-silent-video-preparation-v1");
  assert.equal(result.manifest.frames.length, 16);
  assert.equal(result.manifest.durationUs, 4_000_000);
  assert.equal(result.manifest.width, 640);
  assert.equal(result.manifest.height, 360);
  assert.deepEqual(result.manifest.frames.map((frame) => frame.ptsUs), Array.from({ length: 16 }, (_, i) => i * 250_000));
  for (const frame of result.manifest.frames) {
    assert.equal(frame.durationUs, 250_000);
    assert.equal(frame.sha256, hash(result.images[frame.index]!));
  }
  const pacedRefusal = await prepareVideoEvidence(source, "video/webm");
  assert.equal(pacedRefusal.ok, false);
  if (!pacedRefusal.ok) assert.equal(pacedRefusal.code, "recapture_resolution");
  const candidateRefusal = await prepareCandidateVideoEvidence(paced(), "video/webm");
  assert.equal(candidateRefusal.ok, false);
  if (!candidateRefusal.ok) assert.equal(candidateRefusal.code, "recapture_resolution");
});

test("explicit PTS preserves every generated microsecond identically across FFmpeg field versions", () => {
  const encode = (us: number) => `${Math.floor(us / 1_000_000)}.${String(us % 1_000_000).padStart(6, "0")}`;
  fc.assert(fc.property(fc.integer({ min: 0, max: profile.durationUs }), (us) => {
    const text = encode(us);
    assert.equal(videoPresentationTimeUs({ pts_time: text }), us);
    assert.equal(videoPresentationTimeUs({ pkt_pts_time: text }), us);
    assert.equal(videoPresentationTimeUs({ pts_time: text, pkt_pts_time: text }), us);
    assert.equal(videoPresentationTimeUs({ pts_time: text, pkt_pts_time: encode(us + 1) }), null);
  }), { numRuns: 1_000 });
  for (const raw of [undefined, null, 0, "N/A", "", "-1", "0.0000001", "1e2", " 0", "999999999999999999"]) {
    assert.equal(videoPresentationTimeUs({ pts_time: raw }), null);
    assert.equal(videoPresentationTimeUs({ pkt_pts_time: raw }), null);
  }
  assert.equal(videoPresentationTimeUs({}), null);
});
async function requireDecoder(t: { skip: (reason: string) => void }): Promise<boolean> {
  if (await videoPreparationDecoderAvailable()) return true;
  assert.notEqual(process.env.CI, "true", "CI must provision executable isolated FFmpeg");
  t.skip("no isolated video preparation decoder on this host");
  return false;
}

test("a paced 720p recording preserves all 360 frames, including a one-frame transient, across complete segments", async (t) => {
  if (!await requireDecoder(t)) return;
  const source = paced();
  const result = await prepareVideoEvidence(source, "video/webm");
  assert.ok(result.ok, result.ok ? "expected complete preparation" : result.reason);
  if (!result.ok) return;
  const { manifest, images } = result;
  assert.equal(manifest.purpose, "offline_preparation_only");
  assert.equal(manifest.sourceSha256, hash(source));
  assert.equal(manifest.sourceSizeBytes, source.length);
  assert.equal(manifest.width, 1280);
  assert.equal(manifest.height, 720);
  assert.equal(manifest.durationUs, 12_000_000);
  assert.equal(manifest.frames.length, 360);
  assert.equal(images.length, 360);
  assert.equal(result.manifestSha256, hash(JSON.stringify(manifest)));
  assert.deepEqual(manifest.frames.map((frame) => frame.index), Array.from({ length: 360 }, (_, i) => i));
  assert.equal(manifest.frames[157]!.ptsUs, 5_233_000);
  assert.equal(new Set(manifest.frames.map((frame) => frame.sha256)).size, 2);
  assert.notEqual(manifest.frames[157]!.sha256, manifest.frames[0]!.sha256);
  assert.equal(manifest.frames.filter((frame) => frame.sha256 === manifest.frames[157]!.sha256).length, 1);
  assert.equal(manifest.frames[158]!.sha256, manifest.frames[0]!.sha256);
  for (const frame of manifest.frames) {
    assert.equal(frame.sha256, hash(images[frame.index]!));
    assert.equal(frame.sizeBytes, images[frame.index]!.length);
    assert.ok(frame.sizeBytes <= profile.frameBytes);
    assert.ok(frame.durationUs > 0);
    if (frame.index + 1 < manifest.frames.length) {
      assert.equal(frame.ptsUs + frame.durationUs, manifest.frames[frame.index + 1]!.ptsUs);
    }
  }
  assert.ok(images.reduce((size, image) => size + image.length, 0) <= profile.totalFrameBytes);
  const covered: number[] = [];
  for (const [index, segment] of manifest.segments.entries()) {
    assert.equal(segment.index, index);
    assert.ok(segment.frameCount > 0 && segment.frameCount <= profile.segmentFrames);
    assert.ok(segment.endUs - segment.startUs <= profile.segmentDurationUs);
    assert.equal(segment.startUs, manifest.frames[segment.firstFrame]!.ptsUs);
    const last = manifest.frames[segment.firstFrame + segment.frameCount - 1]!;
    assert.equal(segment.endUs, last.ptsUs + last.durationUs);
    if (index) assert.equal(segment.startUs, manifest.segments[index - 1]!.endUs);
    covered.push(...Array.from({ length: segment.frameCount }, (_, i) => segment.firstFrame + i));
  }
  assert.deepEqual(covered, manifest.frames.map((frame) => frame.index));
  // These fields are intentionally absent: local derivation cannot counterfeit authorization.
  for (const field of ["receipt", "occurrenceId", "policyRevision", "verdict", "approved"]) {
    assert.equal(Object.hasOwn(manifest, field), false);
  }
});

test("source mutation while preparation awaits a decoder cannot change the snapshotted sequence", async (t) => {
  if (!await requireDecoder(t)) return;
  const source = paced();
  const expected = hash(source);
  const pending = prepareVideoEvidence(source, "video/webm");
  source.fill(0);
  const result = await pending;
  assert.ok(result.ok, result.ok ? "expected immutable source" : result.reason);
  if (result.ok) assert.equal(result.manifest.sourceSha256, expected);
});

test("preparation refuses incompatible source bytes before allocating decoder work", async () => {
  assert.equal((await prepareVideoEvidence(Buffer.alloc(0), "video/webm")).ok, false);
  const tooLarge = await prepareVideoEvidence(Buffer.alloc(profile.sourceBytes + 1), "video/webm");
  assert.ok(!tooLarge.ok);
  assert.equal(tooLarge.code, "source_limit");
  assert.equal(tooLarge.retryable, false);
  const wrongType = await prepareVideoEvidence(paced(), "video/mp4");
  assert.ok(!wrongType.ok);
  assert.equal(wrongType.code, "unsupported_media");
});

test("audio is never silently stripped and unreadable source resolution requires recapture", async (t) => {
  if (!await requireDecoder(t)) return;
  const audio = await prepareVideoEvidence(fixture("video-review-has-audio.webm"), "video/webm");
  assert.ok(!audio.ok);
  assert.equal(audio.code, "unsupported_streams");
  const small = await prepareVideoEvidence(fixture("video-review-max-profile.webm"), "video/webm");
  assert.ok(!small.ok);
  assert.equal(small.code, "recapture_resolution");
  assert.equal(small.retryable, false);
  assert.equal(Object.hasOwn(small, "manifest"), false);
});

test("MP4/H.264 and WebM/VP8 convert all decoded frames without changing order or dimensions", async (t) => {
  if (!await requireDecoder(t)) return;
  const root = await mkdtemp(join(tmpdir(), "wollipog-video-conversion-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [codec, extension, type] of [["libx264", "mp4", "video/mp4"],
    ["libvpx", "webm", "video/webm"]] as const) {
    const path = join(root, `source.${extension}`);
    await run("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=blue:s=960x540:r=30:d=1", "-an", "-c:v", codec, "-threads", "1", path], { timeout: 30_000 });
    const source = await readFile(path);
    const result = await prepareVideoEvidence(source, type);
    assert.ok(result.ok, result.ok ? "complete conversion" : result.reason);
    if (!result.ok) continue;
    assert.equal(result.manifest.sourceSha256, hash(source));
    assert.equal(result.manifest.sourceMediaType, type);
    assert.equal(result.manifest.frames.length, 30);
    assert.equal(result.manifest.width, 960);
    assert.equal(result.manifest.height, 540);
    assert.equal(result.manifest.frames[0]!.ptsUs, 0);
    assert.ok(Math.abs(result.manifest.durationUs - 1_000_000) <= 1_000);
    assert.equal(new Set(result.manifest.frames.map((frame) => frame.sha256)).size, 1);
  }
});

test("long scenarios and excessive capture rates fail preflight without partial evidence", async (t) => {
  if (!await requireDecoder(t)) return;
  const root = await mkdtemp(join(tmpdir(), "wollipog-video-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [input, expected] of [["color=c=blue:s=960x540:r=2:d=31", "split_capture"],
    ["color=c=blue:s=960x540:r=60:d=1", "recapture_timing"]] as const) {
    const path = join(root, `${expected}.webm`);
    await run("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", input, "-an", "-c:v", "libvpx-vp9", "-threads", "1", path], { timeout: 30_000 });
    const result = await prepareVideoEvidence(await readFile(path), "video/webm");
    assert.ok(!result.ok);
    assert.equal(result.code, expected);
    assert.equal(result.retryable, false);
    assert.equal(Object.hasOwn(result, "manifest"), false);
    assert.equal(Object.hasOwn(result, "images"), false);
  }
});

test("bounded admission queues two waiters and rejects excess work, allowing declared deadline expiry", async (t) => {
  if (!await requireDecoder(t)) return;
  // Small valid sources finish preflight rapidly, so admitted waiters exercise the handoff
  // rather than hitting the deadline during a long PNG conversion.
  const source = fixture("video-review-max-profile.webm");
  const results = await Promise.all(Array.from({ length: 5 }, () => prepareVideoEvidence(source, "video/webm")));
  assert.deepEqual(results.slice(0, 2).map((result) => result.ok ? "unexpected" : result.code),
    ["recapture_resolution", "recapture_resolution"]);
  for (const result of results.slice(2, 4)) {
    assert.ok(!result.ok);
    if (result.code !== "recapture_resolution") {
      assert.equal(result.code, "decoder_busy");
      assert.equal(result.retryable, true);
      assert.match(result.reason, /deadline expired/, "admitted waiters may expire, but must not be refused as queue-full");
    }
  }
  const busy = results[4]!;
  assert.ok(!busy.ok && busy.retryable);
  assert.equal(busy.code, "decoder_busy");
  assert.match(busy.reason, /queue is full/);
});

test("the CLI refuses a FIFO before waiting for a writer", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-video-fifo-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = join(root, "source.webm");
  await run("/usr/bin/mkfifo", [fifo]);
  await assert.rejects(run(process.execPath, ["--import", "tsx",
    resolve("apps/control-plane/scripts/prepare-video-evidence.ts"), "--source", fifo,
    "--output", join(root, "package"), "--media-type", "video/webm"], { timeout: 5_000 }),
  (error: Error & { killed?: boolean }) => {
    assert.equal(error.killed, false, "must refuse the FIFO rather than hang until the test kills it");
    assert.match(error.message, /Input must be a nonempty regular file/);
    return true;
  });
});

test("the local CLI writes a private complete package and refuses symlinks or existing output", async (t) => {
  if (!await requireDecoder(t)) return;
  const root = await mkdtemp(join(tmpdir(), "wollipog-video-preparation-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.webm");
  const output = join(root, "package");
  await writeFile(source, paced());
  const script = resolve("apps/control-plane/scripts/prepare-video-evidence.ts");
  const args = ["--import", "tsx", script, "--source", source, "--output", output, "--media-type", "video/webm"];
  const { stdout } = await run(process.execPath, args, { timeout: 60_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.deliveryValidated, false);
  assert.equal(report.productionEnabled, false);
  assert.equal(report.frames, 360);
  const manifestBytes = await readFile(join(output, "manifest.json"));
  assert.equal(hash(manifestBytes), report.manifestSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(hash(await readFile(join(output, "frame-0157.png"))), manifest.frames[157].sha256);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, "manifest.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(output, "frame-0157.png"))).mode & 0o777, 0o600);
  assert.equal(/base64|data:image|receiptId/.test(stdout), false);
  const verifyArgs = ["--import", "tsx", script, "--source", source, "--verify-directory", output,
    "--media-type", "video/webm"];
  const verified = JSON.parse((await run(process.execPath, verifyArgs, { timeout: 60_000 })).stdout);
  assert.equal(verified.localDerivationVerified, true);
  assert.equal(verified.deliveryValidated, false);
  assert.equal(verified.productionEnabled, false);
  assert.equal(verified.manifestSha256, report.manifestSha256);
  // A caller may rewrite timing and recalculate a local hash, but fresh derivation still refuses it.
  manifest.frames[157].ptsUs++;
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(run(process.execPath, verifyArgs, { timeout: 60_000 }), /Manifest differs/);
  await writeFile(join(output, "manifest.json"), manifestBytes);
  const transient = await readFile(join(output, "frame-0157.png"));
  await writeFile(join(output, "frame-0157.png"), await readFile(join(output, "frame-0156.png")));
  await assert.rejects(run(process.execPath, verifyArgs, { timeout: 60_000 }), /Package frame differs/);
  await writeFile(join(output, "frame-0157.png"), transient);
  await writeFile(join(output, "extra.png"), transient);
  await assert.rejects(run(process.execPath, verifyArgs, { timeout: 60_000 }), /Package file list differs/);
  await rm(join(output, "extra.png"));
  await assert.rejects(run(process.execPath, args, { timeout: 60_000 }), /EEXIST/);
  assert.equal(hash(await readFile(join(output, "manifest.json"))), report.manifestSha256);
  const link = join(root, "link.webm");
  await symlink(source, link);
  await assert.rejects(run(process.execPath,
    ["--import", "tsx", script, "--source", link, "--output", join(root, "other"), "--media-type", "video/webm"]), /ELOOP/);
});
