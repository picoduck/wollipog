import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSubagentDescriptors,
  deriveSubagentLifecycle,
  filterSubagentTimeline,
  IncrementalSubagentProjector,
  selectedSubagentId,
  subagentTokenTotal,
} from "./subagents.js";
import {
  publishTimelineSnapshotDelta,
  TimelineBuilder,
  timelineSnapshotDelta,
  type TimelineItem,
} from "./timeline.js";
import { IncrementalTimelineRows } from "./components/EventTimeline.js";
import type { SessionEvent, SessionEventPayload } from "@wollipog/protocol";

const context = {
  sessionStatus: "running" as const,
  runnerOnline: true,
  availability: "live" as const,
};

test("subagent lifecycle uses only observable tool, session, and reachability state", () => {
  assert.equal(deriveSubagentLifecycle("pending", "running", true), "starting");
  assert.equal(deriveSubagentLifecycle("in_progress", "input_required", true), "running");
  assert.equal(deriveSubagentLifecycle("completed", "failed", false), "completed", "terminal tool truth wins");
  assert.equal(deriveSubagentLifecycle("failed", "running", true), "failed");
  assert.equal(deriveSubagentLifecycle("cancelled", "running", true), "interrupted");
  assert.equal(deriveSubagentLifecycle("in_progress", "stopped", true), "interrupted");
  assert.equal(deriveSubagentLifecycle("in_progress", "failed", true), "unreachable");
  assert.equal(deriveSubagentLifecycle("in_progress", "running", false), "unreachable");
  assert.equal(deriveSubagentLifecycle("provider_new_state", "running", true), "unknown");
  assert.equal(
    deriveSubagentLifecycle("running", "idle", true, "running"),
    "running",
    "provider-observed detached lifecycle remains active after the foreground turn becomes idle",
  );
  assert.equal(deriveSubagentLifecycle("running", "idle", false, "running"), "unreachable");
  assert.equal(deriveSubagentLifecycle("running", "stopped", true, "running"), "interrupted");
  assert.equal(deriveSubagentLifecycle("running", "completed", true, "running"), "interrupted");
  assert.equal(deriveSubagentLifecycle("completed", "failed", false, "completed"), "completed");
});

test("descriptor projection derives nested identity, activity, direct usage, and inclusive usage", () => {
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "outer", title: "Agent: Audit Storage", text: "", toolKind: "agent", status: "in_progress", startedAt: 100, lastActivityAt: 110, subagentRollup: { inputTokens: 10, outputTokens: 2 } },
    { kind: "agent_thought", id: 2, text: "looking", parentToolUseId: "outer", createdAt: 120, lastActivityAt: 130 },
    { kind: "tool_call", id: 3, toolCallId: "inner", title: "Agent: Inspect Parser", text: "", toolKind: "agent", status: "completed", parentToolUseId: "outer", startedAt: 140, completedAt: 160, subagentRollup: { inputTokens: 4, outputTokens: 1 } },
    { kind: "agent_message", id: 4, text: "found it", parentToolUseId: "inner", createdAt: 150, completedAt: 170 },
    { kind: "agent_message", id: 5, text: "top level", createdAt: 180 },
  ];
  const descriptors = deriveSubagentDescriptors(items, context);
  assert.deepEqual(descriptors.map(({ id, parentId, depth, lifecycle }) => ({ id, parentId, depth, lifecycle })), [
    { id: "outer", parentId: undefined, depth: 0, lifecycle: "running" },
    { id: "inner", parentId: "outer", depth: 1, lifecycle: "completed" },
  ]);
  assert.equal(descriptors[0]!.lastActivityAt, 170, "nested activity advances the parent descriptor");
  assert.equal(subagentTokenTotal(descriptors[0]!.directUsage), 12);
  assert.equal(subagentTokenTotal(descriptors[0]!.inclusiveUsage), 17);
  assert.equal(descriptors[1]!.lastActivityAt, 170);
});

