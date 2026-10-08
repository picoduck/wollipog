import assert from "node:assert/strict";
import { test } from "node:test";
import { RunnerFrameQueue, runnerFrameBypassesInventory } from "./runner-frame-queue.js";
import { MAX_RUNNER_CLIENT_MESSAGE_BYTES } from "./runner-channel.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("count pressure leaves room for the entire negotiated inventory and ordinary replay headroom", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pressure: boolean[] = [];
  const queue = new RunnerFrameQueue<number>(async (n) => { if (n === 0) await held; },
    () => assert.fail("inventory plus headroom must fit"), undefined, undefined,
    (paused) => pressure.push(paused));
  queue.enqueue(0, 1);
  queue.reserveInventory(5000);
  for (let n = 1; n <= 5000; n++) queue.enqueue(n, 1);
  assert.deepEqual(pressure, [], "metadata replay must not prevent liveness frames from being read");
  for (let n = 5001; n <= 6024; n++) queue.enqueue(n, 1);
  assert.deepEqual(pressure, [true], "count pressure remains finite after the advertised burst");
  queue.close();
  release();
  await tick();
  assert.deepEqual(pressure, [true, false]);
});

test("flow control pauses below hard limits and resumes after draining with hysteresis", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pressure: boolean[] = [];
  const handled: number[] = [];
  const queue = new RunnerFrameQueue<number>(async (n) => { handled.push(n); if (n === 0) await held; },
    () => assert.fail("flow-controlled stream must not overflow"), { frames: 8, bytes: 100 }, undefined,
    (paused) => { pressure.push(paused); });
  queue.enqueue(0, 1);
  for (let n = 1; n <= 5; n++) queue.enqueue(n, 10);
  assert.deepEqual(pressure, [true], "pressure starts below the finite resource ceiling");
  release();
  for (let n = 0; n < 8; n++) await tick();
  assert.deepEqual(handled, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pressure, [true, false], "draining releases read pressure exactly once");
  queue.close();
  assert.deepEqual(pressure, [true, false]);
});

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

interface LaneFrame { key: string | null; name: string; prepare?: Promise<string> }

