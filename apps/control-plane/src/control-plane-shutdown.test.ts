import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { STOP_TIMEOUT_SECONDS } from "../../runner/src/systemd-service.js";
import { CONTROL_PLANE_SHUTDOWN_LIMIT_MS, finishControlPlaneShutdown } from "./control-plane-shutdown.js";

function pendingDrain(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("control-plane shutdown fits inside the installed service stop budget", () => {
  assert.ok(CONTROL_PLANE_SHUTDOWN_LIMIT_MS < STOP_TIMEOUT_SECONDS * 1_000);
});

test("a hung close with no SSH drains keeps the original five-second failsafe", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let exits = 0;
  finishControlPlaneShutdown(Promise.resolve(), () => new Promise(() => {}), () => exits++);
  await setImmediate();
  t.mock.timers.tick(4_999); assert.equal(exits, 0);
  t.mock.timers.tick(1); assert.equal(exits, 1);
  t.mock.timers.tick(25_000); assert.equal(exits, 1, "only one exit, even after the hard deadline");
});

test("pending SSH drains get their twenty-second deadline before the short close failsafe", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const drain = pendingDrain();
  let exits = 0;
  finishControlPlaneShutdown(drain.promise, () => new Promise(() => {}), () => exits++);
  await setImmediate();
  t.mock.timers.tick(20_000); assert.equal(exits, 0);
  drain.resolve(); await setImmediate();
  t.mock.timers.tick(4_999); assert.equal(exits, 0);
  t.mock.timers.tick(1); assert.equal(exits, 1);
});

test("an unexpected hung drain cannot extend shutdown beyond the overall bound", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let exits = 0;
  finishControlPlaneShutdown(new Promise(() => {}), async () => {}, () => exits++);
  await setImmediate();
  t.mock.timers.tick(CONTROL_PLANE_SHUTDOWN_LIMIT_MS);
  assert.equal(exits, 1);
});

test("normal or failed application close exits promptly after drains settle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const fail of [false, true]) {
    const drain = pendingDrain();
    let exits = 0;
    finishControlPlaneShutdown(drain.promise, async () => { if (fail) throw new Error("close failed"); }, () => exits++);
    await setImmediate(); assert.equal(exits, 0);
    drain.resolve(); await setImmediate(); assert.equal(exits, 1);
    t.mock.timers.tick(25_000); assert.equal(exits, 1);
  }
});
