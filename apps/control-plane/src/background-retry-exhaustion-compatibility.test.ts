import assert from "node:assert/strict";
import { test } from "node:test";
import { projectBackgroundRetryExhaustionForUi } from "./background-retry-exhaustion-compatibility.js";

const exhausted = { id: "session", runnerId: "runner", backgroundDeliveries: [{
  continuationId: "continuation", parentTurnId: "parent", jobCount: 1, terminalCount: 1,
  retryExhaustedAt: 5, retryExhaustionAcknowledgedAt: 6, watchdogState: "capacity_retry_exhausted",
}] };

test("legacy HTTP and websocket view shapes omit new exhaustion data without mutating canonical evidence", () => {
  for (const protocol of [undefined, null, 75, 212, 218, 219, 220]) {
    for (const payload of [exhausted, [exhausted], { session: exhausted }, { sessions: [exhausted] }, { items: [exhausted] }]) {
      const projected = projectBackgroundRetryExhaustionForUi(payload, protocol);
      assert.doesNotMatch(JSON.stringify(projected), /capacity_retry_exhausted|retryExhaustedAt|retryExhaustionAcknowledgedAt/);
      assert.match(JSON.stringify(projected), /continuation/);
      assert.match(JSON.stringify(payload), /capacity_retry_exhausted/);
    }
  }
  assert.equal(projectBackgroundRetryExhaustionForUi(exhausted, 221), exhausted);
  assert.equal(projectBackgroundRetryExhaustionForUi(exhausted, 222), exhausted);
});

test("legacy projection preserves accepted missing-result authority and unrelated payload data", () => {
  const missing = { ...exhausted, backgroundDeliveries: [{ ...exhausted.backgroundDeliveries[0],
    acceptedAt: 7, missingResultAt: 8, watchdogState: "accepted_without_result" }] };
  const projected = projectBackgroundRetryExhaustionForUi(missing, 218);
  assert.equal(projected.backgroundDeliveries[0]!.acceptedAt, 7);
  assert.equal(projected.backgroundDeliveries[0]!.missingResultAt, 8);
  assert.equal(projected.backgroundDeliveries[0]!.watchdogState, "accepted_without_result");
  assert.equal(projectBackgroundRetryExhaustionForUi({ id: "artifact", backgroundDeliveries: ["opaque"] }, 218).backgroundDeliveries[0], "opaque");
});
