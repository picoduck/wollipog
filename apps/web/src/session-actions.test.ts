import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type QueuedPromptView } from "@wollipog/protocol";
import {
  acquireSessionFork,
  canStopActiveTurn,
  checkpointHandoffUnavailableReason,
  composerPrimaryAction,
  conversationForkAvailability,
  editInForkAvailability,
  forkFailureIsAmbiguous,
  isTerminalDeliveryReceipt,
  pendingQueuedPromptCount,
  sessionForkInProgress,
  subscribeSessionForks,
  type CheckpointHandoffContext,
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
  for (const driver of ["claude-code", "pi", "codex", "acp"] as const) {
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

test("plain conversation forks share runtime gates and preserve Claude and Pi latest-only behavior", () => {
  const context = { ...base, providerSupported: true, forkInProgress: false };
  assert.deepEqual(conversationForkAvailability(2, 3, context), { available: true, forkTurn: 2 });
  assert.deepEqual(conversationForkAvailability(3, 3, { ...context, driver: "claude-code" }), {
    available: true,
    forkTurn: 3,
  });
  assert.match(
    conversationForkAvailability(2, 3, { ...context, driver: "claude-code" }).available
      ? ""
      : conversationForkAvailability(2, 3, { ...context, driver: "claude-code" }).reason,
    /latest completed conversation checkpoint/,
  );
  assert.deepEqual(conversationForkAvailability(3, 3, { ...context, driver: "pi" }), {
    available: true,
    forkTurn: 3,
  });
  const historicalPi = conversationForkAvailability(2, 3, { ...context, driver: "pi" });
  assert.equal(historicalPi.available, false);
  if (!historicalPi.available) assert.match(historicalPi.reason, /^Pi can fork only/u);

  const blocked = [
    { context: { ...context, hasWorktree: false }, reason: /isolated worktree/ },
    { context: { ...context, runnerOnline: false }, reason: /Reconnect the runner/ },
    { context: { ...context, runnerProtocolVersion: 27 }, reason: /Update and restart/ },
    { context: { ...context, providerSupported: false }, reason: /provider does not support/ },
    { context: { ...context, forkInProgress: true }, reason: /already in progress/ },
    { context: { ...context, status: "running" as const }, reason: /current turn or approval/ },
    { context: { ...context, queuedPrompts: 1 }, reason: /queued messages/ },
    { context: { ...context, busy: true }, reason: /Another session action/ },
  ];
  for (const { context: blockedContext, reason } of blocked) {
    const availability = conversationForkAvailability(2, 2, blockedContext);
    assert.equal(availability.available, false);
    if (!availability.available) assert.match(availability.reason, reason);
  }
  const noCheckpoint = conversationForkAvailability(undefined, undefined, context);
  assert.equal(noCheckpoint.available, false);
  if (!noCheckpoint.available) assert.match(noCheckpoint.reason, /Complete a conversation turn/);
});

const failedReceipt: QueuedPromptView = {
  id: "cmd-failed", text: "failed", steerable: false, durableDeliveryState: "failed",
};
const uncertainReceipt: QueuedPromptView = { ...failedReceipt, id: "cmd-uncertain", durableDeliveryState: "uncertain" };
const liveEntry: QueuedPromptView = { id: "queue-live", text: "live", steerable: true, liveQueueObserved: true };
const durablePending: QueuedPromptView = { id: "cmd-pending", text: "pending", steerable: false, durableDeliveryState: "pending" };
const durableQueued: QueuedPromptView = { ...durablePending, id: "cmd-queued", durableDeliveryState: "queued" };

test("settled delivery receipts are listed entries but never pending work", () => {
  assert.equal(isTerminalDeliveryReceipt(failedReceipt), true);
  assert.equal(isTerminalDeliveryReceipt(uncertainReceipt), true);
  for (const entry of [liveEntry, durablePending, durableQueued]) {
    assert.equal(isTerminalDeliveryReceipt(entry), false, `${entry.id} is not a settled receipt`);
  }
  assert.equal(pendingQueuedPromptCount(undefined), 0);
  assert.equal(pendingQueuedPromptCount([]), 0);
  assert.equal(pendingQueuedPromptCount([failedReceipt, uncertainReceipt]), 0, "receipts alone are no pending work");
  assert.equal(pendingQueuedPromptCount([liveEntry, durablePending, durableQueued]), 3);
  assert.equal(pendingQueuedPromptCount([failedReceipt, liveEntry, uncertainReceipt, durablePending]), 2,
    "receipts beside pending work neither add to it nor hide it");
});

test("forks and edit-in-fork ignore settled receipts but still wait for pending work", () => {
  const forkContext = (queued: QueuedPromptView[]) => ({
    ...base, providerSupported: true, forkInProgress: false, queuedPrompts: pendingQueuedPromptCount(queued),
  });
  const completed = new Set([1, 2]);

  for (const queued of [[failedReceipt], [uncertainReceipt], [failedReceipt, uncertainReceipt]]) {
    assert.deepEqual(conversationForkAvailability(2, 2, forkContext(queued)), { available: true, forkTurn: 2 });
    assert.deepEqual(editInForkAvailability(2, completed, forkContext(queued)), { available: true, forkTurn: 1 });
  }
  for (const queued of [[liveEntry], [durablePending], [failedReceipt, liveEntry], [uncertainReceipt, durableQueued]]) {
    const fork = conversationForkAvailability(2, 2, forkContext(queued));
    const editFork = editInForkAvailability(2, completed, forkContext(queued));
    assert.equal(fork.available, false);
    assert.equal(editFork.available, false);
    if (!fork.available) assert.match(fork.reason, /queued messages/);
    if (!editFork.available) assert.match(editFork.reason, /queued messages/);
  }
});

test("checkpoint handoff keeps its gates and their order, and ignores settled receipts", () => {
  const ready: CheckpointHandoffContext = {
    runnerOnline: true,
    runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.conversationHandoff,
    hasWorktree: true,
    status: "idle",
    queuedPrompts: 0,
    busy: false,
    forkInProgress: false,
  };
  assert.equal(checkpointHandoffUnavailableReason(ready), undefined);
  assert.equal(
    checkpointHandoffUnavailableReason({ ...ready, queuedPrompts: pendingQueuedPromptCount([failedReceipt, uncertainReceipt]) }),
    undefined,
    "a Session whose only listed entries are settled receipts is not busy",
  );

  const blocked: Array<[Partial<CheckpointHandoffContext>, string]> = [
    [{ runnerOnline: false }, "The runner is offline."],
    [{ runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.conversationHandoff - 1 },
      "Update the runner to support checkpoint handoffs."],
    [{ hasWorktree: false }, "A worktree is required."],
    [{ busy: true }, "The source session is busy."],
    [{ forkInProgress: true }, "The source session is busy."],
    [{ queuedPrompts: pendingQueuedPromptCount([failedReceipt, liveEntry]) }, "The source session is busy."],
    ...(["running", "starting", "queued", "input_required"] as const).map((status) =>
      [{ status }, "The source session is busy."] as [Partial<CheckpointHandoffContext>, string]),
  ];
  for (const [patch, reason] of blocked) {
    assert.equal(checkpointHandoffUnavailableReason({ ...ready, ...patch }), reason, JSON.stringify(patch));
  }
  // The earliest failing gate wins, exactly as the inline chain it replaces.
  assert.equal(
    checkpointHandoffUnavailableReason({ ...ready, runnerOnline: false, hasWorktree: false, busy: true }),
    "The runner is offline.",
  );
  assert.equal(
    checkpointHandoffUnavailableReason({ ...ready, hasWorktree: false, busy: true }),
    "A worktree is required.",
  );
});

test("a session fork lease survives view remounts and releases exactly once", () => {
  let notifications = 0;
  const unsubscribe = subscribeSessionForks(() => { notifications += 1; });
  const release = acquireSessionFork("source-session");
  assert.ok(release);
  assert.equal(sessionForkInProgress("source-session"), true);
  assert.equal(acquireSessionFork("source-session"), null);
  const otherRelease = acquireSessionFork("other-session");
  assert.ok(otherRelease, "independent sessions are not blocked");
  release();
  release();
  const nextRelease = acquireSessionFork("source-session");
  assert.ok(nextRelease);
  nextRelease();
  otherRelease();
  assert.equal(sessionForkInProgress("source-session"), false);
  assert.equal(notifications, 6, "acquire and release notify, while rejected and duplicate releases do not");
  unsubscribe();
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
