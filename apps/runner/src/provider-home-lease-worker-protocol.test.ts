import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import type { LeaseWorkerExecute, LeaseWorkerAccept } from "./provider-home-lease-worker-protocol.js";

class Port extends EventEmitter {
  readonly sent: Array<LeaseWorkerExecute | LeaseWorkerAccept> = [];
  terminated = 0;
  constructor(readonly epoch: string) { super(); }
  postMessage(value: LeaseWorkerExecute | LeaseWorkerAccept): void { this.sent.push(value); }
  ref(): this { return this; }
  unref(): this { return this; }
  async terminate(): Promise<number> { this.terminated++; return 1; }
  ready(): void { this.emit("message", { kind: "ready", epoch: this.epoch, pid: process.pid }); }
  reply(kind: "receipt" | "done", request: LeaseWorkerExecute, extra: Record<string, unknown> = {}): void {
    this.emit("message", { kind, epoch: this.epoch, id: request.id, ok: true, value: true, ...extra });
  }
  execute(index = 0): LeaseWorkerExecute {
    const value = this.sent.filter((item): item is LeaseWorkerExecute => item.kind === "execute")[index];
    assert.ok(value); return value;
  }
}

function fixture(options: { deadlineMsForTest?: number; pendingLimitForTest?: number } = {}) {
  let port!: Port, starts = 0;
  const diagnostics: unknown[] = [];
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { ...options,
    workerFactoryForTest: data => { starts++; return port = new Port(data.epoch as string); },
    onDiagnostic: d => diagnostics.push(d),
  });
  return { registry, get port() { return port; }, get starts() { return starts; }, diagnostics };
}

test("a receipt grants nothing until its exact acknowledgement completes", async () => {
  const f = fixture(); let settled = false;
  const acquire = f.registry.acquireHome("/private/home").then(value => { settled = true; return value; });
  f.port.ready(); const op = f.port.execute();
  f.port.reply("receipt", op); await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(f.port.sent[1], { kind: "accept", epoch: f.port.epoch, id: op.id, cancel: false });
  f.port.reply("done", op); assert.equal(await acquire, true);
  const close = f.registry.close(); const shutdown = f.port.execute(1);
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
});

for (const phase of ["before-receipt", "after-accept"] as const) test(`cancellation ${phase} requires proof of exactly one unwind`, async () => {
  const f = fixture(), controller = new AbortController();
  const acquire = f.registry.acquireHome("/private/home", "skills", { signal: controller.signal });
  const rejected = assert.rejects(acquire, /cancelled/);
  f.port.ready(); const op = f.port.execute();
  if (phase === "before-receipt") controller.abort();
  f.port.reply("receipt", op);
  if (phase === "before-receipt") {
    assert.equal((f.port.sent[1] as LeaseWorkerAccept).cancel, true);
    f.port.reply("done", op, { ok: false, value: false, error: "cancelled" });
  } else {
    controller.abort(); f.port.reply("done", op);
    const compensate = f.port.execute(1);
    assert.deepEqual(compensate.operation, { method: "cancel", home: "/private/home", completedId: op.id });
    assert.notEqual(compensate.id, op.id);
    f.port.reply("receipt", compensate); f.port.reply("done", compensate);
  }
  await rejected;
  const close = f.registry.close(); const shutdown = f.port.execute(phase === "before-receipt" ? 1 : 2);
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
});

for (const fault of ["wrong-id", "wrong-epoch", "duplicate", "changed", "unproved-cancel", "oversized", "extra-field", "error", "exit"] as const) {
  test(`${fault} poisons the lane without reconstructing authority or reporting release`, async () => {
    const f = fixture();
    const controller = new AbortController();
    const acquire = f.registry.acquireHome("/private/home", "skills", { signal: controller.signal });
    const rejected = assert.rejects(acquire, /worker unavailable/);
    const queued = f.registry.acquireHome("/private/second"); const queuedRejected = assert.rejects(queued, /worker unavailable/);
    f.port.ready(); const op = f.port.execute();
    if (fault === "wrong-id") f.port.reply("receipt", op, { id: "b".repeat(36) });
    else if (fault === "wrong-epoch") f.port.reply("receipt", op, { epoch: "b".repeat(36) });
    else if (fault === "error" || fault === "exit") f.port.emit(fault, fault === "error" ? new Error("lost worker") : 1);
    else if (fault === "oversized") f.port.reply("receipt", op, { junk: "x".repeat(4096) });
    else if (fault === "extra-field") f.port.reply("receipt", op, { privateToken: "untrusted" });
    else {
      if (fault === "unproved-cancel") controller.abort();
      f.port.reply("receipt", op);
      if (fault === "duplicate") f.port.reply("receipt", op);
      else f.port.reply("done", op, fault === "changed" ? { value: false } : { ok: false, value: false, error: "cancel_release_failed" });
    }
    await Promise.all([rejected, queuedRejected]);
    await assert.rejects(f.registry.acquireHome("/private/third"), /worker unavailable/);
    assert.equal(await f.registry.close(), false);
    assert.equal(f.starts, 1); assert.equal(f.port.terminated, 1); assert.equal(f.diagnostics.length, 1);
  });
}

test("queue bounds include the active receipt and expired queued work never executes", async () => {
  const f = fixture({ pendingLimitForTest: 2, deadlineMsForTest: 60 });
  const active = f.registry.acquireHome("/private/first"); const activeRejected = assert.rejects(active, /worker unavailable/);
  const queued = f.registry.acquireHome("/private/second"); const queuedRejected = assert.rejects(queued, /worker unavailable|expired/);
  await assert.rejects(f.registry.acquireHome("/private/third"), /queue is full/);
  f.port.ready(); assert.equal(f.port.sent.length, 1);
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(f.port.sent.length, 1); assert.equal(await f.registry.close(), false);
});

test("shutdown closes admission, drains cancellation, and refuses a late release behind close", async () => {
  const f = fixture(); const acquire = f.registry.acquireHome("/private/home");
  const rejected = assert.rejects(acquire, /cancelled/);
  f.port.ready(); const op = f.port.execute(); const close = f.registry.close();
  await assert.rejects(f.registry.acquireHome("/private/next"), /admission closed/);
  await assert.rejects(f.registry.releaseHome("/private/home"), /release already queued/);
  f.port.reply("receipt", op); f.port.reply("done", op, { ok: false, value: false, error: "cancelled" });
  await rejected;
  const shutdown = f.port.execute(1); assert.equal(shutdown.operation.method, "close");
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown);
  assert.equal(await close, true);
});
