import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeQueueRemovalReason,
  mergeQueueRemovalReasonLabel,
  mergeQueueStatus,
  sameForgeMergeQueueFacts,
  validForgeMergeQueueFacts,
  type ForgeMergeQueueEntry,
  type ForgeMergeQueueFacts,
} from "./forge-merge-queue.js";

const queued = (state: ForgeMergeQueueEntry["state"], extra: Partial<ForgeMergeQueueEntry> = {}): ForgeMergeQueueFacts => ({
  enabled: true, removal: null, entry: { state, position: 3, enqueuedAt: 1_000, groupChecks: null, ...extra },
});

test("every entry state maps to one status, label and tone", () => {
  const expected: Array<[ForgeMergeQueueEntry["state"], string, string, string, boolean]> = [
    ["queued", "queued", "In Merge Queue", "info", false],
    ["awaiting_checks", "queued", "In Merge Queue", "info", false],
    ["mergeable", "queued", "In Merge Queue", "info", false],
    ["locked", "merging", "Merging", "success", false],
    ["unmergeable", "unmergeable", "Unmergeable in Merge Queue", "danger", true],
  ];
  for (const [state, kind, label, tone, attention] of expected) {
    const status = mergeQueueStatus(queued(state), "OPEN");
    assert.ok(status, state);
    assert.deepEqual([status.kind, status.label, status.tone, status.attention], [kind, label, tone, attention], state);
    assert.match(status.detail, /^[A-Z].*\.$/u, "the detail is one sentence");
  }
  assert.match(mergeQueueStatus(queued("queued"), "OPEN")!.detail, /at position 3/u);
  assert.doesNotMatch(mergeQueueStatus(queued("queued", { position: null }), "OPEN")!.detail, /position/u);
  assert.match(mergeQueueStatus(queued("awaiting_checks", { groupChecks: "failing" }), "OPEN")!.detail, /merge-group check failed/u);
});

test("a removal is an attention state that names GitHub's reason", () => {
  const removed = (reason: string | null): ForgeMergeQueueFacts => ({ enabled: true, entry: null, removal: { reason, removedAt: 2_000 } });
  const status = mergeQueueStatus(removed("failed_checks"), "open");
  assert.deepEqual(status, {
    kind: "removed", label: "Removed from Merge Queue", tone: "danger", attention: true,
    detail: "GitHub removed this pull request from the merge queue because a merge-group check failed.",
  });
  assert.match(mergeQueueStatus(removed("merge_conflict"), "OPEN")!.detail, /conflicts with the base branch/u);
  assert.match(mergeQueueStatus(removed(null), "OPEN")!.detail, /because GitHub gave no reason\.$/u);
  assert.match(mergeQueueStatus(removed("brand_new_reason"), "OPEN")!.detail, /because brand new reason\.$/u);
  // GitHub records a removal with reason `merged` when the entry lands.
  const landing = mergeQueueStatus(removed("merged"), "OPEN");
  assert.equal(landing?.kind, "merging");
  assert.equal(landing?.attention, false);
});

test("removal reason labels are Title Case", () => {
  assert.equal(mergeQueueRemovalReasonLabel("failed_checks"), "Check Failed");
  assert.equal(mergeQueueRemovalReasonLabel("merge_conflict"), "Merge Conflict");
  assert.equal(mergeQueueRemovalReasonLabel("checks_timed_out"), "Timed Out");
  assert.equal(mergeQueueRemovalReasonLabel("some_new_thing"), "Some New Thing");
  assert.equal(mergeQueueRemovalReasonLabel(null), "No Reason Given");
  assert.equal(mergeQueueRemovalReason("MANUAL"), "someone removed it");
});

test("nothing shows for unknown facts, a repository without a queue, or a pull request that is not open", () => {
  assert.equal(mergeQueueStatus(undefined, "OPEN"), null);
  assert.equal(mergeQueueStatus(null), null);
  assert.equal(mergeQueueStatus({ enabled: false, entry: null, removal: null }, "OPEN"), null);
  assert.equal(mergeQueueStatus({ enabled: true, entry: null, removal: null }, "OPEN"), null, "a queue alone is not a state");
  // A removal recorded before the queue was disabled (or the pull request retargeted) is history.
  const removal = { reason: "failed_checks", removedAt: 9 };
  assert.equal(mergeQueueStatus({ enabled: false, entry: null, removal }, "OPEN"), null);
  assert.equal(mergeQueueStatus({ enabled: null, entry: null, removal }, "OPEN")?.kind, "removed", "unknown keeps it");
  for (const state of ["MERGED", "merged", "CLOSED", "closed"]) {
    assert.equal(mergeQueueStatus(queued("queued"), state), null, state);
  }
  assert.equal(mergeQueueStatus(queued("queued"))?.kind, "queued", "a caller without a state word still maps");
});

test("peer facts are validated and bounded", () => {
  assert.equal(validForgeMergeQueueFacts(null), null);
  assert.equal(validForgeMergeQueueFacts([]), null);
  assert.equal(validForgeMergeQueueFacts({ entry: { state: "nonsense" } }), null);
  assert.equal(validForgeMergeQueueFacts({ removal: { reason: "x", removedAt: -1 } }), null);
  assert.deepEqual(validForgeMergeQueueFacts({ enabled: "yes", entry: { state: "queued", position: 0, enqueuedAt: 1.5, groupChecks: "maybe" } }), {
    enabled: null, entry: { state: "queued", position: null, enqueuedAt: null, groupChecks: null }, removal: null,
  });
  const long = validForgeMergeQueueFacts({ enabled: true, entry: null, removal: { reason: "r".repeat(500), removedAt: 5 } });
  assert.equal(long?.removal?.reason?.length, 64);
  // An entry supersedes a removal.
  assert.equal(validForgeMergeQueueFacts({ entry: { state: "queued" }, removal: { reason: "manual", removedAt: 5 } })?.removal, null);
});

test("unchanged facts compare equal", () => {
  assert.ok(sameForgeMergeQueueFacts(queued("queued"), queued("queued")));
  assert.ok(sameForgeMergeQueueFacts(undefined, null));
  assert.ok(!sameForgeMergeQueueFacts(queued("queued"), queued("awaiting_checks")));
  assert.ok(!sameForgeMergeQueueFacts(queued("queued"), undefined));
});
