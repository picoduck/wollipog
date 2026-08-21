import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RUNNER_CLIENT_MESSAGE_BYTES,
  MAX_RUNNER_CONNECTIONS,
  MAX_RUNNER_CONNECTIONS_PER_IP,
  RUNNER_AUTH_TIMEOUT_MS,
  RunnerConnectionLimits,
  runnerAuthTimeoutMs,
} from "./runner-channel.js";

test("runner channel production limits are finite and internally consistent", () => {
  assert.ok(MAX_RUNNER_CLIENT_MESSAGE_BYTES > 0);
  assert.ok(MAX_RUNNER_CONNECTIONS >= MAX_RUNNER_CONNECTIONS_PER_IP);
  assert.ok(MAX_RUNNER_CONNECTIONS_PER_IP > 0);
  assert.ok(RUNNER_AUTH_TIMEOUT_MS > 0);
});

test("runner connection admission bounds global and per-IP concurrency", () => {
  const limits = new RunnerConnectionLimits({ maxConnections: 3, maxConnectionsPerIp: 2 });
  const releaseA1 = limits.acquire("192.0.2.1");
  const releaseA2 = limits.acquire("192.0.2.1");
  assert.ok(releaseA1);
  assert.ok(releaseA2);
  assert.equal(limits.acquire("192.0.2.1"), null, "third connection from one IP is rejected");

  const releaseB = limits.acquire("192.0.2.2");
  assert.ok(releaseB);
  assert.equal(limits.acquire("192.0.2.3"), null, "global fourth connection is rejected");

  releaseA1.release();
  const releaseC = limits.acquire("192.0.2.3");
  assert.ok(releaseC, "closing a socket restores global capacity");
  assert.equal(limits.acquire("192.0.2.1"), null, "global capacity remains authoritative");

  releaseA1.release();
  releaseA2.release();
  assert.ok(limits.acquire("192.0.2.1"), "release is idempotent and restores capacity once");
  releaseB.release();
  releaseC.release();
});

test("authenticated runners retain global slots but release shared source-IP slots", () => {
  const limits = new RunnerConnectionLimits({ maxConnections: 3, maxConnectionsPerIp: 1 });
  const first = limits.acquire("127.0.0.1");
  assert.ok(first);
  assert.equal(limits.acquire("127.0.0.1"), null);
  first.authenticated();
  const second = limits.acquire("127.0.0.1");
  assert.ok(second);
  second.authenticated();
  const third = limits.acquire("127.0.0.1");
  assert.ok(third);
  third.authenticated();
  assert.equal(limits.acquire("192.0.2.1"), null, "authenticated sockets retain global slots");
  first.release();
  assert.ok(limits.acquire("192.0.2.1"));
});

test("runner auth timeout parsing rejects non-finite and non-positive overrides", () => {
  assert.equal(runnerAuthTimeoutMs(undefined), RUNNER_AUTH_TIMEOUT_MS);
  assert.equal(runnerAuthTimeoutMs("not-a-number"), RUNNER_AUTH_TIMEOUT_MS);
  assert.equal(runnerAuthTimeoutMs("Infinity"), RUNNER_AUTH_TIMEOUT_MS);
  assert.equal(runnerAuthTimeoutMs("0"), RUNNER_AUTH_TIMEOUT_MS);
  assert.equal(runnerAuthTimeoutMs("250.9"), 250);
});
