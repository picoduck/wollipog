import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferSourceToUrlBase64, parseOpenFragment, urlBase64ToUint8Array } from "./push.js";

test("urlBase64ToUint8Array round-trips base64url of every byte value", () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  const b64url = Buffer.from(bytes).toString("base64url");
  assert.deepEqual([...urlBase64ToUint8Array(b64url)], [...bytes]);
  // Unpadded lengths (43-char VAPID keys are length ≡ 3 mod 4).
  for (const n of [1, 2, 3, 4, 5, 33, 65]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37) & 0xff);
    assert.deepEqual([...urlBase64ToUint8Array(Buffer.from(b).toString("base64url"))], [...b]);
  }
});

test("bufferSourceToUrlBase64 inverts urlBase64ToUint8Array (VAPID key comparison)", () => {
  // A realistic 65-byte VAPID public key shape, plus offset views (getKey can return those).
  const key = new Uint8Array(65).map((_, i) => (i * 53 + 4) & 0xff);
  const b64 = Buffer.from(key).toString("base64url");
  assert.equal(bufferSourceToUrlBase64(key), b64);
  assert.equal(bufferSourceToUrlBase64(key.buffer), b64);
  assert.deepEqual([...urlBase64ToUint8Array(bufferSourceToUrlBase64(key))], [...key]);
  // A view into a larger buffer must honor byteOffset/byteLength.
  const padded = new Uint8Array(100);
  padded.set(key, 10);
  assert.equal(bufferSourceToUrlBase64(new Uint8Array(padded.buffer, 10, 65)), b64);
});

test("parseOpenFragment accepts only a clean #open=<sessionId> fragment", () => {
  assert.equal(parseOpenFragment("#open=s_abc123"), "s_abc123");
  assert.equal(parseOpenFragment(""), null);
  assert.equal(parseOpenFragment("#open="), null);
  assert.equal(parseOpenFragment("#pair=tok"), null);
  assert.equal(parseOpenFragment("#open=s_1&x=2"), null);
  assert.equal(parseOpenFragment(`#open=${"a".repeat(80)}`), null);
});
