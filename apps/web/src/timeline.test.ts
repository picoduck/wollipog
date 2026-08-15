import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventPayloadReference, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import {
  deriveSidePaneContent,
  deriveTimeline,
  groupTimeline,
  MAX_OPEN_PROVIDER_TEXT_ITEMS,
  nestSubagents,
  SubagentTreeProjector,
  TimelineBuilder,
  timelineSnapshotDelta,
  type TimelineItem,
} from "./timeline.js";

let seq = 0;
function ev(payload: SessionEventPayload): SessionEvent {
  seq += 1;
  return { id: seq, sessionId: "s", seq, ts: seq, payload };
}

const payloadRef = (artifactId: string, mimeType: EventPayloadReference["mimeType"] = "text/plain"): EventPayloadReference => ({
  artifactId,
  mimeType,
  encoding: "utf8",
  sizeBytes: 20_000,
  sha256: "a".repeat(64),
});

test("timeline row identity follows runner sequence across REST database-id replacement", () => {
  const payload: SessionEventPayload = { kind: "user_message", text: "stable" };
  const live = deriveTimeline([{ id: 17, sessionId: "s", seq: 42, ts: 1, payload }]);
  const authoritative = deriveTimeline([{ id: 9_001, sessionId: "s", seq: 42, ts: 1, payload }]);
  assert.equal(live[0]!.id, 42);
  assert.equal(authoritative[0]!.id, 42);
});

test("user-message projection preserves queue and steering reconciliation identity", () => {
  const [item] = deriveTimeline([ev({
    kind: "user_message",
    text: "queued",
    turnId: "turn-queued",
    commandId: "prompt-durable",
    submissionId: "submission-steered",
    deliveryIntent: "steer",
  })]);
  assert.equal(item?.kind, "user_message");
  assert.equal(item?.kind === "user_message" ? item.turnId : undefined, "turn-queued");
  assert.equal(item?.kind === "user_message" ? item.commandId : undefined, "prompt-durable");
  assert.equal(item?.kind === "user_message" ? item.submissionId : undefined, "submission-steered");
  assert.equal(item?.kind === "user_message" ? item.deliveryIntent : undefined, "steer");
});

test("user-message projection preserves durable provider-command provenance", () => {
  const commandInvocation = {
    invocationId: "invocation-1",
    submissionId: "submission-1",
    providerCommandId: "command-1",
    catalogRevision: "catalog-1",
    commandName: "review",
    executionMode: "structured" as const,
  };
  const [item] = deriveTimeline([ev({
    kind: "user_message",
    text: "/review storage",
    commandInvocation,
  })]);
  assert.deepEqual(item?.kind === "user_message" ? item.commandInvocation : undefined, commandInvocation);
});

test("canonical steering stays visible without stealing the active turn duration or checkpoint", () => {
  const items = deriveTimeline([
    {
      id: 100,
      sessionId: "s",
      seq: 100,
      ts: 1_000,
      payload: { kind: "user_message", text: "Original prompt", turnId: "turn-active" },
    },
    {
      id: 101,
      sessionId: "s",
      seq: 101,
      ts: 1_500,
      payload: {
        kind: "user_message",
        text: "Steer the same turn",
        turnId: "turn-active",
        submissionId: "submission-steered",
        deliveryIntent: "steer",
      },
    },
    {
      id: 102,
      sessionId: "s",
      seq: 102,
      ts: 2_500,
      payload: { kind: "token_usage", inputTokens: 10, outputTokens: 5, durationMs: 1_200 },
    },
    {
      id: 103,
      sessionId: "s",
      seq: 103,
      ts: 2_600,
      payload: { kind: "conversation_checkpoint", turn: 7 },
    },
  ]);

  const users = items.filter(
    (item): item is Extract<TimelineItem, { kind: "user_message" }> => item.kind === "user_message",
  );
  assert.deepEqual(users.map((item) => item.text), ["Original prompt", "Steer the same turn"]);
  assert.deepEqual(
    [
      users[0]?.durationMs, users[0]?.durationSource, users[0]?.turn,
      users[1]?.durationMs, users[1]?.durationSource, users[1]?.turn,
    ],
    [1_200, "provider", 7, undefined, undefined, undefined],
  );
  assert.deepEqual(
    [users[1]?.submissionId, users[1]?.deliveryIntent, users[1]?.turnId],
    ["submission-steered", "steer", "turn-active"],
  );
  assert.equal(items.at(-1)?.kind, "conversation_checkpoint");
});

test("turn interruption is a standalone non-error transcript outcome with recorded time", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "partial" }),
    ev({ kind: "turn_interrupted" }),
    ev({ kind: "agent_message", text: "next" }),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["agent_message", "turn_interrupted", "agent_message"]);
  const interrupted = items[1] as Extract<TimelineItem, { kind: "turn_interrupted" }>;
  assert.equal(interrupted.createdAt, interrupted.id);
  assert.equal(items.some((item) => item.kind === "error"), false);
  assert.deepEqual(groupTimeline(items).map((group) => group.kind), ["item", "item", "item"]);
});

test("managed continuation delivery markers remain durable but hidden from the timeline", () => {
  const items = deriveTimeline([
    ev({ kind: "stderr", text: "before" }),
    ev({ kind: "stderr", text: "Managed background continuation delivered: bgcont_hidden" }),
    ev({ kind: "stderr", text: "after" }),
  ]);
  assert.deepEqual(items.map((item) => item.kind === "stderr" ? item.text : ""), ["before", "after"]);
});

