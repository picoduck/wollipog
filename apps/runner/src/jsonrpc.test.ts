import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { JsonRpcPeer } from "./jsonrpc.js";

/** A peer wired to in-memory streams; `out` carries bytes the peer would send. */
function makePeer() {
  const stdin = new PassThrough(); // what the peer writes (our "to-agent" channel)
  const stdout = new PassThrough(); // what the peer reads (the "from-agent" channel)
  const peer = new JsonRpcPeer(stdin, stdout);
  return { peer, stdin, stdout };
}

test("request() resolves when a matching response arrives", async () => {
  const { peer, stdin, stdout } = makePeer();
  const p = peer.request("ping");
  // Read the id the peer assigned from what it wrote, then answer it.
  const sent = JSON.parse(String(stdin.read()).trim());
  assert.equal(sent.method, "ping");
  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
  assert.deepEqual(await p, { ok: true });
});

test("requestWithDeadline removes a timed-out request and ignores its late response", async () => {
  const { peer, stdin, stdout } = makePeer();
  const timedOut = peer.requestWithDeadline("turn/steer", { input: [] }, Date.now() + 5);
  const first = JSON.parse(String(stdin.read()).trim());
  await assert.rejects(timedOut, (err: { requestTimeout?: boolean; message?: string }) => {
    assert.equal(err.requestTimeout, true);
    assert.match(String(err.message), /deadline exceeded/);
    return true;
  });
  assert.equal((peer as unknown as { pending: Map<unknown, unknown> }).pending.size, 0);

  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { turnId: "late" } }) + "\n");
  const next = peer.request("ping");
  const second = JSON.parse(String(stdin.read()).trim());
  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { ok: true } }) + "\n");
  assert.deepEqual(await next, { ok: true });
});

test("requestWithDeadline clears its deadline when a response arrives", async () => {
  const { peer, stdin, stdout } = makePeer();
  const response = peer.requestWithDeadline("fast", {}, Date.now() + 50);
  const sent = JSON.parse(String(stdin.read()).trim());
  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: "ok" }) + "\n");
  assert.equal(await response, "ok");
  assert.equal((peer as unknown as { pending: Map<unknown, unknown> }).pending.size, 0);
});

test("notification dispatch preserves frame order around a response in one chunk", async () => {
  for (const notificationFirst of [true, false]) {
    const { peer, stdin, stdout } = makePeer();
    const order: string[] = [];
    peer.onNotification("state", () => order.push("notification"));
    const response = peer.request("set_state");
    response.then(() => order.push("response"));
    const sent = JSON.parse(String(stdin.read()).trim());
    const responseLine = JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: {} });
    const notificationLine = JSON.stringify({ jsonrpc: "2.0", method: "state", params: {} });
    stdout.write(`${notificationFirst ? notificationLine : responseLine}\n${notificationFirst ? responseLine : notificationLine}\n`);
    await response;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, notificationFirst
      ? ["notification", "response"]
      : ["response", "notification"]);
  }
});

test("request() rejects immediately once the peer is disposed (no hang)", async () => {
  const { peer } = makePeer();
  peer.dispose("process exited");
  await assert.rejects(
    () => peer.request("turn/start", { x: 1 }),
    (err: { code?: number; message?: string }) => {
      assert.equal(err.code, -32000);
      assert.match(String(err.message), /closed/i);
      assert.match(String(err.message), /turn\/start/);
      assert.equal((err as { transportFailure?: boolean }).transportFailure, true);
      return true;
    },
  );
});

test("dispose() rejects in-flight requests so awaiters don't wait forever", async () => {
  const { peer } = makePeer();
  const inflight = peer.request("slow");
  peer.dispose("boom");
  await assert.rejects(() => inflight, (err: { message?: string; transportFailure?: boolean }) => {
    assert.match(String(err.message), /boom/);
    assert.equal(err.transportFailure, true);
    return true;
  });
});

test("an async writable error rejects every in-flight request", async () => {
  const { peer, stdin } = makePeer();
  const first = peer.request("thread/read");
  const second = peer.request("thread/resume");
  const firstRejected = assert.rejects(first, (err: { message?: string; transportFailure?: boolean }) => {
    assert.match(String(err.message), /transport failed: EPIPE/);
    assert.equal(err.transportFailure, true);
    return true;
  });
  const secondRejected = assert.rejects(second, (err: { message?: string; transportFailure?: boolean }) => {
    assert.match(String(err.message), /transport failed: EPIPE/);
    assert.equal(err.transportFailure, true);
    return true;
  });
  stdin.emit("error", new Error("EPIPE"));
  await Promise.all([firstRejected, secondRejected]);
  await assert.rejects(() => peer.request("turn/start"), (err: { message?: string; transportFailure?: boolean }) => {
    assert.match(String(err.message), /connection closed/);
    assert.equal(err.transportFailure, true);
    return true;
  });
});
