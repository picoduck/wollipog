import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENT_PAYLOAD_CHUNK_BYTES,
  EVENT_PAYLOAD_MAX_CHUNKS,
  validateEventPayloadReferences,
  type EventPayloadReference,
} from "./index.js";

const reference = (overrides: Partial<EventPayloadReference> = {}): EventPayloadReference => ({
  artifactId: "art_event_1",
  mimeType: "text/plain",
  encoding: "utf8",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  ...overrides,
});

test("event payload reference validation accepts ordered bounded integrity metadata", () => {
  const refs = [reference(), reference({ artifactId: "art_event_2", sizeBytes: EVENT_PAYLOAD_CHUNK_BYTES })];
  assert.deepEqual(validateEventPayloadReferences(refs, "text/plain"), { ok: true, value: refs });
});

/** The error of a validation expected to fail. Fails the test plainly if the validation succeeded,
 * rather than passing `undefined` on to `assert.match`. */
function rejection<T>(result: { ok: true; value: T } | { ok: false; error: string }): string {
  if (result.ok) assert.fail(`expected validation to fail, but it accepted ${JSON.stringify(result.value)}`);
  return result.error;
}

test("event payload reference validation rejects malformed, mismatched, and over-broad metadata", () => {
  assert.match(rejection(validateEventPayloadReferences([])), /1-4 chunks/);
  assert.match(rejection(validateEventPayloadReferences(Array.from({ length: EVENT_PAYLOAD_MAX_CHUNKS + 1 }, () => reference()))), /1-4 chunks/);
  assert.match(rejection(validateEventPayloadReferences([reference({ mimeType: "text/x-diff" })], "text/plain")), /integrity metadata/);
  assert.match(rejection(validateEventPayloadReferences([{ ...reference(), extra: true }])), /integrity metadata/);
  assert.match(rejection(validateEventPayloadReferences([reference({ sizeBytes: EVENT_PAYLOAD_CHUNK_BYTES + 1 })])), /integrity metadata/);
  assert.match(rejection(validateEventPayloadReferences([reference({ sha256: "A".repeat(64) })])), /integrity metadata/);
  assert.match(rejection(validateEventPayloadReferences([reference({ artifactId: "bad\nidentifier" })])), /integrity metadata/);
});