test("timeline delta metadata retains only the immediate predecessor snapshot", () => {
  const builder = new TimelineBuilder();
  builder.push(ev({ kind: "user_message", text: "one" }));
  const first = builder.snapshot();
  builder.push(ev({ kind: "user_message", text: "two" }));
  const second = builder.snapshot();
  assert.equal(timelineSnapshotDelta(first), undefined);
  assert.equal(timelineSnapshotDelta(second)?.previous, first);
  builder.push(ev({ kind: "user_message", text: "three" }));
  const third = builder.snapshot();
  assert.equal(timelineSnapshotDelta(second), undefined);
  assert.equal(timelineSnapshotDelta(third)?.previous, second);
});

test("live agent_message chunks coalesce into one bubble", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Hel" }),
    ev({ kind: "agent_message", text: "lo " }),
    ev({ kind: "agent_message", text: "world" }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "agent_message");
  assert.equal((items[0] as { text: string }).text, "Hello world");
  assert.equal((items[0] as Extract<TimelineItem, { kind: "agent_message" }>).createdAt, items[0]!.id,
    "streamed messages retain the first chunk's recorded time");
});

test("provider message ids coalesce same-item deltas and split adjacent items", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Hel", messageId: "first" }),
    ev({ kind: "agent_message", text: "lo", messageId: "first" }),
    ev({ kind: "agent_message", text: "Second", messageId: "second" }),
  ]);
  assert.deepEqual(items.map((item) => item.kind === "agent_message" ? [item.text, item.messageId] : null), [
    ["Hello", "first"],
    ["Second", "second"],
  ]);
});

test("interleaved provider message deltas resume their original logical rows", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "A1", messageId: "a" }),
    ev({ kind: "agent_message", text: "B1", messageId: "b" }),
    ev({ kind: "agent_message", text: "A2", messageId: "a" }),
    ev({ kind: "agent_message", text: "B2", messageId: "b" }),
  ]) as Extract<TimelineItem, { kind: "agent_message" }>[];
  assert.deepEqual(items.map(({ text, messageId }) => [text, messageId]), [
    ["A1A2", "a"],
    ["B1B2", "b"],
  ]);
  assert.deepEqual(items.map(({ sourceEndId }) => sourceEndId), [items[0]!.id + 2, items[1]!.id + 2]);
});

test("several identified streams remain separate and incremental replay matches full history", () => {
  const events = [
    ev({ kind: "agent_message", text: "A1", messageId: "a" }),
    ev({ kind: "agent_message", text: "B1", messageId: "b" }),
    ev({ kind: "agent_message", text: "C1", messageId: "c" }),
    ev({ kind: "agent_message", text: "B2", messageId: "b" }),
    ev({ kind: "agent_message", text: "A2", messageId: "a" }),
    ev({ kind: "agent_message", text: "C2", messageId: "c" }),
  ];
  const builder = new TimelineBuilder();
  for (const event of events) {
    builder.push(event);
    builder.snapshot();
  }
  assert.deepEqual(builder.snapshot(), deriveTimeline(events));
  assert.deepEqual(
    builder.snapshot().map((item) => item.kind === "agent_message" ? [item.messageId, item.text] : null),
    [["a", "A1A2"], ["b", "B1B2"], ["c", "C1C2"]],
  );
});

test("matching provider ids remain isolated by kind and parent context", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "top-1", messageId: "shared" }),
    ev({ kind: "agent_message", text: "child-1", messageId: "shared", parentToolUseId: "task" }),
    ev({ kind: "agent_thought", text: "thought-1", messageId: "shared" }),
    ev({ kind: "agent_message", text: "top-2", messageId: "shared" }),
    ev({ kind: "agent_message", text: "child-2", messageId: "shared", parentToolUseId: "task" }),
    ev({ kind: "agent_thought", text: "thought-2", messageId: "shared" }),
  ]);
  assert.deepEqual(items.map((item) => [
    item.kind,
    "parentToolUseId" in item ? item.parentToolUseId : undefined,
    "text" in item ? item.text : undefined,
  ]), [
    ["agent_message", undefined, "top-1top-2"],
    ["agent_message", "task", "child-1child-2"],
    ["agent_thought", undefined, "thought-1thought-2"],
  ]);
});

test("provider completion reconciles streamed content once and closes that identity", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Hel", messageId: "a" }),
    ev({ kind: "agent_message", text: "Wor", messageId: "b" }),
    ev({ kind: "agent_message", text: "Hello", messageId: "a", final: true }),
    ev({ kind: "agent_message", text: "World", messageId: "b", final: true }),
    ev({ kind: "agent_message", text: "new", messageId: "a" }),
  ]);
  assert.deepEqual(items.map((item) => item.kind === "agent_message" ? [item.messageId, item.text] : null), [
    ["a", "Hello"],
    ["b", "World"],
    ["a", "new"],
  ]);
});

test("turn, structural, and identity-loss boundaries prevent provider-id reachback", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "before-user", messageId: "same" }),
    ev({ kind: "user_message", text: "next turn" }),
    ev({ kind: "agent_message", text: "after-user", messageId: "same" }),
    ev({ kind: "tool_call", toolCallId: "tool", title: "Tool", status: "completed" }),
    ev({ kind: "agent_message", text: "after-tool", messageId: "same" }),
    ev({ kind: "agent_message", text: "untagged" }),
    ev({ kind: "agent_message", text: "retagged", messageId: "same" }),
  ]);
  assert.deepEqual(
    items.filter((item): item is Extract<TimelineItem, { kind: "agent_message" }> => item.kind === "agent_message")
      .map((item) => item.text),
    ["before-user", "after-user", "after-tool", "untagged", "retagged"],
  );
});

