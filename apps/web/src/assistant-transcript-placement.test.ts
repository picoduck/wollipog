import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantTranscriptReceipt, SessionEventPayload } from "@wollipog/protocol";
import { AssistantReceiptProjector } from "./assistant-transcript-placement.js";
import { TimelineBuilder, timelineSnapshotDelta } from "./timeline.js";

function transcript() {
  const builder = new TimelineBuilder();
  let seq = 0;
  return {
    push(payload: SessionEventPayload) {
      seq += 1;
      builder.push({ id: seq, seq, ts: seq, sessionId: "thread", payload });
      return seq;
    },
    snapshot: () => builder.snapshot(),
  };
}

const call = (toolCallId: string): SessionEventPayload =>
  ({ kind: "tool_call", title: "Assistant Tool", status: "in_progress", toolCallId });
const result = (toolCallId: string, assistantReceipt: AssistantTranscriptReceipt): SessionEventPayload =>
  ({ kind: "tool_call_update", status: "completed", toolCallId, assistantReceipt });

test("a late tool result stays with the message that made the call", () => {
  const timeline = transcript();
  const projector = new AssistantReceiptProjector();
  const launch = { kind: "launch", sessionId: "child" } as const;
  const message = timeline.push({ kind: "agent_message", text: "First reply", final: true });
  timeline.push(call("launch-tool"));
  timeline.push({ kind: "user_message", text: "Second turn" });
  timeline.push({ kind: "agent_message", text: "Second reply", final: true });
  timeline.push(result("launch-tool", launch));
  timeline.push(result("launch-tool", launch));
  const projected = projector.project(timeline.snapshot())!;
  assert.deepEqual([...projected.messages], [[message, [launch]]]);
  assert.equal(projected.items.some(({ kind }) => kind === "assistant_receipt"), false);
});

test("a launch before reply text remains visible while waiting, then attaches to that reply", () => {
  const timeline = transcript();
  const projector = new AssistantReceiptProjector();
  const launch = { kind: "launch", sessionId: "child" } as const;
  timeline.push({ kind: "user_message", text: "Start a session" });
  timeline.push(call("launch-tool"));
  assert.equal(projector.project(timeline.snapshot()), null, "older events have no receipt projection");
  timeline.push(result("launch-tool", launch));
  const first = projector.project(timeline.snapshot())!;
  assert.equal(first.items.at(-1)?.kind, "assistant_receipt");
  assert.equal(first.messages.size, 0);

  const message = timeline.push({ kind: "agent_message", messageId: "reply", text: "Started" });
  const placed = projector.project(timeline.snapshot())!;
  assert.deepEqual([...placed.messages], [[message, [launch]]]);
  assert.equal(placed.items.at(-1)?.kind, "agent_message");

  timeline.push({ kind: "agent_message", messageId: "reply", text: " the work." });
  const streaming = projector.project(timeline.snapshot())!;
  assert.equal(streaming.messages, placed.messages);
  assert.equal(timelineSnapshotDelta(streaming.items)?.previous, placed.items);
  assert.deepEqual(timelineSnapshotDelta(streaming.items)?.dirtyIndexes, [2]);
});
