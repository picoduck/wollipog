import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { AsyncProviderHomeLeaseRegistry, type AsyncLeaseOptions } from "./provider-home-lease-async.js";
import { type LeaseWorkerAccept, type LeaseWorkerExecute } from "./provider-home-lease-worker-protocol.js";

class Port extends EventEmitter {
  readonly sent: Array<LeaseWorkerExecute | LeaseWorkerAccept> = [];
  terminated = 0;
  constructor(readonly epoch: string) { super(); }
  postMessage(value: LeaseWorkerExecute | LeaseWorkerAccept): void { this.sent.push(value); }
  ref(): this { return this; }
  unref(): this { return this; }
  async terminate(): Promise<number> { this.terminated++; return 1; }
  ready(): void { this.emit("message", { kind: "ready", epoch: this.epoch, pid: process.pid, clock: "hrtime-ns-v1" }); }
  execute(index = 0): LeaseWorkerExecute {
    const request = this.sent.filter((item): item is LeaseWorkerExecute => item.kind === "execute")[index];
    assert.ok(request); return request;
  }
  reply(kind: "receipt" | "done", request: LeaseWorkerExecute): void {
    this.emit("message", { kind, epoch: this.epoch, id: request.id, ok: true, value: true });
  }
}

function fixture(t: TestContext, options: AsyncLeaseOptions = {}) {
  const time = { monotonic: 1_000_000_000n, wall: 1_800_000_000_000 };
  // Clock progression and callback/message delivery are intentionally independent.
  t.mock.method(process.hrtime, "bigint", () => time.monotonic);
  t.mock.method(Date, "now", () => time.wall);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let port!: Port, starts = 0;
  const diagnostics: unknown[] = [];
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), {
    workerFactoryForTest: data => { starts++; return port = new Port(data.epoch as string); },
    onDiagnostic: d => diagnostics.push(d),
    ...options,
  });
  return { registry, time, deadline: time.monotonic + 300_000_000_000n, diagnostics,
    get port() { return port; }, get starts() { return starts; } };
}

for (const clock of [undefined, "wall-ms-v0", 1]) test(`legacy or malformed ready clock ${clock} refuses dispatch`, async t => {
  const f = fixture(t), pending = f.registry.acquireHome("/private/home");
  const refusal = assert.rejects(pending, /identity or clock/);
  f.port.emit("message", { kind: "ready", epoch: f.port.epoch, pid: process.pid, ...(clock === undefined ? {} : { clock }) });
  await refusal; assert.equal(f.port.sent.length, 0); assert.equal(f.port.terminated, 1);
  await assert.rejects(f.registry.acquireHome("/private/replacement"), /worker unavailable/); assert.equal(f.starts, 1);
});

test("dispatch context work cannot carry an expired request into the worker", async t => {
  const f = fixture(t, { profileAccess: () => {
    f.time.monotonic = f.deadline;
    return { controlPlaneSupportsProfiles: true, activeProfileIds: [] };
  } });
  const pending = f.registry.acquireHome("/private/home"); const refusal = assert.rejects(pending, /deadline/);
  f.port.ready(); await refusal; assert.equal(f.port.sent.length, 0);
  const close = f.registry.close(), shutdown = f.port.execute();
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
});

for (const phase of ["receipt", "done"] as const) test(`lifecycle callback cannot cross the deadline during ${phase}`, async t => {
  const f = fixture(t); let consume = false;
  const pending = f.registry.acquireHome("/private/home", "skills", { isCurrent: () => {
    if (consume) f.time.monotonic = f.deadline;
    return true;
  } });
  const refusal = assert.rejects(pending, /late completion/);
  f.port.ready(); const request = f.port.execute();
  if (phase === "done") f.port.reply("receipt", request);
  consume = true; f.port.reply(phase, request); await refusal;
  assert.equal(f.port.terminated, 1); assert.equal(f.starts, 1);
});

for (const jump of [-360_000, 360_000]) test(`wall jump ${jump} cannot expire startup, queued work, receipts or acknowledgement`, async t => {
  const f = fixture(t);
  const first = f.registry.acquireHome("/private/first");
  f.time.wall += jump; f.time.monotonic += 1n;
  const queued = f.registry.acquireHome("/private/second");
  f.time.wall += jump; f.time.monotonic += 1n;
  f.port.ready(); const op = f.port.execute();
  assert.equal(op.deadline, f.deadline.toString());
  f.time.wall += jump; f.port.reply("receipt", op);
  f.time.wall += jump; f.port.reply("done", op);
  assert.equal(await first, true);
  const next = f.port.execute(1);
  assert.equal(next.deadline, (f.deadline + 1n).toString());
  f.time.wall -= jump * 10; f.port.reply("receipt", next);
  f.time.wall += jump * 10; f.port.reply("done", next);
  assert.equal(await queued, true);
  const close = f.registry.close(), shutdown = f.port.execute(2);
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown);
  assert.equal(await close, true); assert.deepEqual(f.diagnostics.filter(d => (d as { event: string }).event === "provider_home_worker_unavailable"), []);
});

