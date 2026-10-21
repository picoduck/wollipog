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

test("final messages, usage and idle do not prove completion of interrupted or failed turns", () => {
  for (const terminal of [
    { kind: "turn_interrupted" }, { kind: "error", message: "failed" },
    { kind: "status", status: "failed" }, { kind: "status", status: "stopped" },
    { kind: "status", status: "idle" },
  ] satisfies SessionEventPayload[]) {
    const result = inPlaceHandoffTurns(events(prompt("Task"), response("Partial"), terminal,
      { kind: "token_usage", inputTokens: 1 }, { kind: "status", status: "idle" }));
    assert.equal(result.turns[0]?.eventSeq, undefined);
    assert.match(result.turns[0]!.reason!, /no authoritative completion/);
  }
  assert.deepEqual(inPlaceHandoffTurns(events(
    { kind: "user_message", text: "Steering only", deliveryIntent: "steer", final: true }, response("Partial"), completed,
  )), { turns: [] });
});

test("a failed turn keeps its ordinal and cannot borrow a later turn's completion", () => {
  const result = inPlaceHandoffTurns(events(prompt("Failed"), response("Partial"),
    { kind: "turn_interrupted" }, prompt("Succeeded"), response("Done"), completed));
  assert.equal(result.turns[0]?.eventSeq, undefined);
  assert.deepEqual(result.turns[1], { turn: 2, promptSeq: 4, eventSeq: 6 });
});

test("incomplete prefixes, gaps and unordered histories fail closed", () => {
  const log = events(prompt("Task"), response("Done"), completed);
  for (const incomplete of [log.slice(1), log.filter((event) => event.seq !== 2), [...log].reverse(), []]) {
    const result = inPlaceHandoffTurns(incomplete);
    assert.match(result.reason!, /Load the earlier history/);
    assert.ok(result.turns.every((point) => !point.eventSeq && point.reason));
  }
});

test("later continuation output requires its own completion and moves the boundary", () => {
  const log = events(prompt("Task"), response("First answer"), completed, response("Continuation"));
  assert.equal(inPlaceHandoffTurns(log).turns[0]?.eventSeq, undefined);
  assert.equal(inPlaceHandoffTurns([...log, { seq: 5, payload: completed }]).turns[0]?.eventSeq, 5);
});
