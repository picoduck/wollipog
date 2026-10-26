import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { normalizeBackgroundFollowUp, runnerSupportsProtocol } from "./index.js";

test("follow-up display facts are bounded and never expose arbitrary runner data", () => {
  assert.equal(normalizeBackgroundFollowUp(null), undefined);
  assert.equal(normalizeBackgroundFollowUp({ state: "unknown" }), undefined);
  assert.equal(normalizeBackgroundFollowUp({ state: "blocked", blocker: "arbitrary text" }), undefined);
  assert.deepEqual(normalizeBackgroundFollowUp({ state: "queued", queuedAt: NaN, path: "/private", retryScheduled: "yes" }),
    { state: "queued" });
  assert.deepEqual(normalizeBackgroundFollowUp({ state: "blocked", blocker: "budget", queuedAt: 100, retryScheduled: true, token: "private" }),
    { state: "blocked", blocker: "budget", queuedAt: 100, retryScheduled: true });
  assert.equal(runnerSupportsProtocol(236, "backgroundFollowUp"), false);
  assert.equal(runnerSupportsProtocol(237, "backgroundFollowUp"), true);
});

test("valid follow-up display facts round-trip while arbitrary extra data is discarded", () => {
  fc.assert(fc.property(
    fc.constantFrom("queued" as const, "running" as const),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc.boolean(), fc.jsonValue(),
    (state, queuedAt, retryScheduled, privateData) => {
      const expected = { state, queuedAt, retryScheduled };
      const normalized = normalizeBackgroundFollowUp({ ...expected, privateData });
      assert.deepEqual(normalized, expected);
      assert.deepEqual(normalizeBackgroundFollowUp(JSON.parse(JSON.stringify(normalized))), expected);
    },
  ));
});