test("open provider-message tracking evicts least-recently-used identities at its bound", () => {
  const events: SessionEvent[] = [];
  for (let index = 0; index <= MAX_OPEN_PROVIDER_TEXT_ITEMS; index += 1) {
    events.push(ev({ kind: "agent_message", text: `${index}:`, messageId: `message-${index}` }));
  }
  events.push(ev({ kind: "agent_message", text: "resumed", messageId: "message-0" }));
  const messages = deriveTimeline(events).filter(
    (item): item is Extract<TimelineItem, { kind: "agent_message" }> => item.kind === "agent_message",
  );
  assert.equal(messages.length, MAX_OPEN_PROVIDER_TEXT_ITEMS + 2);
  assert.equal(messages[0]!.text, "0:");
  assert.equal(messages.at(-1)!.text, "resumed");
});

test("mixed ACP tagging splits once when message identity evidence disappears", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Tagged ", messageId: "acp-message" }),
    ev({ kind: "agent_message", text: "stream", messageId: "acp-message" }),
    ev({ kind: "agent_message", text: " untagged" }),
    ev({ kind: "agent_message", text: " tail" }),
  ]);
  assert.deepEqual(items.map((item) => item.kind === "agent_message" ? [item.text, item.messageId] : null), [
    ["Tagged stream", "acp-message"],
    [" untagged tail", undefined],
  ]);
});

test("an authoritative final can reconcile the contiguous open provider message", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Hel", messageId: "first" }),
    ev({ kind: "agent_message", text: "lo", messageId: "first" }),
    ev({ kind: "agent_message", text: "Hello!", messageId: "first", final: true }),
  ]);
  assert.equal(items.length, 1);
  const message = items[0] as Extract<TimelineItem, { kind: "agent_message" }>;
  assert.equal(message.text, "Hello!");
  assert.equal(message.messageId, "first");
  assert.ok(message.sourceEndId! > message.id);
  assert.deepEqual(
    [message.createdAt, message.lastActivityAt, message.completedAt],
    [items[0]!.id, message.sourceEndId, message.sourceEndId],
    "the first chunk remains the start while the final freezes completion at its envelope time",
  );
});

test("streamed thoughts retain start, latest activity, and authoritative completion", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_thought", text: "Think", messageId: "thought" }),
    ev({ kind: "agent_thought", text: "ing", messageId: "thought" }),
    ev({ kind: "agent_thought", text: "Thinking", messageId: "thought", final: true }),
  ]);
  const thought = items[0] as Extract<TimelineItem, { kind: "agent_thought" }>;
  assert.equal(thought.text, "Thinking");
  assert.deepEqual([thought.createdAt, thought.lastActivityAt, thought.completedAt], [thought.id, thought.sourceEndId, thought.sourceEndId]);
});

test("old-runner id-less chunks retain new-web legacy coalescing", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Legacy " }),
    ev({ kind: "agent_message", text: "stream" }),
  ]);
  assert.equal(items.length, 1);
  assert.equal((items[0] as Extract<TimelineItem, { kind: "agent_message" }>).text, "Legacy stream");
});

test("empty provider ids fail closed to contiguous legacy coalescing", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Empty ", messageId: "" }),
    ev({ kind: "agent_message", text: "identity", messageId: "" }),
  ]);
  assert.equal(items.length, 1);
  const message = items[0] as Extract<TimelineItem, { kind: "agent_message" }>;
  assert.equal(message.text, "Empty identity");
  assert.equal(message.messageId, undefined);
});

test("artifact-backed output remains a standalone preview and keeps its ordered references", () => {
  const refs = [payloadRef("chunk-1"), payloadRef("chunk-2")];
  const items = deriveTimeline([
    ev({ kind: "command_output", text: "small" }),
    ev({ kind: "command_output", text: "bounded preview", textRefs: refs }),
    ev({ kind: "command_output", text: "later" }),
  ]);
  assert.equal(items.length, 3);
  const backed = items[1] as Extract<TimelineItem, { kind: "command_output" }>;
  assert.equal(backed.text, "bounded preview");
  assert.deepEqual(backed.textRefs, refs);
});

test("tool-call projections preserve every artifact-backed text fragment", () => {
  const first = [payloadRef("tool-1")];
  const second = [payloadRef("tool-2")];
  const item = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "t1", title: "Run", status: "in_progress", text: "preview one", textRefs: first }),
    ev({ kind: "tool_call_update", toolCallId: "t1", status: "completed", text: "preview two", textRefs: second }),
  ])[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.equal(item.text, "preview one\npreview two");
  assert.deepEqual(item.referencedText, [
    { preview: "preview one", refs: first },
    { preview: "preview two", refs: second },
  ]);
});

test("file-edit projections replace preview references together and surface referenced diffs in the side pane", () => {
  const first = [payloadRef("diff-1", "text/x-diff")];
  const second = [payloadRef("diff-2", "text/x-diff")];
  const items = deriveTimeline([
    ev({ kind: "file_edit", path: "src/a.ts", diff: "preview one", diffRefs: first }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "preview two", diffRefs: second }),
  ]);
  const edit = items[0] as Extract<TimelineItem, { kind: "file_edit" }>;
  assert.equal(edit.diff, "preview two");
  assert.deepEqual(edit.diffRefs, second);
  assert.deepEqual(deriveSidePaneContent(items).artifacts, [{ path: "src/a.ts", hasDiff: true }]);
});

