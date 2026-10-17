import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { LEASE_WORKER_ERRORS, LEASE_WORKER_PROFILE_LIMIT, ProviderHomeLeaseError, validLeaseWorkerOperation, type LeaseWorkerExecute, type LeaseWorkerAccept } from "./provider-home-lease-worker-protocol.js";

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

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const OTHER_PROFILE = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";

test("acquire frames accept exactly one bounded optional profile context", () => {
  const base = { method: "acquire", home: "/private/home", provider: "claude" };
  const profile = { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE] };
  assert.equal(validLeaseWorkerOperation(base), true);
  assert.equal(validLeaseWorkerOperation({ ...base, profile }), true);
  assert.equal(validLeaseWorkerOperation({ ...base, method: "acquire_reference", profile: { ...profile, expectedId: PROFILE } }), true);
  const invalid: Array<[string, unknown]> = [
    ["extra operation key", { ...base, profile, extra: true }],
    ["extra key without profile", { ...base, extra: true }],
    ["profile on release", { method: "release", home: "/private/home", profile }],
    ["null profile", { ...base, profile: null }],
    ["array profile", { ...base, profile: [] }],
    ["extra profile key", { ...base, profile: { ...profile, grants: [] } }],
    ["missing capability", { ...base, profile: { activeProfileIds: [] } }],
    ["non-boolean capability", { ...base, profile: { ...profile, controlPlaneSupportsProfiles: "yes" } }],
    ["undefined expected id", { ...base, profile: { ...profile, expectedId: undefined } }],
    ["malformed expected id", { ...base, profile: { ...profile, expectedId: "../profile" } }],
    ["malformed active id", { ...base, profile: { ...profile, activeProfileIds: [PROFILE.toUpperCase()] } }],
    ["duplicate active ids", { ...base, profile: { ...profile, activeProfileIds: [PROFILE, PROFILE] } }],
    ["too many active ids", { ...base, profile: { ...profile, activeProfileIds: Array.from({ length: LEASE_WORKER_PROFILE_LIMIT + 1 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-4a5b-4c6d-8e7f-001122334455`) } }],
  ];
  for (const [name, value] of invalid) assert.equal(validLeaseWorkerOperation(value), false, name);
});

test("profile context is read at dispatch and refusal codes reach the caller unchanged", async () => {
  let access = { controlPlaneSupportsProfiles: false, activeProfileIds: [] as string[] };
  let port!: Port, data: Record<string, unknown> | undefined;
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), {
    controlPlaneInstanceId: "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3",
    profileAccess: () => { if (!access) throw new Error("capability source failed"); return access; },
    workerFactoryForTest: value => { data = value; return port = new Port(value.epoch as string); },
  });
  const first = registry.acquireHome("/private/home", "claude", {}, { expectedProfileId: PROFILE });
  assert.equal(data?.controlPlaneInstanceId, "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3");
  // Granted after enqueue but before dispatch: the worker sees the grants current at dispatch.
  access = { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE] };
  port.ready();
  const op = port.execute();
  assert.deepEqual(op.operation, { method: "acquire", home: "/private/home", provider: "claude",
    profile: { expectedId: PROFILE, controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE] } });
  for (const kind of ["receipt", "done"] as const) port.reply(kind, op, { ok: false, value: false, error: "profile_not_granted" });
  await assert.rejects(first, (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_not_granted" &&
    error.message === LEASE_WORKER_ERRORS.profile_not_granted);

  // Revoked while queued behind another operation: the queued acquisition carries the revocation.
  const busy = registry.acquireHome("/private/busy", "claude");
  const queued = registry.acquireHomeReference("/private/second", "claude");
  access = { controlPlaneSupportsProfiles: true, activeProfileIds: [OTHER_PROFILE] };
  const op2 = port.execute(1);
  assert.deepEqual((op2.operation as { profile?: unknown }).profile, { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE] });
  port.reply("receipt", op2); port.reply("done", op2); assert.equal(await busy, true);
  const op3 = port.execute(2);
  assert.deepEqual(op3.operation, { method: "acquire_reference", home: "/private/second", provider: "claude",
    profile: { controlPlaneSupportsProfiles: true, activeProfileIds: [OTHER_PROFILE] } });
  for (const kind of ["receipt", "done"] as const) port.reply(kind, op3, { ok: false, value: false, error: "profile_changed" });
  await assert.rejects(queued, (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_changed");

  // A failing capability source refuses only that acquisition; non-acquisitions never carry a profile.
  access = undefined as never;
  await assert.rejects(registry.acquireHome("/private/fourth", "claude"), /profile context is unavailable/);
  const release = registry.releaseHome("/private/busy");
  const op4 = port.execute(3);
  assert.deepEqual(op4.operation, { method: "release", home: "/private/busy" });
  port.reply("receipt", op4); port.reply("done", op4); assert.equal(await release, true);
  await assert.rejects(registry.acquireHome("/private/home", "claude", {}, { expectedProfileId: "not-a-profile" }), /invalid or oversized/);
  const close = registry.close(); const shutdown = port.execute(4);
  port.reply("receipt", shutdown); port.reply("done", shutdown); assert.equal(await close, true);
});

test("without a capability source an acquisition carries a profile only when it names one", async () => {
  const f = fixture();
  const plain = f.registry.acquireHome("/private/home");
  f.port.ready(); const op = f.port.execute();
  assert.deepEqual(op.operation, { method: "acquire", home: "/private/home", provider: "skills" });
  f.port.reply("receipt", op); f.port.reply("done", op); assert.equal(await plain, true);
  const named = f.registry.acquireHome("/private/home", "claude", {}, { expectedProfileId: PROFILE });
  const op2 = f.port.execute(1);
  assert.deepEqual((op2.operation as { profile?: unknown }).profile, { expectedId: PROFILE, controlPlaneSupportsProfiles: false, activeProfileIds: [] });
  f.port.reply("receipt", op2); f.port.reply("done", op2); assert.equal(await named, true);
  const close = f.registry.close(); const shutdown = f.port.execute(2);
  f.port.reply("receipt", shutdown); f.port.reply("done", shutdown); assert.equal(await close, true);
});