test("replayed App Server events retain selectable durable subagent output", () => {
  const builder = new TimelineBuilder();
  const events: SessionEventPayload[] = [
    {
      kind: "tool_call",
      toolCallId: "codex-child",
      title: "Agent: Inspect Background Work",
      toolKind: "agent",
      status: "completed",
      subagentLifecycle: "completed",
    },
    { kind: "agent_message", text: "Durable child result", final: true, parentToolUseId: "codex-child" },
  ];
  events.forEach((payload, index) => builder.push({
    id: index + 1,
    sessionId: "codex-resumed",
    seq: index + 1,
    ts: 100 + index,
    payload,
  }));
  const recorded = {
    sessionStatus: "idle" as const,
    runnerOnline: false,
    availability: "recorded" as const,
  };
  const projector = new IncrementalSubagentProjector();
  const projection = projector.project(builder.snapshot(), recorded);
  assert.deepEqual(projection.descriptors.map(({ id, lifecycle, availability }) => ({ id, lifecycle, availability })), [
    { id: "codex-child", lifecycle: "completed", availability: "recorded" },
  ]);
  assert.equal((projector.timeline("codex-child")[0] as { text: string }).text, "Durable child result");
});

test("referenced legacy task tools remain visible while duplicate and cyclic ownership stays finite", () => {
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "legacy", title: "Task", text: "", status: "completed" },
    { kind: "agent_message", id: 2, text: "legacy child", parentToolUseId: "legacy" },
    { kind: "tool_call", id: 3, toolCallId: "A", title: "A", text: "", toolKind: "agent", status: "completed", parentToolUseId: "B" },
    { kind: "tool_call", id: 4, toolCallId: "B", title: "B", text: "", toolKind: "agent", status: "completed", parentToolUseId: "A" },
    { kind: "tool_call", id: 5, toolCallId: "dup", title: "First", text: "", toolKind: "agent", status: "completed" },
    { kind: "tool_call", id: 6, toolCallId: "dup", title: "Second", text: "", toolKind: "agent", status: "completed" },
  ];
  const descriptors = deriveSubagentDescriptors(items, context);
  assert.deepEqual(descriptors.map(({ id, depth }) => ({ id, depth })), [
    { id: "legacy", depth: 0 },
    { id: "A", depth: 0 },
    { id: "B", depth: 0 },
  ]);
  assert.equal(descriptors[0]!.title, "Agent", "generic provider tool names use a stable product label");
});

test("selected output contains the selected subtree and excludes parent and sibling work", () => {
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "outer", title: "Outer", text: "", toolKind: "agent", status: "completed" },
    { kind: "agent_message", id: 2, text: "outer output", parentToolUseId: "outer" },
    { kind: "tool_call", id: 3, toolCallId: "inner", title: "Inner", text: "", toolKind: "agent", status: "completed", parentToolUseId: "outer" },
    { kind: "agent_message", id: 4, text: "inner output", parentToolUseId: "inner" },
    { kind: "tool_call", id: 5, toolCallId: "sibling", title: "Sibling", text: "", toolKind: "agent", status: "completed" },
    { kind: "agent_message", id: 6, text: "sibling output", parentToolUseId: "sibling" },
    { kind: "agent_message", id: 7, text: "parent output" },
  ];
  const descriptors = deriveSubagentDescriptors(items, context);
  assert.deepEqual(filterSubagentTimeline(items, descriptors, "outer").map((item) => item.id), [2, 3, 4]);
  assert.deepEqual(filterSubagentTimeline(items, descriptors, "inner").map((item) => item.id), [4]);
});

test("selection retains a valid request, then prefers active, failed, and recent recorded work", () => {
  const base = (id: string, status: string, at: number): TimelineItem =>
    ({ kind: "tool_call", id: at, toolCallId: id, title: id, text: "", toolKind: "agent", status, startedAt: at });
  const descriptors = deriveSubagentDescriptors([
    base("old-complete", "completed", 10),
    base("failed", "failed", 20),
    base("active", "in_progress", 30),
  ], context);
  assert.equal(selectedSubagentId(descriptors, "old-complete"), "old-complete");
  assert.equal(selectedSubagentId(descriptors, "missing"), null, "an invalid explicit request never falls through");
  assert.equal(selectedSubagentId(descriptors, null, "old-complete"), "old-complete",
    "an automatic selection remains stable while a newer active agent changes");
  const terminal = deriveSubagentDescriptors([base("complete", "completed", 10), base("failed", "failed", 20)], context);
  assert.equal(selectedSubagentId(terminal), "failed");
  const completed = deriveSubagentDescriptors([base("old", "completed", 10), base("new", "completed", 20)], context);
  assert.equal(selectedSubagentId(completed), "new");
});

