import assert from "node:assert/strict";
import { test } from "node:test";
import { inPlaceHandoffTurns, type SessionEventPayload } from "./index.js";

const events = (...payloads: SessionEventPayload[]) => payloads.map((payload, index) => ({ seq: index + 1, payload }));
const prompt = (text: string): SessionEventPayload => ({ kind: "user_message", text, final: true });
const response = (text: string): SessionEventPayload => ({ kind: "agent_message", text, final: true });
const completed: SessionEventPayload = { kind: "agent_response_completed" };

test("in-place handoffs count canonical prompts, keep steering and multiple responses in one turn", () => {
  const log = events(
    { kind: "status", status: "starting" }, prompt("First task"),
    { kind: "status", status: "running" }, response("A preliminary answer"),
    { kind: "user_message", text: "Also check this", deliveryIntent: "steer", final: true },
    { kind: "tool_call", toolCallId: "t", title: "Inspect", status: "completed" },
    response("The final answer"), completed, { kind: "status", status: "idle" },
    prompt("Second task"), response("Another answer"), completed,
  );
  const before = JSON.stringify(log);
  assert.deepEqual(inPlaceHandoffTurns(log), { turns: [
    { turn: 1, promptSeq: 2, eventSeq: 8 }, { turn: 2, promptSeq: 10, eventSeq: 12 },
  ] });
  assert.equal(JSON.stringify(log), before, "projection never edits source history");
});

test("final messages, usage and errors alone do not establish a turn boundary", () => {
  for (const unfinished of [
    response("Partial"), { kind: "error", message: "failed" }, { kind: "token_usage", inputTokens: 1 },
  ] satisfies SessionEventPayload[]) {
    const result = inPlaceHandoffTurns(events(prompt("Task"), unfinished));
    assert.equal(result.turns[0]?.eventSeq, undefined);
    assert.match(result.turns[0]!.reason!, /didn't finish/);
  }
  assert.deepEqual(inPlaceHandoffTurns(events(
    { kind: "user_message", text: "Steering only", deliveryIntent: "steer", final: true }, response("Partial"), completed,
  )), { turns: [] });
});

test("a failed turn keeps its ordinal and cannot borrow a later turn's completion", () => {
  const result = inPlaceHandoffTurns(events(prompt("Failed"), response("Partial"),
    { kind: "error", message: "No durable end" }, prompt("Succeeded"), response("Done"), completed));
  assert.equal(result.turns[0]?.eventSeq, undefined);
  assert.deepEqual(result.turns[1], { turn: 2, promptSeq: 4, eventSeq: 6 });
});

test("incomplete prefixes, gaps and unordered histories fail closed", () => {
  const log = events(prompt("Task"), response("Done"), completed);
  for (const incomplete of [log.slice(1), log.filter((event) => event.seq !== 2), [...log].reverse(), []]) {
    const result = inPlaceHandoffTurns(incomplete);
    assert.match(result.reason!, /Load earlier messages/);
    assert.ok(result.turns.every((point) => !point.eventSeq && point.reason));
  }
});

test("stopped, interrupted, failed and idle turns with durable end events can be handed off", () => {
  for (const boundary of [
    { kind: "turn_interrupted" }, { kind: "status", status: "idle" }, { kind: "status", status: "stopped" },
    { kind: "status", status: "failed" }, { kind: "status", status: "completed" },
  ] satisfies SessionEventPayload[]) {
    assert.deepEqual(inPlaceHandoffTurns(events(prompt("Task"), response("Partial"), boundary)).turns,
      [{ turn: 1, promptSeq: 1, eventSeq: 3 }]);
  }
});

test("a settled snapshot closes only the loaded log tail, including cost-guardrail pauses", () => {
  const log = events(prompt("Task"), response("Partial work"),
    { kind: "stderr", text: "Runner governance paused this turn at the cost threshold." });
  for (const status of ["idle", "completed", "stopped", "failed"] as const) {
    assert.deepEqual(inPlaceHandoffTurns(log, { status, throughSeq: 3 }).turns,
      [{ turn: 1, promptSeq: 1, eventSeq: 3 }]);
    assert.deepEqual(inPlaceHandoffTurns(log, { status, historyComplete: true }).turns,
      [{ turn: 1, promptSeq: 1, eventSeq: 3 }]);
  }
  for (const state of [
    { status: "running" as const, throughSeq: 3 }, { status: "idle" as const, throughSeq: 2 },
    { status: "idle" as const, throughSeq: 4 },
    { status: "idle" as const, throughSeq: 2, historyComplete: true },
    { status: "idle" as const, throughSeq: 3, historyComplete: false },
  ]) assert.equal(inPlaceHandoffTurns(log, state).turns[0]?.eventSeq, undefined);
  assert.match(inPlaceHandoffTurns(log, { status: "idle", throughSeq: 4 }).turns[0]!.reason!, /Load the remaining messages/);
  assert.match(inPlaceHandoffTurns(log, { status: "idle", historyComplete: false }).turns[0]!.reason!, /Load the remaining messages/);
  assert.equal(inPlaceHandoffTurns(log.slice(1), { status: "idle", throughSeq: 3 }).turns[0]?.eventSeq, undefined);
});

test("later continuation output requires its own completion and moves the boundary", () => {
  const log = events(prompt("Task"), response("First answer"), completed, response("Continuation"));
  assert.equal(inPlaceHandoffTurns(log).turns[0]?.eventSeq, undefined);
  assert.equal(inPlaceHandoffTurns([...log, { seq: 5, payload: completed }]).turns[0]?.eventSeq, 5);
});
