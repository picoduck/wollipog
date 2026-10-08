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

interface PreparedFrame { name: string; runnerWide?: boolean; malformed?: boolean }

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = async () => { for (let n = 0; n < 20; n++) await tick(); };

/** A queue whose frames each wait for their own preparation, as a large session event waits for
 * its durable payload (#2794). */
function preparingQueue(options: { limits?: { frames: number; bytes: number }; onPressure?: (paused: boolean) => void } = {}) {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const prepared: string[] = [];
  const handled: string[] = [];
  const discarded: string[] = [];
  let active = 0;
  const queue = new RunnerFrameQueue<PreparedFrame, Promise<string>>(async (frame, preparation) => {
    assert.equal(active, 0, "frames are handled one at a time");
    active += 1;
    try {
      handled.push(preparation ? `${frame.name}:${await preparation}` : frame.name);
    } finally {
      active -= 1;
    }
  }, () => assert.fail("preparation must not fail the queue"), options.limits, undefined, options.onPressure, {
    runnerWide: (frame) => frame.runnerWide === true,
    prepare: (frame) => {
      if (frame.malformed) throw new TypeError("missing payload");
      prepared.push(frame.name);
      const gate = deferred();
      gates.set(frame.name, gate);
      return gate.promise;
    },
    discard: (preparation) => { void preparation.then((value) => discarded.push(value)); },
  });
  return { queue, gates, prepared, handled, discarded };
}

test("frames are handled in arrival order while later frames are prepared ahead", async () => {
  const { queue, gates, prepared, handled } = preparingQueue();
  queue.enqueue({ name: "large-a" }, 1);
  queue.enqueue({ name: "small-b" }, 1);
  queue.enqueue({ name: "large-c" }, 1);
  await settle();
  assert.deepEqual(prepared, ["large-a", "small-b", "large-c"], "every queued frame's preparation has started");
  assert.equal(handled.length, 0);
  gates.get("large-c")!.resolve("durable");
  gates.get("small-b")!.resolve("inline");
  await settle();
  assert.equal(handled.length, 0, "a later frame never overtakes the one still preparing");
  gates.get("large-a")!.resolve("durable");
  await settle();
  assert.deepEqual(handled, ["large-a:durable", "small-b:inline", "large-c:durable"]);
  queue.close();
});

test("nothing behind a runner-wide frame is prepared until it has been handled", async () => {
  const { queue, gates, prepared, handled } = preparingQueue();
  queue.enqueue({ name: "register", runnerWide: true }, 1);
  queue.enqueue({ name: "event" }, 1);
  await settle();
  assert.deepEqual(prepared, ["register"], "registration may materialize the session the event names");
  gates.get("register")!.resolve("done");
  await settle();
  assert.deepEqual(prepared, ["register", "event"]);
  gates.get("event")!.resolve("durable");
  await settle();
  assert.deepEqual(handled, ["register:done", "event:durable"]);
  queue.close();
});

test("frames waiting behind a preparing frame stay counted toward read pressure", async () => {
  const pressure: boolean[] = [];
  const { queue, gates, handled } = preparingQueue({
    limits: { frames: 64, bytes: 400 }, onPressure: (paused) => pressure.push(paused),
  });
  for (let n = 1; n <= 11; n++) queue.enqueue({ name: `frame-${n}` }, 10);
  await settle();
  assert.equal(handled.length, 0);
  assert.deepEqual(pressure, [true], "frames queued behind a durable write pause socket reads");
  for (const gate of gates.values()) gate.resolve("ready");
  await settle();
  assert.equal(handled.length, 11);
  assert.deepEqual(pressure, [true, false]);
  queue.close();
});

test("closing the queue discards every prepared frame it did not hand to the handler", async () => {
  const { queue, gates, handled, discarded } = preparingQueue();
  queue.enqueue({ name: "head" }, 1);
  queue.enqueue({ name: "queued" }, 1);
  await settle();
  queue.close();
  for (const [name, gate] of gates) gate.resolve(name);
  await settle();
  assert.deepEqual(handled, ["head:head"], "the handler owns the frame it was given");
  assert.deepEqual(discarded, ["queued"]);
});

test("a frame whose preparation throws is handled unprepared, in order", async () => {
  const { queue, gates, handled } = preparingQueue();
  queue.enqueue({ name: "malformed", malformed: true }, 1);
  queue.enqueue({ name: "next" }, 1);
  await settle();
  gates.get("next")!.resolve("ready");
  await settle();
  assert.deepEqual(handled, ["malformed", "next:ready"]);
  queue.close();
});

test("a frame that cannot be classified is treated as runner-wide", async () => {
  const prepared: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const queue = new RunnerFrameQueue<PreparedFrame, string>(async (frame) => { if (frame.name === "first") await held; },
    () => assert.fail("no failure"), undefined, undefined, undefined, {
      runnerWide: (frame) => {
        if (frame.malformed) throw new TypeError("missing snapshot");
        return false;
      },
      prepare: (frame) => { prepared.push(frame.name); return frame.name; },
      discard: () => {},
    });
  queue.enqueue({ name: "first" }, 1);
  queue.enqueue({ name: "unclassified", malformed: true }, 1);
  queue.enqueue({ name: "after" }, 1);
  await settle();
  assert.deepEqual(prepared, ["first", "unclassified"], "nothing behind it is prepared early");
  release();
  await settle();
  assert.deepEqual(prepared, ["first", "unclassified", "after"]);
  queue.close();
});
