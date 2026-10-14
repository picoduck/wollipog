import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { mediaActiveStopIdentityBody, mediaActiveStopRequestBody, mediaActiveStopAcknowledgementBody } from "./media-active-stop.js";

const digest = fc.stringMatching(/^[a-f0-9]{64}$/);
const request = fc.record({ rootSessionId: fc.uuid().map((v) => "root-" + v), childSessionId: fc.uuid().map((v) => "child-" + v),
  sessionId: fc.uuid().map((v) => "media-" + v), runnerId: fc.uuid(), generation: fc.uuid(), operationId: fc.uuid(),
  commandSha256: digest, dispatchSha256: digest });
test("dedicated Stop canonicalization preserves all identity fields across JSON ordering and is idempotent", () => {
  fc.assert(fc.property(request, (input) => {
    const reversed = Object.fromEntries(Object.entries(input).reverse()) as typeof input;
    assert.deepEqual(mediaActiveStopRequestBody(reversed), { ...input }, "JSON data fields, not object prototypes, are preserved");
    assert.equal(JSON.stringify(mediaActiveStopRequestBody(reversed)), JSON.stringify(mediaActiveStopRequestBody(input)));
    assert.deepEqual(mediaActiveStopRequestBody(mediaActiveStopRequestBody(input)), { ...input });
    const { operationId: _operation, ...identity } = input;
    assert.deepEqual(mediaActiveStopIdentityBody(JSON.parse(JSON.stringify(identity))), identity);
  }));
});
test("caller-added authority and terminal outcome fields cannot enter dedicated Stop canonicalization", () => {
  fc.assert(fc.property(request, fc.constantFrom("grant", "costUsd", "pid", "terminal", "secret", "approved"), (input, key) => {
    assert.throws(() => mediaActiveStopRequestBody({ ...input, [key]: true }));
    assert.throws(() => mediaActiveStopAcknowledgementBody({ ...input, outcome: "completed", stopFenceSha256: "a".repeat(64) } as never));
    assert.throws(() => mediaActiveStopRequestBody({ ...input, childSessionId: input.sessionId }));
    assert.throws(() => mediaActiveStopRequestBody({ ...input, childSessionId: input.rootSessionId }));
  }));
});