test("incremental projection inspects only changed timeline slots and preserves unrelated output", () => {
  let sequence = 0;
  const event = (payload: SessionEventPayload): SessionEvent => {
    sequence += 1;
    return { id: sequence, sessionId: "session", seq: sequence, ts: sequence, payload };
  };
  const builder = new TimelineBuilder();
  const projector = new IncrementalSubagentProjector();
  builder.push(event({
    kind: "tool_call",
    toolCallId: "agent",
    title: "Agent",
    toolKind: "agent",
    status: "in_progress",
  }));
  builder.push(event({ kind: "agent_message", text: "first", parentToolUseId: "agent" }));
  const initial = projector.project(builder.snapshot(), context);
  const initialOutput = projector.timeline("agent");
  assert.equal(initial.processedItems, 2);

  builder.push(event({ kind: "agent_message", text: " second", parentToolUseId: "agent" }));
  const streamed = projector.project(builder.snapshot(), context);
  const streamedOutput = projector.timeline("agent");
  assert.equal(streamed.incremental, true);
  assert.equal(streamed.processedItems, 1, "a coalesced streamed chunk touches only its changed slot");
  assert.equal((streamedOutput[0] as { text: string }).text, "first second");

  builder.push(event({ kind: "agent_message", text: "top level" }));
  const unrelated = projector.project(builder.snapshot(), context);
  const unchangedOutput = projector.timeline("agent");
  assert.equal(unrelated.processedItems, 1, "an append never rescans prior transcript items");
  assert.equal(unchangedOutput, streamedOutput, "unrelated appends preserve the selected output projection");
  assert.notEqual(initialOutput, streamedOutput, "a selected streamed update replaces only its output generation");
});

test("descriptor assembly inspects only agent and output-owner ids", () => {
  const root = {
    kind: "tool_call", id: 1, toolCallId: "agent", title: "Agent", text: "",
    toolKind: "agent", status: "in_progress",
  } as TimelineItem;
  const unrelated = Array.from({ length: 500 }, (_, index) => ({
    kind: "tool_call" as const,
    id: index + 2,
    toolCallId: `unrelated-${index}`,
    title: "Read",
    text: "",
    toolKind: "read",
    status: "completed",
  } as TimelineItem));
  const output = {
    kind: "agent_message", id: 502, text: "working", parentToolUseId: "agent",
  } as TimelineItem;
  const projector = new IncrementalSubagentProjector();
  const projection = projector.project([root, ...unrelated, output], context);
  assert.equal(projection.descriptorCandidates, 1);
  assert.deepEqual(projection.descriptors.map(({ id }) => id), ["agent"]);
});

test("empty tool ids never become descriptors or leak unparented incremental items", () => {
  const initial: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "outer", title: "Outer", text: "", toolKind: "agent", status: "in_progress" },
    { kind: "tool_call", id: 2, toolCallId: "", title: "Malformed", text: "", toolKind: "agent", status: "in_progress", parentToolUseId: "outer" },
    { kind: "agent_message", id: 3, text: "outer child", parentToolUseId: "outer" },
    { kind: "agent_message", id: 4, text: "top level" },
  ];
  const projector = new IncrementalSubagentProjector();
  const first = projector.project(initial, context);
  assert.deepEqual(first.descriptors.map(({ id }) => id), ["outer"]);
  projector.timeline("outer");

  const next = [...initial, { kind: "agent_message", id: 5, text: "second top level" } as TimelineItem];
  publishTimelineSnapshotDelta(next, {
    previous: initial,
    dirtyFrom: initial.length,
    dirtyIndexes: [initial.length],
    dirtyHasParentItems: false,
  });
  projector.project(next, context);
  const output = projector.timeline("outer");
  assert.deepEqual(output, filterSubagentTimeline(next, projector.project(next, context).descriptors, "outer"));
  assert.doesNotMatch(output.map((item) => "text" in item ? item.text : "").join(" "), /top level/);
});