test("message timestamps and defensible top-level turn durations survive projection", () => {
  const events: SessionEvent[] = [
    { id: 10, sessionId: "s", seq: 10, ts: 1_000, payload: { kind: "user_message", text: "first" } },
    { id: 11, sessionId: "s", seq: 11, ts: 1_300, payload: { kind: "agent_message", text: "answer", final: true } },
    { id: 12, sessionId: "s", seq: 12, ts: 2_500, payload: { kind: "token_usage", inputTokens: 1, outputTokens: 1 } },
    { id: 13, sessionId: "s", seq: 13, ts: 4_000, payload: { kind: "user_message", text: "second" } },
    { id: 14, sessionId: "s", seq: 14, ts: 4_500, payload: { kind: "token_usage", inputTokens: 1, outputTokens: 1, durationMs: 320 } },
  ];
  const items = deriveTimeline(events);
  const first = items[0] as Extract<TimelineItem, { kind: "user_message" }>;
  const answer = items[1] as Extract<TimelineItem, { kind: "agent_message" }>;
  const second = items[2] as Extract<TimelineItem, { kind: "user_message" }>;
  assert.deepEqual([first.createdAt, answer.createdAt], [1_000, 1_300]);
  assert.deepEqual([first.durationMs, first.durationSource], [1_500, "observed"]);
  assert.deepEqual([second.durationMs, second.durationSource], [320, "provider"]);
});

test("missing or invalid terminal evidence never fabricates a turn duration", () => {
  const events: SessionEvent[] = [
    { id: 20, sessionId: "s", seq: 20, ts: 5_000, payload: { kind: "user_message", text: "unfinished" } },
    { id: 21, sessionId: "s", seq: 21, ts: 4_000, payload: { kind: "token_usage", inputTokens: 1, outputTokens: 1, durationMs: Number.NaN } },
  ];
  const item = deriveTimeline(events)[0] as Extract<TimelineItem, { kind: "user_message" }>;
  assert.equal(item.durationMs, undefined);
  assert.equal(item.durationSource, undefined);
});

test("final (whole-message) events stay as separate bubbles — no run-on", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "First message.", final: true }),
    ev({ kind: "agent_message", text: "Second message.", final: true }),
  ]);
  assert.equal(items.length, 2);
  assert.equal((items[0] as { text: string }).text, "First message.");
  assert.equal((items[1] as { text: string }).text, "Second message.");
});

test("a final message does not absorb following live chunks", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "Done.", final: true }),
    ev({ kind: "agent_message", text: "Next" }),
    ev({ kind: "agent_message", text: "chunk" }),
  ]);
  assert.equal(items.length, 2);
  assert.equal((items[0] as { text: string }).text, "Done.");
  assert.equal((items[1] as { text: string }).text, "Nextchunk");
});

test("tool_call + tool_call_update still group by id (regression)", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "t1", title: "ls", status: "pending" }),
    ev({ kind: "tool_call_update", toolCallId: "t1", status: "completed", text: "out" }),
  ]);
  assert.equal(items.length, 1);
  const tc = items[0] as { kind: string; status: string; text: string };
  assert.equal(tc.kind, "tool_call");
  assert.equal(tc.status, "completed");
  assert.equal(tc.text, "out");
});

test("live, imported, and backfilled tool events share envelope timing semantics", () => {
  const streams: SessionEvent[][] = [
    [
      { id: 31, sessionId: "live", seq: 1, ts: 1_000, payload: { kind: "tool_call", toolCallId: "live", title: "Live", status: "running" } },
      { id: 32, sessionId: "live", seq: 2, ts: 4_000, payload: { kind: "tool_call_update", toolCallId: "live", status: "completed" } },
    ],
    [
      { id: 41, sessionId: "imported", seq: 1, ts: 2_000, payload: { kind: "tool_call", toolCallId: "imported", title: "Imported", status: "completed" } },
    ],
    [
      { id: 51, sessionId: "backfill", seq: 1, ts: 3_000, payload: { kind: "tool_call_update", toolCallId: "backfill", title: "Backfilled", status: "completed" } },
    ],
  ];
  const [live, imported, backfilled] = streams.map((events) => deriveTimeline(events)[0] as Extract<TimelineItem, { kind: "tool_call" }>);
  assert.deepEqual([live.startedAt, live.lastActivityAt, live.completedAt], [1_000, 4_000, 4_000]);
  assert.deepEqual([imported.startedAt, imported.lastActivityAt, imported.completedAt], [2_000, 2_000, 2_000]);
  assert.deepEqual([backfilled.startedAt, backfilled.lastActivityAt, backfilled.completedAt], [3_000, 3_000, 3_000]);
});

