import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeNativeHttpResponse, encodeNativeHttpRequest } from "./native-ipc-codec.js";

function responseFrame(meta: object, body: Uint8Array): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(meta));
  const frame = new Uint8Array(4 + metadata.length + body.length);
  new DataView(frame.buffer).setUint32(0, metadata.length, true);
  frame.set(metadata, 4);
  frame.set(body, 4 + metadata.length);
  return frame;
}

test("native IPC frames preserve binary request and response bodies", () => {
  const body = Uint8Array.from([0, 1, 2, 254, 255]);
  const request = encodeNativeHttpRequest({
    runtimeKey: "profile:1",
    requestId: "request-1",
    method: "POST",
    path: "/api/images",
    headers: [["content-type", "image/png"]],
  }, body);
  const metaLength = new DataView(request.buffer).getUint32(0, true);
  assert.deepEqual(request.slice(4 + metaLength), body);

  const response = responseFrame({
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/octet-stream"]],
    bodyLength: body.length,
  }, body);
  const decoded = decodeNativeHttpResponse(response.buffer);
  assert.equal(decoded.meta.status, 200);
  assert.deepEqual(decoded.body, body);
});

test("native IPC response decoding rejects inconsistent and malformed frames", () => {
  assert.throws(() => decodeNativeHttpResponse(new Uint8Array([1, 2, 3])), TypeError);
  const badLength = responseFrame({
    status: 200,
    statusText: "OK",
    headers: [],
    bodyLength: 10,
  }, Uint8Array.of(1));
  assert.throws(() => decodeNativeHttpResponse(badLength), TypeError);
});
