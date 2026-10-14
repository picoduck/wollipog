import assert from "node:assert/strict";
import { test } from "node:test";
import { planEvidenceRecovery } from "./evidence-review-recovery.js";
import { PACED_VIDEO_PREPARATION_PROFILE as profile,
  videoPreparationImagesFromPipe, type VideoPreparationFailureCode } from "./video-evidence-preparation.js";

test("per-frame byte overflow has a specific recapture reason, malformed truncation remains integrity", () => {
  // Native PNG framing with a complete bounded IHDR and a single oversized IDAT. The parser's
  // resource boundary must fire before this deliberately untrusted payload could be retained.
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4); ihdr.writeUInt32BE(1280, 8); ihdr.writeUInt32BE(720, 12);
  const idat = Buffer.alloc(profile.frameBytes + 13);
  idat.writeUInt32BE(profile.frameBytes + 1, 0); idat.write("IDAT", 4);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const input = Buffer.concat([signature, ihdr, idat]);
  assert.deepEqual(videoPreparationImagesFromPipe(input, 1280, 720), { ok: false, code: "recapture_frame_size" });
  assert.deepEqual(videoPreparationImagesFromPipe(input.subarray(0, 40), 1280, 720), { ok: false, code: "integrity" });
  const recovery = planEvidenceRecovery("full_control", "recapture_frame_size", 0);
  assert.equal(recovery.action, "recapture");
  assert.match(recovery.reason, /splitting cannot repair/u);
  assert.equal(Object.hasOwn(recovery, "frames"), false);
});
test("busy retries are finite and conversion/splitting/recapture never changes coverage or authority", () => {
  assert.deepEqual([0, 1].map((attempt) => planEvidenceRecovery("full_control", "decoder_busy", attempt).action), ["retry", "retry"]);
  assert.equal(planEvidenceRecovery("full_control", "decoder_busy", 2).action, "wait");
  const codes: VideoPreparationFailureCode[] = ["source_limit", "unsupported_media", "decode_limit",
    "unsupported_streams", "recapture_resolution", "recapture_timing", "split_capture", "recapture_frame_size"];
  for (const code of codes) {
    const plan = planEvidenceRecovery("full_control", code, 0);
    assert.ok(plan.action === "split" || plan.action === "recapture");
    assert.equal(plan.preserve, "all_source_frames_native_timing");
    assert.equal(plan.requiresNewArtifact, true);
    assert.equal(planEvidenceRecovery("full_control", code, 2).action, "reject");
    assert.equal(planEvidenceRecovery("custom", code, 0).action, "human");
  }
  for (const attempt of [-1, NaN, Infinity, 0.5]) {
    assert.equal(planEvidenceRecovery("full_control", "decoder_busy", attempt).action, "human");
  }
});