test("out-of-order envelope clocks never move displayed activity or completion before the start", () => {
  const message = deriveTimeline([
    { id: 61, sessionId: "clock", seq: 1, ts: 5_000, payload: { kind: "agent_message", text: "partial", messageId: "m" } },
    { id: 62, sessionId: "clock", seq: 2, ts: 4_000, payload: { kind: "agent_message", text: "complete", messageId: "m", final: true } },
  ])[0] as Extract<TimelineItem, { kind: "agent_message" }>;
  assert.deepEqual([message.createdAt, message.lastActivityAt, message.completedAt], [5_000, 5_000, 5_000]);

  const tool = deriveTimeline([
    { id: 63, sessionId: "clock", seq: 3, ts: 5_000, payload: { kind: "tool_call", toolCallId: "t", title: "Tool", status: "running" } },
    { id: 64, sessionId: "clock", seq: 4, ts: 4_000, payload: { kind: "tool_call_update", toolCallId: "t", status: "completed" } },
  ])[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.deepEqual([tool.startedAt, tool.lastActivityAt, tool.completedAt], [5_000, 5_000, 5_000]);
});

test("an authoritative nonterminal tool event reopens an out-of-order terminal placeholder", () => {
  const item = deriveTimeline([
    ev({ kind: "tool_call_update", toolCallId: "late", title: "Late", status: "completed" }),
    ev({ kind: "tool_call", toolCallId: "late", title: "Late", status: "running" }),
  ])[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.equal(item.status, "running");
  assert.equal(item.completedAt, undefined);
  assert.equal(item.lastActivityAt, item.id + 1);
});

test("stream start + authoritative tool call upsert by id instead of duplicating a row", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "pending", parentToolUseId: "outer" }),
    ev({ kind: "tool_call", toolCallId: "task", title: "Task: inspect", toolKind: "agent", status: "in_progress", text: "details", parentToolUseId: "outer" }),
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    kind: "tool_call",
    id: items[0]!.id,
    toolCallId: "task",
    title: "Task: inspect",
    toolKind: "agent",
    status: "in_progress",
    text: "details",
    parentToolUseId: "outer",
    startedAt: (items[0] as Extract<TimelineItem, { kind: "tool_call" }>).startedAt,
    lastActivityAt: (items[0] as Extract<TimelineItem, { kind: "tool_call" }>).lastActivityAt,
    subagentRollup: undefined,
  });
});

test("groupTimeline folds reasoning + tool calls into a work block, messages stay standalone", () => {
  const items = deriveTimeline([
    ev({ kind: "user_message", text: "go" }),
    ev({ kind: "agent_thought", text: "thinking", final: true }),
    ev({ kind: "tool_call", toolCallId: "t1", title: "ls", status: "completed" }),
    ev({ kind: "agent_message", text: "the answer", final: true }),
  ]);
  const groups = groupTimeline(items);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ["item", "work", "item"],
  );
  const work = groups[1];
  if (work.kind !== "work") throw new Error("expected a work block");
  assert.equal(work.items.length, 2); // reasoning + tool call
  const u = groups[0];
  const a = groups[2];
  if (u.kind !== "item" || a.kind !== "item") throw new Error("expected standalone items");
  assert.equal(u.item.kind, "user_message");
  assert.equal(a.item.kind, "agent_message"); // final answer stays out of the block
});

test("deriveSidePaneContent: empty stream is empty", () => {
  const c = deriveSidePaneContent(deriveTimeline([]));
  assert.equal(c.isEmpty, true);
  assert.deepEqual(c.plan, []);
});

test("deriveSidePaneContent: plan + artifacts (deduped by path) + tools, reflecting timeline updates", () => {
  const items = deriveTimeline([
    ev({ kind: "user_message", text: "go" }),
    ev({ kind: "plan", entries: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }),
    ev({ kind: "tool_call", toolCallId: "t1", title: "Edit a.ts", status: "in_progress" }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "@@ -1 +1 @@" }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "@@ -2 +2 @@" }), // same path → deduped upstream
    ev({ kind: "file_edit", path: "src/b.ts" }), // no diff
    ev({ kind: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ev({ kind: "agent_message", text: "done", final: true }),
  ]);
  const c = deriveSidePaneContent(items);
  assert.equal(c.isEmpty, false);
  assert.deepEqual(c.plan.map((e) => e.status), ["completed", "in_progress"]);
  assert.deepEqual(c.artifacts, [
    { path: "src/a.ts", hasDiff: true },
    { path: "src/b.ts", hasDiff: false },
  ]);
  assert.equal(c.tools.length, 1);
  assert.deepEqual(c.tools[0], { toolCallId: "t1", title: "Edit a.ts", status: "completed" }); // update applied
});

test("per-turn worktree diffs stay distinct (no path dedupe for the synthetic capture)", () => {
  const items = deriveTimeline([
    ev({ kind: "file_edit", path: "worktree", diff: "diff turn 1" }),
    ev({ kind: "file_edit", path: "worktree", diff: "diff turn 2" }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "v1" }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "v2" }),
  ]);
  const edits = items.filter((i) => i.kind === "file_edit");
  assert.equal(edits.length, 3, "two worktree deltas + one coalesced per-file edit");
  assert.deepEqual(
    edits.map((e) => (e as { diff?: string }).diff),
    ["diff turn 1", "diff turn 2", "v2"],
  );
});

test("side pane collapses per-turn worktree deltas into one Files entry", () => {
  const items = deriveTimeline([
    ev({ kind: "file_edit", path: "worktree", diff: "turn 1" }),
    ev({ kind: "file_edit", path: "worktree", diff: "turn 2" }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "v1" }),
  ]);
  const pane = deriveSidePaneContent(items);
  assert.equal(pane.artifacts.length, 2, "one collapsed worktree entry + one real file");
  assert.deepEqual(
    pane.artifacts.map((a) => a.path).sort(),
    ["src/a.ts", "worktree"],
  );
});