for (const offset of [-1n, 0n, 1n]) test(`startup dispatch at deadline ${offset} ns uses the original enqueue budget`, async t => {
  const f = fixture(t);
  const pending = f.registry.acquireHome("/private/home");
  const refusal = offset < 0n ? undefined : assert.rejects(pending, /deadline/);
  f.time.monotonic = f.deadline + offset; f.port.ready();
  if (offset < 0n) {
    const op = f.port.execute(); assert.equal(op.deadline, f.deadline.toString());
    f.port.reply("receipt", op); f.port.reply("done", op); assert.equal(await pending, true);
  } else { await refusal; assert.equal(f.port.sent.length, 0); }
  const close = f.registry.close(), shutdown = f.port.execute(offset < 0n ? 1 : 0);
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
});

for (const phase of ["receipt", "done"] as const) for (const offset of [-1n, 0n, 1n]) {
  test(`${phase} delivered at deadline ${offset} ns cannot outrun an undelivered timer`, async t => {
    const f = fixture(t);
    const pending = f.registry.acquireHome("/private/home");
    const refusal = offset < 0n ? undefined : assert.rejects(pending, /late completion/);
    f.port.ready(); const op = f.port.execute();
    if (phase === "done") f.port.reply("receipt", op);
    f.time.monotonic = f.deadline + offset; f.port.reply(phase, op);
    if (offset < 0n) {
      if (phase === "receipt") f.port.reply("done", op);
      assert.equal(await pending, true);
      const close = f.registry.close(), shutdown = f.port.execute(1);
      f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
    } else {
      await refusal; await assert.rejects(f.registry.acquireHome("/private/replacement"), /worker unavailable/);
      assert.equal(f.starts, 1); assert.equal(f.port.terminated, 1); assert.equal(await f.registry.close(), false);
    }
  });
}

test("early timer delivery rearms the remaining budget and genuine active expiry poisons once", async t => {
  const f = fixture(t); let settled = false;
  const pending = f.registry.acquireHome("/private/home");
  const refusal = assert.rejects(pending, /active deadline/).then(() => { settled = true; });
  f.port.ready();
  t.mock.timers.tick(300_000); await Promise.resolve(); assert.equal(settled, false);
  f.time.monotonic = f.deadline - 1n;
  t.mock.timers.tick(300_000); await Promise.resolve(); assert.equal(settled, false);
  f.time.monotonic = f.deadline;
  t.mock.timers.tick(1); await refusal;
  assert.equal(f.port.terminated, 1); assert.equal(f.starts, 1);
  await assert.rejects(f.registry.acquireHome("/private/replacement"), /worker unavailable/);
});

test("early queued watchdog never expires work while worker startup is delayed", async t => {
  const f = fixture(t); let settled = false;
  const pending = f.registry.acquireHome("/private/home");
  const refusal = assert.rejects(pending, /deadline/).then(() => { settled = true; });
  t.mock.timers.tick(300_000); await Promise.resolve(); assert.equal(settled, false);
  f.time.monotonic = f.deadline; t.mock.timers.tick(300_000); await refusal;
  f.port.ready(); assert.equal(f.port.sent.length, 0); assert.equal(f.port.terminated, 0);
  const close = f.registry.close(), shutdown = f.port.execute();
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
});

test("cancellation compensation keeps the original deadline through its own receipt and done", async t => {
  const f = fixture(t), controller = new AbortController();
  const pending = f.registry.acquireHome("/private/home", "skills", { signal: controller.signal });
  const refusal = assert.rejects(pending, /late completion/);
  f.port.ready(); const op = f.port.execute(); f.port.reply("receipt", op);
  controller.abort(); f.time.monotonic = f.deadline - 2n; f.port.reply("done", op);
  const compensate = f.port.execute(1);
  assert.equal(compensate.deadline, op.deadline); assert.equal(compensate.operation.method, "cancel");
  f.time.wall += 360_000; f.port.reply("receipt", compensate);
  f.time.monotonic = f.deadline; f.port.reply("done", compensate); await refusal;
  assert.equal(f.port.terminated, 1); assert.equal(f.starts, 1); assert.equal(await f.registry.close(), false);
});
