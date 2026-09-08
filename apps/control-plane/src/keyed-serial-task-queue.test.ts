import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedSerialTaskQueue } from "./keyed-serial-task-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("serializes work for one session without blocking another session", async () => {
  const queue = new KeyedSerialTaskQueue();
  const firstRelease = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const otherStarted = deferred();

  const first = queue.run("session-1", async () => {
    firstStarted.resolve();
    await firstRelease.promise;
    return "first";
  });
  await firstStarted.promise;
  const second = queue.run("session-1", async () => {
    secondStarted.resolve();
    return "second";
  });
  const other = queue.run("session-2", async () => {
    otherStarted.resolve();
    return "other";
  });

  await otherStarted.promise;
  assert.equal(await other, "other");
  let secondBegan = false;
  void secondStarted.promise.then(() => { secondBegan = true; });
  await Promise.resolve();
  assert.equal(secondBegan, false);

  firstRelease.resolve();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("a rejected task does not poison the next task for its session", async () => {
  const queue = new KeyedSerialTaskQueue();
  await assert.rejects(queue.run("session", async () => { throw new Error("expected"); }), /expected/);
  assert.equal(await queue.run("session", async () => 42), 42);
});
