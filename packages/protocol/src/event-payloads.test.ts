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

test("event payload reference validation rejects malformed, mismatched, and over-broad metadata", () => {
  assert.match(validateEventPayloadReferences([]).error, /1-4 chunks/);
  assert.match(validateEventPayloadReferences(Array.from({ length: EVENT_PAYLOAD_MAX_CHUNKS + 1 }, () => reference())).error, /1-4 chunks/);
  assert.match(validateEventPayloadReferences([reference({ mimeType: "text/x-diff" })], "text/plain").error, /integrity metadata/);
  assert.match(validateEventPayloadReferences([{ ...reference(), extra: true }]).error, /integrity metadata/);
  assert.match(validateEventPayloadReferences([reference({ sizeBytes: EVENT_PAYLOAD_CHUNK_BYTES + 1 })]).error, /integrity metadata/);
  assert.match(validateEventPayloadReferences([reference({ sha256: "A".repeat(64) })]).error, /integrity metadata/);
  assert.match(validateEventPayloadReferences([reference({ artifactId: "bad\nidentifier" })]).error, /integrity metadata/);
});
