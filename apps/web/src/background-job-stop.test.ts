import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { BACKGROUND_DELIVERY_STATUS, blockedResultSessionAlternative } from "./background-delivery-status.js";
import { backgroundJobStopAvailability } from "./background-job-stop.js";

test("Stop Job applies to Claude Code sessions with managed work, and says why it is unavailable (#1780)", () => {
  const claude = { driver: "claude-code" as const, backgroundWorkTracking: "managed" as const };
  assert.deepEqual(backgroundJobStopAvailability(claude, PROTOCOL_VERSION, true), { available: true });
  assert.deepEqual(backgroundJobStopAvailability(claude, 190, true), { available: true });
  assert.deepEqual(backgroundJobStopAvailability(claude, 189, true), {
    available: false,
    reason: "This machine needs a newer runner for stopping a background job. Update and restart the runner.",
  });
  assert.equal(backgroundJobStopAvailability(claude, null, true)?.available, false);
  assert.deepEqual(backgroundJobStopAvailability(claude, PROTOCOL_VERSION, false),
    { available: false, reason: "The runner is offline." });
  assert.equal(backgroundJobStopAvailability({ ...claude, driver: "codex" }, PROTOCOL_VERSION, true), null);
  assert.equal(backgroundJobStopAvailability({ ...claude, backgroundWorkTracking: "untracked" }, PROTOCOL_VERSION, true), null);
});

test("Stop Job is unavailable to a person the server would refuse, before any runner reason (#1843)", () => {
  const claude = { driver: "claude-code" as const, backgroundWorkTracking: "managed" as const };
  const reason = "Only the session owner or its controlling Orchestrator can stop its background jobs.";
  const refused = {
    ...claude,
    commandPermissions: {
      stop: { allowed: true as const },
      restart: { allowed: true as const },
      stopBackgroundJob: { allowed: false as const, reason },
    },
  };
  assert.deepEqual(backgroundJobStopAvailability(refused, PROTOCOL_VERSION, true), { available: false, reason });
  assert.deepEqual(backgroundJobStopAvailability(refused, 189, false), { available: false, reason },
    "the person's refusal is the reason even where the runner could not stop the job either");
  assert.equal(backgroundJobStopAvailability({ ...refused, driver: "codex" }, PROTOCOL_VERSION, true), null,
    "a session with no managed jobs still offers nothing");
  const allowed = { ...refused, commandPermissions: { ...refused.commandPermissions, stopBackgroundJob: { allowed: true as const } } };
  assert.deepEqual(backgroundJobStopAvailability(allowed, PROTOCOL_VERSION, true), { available: true });
});

test("Result Blocked says a restart reports the result only where the runner's restart does (#1779)", () => {
  assert.equal(blockedResultSessionAlternative(false),
    "Restarting or stopping the session also ends the unfinished job, but ends every other job and discards this result.",
    "a v190 runner's restart still discards the result");
  assert.equal(blockedResultSessionAlternative(true),
    "Stopping the session also ends the unfinished job but discards this result. Restarting the session ends every " +
    "job and reports this result to the new conversation.");
  assert.doesNotMatch(BACKGROUND_DELIVERY_STATUS.continuation_blocked.action, /discard/u,
    "the shared copy, read without knowing the runner, claims nothing a restart may not do");
});