test("nested incremental output stays equivalent to the one-shot subtree filter", () => {
  const builder = new TimelineBuilder();
  const projector = new IncrementalSubagentProjector();
  let seq = 0;
  const push = (payload: SessionEventPayload) => builder.push({
    id: ++seq, sessionId: "nested", seq, ts: seq, payload,
  });
  push({ kind: "tool_call", toolCallId: "outer", title: "Outer", toolKind: "agent", status: "in_progress" });
  push({ kind: "agent_message", text: "outer", parentToolUseId: "outer" });
  push({ kind: "tool_call", toolCallId: "inner", title: "Inner", toolKind: "agent", status: "in_progress", parentToolUseId: "outer" });
  push({ kind: "agent_message", text: "inner", parentToolUseId: "inner" });
  let snapshot = builder.snapshot();
  let projection = projector.project(snapshot, context);
  assert.deepEqual(projector.timeline("outer"), filterSubagentTimeline(snapshot, projection.descriptors, "outer"));
  push({ kind: "agent_message", text: " streamed", parentToolUseId: "inner" });
  snapshot = builder.snapshot();
  projection = projector.project(snapshot, context);
  assert.equal(projection.incremental, true);
  assert.deepEqual(projector.timeline("outer"), filterSubagentTimeline(snapshot, projection.descriptors, "outer"));
  push({ kind: "tool_call", toolCallId: "deep", title: "Deep", toolKind: "agent", status: "in_progress", parentToolUseId: "inner" });
  push({ kind: "agent_message", text: "deep output", parentToolUseId: "deep" });
  snapshot = builder.snapshot();
  projection = projector.project(snapshot, context);
  assert.deepEqual(projector.timeline("outer"), filterSubagentTimeline(snapshot, projection.descriptors, "outer"),
    "a newly discovered descendant invalidates and rebuilds the selected subtree exactly");
});

test("incremental subtree projection handles removal and mid-list insertion exactly", () => {
  const root = { kind: "tool_call", id: 1, toolCallId: "outer", title: "Outer", text: "", toolKind: "agent", status: "in_progress" } as TimelineItem;
  const first = { kind: "agent_message", id: 2, text: "first", parentToolUseId: "outer" } as TimelineItem;
  const third = { kind: "agent_message", id: 4, text: "third", parentToolUseId: "outer" } as TimelineItem;
  const initial = [root, first, third];
  const projector = new IncrementalSubagentProjector();
  let projection = projector.project(initial, context);
  projector.timeline("outer");

  const removed = [root, third];
  publishTimelineSnapshotDelta(removed, {
    previous: initial, dirtyFrom: 1, dirtyIndexes: [1, 2], dirtyHasParentItems: true,
  });
  projection = projector.project(removed, context);
  assert.equal(projection.incremental, true);
  const removedOutput = projector.timeline("outer");
  assert.deepEqual(removedOutput, filterSubagentTimeline(removed, projection.descriptors, "outer"));
  assert.deepEqual(timelineSnapshotDelta(removedOutput)?.dirtyIndexes, [0, 1],
    "a shrinking filtered snapshot reports the changed row and every vacated trailing slot");

  const middle = { kind: "agent_message", id: 3, text: "middle", parentToolUseId: "outer" } as TimelineItem;
  const inserted = [root, middle, third];
  publishTimelineSnapshotDelta(inserted, {
    previous: removed, dirtyFrom: 1, dirtyIndexes: [1, 2], dirtyHasParentItems: true,
  });
  projection = projector.project(inserted, context);
  assert.equal(projection.incremental, true);
  assert.deepEqual(projector.timeline("outer"), filterSubagentTimeline(inserted, projection.descriptors, "outer"));
});

