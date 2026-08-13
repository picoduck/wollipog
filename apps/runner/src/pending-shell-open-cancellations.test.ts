import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingShellOpenCancellations } from "./pending-shell-open-cancellations.js";

test("a close-before-open tombstone blocks exactly the delayed open", () => {
  const cancellations = new PendingShellOpenCancellations();
  cancellations.cancel("shell-1");
  assert.equal(cancellations.has("shell-1"), true);
  assert.equal(cancellations.consume("shell-1"), true);
  assert.equal(cancellations.consume("shell-1"), false);
});

test("pending-open tombstones are bounded and expire", async () => {
  const cancellations = new PendingShellOpenCancellations(5, 2);
  cancellations.cancel("oldest");
  cancellations.cancel("middle");
  cancellations.cancel("newest");
  assert.equal(cancellations.has("oldest"), false);
  assert.equal(cancellations.has("middle"), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(cancellations.has("middle"), false);
  assert.equal(cancellations.has("newest"), false);
});

test("cancellation cannot expire while its exact open handler is active", async () => {
  const cancellations = new PendingShellOpenCancellations(5, 1);
  cancellations.register("slow-open");
  cancellations.cancel("slow-open");
  cancellations.cancel("unknown-close");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(cancellations.consume("slow-open"), true);
  cancellations.unregister("slow-open");
  assert.equal(cancellations.has("slow-open"), false);
});