function laneQueue(options: { limits?: { frames: number; bytes: number }; onPressure?: (paused: boolean) => void } = {}) {
  const handled: Array<{ name: string; prepared?: string }> = [];
  const discarded: string[] = [];
  let active = 0;
  const queue = new RunnerFrameQueue<LaneFrame, string>(async (frame, prepared) => {
    assert.equal(active, 0, "frames are handled one at a time");
    active += 1;
    handled.push({ name: frame.name, ...(prepared !== undefined ? { prepared } : {}) });
    await tick();
    active -= 1;
  }, () => assert.fail("lanes must not fail the queue"), options.limits, undefined, options.onPressure, {
    key: (frame) => frame.key,
    prepare: (frame) => frame.prepare,
    discard: (prepared) => discarded.push(prepared),
  });
  return { queue, handled, discarded };
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = async () => { for (let n = 0; n < 20; n++) await tick(); };

test("a preparing frame holds only its own key's later frames, in arrival order", async () => {
  const { queue, handled } = laneQueue();
  const staging = deferred();
  queue.enqueue({ key: "a", name: "a1", prepare: staging.promise }, 1);
  queue.enqueue({ key: "a", name: "a2" }, 1);
  queue.enqueue({ key: "b", name: "b1" }, 1);
  queue.enqueue({ key: "a", name: "a3" }, 1);
  queue.enqueue({ key: "b", name: "b2" }, 1);
  await settle();
  assert.deepEqual(handled.map((frame) => frame.name), ["b1", "b2"]);
  staging.resolve("durable");
  await settle();
  assert.deepEqual(handled, [
    { name: "b1" }, { name: "b2" }, { name: "a1", prepared: "durable" }, { name: "a2" }, { name: "a3" },
  ]);
  queue.close();
});

test("a keyless frame waits for every earlier frame and holds every later one", async () => {
  const { queue, handled } = laneQueue();
  const staging = deferred();
  queue.enqueue({ key: "a", name: "a1", prepare: staging.promise }, 1);
  queue.enqueue({ key: null, name: "register" }, 1);
  queue.enqueue({ key: "b", name: "b1" }, 1);
  await settle();
  assert.equal(handled.length, 0, "the barrier and everything after it wait");
  staging.resolve("durable");
  await settle();
  assert.deepEqual(handled.map((frame) => frame.name), ["a1", "register", "b1"]);
  queue.close();
});

test("frames of one key are prepared in parallel while held", async () => {
  const prepared: string[] = [];
  const first = deferred();
  const second = deferred();
  const queue = new RunnerFrameQueue<LaneFrame, string>(async () => {}, () => assert.fail("no failure"),
    undefined, undefined, undefined, {
      key: (frame) => frame.key,
      prepare: (frame) => { prepared.push(frame.name); return frame.prepare; },
      discard: () => {},
    });
  queue.enqueue({ key: "a", name: "a1", prepare: first.promise }, 1);
  queue.enqueue({ key: "a", name: "a2", prepare: second.promise }, 1);
  await settle();
  assert.deepEqual(prepared, ["a1", "a2"], "the held frame's durable write starts without waiting for the first");
  first.resolve("one");
  second.resolve("two");
  await settle();
  queue.close();
});

test("held frames stay counted toward read pressure", async () => {
  const pressure: boolean[] = [];
  const { queue, handled } = laneQueue({ limits: { frames: 64, bytes: 400 }, onPressure: (paused) => pressure.push(paused) });
  const staging = deferred();
  queue.enqueue({ key: "a", name: "a1", prepare: staging.promise }, 10);
  for (let n = 2; n <= 10; n++) queue.enqueue({ key: "a", name: `a${n}` }, 10);
  await settle();
  assert.equal(handled.length, 0);
  assert.deepEqual(pressure, [true], "frames waiting behind a durable write pause socket reads");
  staging.resolve("durable");
  await settle();
  assert.equal(handled.length, 10);
  assert.deepEqual(pressure, [true, false]);
  queue.close();
});

test("closing the queue discards prepared values, including ones that settle afterward", async () => {
  const { queue, handled, discarded } = laneQueue();
  const staging = deferred();
  queue.enqueue({ key: "a", name: "a1", prepare: staging.promise }, 1);
  queue.enqueue({ key: "b", name: "b1", prepare: Promise.resolve("ready") }, 1);
  await tick();
  // b1 is prepared and runnable but the queue closes before it runs.
  queue.close();
  staging.resolve("settled-after-close");
  await settle();
  assert.ok(handled.every((frame) => frame.name !== "a1"));
  const handledValues = handled.map((frame) => frame.prepared);
  assert.deepEqual(
    [...discarded, ...handledValues].sort(),
    ["ready", "settled-after-close"],
    "every prepared value is either handled or discarded, exactly once",
  );
});

test("a frame whose preparation throws is handled unprepared", async () => {
  const handled: string[] = [];
  const queue = new RunnerFrameQueue<LaneFrame, string>(async (frame, prepared) => {
    handled.push(`${frame.name}:${prepared ?? "unprepared"}`);
  }, () => assert.fail("a malformed frame is the handler's to reject"), undefined, undefined, undefined, {
    key: (frame) => frame.key,
    prepare: (frame) => {
      if (frame.name === "malformed") throw new TypeError("missing payload");
      return undefined;
    },
    discard: () => {},
  });
  queue.enqueue({ key: "a", name: "malformed" }, 1);
  queue.enqueue({ key: "a", name: "next" }, 1);
  await settle();
  assert.deepEqual(handled, ["malformed:unprepared", "next:unprepared"]);
  queue.close();
});
