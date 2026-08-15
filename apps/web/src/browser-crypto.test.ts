import assert from "node:assert/strict";
import test from "node:test";
import { browserRandomUUID } from "./browser-crypto.js";

test("uses native randomUUID when the browser exposes it", () => {
  const expected = "123e4567-e89b-42d3-a456-426614174000" as `${string}-${string}-${string}-${string}-${string}`;
  const cryptoApi = {
    randomUUID: () => expected,
    getRandomValues: <T extends ArrayBufferView | null>(value: T) => value,
  };
  assert.equal(browserRandomUUID(cryptoApi), expected);
});

test("generates an RFC 4122 UUID v4 when randomUUID is unavailable", () => {
  const cryptoApi = {
    getRandomValues<T extends ArrayBufferView | null>(value: T): T {
      new Uint8Array(value!.buffer, value!.byteOffset, value!.byteLength).fill(0xab);
      return value;
    },
  };
  assert.equal(browserRandomUUID(cryptoApi), "abababab-abab-4bab-abab-abababababab");
});
