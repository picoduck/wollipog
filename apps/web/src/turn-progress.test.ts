import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval, SessionEvent, SessionEventPayload, SessionStatus } from "@wollipog/protocol";
import { deriveActiveTurnProgress, IncrementalActiveTurnProgress } from "./turn-progress.js";

let seq = 0;
const sessionId = "progress-session";
function event(payload: SessionEventPayload, ts: number): SessionEvent {
  const next = ++seq;
  return { id: next, seq: next, sessionId, ts, payload };
}

function derive(
  events: SessionEvent[],
  status: SessionStatus = "running",
  pendingApproval: PendingApproval | null = null,
) {
  return deriveActiveTurnProgress({ events, status, pendingApproval });
}

test("steady progress is scoped to the latest non-steer turn and reports observable tool and plan facts", () => {
  seq = 0;
  const events = [
    event({ kind: "user_message", text: "old turn" }, 1_000),
    event({ kind: "tool_call", toolCallId: "old", title: "Old Tool", status: "failed", text: "old error" }, 1_100),
    event({ kind: "user_message", text: "steer", deliveryIntent: "steer" }, 1_200),
    event({ kind: "user_message", text: "current turn" }, 2_000),
    event({ kind: "tool_call", toolCallId: "done", title: "Inspect Files", toolKind: "read", status: "in_progress" }, 2_100),
    event({ kind: "tool_call_update", toolCallId: "done", status: "completed", text: "ok" }, 2_200),
    event({ kind: "plan", entries: [
      { content: "Inspect files", status: "completed" },
      { content: "Run focused tests", status: "in_progress" },
    ] }, 2_300),
    event({ kind: "tool_call", toolCallId: "active", title: "Run Tests", toolKind: "command", status: "in_progress" }, 2_400),
  ];

  const progress = derive(events)!;
  assert.equal(progress.turnStartedAt, 2_000);
  assert.equal(progress.lastActivityAt, 2_400);
  assert.deepEqual(progress.currentOperation, {
    eventId: 8,
    title: "Run Tests",
    toolKind: "command",
    startedAt: 2_400,
    lastActivityAt: 2_400,
  });
  assert.equal(progress.completedTools, 1);
  assert.equal(progress.failedTools, 0);
  assert.equal(progress.currentPlanStep?.content, "Run focused tests");
});

test("retry churn groups only consecutive failures with identical identity and unchanged output", () => {
  seq = 0;
  const events = [
    event({ kind: "user_message", text: "test" }, 1_000),
    event({ kind: "tool_call", toolCallId: "a", title: "Run Tests", toolKind: "command", status: "failed", text: "  ECONNRESET\n" }, 1_100),
    event({ kind: "tool_call", toolCallId: "b", title: " run   tests ", toolKind: "COMMAND", status: "failed", text: "ECONNRESET" }, 1_200),
    event({ kind: "tool_call", toolCallId: "c", title: "Run Tests", toolKind: "command", status: "failed", text: "ECONNRESET" }, 1_300),
  ];

  const progress = derive(events)!;
  assert.deepEqual(progress.retryGroup, {
    eventId: 4,
    title: "Run Tests",
    attempts: 3,
    retries: 2,
    latestError: "ECONNRESET",
  });
  assert.equal(progress.failedTools, 3);

  const changedFailure = [...events,
    event({ kind: "tool_call", toolCallId: "d", title: "Run Tests", toolKind: "command", status: "failed", text: "ETIMEDOUT" }, 1_400),
  ];
  assert.equal(derive(changedFailure)!.retryGroup, undefined,
    "a changed error ends the currently-consecutive unchanged retry condition");
  const laterSuccess = [...events,
    event({ kind: "tool_call", toolCallId: "ok", title: "Run Tests", toolKind: "command", status: "completed", text: "ok" }, 1_500),
  ];
  assert.equal(derive(laterSuccess)!.retryGroup, undefined, "later success clears a stale retry badge");

  const textlessFailuresAfterProgress = [
    event({ kind: "user_message", text: "retry without errors" }, 2_000),
    event({ kind: "tool_call", toolCallId: "progress-a", title: "Run Tests", toolKind: "command", status: "in_progress" }, 2_100),
    event({ kind: "tool_call_update", toolCallId: "progress-a", status: "running", text: "still working" }, 2_200),
    event({ kind: "tool_call_update", toolCallId: "progress-a", status: "failed" }, 2_300),
    event({ kind: "tool_call", toolCallId: "progress-b", title: "Run Tests", toolKind: "command", status: "in_progress" }, 2_400),
    event({ kind: "tool_call_update", toolCallId: "progress-b", status: "running", text: "still working" }, 2_500),
    event({ kind: "tool_call_update", toolCallId: "progress-b", status: "failed" }, 2_600),
  ];
  assert.equal(derive(textlessFailuresAfterProgress)!.retryGroup, undefined,
    "progress output is not reused as failure evidence for textless terminal updates");

  const oversized = "x".repeat(700);
  const oversizedFailures = [
    event({ kind: "user_message", text: "large failures" }, 3_000),
    event({ kind: "tool_call", toolCallId: "large-a", title: "Run Tests", status: "failed", text: oversized }, 3_100),
    event({ kind: "tool_call", toolCallId: "large-b", title: "Run Tests", status: "failed", text: oversized }, 3_200),
  ];
  const boundedError = derive(oversizedFailures)!.retryGroup!.latestError;
  assert.equal(boundedError.length, 512);
  assert.equal(boundedError.endsWith("…"), true, "raw tool cards, not the compact strip, retain oversized output");
});

