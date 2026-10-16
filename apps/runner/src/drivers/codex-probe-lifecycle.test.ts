import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexProbeLifecycle } from "./codex-probe-lifecycle.js";
import type { AgentProcess } from "../spawn.js";

test("failed owned teardown fences the next provider launch while allowing credential cleanup", async () => {
  class FailedTeardown extends CodexProbeLifecycle {
    override stop(): Promise<boolean> { return Promise.resolve(false); }
  }
  const lifecycle = new FailedTeardown();
  try {
    let launches = 0;
    await lifecycle.run(async () => { launches++; });
    // A synthetic exact child identity avoids signalling any real process in this failure proof.
    lifecycle.own({} as AgentProcess);
    await lifecycle.stopOwned();
    assert.equal(lifecycle.cleanupFailed, true);
    await assert.rejects(lifecycle.run(async () => { launches++; }), /probe_cleanup_failed/);
    assert.equal(launches, 1);
    let credentialsRemoved = false;
    await lifecycle.attempt(() => { credentialsRemoved = true; });
    assert.equal(credentialsRemoved, true);
  } finally { lifecycle.releaseSignals(); }
});

test("probe cancellation fences subsequent operations and preserves the first signal", async () => {
  const before = process.listenerCount("SIGINT");
  const previousInt = new Set(process.listeners("SIGINT"));
  const previousTerm = new Set(process.listeners("SIGTERM"));
  const lifecycle = new CodexProbeLifecycle();
  try {
    const pending = lifecycle.run(() => new Promise<never>(() => {}));
    // Exercise only this instance's installed handlers, including with in-process node:test.
    // process.emit would also fire any harness/runner termination handlers.
    const interrupt = process.listeners("SIGINT").filter(handler => !previousInt.has(handler));
    const terminate = process.listeners("SIGTERM").filter(handler => !previousTerm.has(handler));
    assert.equal(interrupt.length, 1);
    assert.equal(terminate.length, 1);
    interrupt[0]!("SIGINT");
    terminate[0]!("SIGTERM");
    await assert.rejects(pending, /probe_interrupted/);
    let launched = false;
    await assert.rejects(lifecycle.run(async () => { launched = true; }));
    assert.equal(launched, false);
    assert.equal(lifecycle.interruptedBy, "SIGINT");
    assert.equal(lifecycle.cleanupFailed, false);
  } finally { lifecycle.releaseSignals(); }
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("probe cleanup continues after a rejected, false, or timed-out action", async () => {
  const lifecycle = new CodexProbeLifecycle();
  try {
    await lifecycle.attempt(() => { throw new Error("synthetic-private-error"); });
    await lifecycle.attempt(() => false);
    await lifecycle.attempt(() => new Promise<never>(() => {}), 10);
    let removed = false;
    await lifecycle.attempt(() => { removed = true; });
    assert.equal(removed, true);
    assert.equal(lifecycle.cleanupFailed, true);
  } finally { lifecycle.releaseSignals(); }
});

test("probe operation timeout removes the cancellation listener", async () => {
  const lifecycle = new CodexProbeLifecycle();
  try {
    await assert.rejects(lifecycle.run(() => new Promise<never>(() => {}), 10), /probe_timeout/);
    assert.equal(await lifecycle.run(async () => "next"), "next");
  } finally { lifecycle.releaseSignals(); }
});
