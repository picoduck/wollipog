import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { planEvidenceRecovery } from "./evidence-review-recovery.js";
import { countsTowardRepairLimit, exhaustedVideoEvidenceLineage, VIDEO_EVIDENCE_REPAIR_LIMIT,
  videoEvidenceRepairException } from "./video-evidence-repair.js";

const subject = { occurrenceId: "workflow_1", evidenceId: "video", childSessionId: "child" };

test("repair exceptions route inadequate captures to the child and cap them per lineage (#2938)", () => {
  const split = videoEvidenceRepairException(subject, "split_capture", planEvidenceRecovery("full_control", "split_capture", 0), 0);
  assert.deepEqual([split.action, split.owner, split.repairAttempt, split.reprepare], ["split", "orchestrator", 1, false]);
  const recapture = videoEvidenceRepairException(subject, "recapture_frame_size",
    planEvidenceRecovery("full_control", "recapture_frame_size", 0), 1);
  assert.deepEqual([recapture.action, recapture.repairAttempt], ["recapture", 2]);
  const exhausted = videoEvidenceRepairException(subject, "split_capture", planEvidenceRecovery("full_control", "split_capture", 0),
    VIDEO_EVIDENCE_REPAIR_LIMIT);
  assert.deepEqual([exhausted.action, exhausted.repairAttempt, exhausted.reprepare], ["reject", VIDEO_EVIDENCE_REPAIR_LIMIT, false]);
  assert.match(exhausted.requiredInput, /exhausted exception/u);
  for (const exception of [split, recapture, exhausted]) {
    assert.equal(countsTowardRepairLimit(exception), true);
    assert.match(exception.requiredInput, /Decline occurrence workflow_1 /u);
    assert.equal(exception.summary.includes(exception.reason) && exception.summary.includes(exception.requiredInput), true);
  }
  const blocked = exhaustedVideoEvidenceLineage(subject, exhausted);
  assert.deepEqual([blocked.action, blocked.reprepare, countsTowardRepairLimit(blocked)], ["reject", false, true]);
});

test("exhaustion comes only from the lineage count, never from a planner attempt counting decoder retries", () => {
  // planEvidenceRecovery's attempt 2 means two busy retries of one source, not two replacement captures.
  const retried = videoEvidenceRepairException(subject, "split_capture", planEvidenceRecovery("full_control", "split_capture", 2), 0);
  assert.deepEqual([retried.action, retried.repairAttempt, retried.reprepare], ["split", 1, false]);
});

test("the exception identifies child-authored evidence only by digest", () => {
  const marker = "/home/child/.secret SENSITIVE-MARKER https://private.example/";
  const exception = videoEvidenceRepairException({ ...subject, evidenceId: marker }, "split_capture",
    planEvidenceRecovery("full_control", "split_capture", 0), 0);
  assert.equal(exception.evidenceRef, `sha256:${createHash("sha256").update(marker).digest("hex")}`);
  assert.doesNotMatch(JSON.stringify(exception), /SENSITIVE-MARKER/u);
  assert.doesNotMatch(JSON.stringify(exhaustedVideoEvidenceLineage({ ...subject, evidenceId: marker }, exception)), /SENSITIVE-MARKER/u);
});

test("busy and unverifiable decoders are not inadequate captures and keep their exact occurrence", () => {
  const busy = videoEvidenceRepairException(subject, "decoder_busy", planEvidenceRecovery("full_control", "decoder_busy", 2), 0);
  assert.deepEqual([busy.action, busy.owner, busy.reprepare, countsTowardRepairLimit(busy)], ["wait", "orchestrator", true, false]);
  const integrity = videoEvidenceRepairException(subject, "integrity", planEvidenceRecovery("full_control", "integrity", 0), 0);
  assert.deepEqual([integrity.action, integrity.owner, integrity.reprepare, countsTowardRepairLimit(integrity)],
    ["human", "human", true, false]);
});