test("pending approval and pending question expose distinct authoritative waiting reasons", () => {
  seq = 0;
  const events = [event({ kind: "user_message", text: "work" }, 1_000)];
  const approval = derive(events, "input_required", {
    requestId: "approval",
    title: "Run deployment command",
    options: [],
    kind: "permission",
  })!;
  assert.deepEqual(approval.waitingReason, {
    kind: "approval",
    label: "Waiting for Approval",
    title: "Run deployment command",
  });

  const question = derive(events, "input_required", {
    requestId: "question",
    title: "Choose a release channel",
    options: [],
    kind: "question",
    questions: [],
  })!;
  assert.deepEqual(question.waitingReason, {
    kind: "question",
    label: "Waiting for Answer to Question",
    title: "Choose a release channel",
  });
});

test("a long silent command remains active without being labeled stalled", () => {
  seq = 0;
  const events = [
    event({ kind: "user_message", text: "build" }, 1_000),
    event({ kind: "tool_call", toolCallId: "build", title: "Build Release", toolKind: "command", status: "in_progress" }, 2_000),
  ];
  const progress = derive(events)!;
  assert.equal(progress.lastActivityAt, 2_000);
  assert.equal(progress.currentOperation?.title, "Build Release");
  assert.equal(progress.retryGroup, undefined);
  assert.equal("stalled" in progress, false);
  assert.equal(derive(events, "completed"), null, "the strip is active-turn only");
});

test("pending tools are current operations and cancelled terminal attempts count as failures", () => {
  seq = 0;
  const events = [
    event({ kind: "user_message", text: "work" }, 1_000),
    event({ kind: "tool_call", toolCallId: "first", title: "Await Tool", status: "cancelled", text: "cancelled by provider" }, 1_100),
    event({ kind: "tool_call", toolCallId: "second", title: "Queued Tool", status: "pending" }, 1_200),
  ];
  const progress = derive(events)!;
  assert.equal(progress.failedTools, 1);
  assert.equal(progress.currentOperation?.title, "Queued Tool");

  seq = 0;
  const cancellations = derive([
    event({ kind: "user_message", text: "work" }, 1_000),
    event({ kind: "tool_call", toolCallId: "cancel-a", title: "Run Tool", status: "cancelled", text: "cancelled" }, 1_100),
    event({ kind: "tool_call", toolCallId: "cancel-b", title: "Run Tool", status: "canceled", text: "cancelled" }, 1_200),
  ])!;
  assert.equal(cancellations.failedTools, 2);
  assert.equal(cancellations.retryGroup, undefined, "repeated cancellation is not reliable retry evidence");
});

test("current operation exposes a subagent link only from normalized kind or child-parent evidence", () => {
  seq = 0;
  const direct = derive([
    event({ kind: "user_message", text: "delegate" }, 1_000),
    event({ kind: "tool_call", toolCallId: "agent", title: "Audit Storage", toolKind: "agent", status: "in_progress" }, 1_100),
  ])!;
  assert.equal(direct.currentOperation?.subagentId, "agent");

  seq = 0;
  const evidenced = derive([
    event({ kind: "user_message", text: "delegate" }, 1_000),
    event({ kind: "tool_call", toolCallId: "task", title: "Audit Storage", status: "in_progress" }, 1_100),
    event({ kind: "agent_message", text: "working", parentToolUseId: "task" }, 1_200),
  ])!;
  assert.equal(evidenced.currentOperation?.subagentId, "task");

  seq = 0;
  const titleOnly = derive([
    event({ kind: "user_message", text: "delegate" }, 1_000),
    event({ kind: "tool_call", toolCallId: "ordinary", title: "Agent: Audit Storage", status: "in_progress" }, 1_100),
  ])!;
  assert.equal(titleOnly.currentOperation?.subagentId, undefined, "a suggestive title is not identity evidence");
});

test("a child operation retains navigation to its nearest proven subagent ancestor", () => {
  seq = 0;
  const progress = derive([
    event({ kind: "user_message", text: "delegate" }, 1_000),
    event({ kind: "tool_call", toolCallId: "agent", title: "Audit Storage", toolKind: "agent", status: "in_progress" }, 1_100),
    event({
      kind: "tool_call",
      toolCallId: "child-command",
      title: "Run Storage Tests",
      toolKind: "execute",
      status: "in_progress",
      parentToolUseId: "agent",
    }, 1_200),
  ])!;
  assert.deepEqual(progress.currentOperation, {
    eventId: 3,
    title: "Run Storage Tests",
    toolKind: "execute",
    subagentId: "agent",
    startedAt: 1_200,
    lastActivityAt: 1_200,
  });
});

