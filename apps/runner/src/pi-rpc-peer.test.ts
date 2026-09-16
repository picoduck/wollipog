import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PiRpcOversizedResponseError, PiRpcPeer } from "./pi-rpc-peer.js";

test("Pi RPC framing splits only on LF and accepts CRLF", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  const peer = new PiRpcPeer(input, output, (event) => events.push(event), (error) => errors.push(error));
  output.write('{"type":"message_update","text":"one\u2028two"}\r\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "message_update", text: "one\u2028two" }]);
  assert.deepEqual(errors, []);
  peer.dispose();
});

test("Pi RPC framing fails closed on oversized and malformed records", async () => {
  for (const payload of ["x".repeat(33), "not-json\n"]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const peer = new PiRpcPeer(input, output, () => assert.fail("invalid frame reached event handler"), (error) => errors.push(error), 32);
    output.write(payload);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    peer.dispose();
  }
});

test("Pi RPC correlates command responses without consuming events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: Record<string, unknown>[] = [];
  const peer = new PiRpcPeer(input, output, (event) => events.push(event), assert.fail);
  let written = "";
  input.on("data", (chunk) => { written += String(chunk); });
  const pending = peer.request({ type: "get_state" });
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(written.trim()) as { id: string };
  output.write(`${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true, data: { sessionId: "one" } })}\n`);
  const result = await pending;
  assert.deepEqual(result.data, { sessionId: "one" });
  assert.deepEqual(events, [{ type: "agent_start" }]);
  peer.dispose();
});

test("Pi RPC can drain one opted-in oversized response and preserve later frames", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  const peer = new PiRpcPeer(input, output, (event) => events.push(event), (error) => errors.push(error), 96);
  let written = "";
  input.on("data", (chunk) => { written += String(chunk); });
  const pending = peer.request(
    { type: "get_entries" },
    15_000,
    { discardOversizedResponse: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(written.trim()) as { id: string };
  const oversized = JSON.stringify({
    id: request.id,
    type: "response",
    command: "get_entries",
    success: true,
    data: { entries: [{ data: "x".repeat(200) }], leafId: "leaf" },
  });
  output.write(oversized.slice(0, 120));
  await assert.rejects(pending, PiRpcOversizedResponseError);
  output.write(`${oversized.slice(120)}\n${JSON.stringify({ type: "agent_start" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.deepEqual(events, [{ type: "agent_start" }]);
  peer.dispose();
});

test("Pi RPC drains an opted-in oversized response that arrives after its timeout", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  const peer = new PiRpcPeer(input, output, (event) => events.push(event), (error) => errors.push(error), 96);
  let written = "";
  input.on("data", (chunk) => { written += String(chunk); });
  const pending = peer.request(
    { type: "get_entries" },
    10,
    { discardOversizedResponse: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(written.trim()) as { id: string };
  await assert.rejects(pending, /timed out/);
  output.write(`${JSON.stringify({
    id: request.id,
    type: "response",
    command: "get_entries",
    success: true,
    data: { entries: [{ data: "x".repeat(200) }], leafId: "leaf" },
  })}\n${JSON.stringify({ type: "agent_start" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.deepEqual(events, [{ type: "agent_start" }]);
  peer.dispose();
});
