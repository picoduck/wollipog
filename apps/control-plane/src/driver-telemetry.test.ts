import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDriverTelemetry, telemetryWindowDays } from "./driver-telemetry.js";

const valid = {
  type: "driver_telemetry" as const,
  metric: "approval" as const,
  driver: "codex-app-server" as const,
  version: "0.144.1-beta_2",
  context: "wsl" as const,
  outcome: "allowed" as const,
  durationMs: 123,
};

test("driver telemetry accepts only closed, bounded, content-free dimensions", () => {
  assert.deepEqual(normalizeDriverTelemetry(valid), valid);
  assert.equal(normalizeDriverTelemetry({ ...valid, durationMs: Number.NaN }), null);
  assert.equal(normalizeDriverTelemetry({ ...valid, durationMs: -1 }), null);
  assert.equal(normalizeDriverTelemetry({ ...valid, version: "C:/secret/path" })?.version, undefined);
  assert.equal(normalizeDriverTelemetry({ ...valid, version: "x".repeat(81) })?.version, undefined);
  assert.equal(normalizeDriverTelemetry({ ...valid, metric: "prompt" as never }), null);
  assert.equal(normalizeDriverTelemetry({ ...valid, driver: "unknown" as never }), null);
  assert.equal(normalizeDriverTelemetry({ ...valid, reason: "raw error text" as never }), null);
});

test("telemetry query windows default to 30 days and reject out-of-range values", () => {
  assert.equal(telemetryWindowDays(undefined), 30);
  assert.equal(telemetryWindowDays("7.9"), 7);
  assert.equal(telemetryWindowDays(0), null);
  assert.equal(telemetryWindowDays(91), null);
  assert.equal(telemetryWindowDays("garbage"), null);
});
