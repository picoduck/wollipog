import assert from "node:assert/strict";
import test from "node:test";
import { withCapturedAnimationFrames, withScopedClockOverrides } from "./test-clock-overrides.js";

test("scoped clock overrides restore descriptors after success and failure", async () => {
  const clock = { setTimeout() {}, requestAnimationFrame() {} };
  const timeout = Object.getOwnPropertyDescriptor(clock, "setTimeout");
  const frame = Object.getOwnPropertyDescriptor(clock, "requestAnimationFrame");
  await withScopedClockOverrides(clock, {
    setTimeout: () => 1,
    requestAnimationFrame: () => 2,
  }, () => {
    assert.equal(clock.setTimeout(), 1);
    assert.equal(clock.requestAnimationFrame(), 2);
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(clock, "setTimeout"), timeout);
  assert.deepEqual(Object.getOwnPropertyDescriptor(clock, "requestAnimationFrame"), frame);
  await assert.rejects(withScopedClockOverrides(clock, { setTimeout: () => 3 }, () => {
    throw new Error("test failure");
  }), /test failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(clock, "setTimeout"), timeout);

  Object.defineProperty(clock, "requestAnimationFrame", { configurable: false, value: clock.requestAnimationFrame });
  await assert.rejects(withScopedClockOverrides(clock, {
    setTimeout: () => 4,
    requestAnimationFrame: () => 5,
  }, () => {}), TypeError);
  assert.deepEqual(Object.getOwnPropertyDescriptor(clock, "setTimeout"), timeout,
    "a failed second override also restores the first");
});

test("captured frames run only when flushed and cancellation removes a callback", async () => {
  const clock = {
    requestAnimationFrame: (_callback: FrameRequestCallback) => 99,
    cancelAnimationFrame: (_id: number) => {},
  } as unknown as Window;
  const calls: string[] = [];
  await withCapturedAnimationFrames(clock, ({ pending, flush }) => {
    const canceled = clock.requestAnimationFrame(() => calls.push("canceled"));
    clock.requestAnimationFrame(() => calls.push("restored"));
    clock.cancelAnimationFrame(canceled);
    assert.equal(pending(), 1);
    assert.equal(calls.length, 0);
    flush();
    assert.equal(calls.join(","), "restored");
    assert.equal(pending(), 0);
    clock.requestAnimationFrame(() => {
      calls.push("first");
      clock.cancelAnimationFrame(second);
      clock.requestAnimationFrame(() => calls.push("next frame"));
    });
    const second = clock.requestAnimationFrame(() => calls.push("canceled in flush"));
    flush();
    assert.equal(calls.join(","), "restored,first");
    assert.equal(pending(), 1);
    flush();
    assert.equal(calls.join(","), "restored,first,next frame");
  });
  assert.equal(clock.requestAnimationFrame(() => {}), 99);
});
