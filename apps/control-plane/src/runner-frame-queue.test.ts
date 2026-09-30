import assert from "node:assert/strict";
import { test } from "node:test";
import { RunnerFrameQueue, runnerFrameBypassesInventory } from "./runner-frame-queue.js";
import { MAX_RUNNER_CLIENT_MESSAGE_BYTES } from "./runner-channel.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the normal post-ACK inventory burst fits beyond the baseline frame count", async () => {
  let release!: () => void;
  let began!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { began = resolve; });
  let handled = 0;
  let failures = 0;
  const queue = new RunnerFrameQueue<number>(async (n) => {
    if (n === 0) await held;
    else if (++handled === 5000) began();
  }, () => { failures++; });
  queue.enqueue(0, 1);
  // Registration reserves its advertised inventory before sending the early ACK.
  queue.reserveInventory(5000);
  for (let n = 1; n <= 5000; n++) queue.enqueue(n, 100);
  release();
  assert.equal(failures, 0, "a legitimate retained inventory must not enter a permanent reconnect loop");
  await finished;
  assert.equal(handled, 5000);
});

test("two maximum-sized legitimate frames fit behind a held registration", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen: number[] = [];
  const queue = new RunnerFrameQueue<number>(async (n) => { seen.push(n); if (n === 0) await held; },
    () => assert.fail("legitimate two-frame replay must fit"));
  queue.enqueue(0, 1);
  queue.enqueue(1, MAX_RUNNER_CLIENT_MESSAGE_BYTES);
  queue.enqueue(2, MAX_RUNNER_CLIENT_MESSAGE_BYTES);
  release();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(seen, [0, 1, 2]);
});

test("a frame arriving while attention flush yields is not stranded", async () => {
  const seen: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let flushing = false;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const queue = new RunnerFrameQueue<number>(async (n) => { seen.push(n); }, () => assert.fail("queue failed"), undefined,
    async () => { if (!flushing) { flushing = true; began(); await held; } });
  queue.enqueue(1, 1);
  await started;
  assert.equal(flushing, true);
  queue.enqueue(2, 1);
  release();
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(seen, [1, 2]);
});

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
