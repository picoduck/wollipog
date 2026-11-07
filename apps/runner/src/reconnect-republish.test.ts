import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { projectReconnectOutboxMessage, republishReconnectState } from "./reconnect-republish.js";
import { Outbox, flushProjectedOutbox } from "./outbox.js";

test("receipt replay shares credits and reads current revisions after live sends and reconnect", async (t) => {
  const durable = new Map(Array.from({ length: 260 }, (_, i) => [String(i), {
    commandId: String(i), sessionId: "s", state: "queued" as const, revision: 2, duplicate: true,
  }]));
  const invocation = { requestId: "request", invocationId: "inv", submissionId: "sub", sessionId: "s", state: "completed" as const,
    revision: 3, duplicate: true };
  const receipts = {
    durable: { recentUpdateIds: () => [...durable.keys()], recentUpdate: (id: string) => durable.get(id) ?? null },
    invocations: { recentUpdateIds: () => ["inv"], recentUpdate: () => invocation },
  };
  const source = { republishSessionIds: () => [], republishSessionSnapshot: () => null, republishSessionQueue: () => null };
  type Frame = RunnerToControlPlane | { type: "runner_processing_barrier"; barrierId: number };
  const sent: Frame[] = [];
  const start = () => republishReconnectState(source, (message) => message,
    (wire) => sent.push(JSON.parse(wire)), () => assert.fail("write failed"), () => {}, receipts);
  let window = start();
  t.after(() => window.close());
  await turn();
  assert.equal(sent.length, 129);
  await turn();
  assert.equal(sent.length, 129, "no replay before application ACK");
  for (const id of ["0", "259"]) {
    const live = { ...durable.get(id)!, revision: 3 };
    durable.set(id, live);
    sent.push({ type: "durable_session_command_update", ...live });
  }
  invocation.revision = 4;
  sent.push({ type: "session_command_invocation_update", ...invocation });
  durable.delete("258");
  for (let n = 0; n < 10 && !window.complete; n++) {
    const barrier = [...sent].reverse().find((frame) => frame.type === "runner_processing_barrier");
    if (barrier?.type === "runner_processing_barrier") window.acknowledge(barrier.barrierId);
    await turn();
  }
  assert.ok(window.complete);
  for (const id of ["0", "259"]) {
    const last = [...sent].reverse().find((frame) => frame.type === "durable_session_command_update" && frame.commandId === id);
    assert.ok(last?.type === "durable_session_command_update");
    assert.equal(last.revision, 3);
  }
  assert.ok(!sent.some((frame) => frame.type === "durable_session_command_update" && frame.commandId === "258"));
  const lastInvocation = [...sent].reverse().find((frame) => frame.type === "session_command_invocation_update");
  assert.ok(lastInvocation?.type === "session_command_invocation_update");
  assert.equal(lastInvocation.revision, 4);
  sent.length = 0;
  window = start();
  await turn();
  window.close();
  const count = sent.length;
  window.acknowledge(1);
  await turn();
  assert.equal(sent.length, count, "disconnect discards unsent replay");
  sent.length = 0;
  window = start();
  await turn();
  assert.ok(sent.some((frame) => frame.type === "durable_session_command_update" && frame.commandId === "0" && frame.revision === 3));
});

test("acknowledged reconnect regenerates outbox queues while legacy peers and other frames retain FIFO", () => {
  for (const paced of [false, true]) {
    const outbox = new Outbox<{ type: string; n: number }>();
    for (const [n, type] of ["session_status", "session_queue", "session_event", "session_queue"].entries()) outbox.enqueue({ type, n });
    const sent: number[] = [];
    flushProjectedOutbox(outbox, (message) => projectReconnectOutboxMessage(message, paced, (value) => value),
      (message) => sent.push(message.n), () => assert.fail(), () => assert.fail());
    assert.deepEqual(sent, paced ? [0, 2] : [0, 2, 3]);
    assert.equal(outbox.size, 0);
  }
});

test("pending and in-flight reconnect queue projections never overwrite newer live queue state", async (t) => {
  type Queue = Extract<RunnerToControlPlane, { type: "session_queue" }>;
  const ids = Array.from({ length: 260 }, (_, i) => String(i));
  const current = new Map(ids.map((id) => [id, { type: "session_queue", sessionId: id, queue: [] } as Queue]));
  const sent: Array<Queue | { type: "runner_processing_barrier"; barrierId: number }> = [];
  const window = republishReconnectState({
    republishSessionIds: () => ids,
    republishSessionSnapshot: () => null,
    republishSessionQueue: (id) => current.get(id) ?? null,
  }, (message) => message, (wire) => sent.push(JSON.parse(wire)), () => assert.fail("write failed"), () => {});
  t.after(() => window.close());
  for (let n = 0; n < 10 && !sent.some((frame) => frame.type === "runner_processing_barrier"); n++) await turn();
  assert.ok(sent.some((frame) => frame.type === "session_queue" && frame.sessionId === "0"));
  assert.ok(!sent.some((frame) => frame.type === "session_queue" && frame.sessionId === "259"));
  for (const id of ["0", "259"]) {
    const live: Queue = { type: "session_queue", sessionId: id, queue: [], held: true, activeTurnId: "new-turn" };
    current.set(id, live);
    sent.push(live); // Live publication uses the immediate path, ahead of any unsent projection.
  }
  current.delete("258"); // A removed session is not resurrected by a pending projection.
  for (let n = 0; n < 10 && !window.complete; n++) {
    const barrier = [...sent].reverse().find((frame) => frame.type === "runner_processing_barrier");
    if (barrier?.type === "runner_processing_barrier") window.acknowledge(barrier.barrierId);
    await turn();
  }
  assert.equal(window.complete, true);
  for (const id of ["0", "259"]) {
    assert.deepEqual([...sent].reverse().find((frame) => frame.type === "session_queue" && frame.sessionId === id), current.get(id));
  }
  assert.ok(!sent.some((frame) => frame.type === "session_queue" && frame.sessionId === "258"));
});