test("reused provider tool ids reveal the retained timeline item's original event", () => {
  seq = 0;
  const progress = derive([
    event({ kind: "user_message", text: "first turn" }, 1_000),
    event({ kind: "tool_call", toolCallId: "tool", title: "First Operation", status: "completed" }, 1_100),
    event({ kind: "user_message", text: "second turn" }, 2_000),
    event({ kind: "tool_call", toolCallId: "tool", title: "Current Operation", status: "running" }, 2_100),
  ])!;
  assert.equal(progress.currentOperation?.eventId, 2,
    "semantic reveal follows TimelineBuilder's session-wide first-id retention for reused provider ids");
});

test("retry propagation stops once an unchanged early tool leaves downstream state stable", () => {
  seq = 0;
  const initial = [
    event({ kind: "user_message", text: "large tool turn" }, 1_000),
    event({ kind: "tool_call", toolCallId: "first", title: "Long Parent", status: "running" }, 1_001),
  ];
  for (let index = 0; index < 5_000; index += 1) {
    initial.push(event({
      kind: "tool_call",
      toolCallId: `later-${index}`,
      title: `Later Tool ${index}`,
      status: "completed",
    }, 1_002 + index));
  }
  const projector = new IncrementalActiveTurnProgress();
  const options = { scopeKey: "retry-scan", status: "running" as const, pendingApproval: null };
  projector.project(initial, options);
  const next = [...initial, event({
    kind: "tool_call_update",
    toolCallId: "first",
    status: "running",
    text: "still working",
  }, 7_000)];
  const projection = projector.project(next, options);
  assert.equal(projection.processedEvents, 1);
  assert.equal(projection.retryScannedTools, 1,
    "an activity-only update does not rescan thousands of unchanged later tools");
});

test("an active status cannot repaint a completed prior turn before its new user-message boundary", () => {
  seq = 0;
  const completedEvents = [
    event({ kind: "user_message", text: "completed turn", turnId: "turn-old" }, 1_000),
    event({ kind: "tool_call", toolCallId: "done", title: "Done", status: "completed" }, 1_100),
  ];
  const projector = new IncrementalActiveTurnProgress();
  const base = { scopeKey: "status-lead", pendingApproval: null, activeTurnId: "turn-new" };
  assert.equal(projector.project(completedEvents, { ...base, status: "completed" }).progress, null);
  const statusLed = projector.project(completedEvents, { ...base, status: "running" });
  assert.equal(statusLed.progress, null, "the prior turn stays hidden during the status-before-event window");
  const rebuilt = projector.project([...completedEvents], { ...base, status: "running", historyRebuilt: true });
  assert.equal(rebuilt.progress, null, "an authoritative turn mismatch survives defensive history rebuild");
  const next = [...completedEvents, event({ kind: "user_message", text: "new turn", turnId: "turn-new" }, 2_000)];
  assert.equal(projector.project(next, { ...base, status: "running" }).progress?.turnEventId, 3);
});

test("incremental projection processes only appended events and rebuilds replaced history or scope", () => {
  seq = 0;
  const initial = [event({ kind: "user_message", text: "long task" }, 1_000)];
  for (let index = 0; index < 5_000; index += 1) {
    initial.push(event({ kind: "agent_message", text: `chunk ${index}` }, 1_001 + index));
  }
  const projector = new IncrementalActiveTurnProgress();
  const options = {
    scopeKey: "session:1",
    status: "running" as const,
    pendingApproval: null,
  };

  const first = projector.project(initial, options);
  assert.equal(first.rebuilt, true);
  assert.equal(first.processedEvents, 5_001);
  const repeated = projector.project(initial, options);
  assert.equal(repeated.rebuilt, false);
  assert.equal(repeated.processedEvents, 0);

  const appended = [...initial, event({
    kind: "tool_call",
    toolCallId: "latest",
    title: "Verify Release",
    status: "running",
  }, 7_000)];
  const extended = projector.project(appended, options);
  assert.equal(extended.rebuilt, false);
  assert.equal(extended.processedEvents, 1, "a 5,000-event prefix is not folded again");
  assert.equal(extended.progress?.currentOperation?.title, "Verify Release");

  const replaced = [...appended];
  const recovered = projector.project(replaced, { ...options, historyRebuilt: true });
  assert.equal(recovered.rebuilt, true);
  assert.equal(recovered.processedEvents, replaced.length, "tagged recovery never trusts tail identity");

  const switched = projector.project(replaced, { ...options, scopeKey: "other-session:2" });
  assert.equal(switched.rebuilt, true);
  assert.equal(switched.processedEvents, replaced.length, "session or event-epoch scope changes reset retained state");
});
