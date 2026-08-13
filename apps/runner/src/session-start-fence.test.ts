import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionStartFence } from "./session-start-fence.js";

test("shell work waits for the matching session start and observes success", async () => {
  const fence = new SessionStartFence();
  let resolve!: (value: boolean) => void;
  const start = new Promise<boolean>((done) => { resolve = done; });
  fence.track("s1", start);

  let settled = false;
  const waiting = fence.wait("s1").then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  resolve(true);
  assert.equal(await waiting, true);
  assert.equal(await fence.wait("s1"), null, "completed starts are removed");
});

test("session start fences are isolated and preserve launch failure", async () => {
  const fence = new SessionStartFence();
  let resolve!: (value: boolean) => void;
  fence.track("failed", new Promise<boolean>((done) => { resolve = done; }));
  assert.equal(await fence.wait("other"), null);
  const waiting = fence.wait("failed");
  resolve(false);
  assert.equal(await waiting, false);
});

test("a failure settled before shell wiring remains until it is consumed", async () => {
  const fence = new SessionStartFence();
  let resolve!: (value: boolean) => void;
  const tracked = fence.track("failed-before-wait", new Promise<boolean>((done) => { resolve = done; }));
  resolve(false);
  assert.equal(await tracked, false);
  assert.equal(await fence.wait("failed-before-wait"), false);
  assert.equal(await fence.wait("failed-before-wait"), null);
});

test("a replacement generation cannot be cleared by the prior settlement", async () => {
  const fence = new SessionStartFence();
  let resolveOld!: (value: boolean) => void;
  let resolveNew!: (value: boolean) => void;
  fence.track("same", new Promise<boolean>((done) => { resolveOld = done; }));
  fence.track("same", new Promise<boolean>((done) => { resolveNew = done; }));
  resolveOld(true);
  await Promise.resolve();
  const waiting = fence.wait("same");
  resolveNew(false);
  assert.equal(await waiting, false);
});

test("delete cancellation releases a pending waiter as a retained failure", async () => {
  const fence = new SessionStartFence();
  fence.track("deleted", new Promise<boolean>(() => {}));
  const waiting = fence.wait("deleted");
  fence.cancel("deleted");
  assert.equal(await waiting, false);
});

test("an unconsumed settled generation expires on a bounded generation-safe timer", async () => {
  const fence = new SessionStartFence(5);
  await fence.track("expired", Promise.resolve(false));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(await fence.wait("expired"), null);
});
