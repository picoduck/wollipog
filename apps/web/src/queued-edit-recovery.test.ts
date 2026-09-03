import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedPromptView } from "@wollipog/protocol";
import { reconcileQueuedEditRecovery } from "./queued-edit-recovery.js";

const unchanged: QueuedPromptView = {
  id: "queue-1",
  text: "Original",
  liveQueueObserved: true,
  editable: true,
  editRevision: "revision-1",
};

test("an unchanged live target keeps the recovered edit retryable", () => {
  assert.deepEqual(
    reconcileQueuedEditRecovery("queue-1", "revision-1", [unchanged], true),
    { status: "retryable" },
  );
});

test("a changed target revision cannot be overwritten by recovered content", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, editRevision: "revision-2" }],
    true,
  );
  assert.equal(result.status, "stale");
  assert.match("reason" in result ? result.reason : "", /changed elsewhere/i);
});

test("promotion, cancellation, and consumption all retire the missing edit target", () => {
  for (const transition of ["promotion", "cancellation", "consumption"]) {
    const result = reconcileQueuedEditRecovery("queue-1", "revision-1", [], true);
    assert.equal(result.status, "stale", transition);
    assert.match("reason" in result ? result.reason : "", /no longer waiting/i, transition);
  }
});

test("an immutable projection cannot accept a recovered edit", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, editable: false, editDisabledReason: "This turn is already starting." }],
    true,
  );
  assert.deepEqual(result, { status: "stale", reason: "This turn is already starting." });
});

test("offline and incomplete projections preserve recovery while authority is unavailable", () => {
  for (const queued of [undefined, [], [unchanged]]) {
    const result = reconcileQueuedEditRecovery("queue-1", "revision-1", queued, false);
    assert.equal(result.status, "checking");
    assert.match("reason" in result ? result.reason : "", /authoritative queue/i);
  }
});

test("a different entry cannot inherit recovery through matching content or position", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, id: "queue-2" }],
    true,
  );
  assert.equal(result.status, "stale");
});
