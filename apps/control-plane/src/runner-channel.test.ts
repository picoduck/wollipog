import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RUNNER_CLIENT_MESSAGE_BYTES,
  MAX_RUNNER_CONNECTIONS,
  MAX_RUNNER_CONNECTIONS_PER_IP,
  RUNNER_AUTH_TIMEOUT_MS,
  RunnerConnectionLimits,
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

  releaseA1();
  const releaseC = limits.acquire("192.0.2.3");
  assert.ok(releaseC, "closing a socket restores global capacity");
  assert.equal(limits.acquire("192.0.2.1"), null, "global capacity remains authoritative");

  releaseA1();
  releaseA2();
  assert.ok(limits.acquire("192.0.2.1"), "release is idempotent and restores capacity once");
  releaseB();
  releaseC();
});
