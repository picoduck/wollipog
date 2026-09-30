import assert from "node:assert/strict";
import { test } from "node:test";
import { RunnerFrameQueue, runnerFrameBypassesInventory } from "./runner-frame-queue.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only liveness, credential handshakes, and correlated replies bypass inventory ordering", () => {
  for (const type of ["heartbeat", "agent_control_credential", "git_result", "session_history_page_result"])
    assert.equal(runnerFrameBypassesInventory(type), true);
  for (const type of ["register", "session_runtime_updated", "session_event", "session_status",
    "durable_session_command_result", "stop_session_result", "unknown_result"])
    assert.equal(runnerFrameBypassesInventory(type), false);
});

test("runner frames remain FIFO across a yielding registration", async () => {
  const seen: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const queue = new RunnerFrameQueue<number>(async (n) => { seen.push(n); if (n === 1) await held; },
    () => assert.fail("unexpected queue failure"));
  queue.enqueue(1, 1);
  queue.enqueue(2, 1);
  queue.enqueue(3, 1);
  assert.deepEqual(seen, [1]);
  release();
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(seen, [1, 2, 3]);
});

for (const limits of [{ frames: 1, bytes: 100 }, { frames: 100, bytes: 1 }]) {
  test(`runner replay is bounded by ${limits.frames === 1 ? "count" : "bytes"}`, async () => {
    let release!: () => void;
    let failures = 0;
    const seen: number[] = [];
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queue = new RunnerFrameQueue<number>(async (n) => { seen.push(n); await held; },
      () => { failures++; }, limits);
    queue.enqueue(1, 1);
    queue.enqueue(2, 1);
    queue.enqueue(3, 1);
    release();
    await tick();
    assert.equal(failures, 1);
    assert.deepEqual(seen, [1], "overflow discards queued frames rather than growing or replaying them");
  });
}

test("closing a socket discards queued work and isolates handler rejection", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen: number[] = [];
  const queue = new RunnerFrameQueue<number>(async (n) => { seen.push(n); await held; }, () => {});
  queue.enqueue(1, 1);
  queue.enqueue(2, 1);
  queue.close();
  release();
  await tick();
  queue.enqueue(3, 1);
  assert.deepEqual(seen, [1]);
  let failure = 0;
  new RunnerFrameQueue(async () => { throw new Error("synthetic"); }, () => { failure++; }).enqueue(0, 1);
  await tick();
  assert.equal(failure, 1);
});