test("a skipped output revision rebuilds instead of patching a stale cache", () => {
  const root = { kind: "tool_call", id: 1, toolCallId: "agent", title: "Agent", text: "", toolKind: "agent", status: "in_progress" } as TimelineItem;
  const a1 = { kind: "agent_message", id: 2, text: "a1", parentToolUseId: "agent" } as TimelineItem;
  const b1 = { kind: "agent_thought", id: 3, text: "b1", parentToolUseId: "agent" } as TimelineItem;
  const generation1 = [root, a1, b1];
  const projector = new IncrementalSubagentProjector();
  projector.project(generation1, context);
  projector.timeline("agent");

  const a2 = { ...a1, text: "a2" };
  const generation2 = [root, a2, b1];
  publishTimelineSnapshotDelta(generation2, { previous: generation1, dirtyFrom: 1, dirtyIndexes: [1], dirtyHasParentItems: true });
  projector.project(generation2, context);

  const b2 = { ...b1, text: "b2" };
  const generation3 = [root, a2, b2];
  publishTimelineSnapshotDelta(generation3, { previous: generation2, dirtyFrom: 2, dirtyIndexes: [2], dirtyHasParentItems: true });
  projector.project(generation3, context);
  assert.deepEqual(projector.timeline("agent").map((item) => "text" in item ? item.text : ""), ["a2", "b2"]);
});

test("context-only invalidation and cross-session reuse rebuild selected output", () => {
  const sessionA: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "agent", title: "Agent A", text: "", toolKind: "agent", status: "in_progress" },
    { kind: "agent_message", id: 2, text: "session A", parentToolUseId: "agent" },
  ];
  const projector = new IncrementalSubagentProjector();
  projector.project(sessionA, context);
  const liveOutput = projector.timeline("agent");
  const offline = projector.project(sessionA, { ...context, runnerOnline: false, availability: "recorded" });
  const recordedOutput = projector.timeline("agent");
  assert.equal(offline.descriptors[0]?.availability, "recorded");
  assert.notEqual(recordedOutput, liveOutput, "context changes invalidate the selected-output cache");

  const sessionB: TimelineItem[] = [
    { kind: "tool_call", id: 10, toolCallId: "agent", title: "Agent B", text: "", toolKind: "agent", status: "completed" },
    { kind: "agent_message", id: 11, text: "session B", parentToolUseId: "agent" },
  ];
  const next = projector.project(sessionB, context);
  const nextOutput = projector.timeline("agent");
  assert.equal(next.incremental, false);
  assert.notEqual(nextOutput, recordedOutput);
  assert.deepEqual(nextOutput.map((item) => "text" in item ? item.text : ""), ["session B"]);
});

test("filtered snapshot metadata keeps downstream row projection incremental", () => {
  let sequence = 0;
  const event = (payload: SessionEventPayload): SessionEvent => ({
    id: ++sequence, sessionId: "rows", seq: sequence, ts: sequence, payload,
  });
  const builder = new TimelineBuilder();
  const subagents = new IncrementalSubagentProjector();
  const rows = new IncrementalTimelineRows();
  const disclosure = new Map<string, boolean>();
  builder.push(event({ kind: "tool_call", toolCallId: "agent", title: "Agent", toolKind: "agent", status: "in_progress" }));
  builder.push(event({ kind: "agent_message", text: "first", parentToolUseId: "agent" }));
  subagents.project(builder.snapshot(), context);
  const first = subagents.timeline("agent");
  rows.project(first, disclosure);

  builder.push(event({ kind: "agent_message", text: " second", parentToolUseId: "agent" }));
  subagents.project(builder.snapshot(), context);
  const second = subagents.timeline("agent");
  assert.equal(timelineSnapshotDelta(second)?.previous, first);
  assert.deepEqual(timelineSnapshotDelta(second)?.dirtyIndexes, [0]);
  const update = rows.project(second, disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);

  builder.push(event({
    kind: "tool_call",
    toolCallId: "child-tool",
    title: "Read",
    toolKind: "read",
    status: "in_progress",
    parentToolUseId: "agent",
  }));
  subagents.project(builder.snapshot(), context);
  const third = subagents.timeline("agent");
  assert.equal(timelineSnapshotDelta(third)?.previous, second);
  assert.equal(timelineSnapshotDelta(third)?.dirtyHasParentItems, false,
    "the intentionally omitted selected root is not reported as a resolvable parent");
  const appended = rows.project(third, disclosure);
  assert.equal(appended.incremental, true);
  assert.equal(appended.processedItems, 1);
});

test("known zero token usage remains distinct from unavailable usage", () => {
  assert.equal(subagentTokenTotal(undefined), undefined);
  assert.equal(subagentTokenTotal({}), undefined);
  assert.equal(subagentTokenTotal({ inputTokens: 0, outputTokens: 0 }), 0);
});