test("question_request renders a question item; question_resolved marks it answered", () => {
  const items = deriveTimeline([
    ev({
      kind: "question_request",
      requestId: "q1",
      questions: [{ id: "Which?", question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
    }),
    ev({ kind: "question_resolved", requestId: "q1", answered: true }),
  ]);
  assert.equal(items.length, 1);
  const q = items[0] as Extract<import("./timeline.js").TimelineItem, { kind: "question" }>;
  assert.equal(q.kind, "question");
  assert.equal(q.answered, true);
});

test("permission context rides into the timeline item", () => {
  const items = deriveTimeline([
    ev({
      kind: "permission_request",
      requestId: "p1",
      title: "Bash: rm -rf build",
      options: [{ optionId: "allow", name: "Allow" }],
      context: { toolName: "Bash", input: "rm -rf build" },
    }),
  ]);
  const p = items[0] as Extract<import("./timeline.js").TimelineItem, { kind: "permission" }>;
  assert.equal(p.context?.input, "rm -rf build");
});

test("review_decision renders as a standalone visible timeline item", () => {
  const items = deriveTimeline([
    ev({
      kind: "review_decision",
      reviewId: "review-1",
      reviewer: { kind: "agent", id: "codex-guardian" },
      outcome: "allowed",
      riskLevel: "low",
      rationale: "read-only operation",
    }),
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    kind: "review_decision",
    id: items[0]!.id,
    reviewId: "review-1",
    reviewer: { kind: "agent", id: "codex-guardian" },
    outcome: "allowed",
    riskLevel: "low",
    rationale: "read-only operation",
  });
  assert.equal(groupTimeline(items)[0]!.kind, "item");
});

test("checkpoint + checkpoint_restored render as standalone divider items", () => {
  const items = deriveTimeline([
    ev({ kind: "checkpoint", turn: 1, tree: "abc" }),
    ev({ kind: "agent_message", text: "working…" }),
    ev({ kind: "checkpoint_restored", turn: 1 }),
  ]);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["checkpoint", "agent_message", "checkpoint_restored"],
  );
  const groups = groupTimeline(items);
  assert.ok(groups.every((g) => g.kind === "item" || !g.items.some((i) => i.kind === "checkpoint")),
    "checkpoints never fold into Worked blocks");
});

test("conversation fork points and provenance render as standalone timeline items", () => {
  const items = deriveTimeline([
    ev({ kind: "conversation_checkpoint", turn: 2 }),
    ev({ kind: "conversation_forked", sourceSessionId: "s_source", turn: 2 }),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["conversation_checkpoint", "conversation_forked"]);
  assert.ok(groupTimeline(items).every((group) => group.kind === "item"));
});

test("only a matching completed provider checkpoint makes a user message edit-addressable", () => {
  const items = deriveTimeline([
    ev({ kind: "user_message", text: "completed one" }),
    ev({ kind: "conversation_checkpoint", turn: 1 }),
    ev({ kind: "user_message", text: "cancelled two" }),
    ev({ kind: "error", message: "cancelled" }),
    ev({ kind: "user_message", text: "completed three" }),
    ev({ kind: "conversation_checkpoint", turn: 3 }),
  ]);
  const users = items.filter((item): item is Extract<TimelineItem, { kind: "user_message" }> => item.kind === "user_message");
  assert.deepEqual(users.map((item) => [item.text, item.turn]), [
    ["completed one", 1],
    ["cancelled two", undefined],
    ["completed three", 3],
  ]);
});

test("nestSubagents: a subagent's items nest under the Task tool call that spawned them", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "task1", title: "Task: explore", status: "in_progress" }),
    ev({ kind: "agent_message", text: "looking around", parentToolUseId: "task1" }),
    ev({ kind: "tool_call", toolCallId: "grep1", title: "Grep", status: "in_progress", parentToolUseId: "task1" }),
    ev({ kind: "tool_call_update", toolCallId: "grep1", status: "completed", parentToolUseId: "task1" }),
    ev({ kind: "agent_message", text: "done exploring" }), // top-level, after the subagent
  ]);
  const nested = nestSubagents(items);
  // Top level: the Task call + the trailing top-level message. The subagent items are gone from
  // the top level and live under the Task call's children.
  assert.deepEqual(nested.map((i) => i.kind), ["tool_call", "agent_message"]);
  const task = nested[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.equal(task.toolCallId, "task1");
  assert.equal(task.children?.length, 2, "message + the (merged) grep call");
  assert.deepEqual(task.children?.map((c) => c.kind), ["agent_message", "tool_call"]);
  assert.equal((nested[1] as { text: string }).text, "done exploring");
});

test("nestSubagents: no-op (same array identity) when nothing claims a parent", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "t1", title: "Grep", status: "completed" }),
    ev({ kind: "agent_message", text: "hi" }),
  ]);
  assert.equal(nestSubagents(items), items, "returns the same array when there are no subagents");
});

test("nestSubagents: an orphan child (parent not present) stays at the top level", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "orphaned child", parentToolUseId: "missing-task" }),
  ]);
  const nested = nestSubagents(items);
  assert.equal(nested.length, 1);
  assert.equal(nested[0]!.kind, "agent_message");
});

test("nestSubagents: two subagents keep their own children (no cross-contamination)", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "A", title: "Task A", status: "in_progress" }),
    ev({ kind: "tool_call", toolCallId: "B", title: "Task B", status: "in_progress" }),
    ev({ kind: "agent_thought", text: "A thinks", parentToolUseId: "A" }),
    ev({ kind: "agent_thought", text: "B thinks", parentToolUseId: "B" }),
  ]);
  const nested = nestSubagents(items);
  assert.equal(nested.length, 2);
  const a = nested.find((i) => i.kind === "tool_call" && i.toolCallId === "A") as Extract<TimelineItem, { kind: "tool_call" }>;
  const b = nested.find((i) => i.kind === "tool_call" && i.toolCallId === "B") as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.equal((a.children?.[0] as { text: string }).text, "A thinks");
  assert.equal((b.children?.[0] as { text: string }).text, "B thinks");
});

