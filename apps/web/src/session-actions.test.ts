import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireSessionFork,
  canStopActiveTurn,
  composerPrimaryAction,
  editInForkAvailability,
  forkFailureIsAmbiguous,
  type EditInForkContext,
} from "./session-actions.js";

const base: EditInForkContext = {
  driver: "codex-app-server",
  hasWorktree: true,
  runnerOnline: true,
  runnerProtocolVersion: 54,
  status: "idle",
  queuedPrompts: 0,
  busy: false,
};

test("edit-and-fork targets the completed predecessor and fails closed without it", () => {
  assert.deepEqual(editInForkAvailability(2, new Set([1, 2]), base), { available: true, forkTurn: 1 });
  assert.equal(editInForkAvailability(1, new Set([1]), base).available, false, "first turn has no predecessor");
  assert.equal(editInForkAvailability(3, new Set([1, 3]), base).available, false,
    "a cancelled/refused predecessor cannot be silently skipped");
  assert.equal(editInForkAvailability(undefined, new Set(), base).available, false);
});

test("historical edit-and-fork is Codex interactive only and every runtime gate fails closed", () => {
  const turns = new Set([1, 2]);
  for (const driver of ["claude-code", "codex", "acp"] as const) {
    assert.equal(editInForkAvailability(2, turns, { ...base, driver }).available, false);
  }
  const blocked: EditInForkContext[] = [
    { ...base, hasWorktree: false },
    { ...base, runnerOnline: false },
    { ...base, runnerProtocolVersion: 27 },
    { ...base, status: "running" },
    { ...base, status: "starting" },
    { ...base, status: "input_required" },
    { ...base, status: "queued" },
    { ...base, queuedPrompts: 1 },
    { ...base, busy: true },
  ];
  for (const context of blocked) assert.equal(editInForkAvailability(2, turns, context).available, false);
});

test("a session fork lease survives view remounts and releases exactly once", () => {
  const release = acquireSessionFork("source-session");
  assert.ok(release);
  assert.equal(acquireSessionFork("source-session"), null);
  const otherRelease = acquireSessionFork("other-session");
  assert.ok(otherRelease, "independent sessions are not blocked");
  release();
  release();
  const nextRelease = acquireSessionFork("source-session");
  assert.ok(nextRelease);
  nextRelease();
  otherRelease();
});

test("lost responses and 5xx fork failures are ambiguous and must not be retried", () => {
  assert.equal(forkFailureIsAmbiguous(), true, "network response lost");
  assert.equal(forkFailureIsAmbiguous(502), true);
  assert.equal(forkFailureIsAmbiguous(504), true);
  assert.equal(forkFailureIsAmbiguous(409), false, "a definite admission rejection is retryable later");
  assert.equal(forkFailureIsAmbiguous(400), false);
});

test("turn interruption requires a live v72 runner, an active provider turn, and no policy pause", () => {
  assert.equal(canStopActiveTurn({ runnerOnline: true, runnerProtocolVersion: 72, status: "running", activeTurnId: "turn-a" }), true);
  assert.equal(canStopActiveTurn({ runnerOnline: true, runnerProtocolVersion: 72, status: "input_required", activeTurnId: "turn-a" }), true);
  assert.equal(canStopActiveTurn({
    runnerOnline: true,
    runnerProtocolVersion: 72,
    status: "input_required",
    policyPaused: true,
    activeTurnId: "turn-a",
  }), false);
  assert.equal(canStopActiveTurn({ runnerOnline: true, runnerProtocolVersion: 72, status: "running" }), false);
  for (const status of ["queued", "starting", "idle", "stopped", "completed", "failed"] as const) {
    assert.equal(canStopActiveTurn({ runnerOnline: true, runnerProtocolVersion: 72, status }), false, status);
  }
  assert.equal(canStopActiveTurn({ runnerOnline: false, runnerProtocolVersion: 72, status: "running" }), false);
  assert.equal(canStopActiveTurn({ runnerOnline: true, runnerProtocolVersion: 71, status: "running" }), false);
  assert.equal(canStopActiveTurn({ runnerOnline: true, runnerProtocolVersion: undefined, status: "running" }), false);
});

test("the fixed composer control stops only when the active turn has no draft content", () => {
  assert.equal(composerPrimaryAction({ canStopTurn: true, hasContent: false, stopping: false }), "stop");
  assert.equal(composerPrimaryAction({ canStopTurn: true, hasContent: false, stopping: true }), "stopping");
  assert.equal(composerPrimaryAction({ canStopTurn: true, hasContent: true, stopping: false }), "send");
  assert.equal(composerPrimaryAction({ canStopTurn: true, hasContent: true, stopping: true }), "stopping");
  assert.equal(composerPrimaryAction({ canStopTurn: false, hasContent: false, stopping: false }), "send");
});
