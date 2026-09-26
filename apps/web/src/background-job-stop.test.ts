import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { BACKGROUND_DELIVERY_STATUS, backgroundDeliveryAction } from "./background-delivery-status.js";
import { backgroundJobStopAvailability } from "./background-job-stop.js";

test("Stop Job applies to Claude Code sessions with managed work, and says why it is unavailable (#1780)", () => {
  const claude = { driver: "claude-code" as const, backgroundWorkTracking: "managed" as const };
  assert.deepEqual(backgroundJobStopAvailability(claude, PROTOCOL_VERSION, true), { available: true });
  assert.deepEqual(backgroundJobStopAvailability(claude, 190, true), { available: true });
  assert.deepEqual(backgroundJobStopAvailability(claude, 189, true), {
    available: false,
    reason: "Runner protocol is v189; Stop Job requires protocol v190. Update and restart the runner.",
  });
  assert.equal(backgroundJobStopAvailability(claude, null, true)?.available, false);
  assert.deepEqual(backgroundJobStopAvailability(claude, PROTOCOL_VERSION, false),
    { available: false, reason: "The runner is offline." });
  assert.equal(backgroundJobStopAvailability({ ...claude, driver: "codex" }, PROTOCOL_VERSION, true), null);
  assert.equal(backgroundJobStopAvailability({ ...claude, backgroundWorkTracking: "untracked" }, PROTOCOL_VERSION, true), null);
});

test("only Result Blocked guidance changes with Stop Job availability (#1780)", () => {
  const blocked = BACKGROUND_DELIVERY_STATUS.continuation_blocked.action;
  assert.equal(backgroundDeliveryAction("continuation_blocked"), blocked, "a surface that does not know keeps the shared copy");
  assert.equal(backgroundDeliveryAction("continuation_blocked", null), blocked);
  assert.match(backgroundDeliveryAction("continuation_blocked", { available: true }),
    /^Use Stop Job on the unfinished job below: only that job ends, it is recorded as killed, and this result is then returned\./);
  assert.match(backgroundDeliveryAction("continuation_blocked", { available: true }, false),
    /^Use Stop Job on the unfinished job from the same turn, listed in Background Work: only that job ends/);
  assert.equal(backgroundDeliveryAction("continuation_blocked", { available: false, reason: "The runner is offline." }),
    `Stop Job is unavailable: The runner is offline. ${blocked}`);
  assert.equal(backgroundDeliveryAction("accepted_without_result", { available: true }),
    BACKGROUND_DELIVERY_STATUS.accepted_without_result.action);
});

test("Result Blocked says a restart reports the result only where the runner's restart does (#1779)", () => {
  assert.match(backgroundDeliveryAction("continuation_blocked", { available: true }),
    /Restarting or stopping the session also ends it, but ends every other job and discards this result\.$/u,
    "a v190 runner's restart still discards the result");
  const reported = backgroundDeliveryAction("continuation_blocked", { available: true }, true, true);
  assert.match(reported, /Stopping the session also ends it but discards this result; restarting the session ends every job and reports this result to the new conversation instead\.$/u);
  assert.doesNotMatch(BACKGROUND_DELIVERY_STATUS.continuation_blocked.action, /discard/u,
    "the shared copy, read without knowing the runner, claims nothing a restart may not do");
});