test("nestSubagents: recursively nests an agent task spawned by another agent", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "outer", title: "Task: outer", toolKind: "agent", status: "in_progress" }),
    ev({ kind: "tool_call", toolCallId: "inner", title: "Task: inner", toolKind: "agent", status: "in_progress", parentToolUseId: "outer" }),
    ev({ kind: "agent_message", text: "deep result", parentToolUseId: "inner" }),
  ]);
  const nested = nestSubagents(items);
  assert.equal(nested.length, 1);
  const outer = nested[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  const inner = outer.children?.[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.equal(inner.toolCallId, "inner");
  assert.equal((inner.children?.[0] as { text: string }).text, "deep result");
});

test("nestSubagents: resolves a parent that appears later in a backfilled transcript", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "historical child", parentToolUseId: "task" }),
    ev({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "completed" }),
  ]);
  const nested = nestSubagents(items);
  assert.equal(nested.length, 1);
  assert.equal(((nested[0] as Extract<TimelineItem, { kind: "tool_call" }>).children?.[0] as { text: string }).text, "historical child");
});

test("nestSubagents: cyclic, self-parented, and duplicate-parent input remains visible and finite", () => {
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "A", title: "A", text: "", status: "in_progress", parentToolUseId: "B" },
    { kind: "tool_call", id: 2, toolCallId: "B", title: "B", text: "", status: "in_progress", parentToolUseId: "A" },
    { kind: "tool_call", id: 3, toolCallId: "self", title: "self", text: "", status: "in_progress", parentToolUseId: "self" },
    { kind: "tool_call", id: 4, toolCallId: "dup", title: "dup 1", text: "", status: "completed" },
    { kind: "tool_call", id: 5, toolCallId: "dup", title: "dup 2", text: "", status: "completed" },
    { kind: "agent_message", id: 6, text: "ambiguous", parentToolUseId: "dup" },
  ];
  const nested = nestSubagents(items);
  assert.equal(nested.length, items.length, "bad parent graphs stay flat instead of dropping items");
  assert.ok(nested.every((item) => item.kind !== "tool_call" || !item.children));
});

test("SubagentTreeProjector preserves old subtree identity across unrelated stream deltas", () => {
  const projector = new SubagentTreeProjector();
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "in_progress" }),
    ev({ kind: "agent_message", text: "child", parentToolUseId: "task" }),
  ]);
  const first = projector.project(items);
  const second = projector.project([...items, { kind: "agent_message", id: 999_999, text: "unrelated top-level delta" }]);
  assert.equal(second[0], first[0], "the unchanged parent and children array are structurally shared");
  assert.equal(
    (second[0] as Extract<TimelineItem, { kind: "tool_call" }>).children,
    (first[0] as Extract<TimelineItem, { kind: "tool_call" }>).children,
  );
});

test("SubagentTreeProjector invalidates only a changed deep ancestry branch", () => {
  const projector = new SubagentTreeProjector();
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "A", title: "A", text: "", status: "in_progress" },
    { kind: "tool_call", id: 2, toolCallId: "A-inner", title: "A inner", text: "", status: "in_progress", parentToolUseId: "A" },
    { kind: "agent_message", id: 3, text: "old", parentToolUseId: "A-inner" },
    { kind: "tool_call", id: 4, toolCallId: "B", title: "B", text: "", status: "in_progress" },
    { kind: "agent_message", id: 5, text: "stable", parentToolUseId: "B" },
  ];
  const first = projector.project(items);
  const updated = [...items];
  updated[2] = { ...updated[2] as Extract<TimelineItem, { kind: "agent_message" }>, text: "new" };
  const second = projector.project(updated);
  assert.notEqual(second[0], first[0], "the changed deep child's outer ancestor is cloned");
  assert.equal(second[1], first[1], "the unrelated sibling subtree preserves identity");
});

test("builder adds attributed token and duration rollups to the spawning agent task", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "in_progress" }),
    ev({ kind: "token_usage", inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, costUsd: 0.02, durationMs: 1250, parentToolUseId: "task" }),
    ev({ kind: "tool_call_update", toolCallId: "task", status: "completed" }),
  ]);
  const task = items[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.deepEqual(task.subagentRollup, { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, costUsd: 0.02, durationMs: 1250 });
});

