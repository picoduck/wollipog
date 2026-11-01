import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { watchSshLifetime } from "./ssh-supervision.js";

test("an SSH EOF requests exactly one graceful shutdown, never a second signal", async () => {
  const input = new PassThrough();
  let stops = 0;
  watchSshLifetime(input, () => stops++);
  input.write("ignored input");
  assert.equal(stops, 0);
  input.end();
  await setImmediate();
  input.emit("error", new Error("transport ended"));
  assert.equal(stops, 1);
});

test("SSH shutdown observes an already ended stream and can be disarmed", async () => {
  const input = new PassThrough();
  input.resume(); input.end(); await setImmediate();
  let stops = 0;
  watchSshLifetime(input, () => stops++);
  assert.equal(stops, 1);
  const next = new PassThrough();
  watchSshLifetime(next, () => stops++)();
  next.end(); await setImmediate();
  assert.equal(stops, 1);
});