test("builder retains an out-of-order historical rollup until its parent task appears", () => {
  const items = deriveTimeline([
    ev({ kind: "token_usage", inputTokens: 8, outputTokens: 3, parentToolUseId: "late-task" }),
    ev({ kind: "tool_call", toolCallId: "late-task", title: "Task", toolKind: "agent", status: "completed" }),
  ]);
  const task = items[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.deepEqual(task.subagentRollup, { inputTokens: 8, outputTokens: 3 });
});

test("builder drains a pending rollup when an orphan tool update materializes the parent", () => {
  const items = deriveTimeline([
    ev({ kind: "token_usage", inputTokens: 5, outputTokens: 2, parentToolUseId: "update-only-task" }),
    ev({ kind: "tool_call_update", toolCallId: "update-only-task", title: "Task", status: "completed" }),
  ]);
  const task = items[0] as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.deepEqual(task.subagentRollup, { inputTokens: 5, outputTokens: 2 });
});

test("subagent agent_message chunks coalesce only within the same parent", () => {
  const items = deriveTimeline([
    ev({ kind: "agent_message", text: "top " }),
    ev({ kind: "agent_message", text: "level", parentToolUseId: undefined }),
    ev({ kind: "agent_message", text: "sub1 ", parentToolUseId: "task1" }),
    ev({ kind: "agent_message", text: "sub2", parentToolUseId: "task1" }),
  ]);
  // The two top-level chunks merge; the two subagent chunks merge; but a top→sub switch does not.
  assert.equal(items.length, 2);
  assert.equal((items[0] as { text: string }).text, "top level");
  assert.equal((items[1] as { text: string }).text, "sub1 sub2");
  assert.equal((items[1] as { parentToolUseId?: string }).parentToolUseId, "task1");
});

test("builder: a subagent file_edit of the same path stays distinct from the top-level one", () => {
  const items = deriveTimeline([
    ev({ kind: "file_edit", path: "src/a.ts" }), // top-level, no diff
    ev({ kind: "tool_call", toolCallId: "task1", title: "Task", status: "in_progress" }), // the parent
    ev({ kind: "file_edit", path: "src/a.ts", parentToolUseId: "task1" }), // subagent, same path
  ]);
  // Two distinct rows — the subagent edit is NOT swallowed by the top-level's path dedupe.
  const edits = items.filter((i) => i.kind === "file_edit") as Extract<TimelineItem, { kind: "file_edit" }>[];
  assert.equal(edits.length, 2);
  assert.equal(edits[0]!.parentToolUseId, undefined);
  assert.equal(edits[1]!.parentToolUseId, "task1");
  // ...and after nesting, the subagent's edit sits under its Task call, not top-level.
  const nested = nestSubagents(items);
  assert.equal(nested.filter((i) => i.kind === "file_edit").length, 1, "only the top-level edit stays top-level");
  const task = nested.find((i) => i.kind === "tool_call") as Extract<TimelineItem, { kind: "tool_call" }>;
  assert.equal(task.children?.length, 1, "the subagent edit nests under the Task call");
});

test("builder: progressive edits to one file WITHIN a parent still coalesce", () => {
  const items = deriveTimeline([
    ev({ kind: "file_edit", path: "src/a.ts", parentToolUseId: "task1" }),
    ev({ kind: "file_edit", path: "src/a.ts", diff: "@@ later @@", parentToolUseId: "task1" }),
  ]);
  const edits = items.filter((i) => i.kind === "file_edit") as Extract<TimelineItem, { kind: "file_edit" }>[];
  assert.equal(edits.length, 1, "same (parent, path) coalesces");
  assert.equal(edits[0]!.diff, "@@ later @@");
});

test("builder: a subagent plan does not overwrite the top-level plan (one plan per parent)", () => {
  const items = deriveTimeline([
    ev({ kind: "plan", entries: [{ content: "top task", status: "pending" }] }),
    ev({ kind: "plan", entries: [{ content: "sub task", status: "in_progress" }], parentToolUseId: "task1" }),
    ev({ kind: "plan", entries: [{ content: "top task", status: "completed" }] }), // update top-level
  ]);
  const plans = items.filter((i) => i.kind === "plan") as Extract<TimelineItem, { kind: "plan" }>[];
  assert.equal(plans.length, 2, "top-level and subagent plans are distinct");
  const top = plans.find((p) => p.parentToolUseId === undefined)!;
  const sub = plans.find((p) => p.parentToolUseId === "task1")!;
  assert.equal(top.entries[0]!.status, "completed", "the top-level plan updated in place");
  assert.equal(sub.entries[0]!.content, "sub task", "the subagent plan is untouched");
});

test("nestSubagents does not mutate its input array or items", () => {
  const items = deriveTimeline([
    ev({ kind: "tool_call", toolCallId: "task1", title: "Task", status: "in_progress" }),
    ev({ kind: "agent_message", text: "child", parentToolUseId: "task1" }),
  ]);
  const snapshotBefore = items.map((i) => ({ ...i }));
  const parentBefore = items[0];
  nestSubagents(items);
  // The input array's items keep their identity + shape; the parent isn't given children in place.
  assert.equal(items[0], parentBefore);
  assert.equal((items[0] as Extract<TimelineItem, { kind: "tool_call" }>).children, undefined);
  assert.deepEqual(items.map((i) => ({ ...i })), snapshotBefore);
});

test("deriveSidePaneContent: the side pane shows the TOP-LEVEL plan, not a subagent's", () => {
  // Subagent plans first, top-level plan arrives later — the pane must show the top-level one.
  const sub = deriveSidePaneContent(
    deriveTimeline([
      ev({ kind: "plan", entries: [{ content: "sub work", status: "in_progress" }], parentToolUseId: "task1" }),
      ev({ kind: "plan", entries: [{ content: "top work", status: "pending" }] }),
    ]),
  );
  assert.equal(sub.plan[0]!.content, "top work");

  // A subagent-only turn (no top-level plan) still surfaces the subagent's plan rather than nothing.
  const only = deriveSidePaneContent(
    deriveTimeline([ev({ kind: "plan", entries: [{ content: "sub only", status: "pending" }], parentToolUseId: "task1" })]),
  );
  assert.equal(only.plan[0]!.content, "sub only");
});
