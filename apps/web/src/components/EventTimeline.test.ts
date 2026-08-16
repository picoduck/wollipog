import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import type { SessionEventPayload } from "@wollipog/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { groupTimeline, SubagentTreeProjector, TimelineBuilder, type TimelineItem } from "../timeline.js";
import {
  automaticSubagentOpen,
  automaticSubagentOpenAfterChange,
  EventTimeline,
  estimateTimelineRow,
  flattenTimelineRows,
  IncrementalTimelineRows,
  stabilizeTimelineRowKeys,
  stabilizeWorkGroupKeys,
  timelineFileSourceLocation,
} from "./EventTimeline.js";
import { reanchorAtLogicalIndex } from "./MeasuredVirtualList.js";

// Vite supplies the JSX runtime in production; direct Node rendering needs the classic global
// expected by the repository's tsx test transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("timeline row estimates include timestamp header lines", () => {
  const tool = {
    kind: "tool_call" as const,
    id: 1,
    toolCallId: "tool",
    title: "Tool",
    status: "completed",
    text: "",
  };
  const thought = { kind: "agent_thought" as const, id: 2, text: "Thinking" };
  assert.equal(estimateTimelineRow({ kind: "item", key: "tool", item: tool, inWork: false, depth: 0 }), 72);
  assert.equal(estimateTimelineRow({ kind: "item", key: "thought", item: thought, inWork: true, depth: 0 }), 72);
  assert.equal(estimateTimelineRow({ kind: "subagent_summary", key: "agent", tool, depth: 0, open: false }), 52);
  assert.equal(estimateTimelineRow({ kind: "work_summary", key: "work", tools: 1, edits: 0, thoughts: 0, open: false }), 32);
});

test("semantic reveal resolution opens a collapsed work group without exposing virtual keys", () => {
  const projector = new IncrementalTimelineRows();
  projector.project([
    { kind: "tool_call", id: 17, toolCallId: "build", title: "Build", status: "running", text: "" },
  ], new Map());

  assert.deepEqual(projector.resolveRevealTarget(17), {
    rowKey: "item:tool:build",
    disclosureKeys: ["work:head"],
  });
  assert.equal(projector.resolveRevealTarget(999), null);
});

test("semantic reveal resolution opens every ancestor for a deeply nested event", () => {
  const projector = new IncrementalTimelineRows();
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "outer", title: "Outer", toolKind: "agent", status: "running", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "inner", title: "Inner", toolKind: "agent", status: "running", text: "", parentToolUseId: "outer" },
    { kind: "agent_message", id: 3, text: "Nested result", parentToolUseId: "inner" },
  ];
  projector.project(items, new Map());

  assert.deepEqual(projector.resolveRevealTarget(3), {
    rowKey: "item:agent_message:3",
    disclosureKeys: ["work:head", "agent:outer", "agent:inner"],
  });
});

test("semantic reveal targets duplicate tool ids by unique event id", () => {
  const projector = new IncrementalTimelineRows();
  projector.project([
    { kind: "tool_call", id: 4, toolCallId: "duplicate", title: "First", status: "completed", text: "" },
    { kind: "tool_call", id: 5, toolCallId: "duplicate", title: "Second", status: "running", text: "" },
  ], new Map());

  assert.equal(projector.resolveRevealTarget(4)?.rowKey, "item:tool:duplicate:4");
  assert.equal(projector.resolveRevealTarget(5)?.rowKey, "item:tool:duplicate:5");
});

test("semantic reveal identity survives streamed replacement and expires with history", () => {
  const projector = new IncrementalTimelineRows();
  const disclosure = new Map<string, boolean>();
  projector.project([
    { kind: "agent_message", id: 8, text: "stream" },
  ], disclosure);
  const first = projector.resolveRevealTarget(8);

  projector.project([
    { kind: "agent_message", id: 8, sourceEndId: 9, text: "streaming" },
  ], disclosure);
  assert.deepEqual(projector.resolveRevealTarget(8), first);

  projector.project([
    { kind: "agent_message", id: 7, sourceEndId: 9, text: "recovered prefix plus streaming" },
  ], disclosure);
  assert.equal(projector.resolveRevealTarget(7)?.rowKey, first?.rowKey,
    "backward recovery resolves through the stabilized rendered row key");

  projector.project([{ kind: "user_message", id: 10, text: "replacement history" }], disclosure);
  assert.equal(projector.resolveRevealTarget(7), null);
});

test("turn interruption renders a timestamped Interrupted outcome without error styling", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{ kind: "turn_interrupted", id: 1, createdAt: Date.UTC(2026, 7, 4, 12, 0, 0) }],
  }));
  assert.match(html, /class="tl-interrupted"/);
  assert.match(html, />Interrupted</);
  assert.match(html, /Recorded/);
  assert.doesNotMatch(html, /tl-error/);
});

test("canonical accepted steering messages render one compact Steered marker", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      {
        kind: "user_message",
        id: 1,
        text: "Canonical steering message",
        submissionId: "submission-1",
        deliveryIntent: "steer",
      },
      { kind: "user_message", id: 2, text: "Ordinary message", submissionId: "submission-2" },
      { kind: "user_message", id: 3, text: "Incomplete steering metadata", deliveryIntent: "steer" },
    ],
  }));
  assert.equal((html.match(/class="steered-marker"/g) ?? []).length, 1);
  assert.match(html, /<span class="steered-marker">Steered<\/span>/);
});

test("Claude timeline keeps historical rewind while enabling conversation fork only at latest turn", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "checkpoint", id: 1, turn: 1 },
      { kind: "conversation_checkpoint", id: 2, turn: 1 },
      { kind: "checkpoint", id: 3, turn: 2 },
      { kind: "conversation_checkpoint", id: 4, turn: 2 },
    ],
    onRewind: () => {},
    onFork: () => {},
    forkLatestOnly: true,
  }));

  assert.equal((html.match(/Rewind Files to Here/g) ?? []).length, 2);
  assert.equal((html.match(/Fork Conversation Here/g) ?? []).length, 1);
  assert.equal((html.match(/Claude Forks Latest Only/g) ?? []).length, 1);
  assert.match(html, /Claude CLI can fork only its current transcript at the matching latest-turn checkpoint\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Claude Forks Latest Only<\/button>/);
});

test("Claude timeline disables an older conversation fork after a later cancelled turn", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "checkpoint", id: 1, turn: 1 },
      { kind: "conversation_checkpoint", id: 2, turn: 1 },
      { kind: "checkpoint", id: 3, turn: 2 },
    ],
    onRewind: () => {},
    onFork: () => {},
    forkLatestOnly: true,
  }));

  assert.equal((html.match(/Rewind Files to Here/g) ?? []).length, 2);
  assert.equal((html.match(/Fork Conversation Here/g) ?? []).length, 0);
  assert.equal((html.match(/Claude Forks Latest Only/g) ?? []).length, 1);
});

test("file-edit source locations canonicalize separators and reject traversal-shaped paths", () => {
  assert.deepEqual(timelineFileSourceLocation("src\\App.tsx"), { path: "src/App.tsx" });
  assert.equal(timelineFileSourceLocation("../outside.ts"), null);
});

test("recursive agent summaries render rollups while deeper and large bodies stay lazy", () => {
  const largeChildren = Array.from({ length: 41 }, (_, index) => ({
    kind: "file_edit" as const,
    id: 100 + index,
    path: `generated-${index}.txt`,
    parentToolUseId: "large",
  }));
  const items = [
      { kind: "tool_call", id: 1, toolCallId: "outer", title: "Outer", text: "", toolKind: "agent", status: "completed", subagentRollup: { durationMs: 6100, inputTokens: 1800, outputTokens: 500 } },
      { kind: "agent_thought", id: 2, text: "outer work", parentToolUseId: "outer" },
      { kind: "tool_call", id: 3, toolCallId: "inner", title: "Inner", text: "", toolKind: "agent", status: "completed", parentToolUseId: "outer", subagentRollup: { durationMs: 4200, inputTokens: 1200, outputTokens: 340 } },
      { kind: "agent_message", id: 4, text: "deep body", parentToolUseId: "inner" },
      { kind: "tool_call", id: 5, toolCallId: "large", title: "Large", text: "", toolKind: "agent", status: "completed", subagentRollup: { durationMs: 12_500, inputTokens: 5000, outputTokens: 900 } },
      ...largeChildren,
      { kind: "tool_call", id: 200, toolCallId: "empty", title: "Empty", text: "", toolKind: "agent", status: "completed", subagentRollup: { durationMs: 500, inputTokens: 2, outputTokens: 1 } },
  ];
  const groups = groupTimeline(new SubagentTreeProjector().project(items));
  const collapsed = flattenTimelineRows(groups, new Map());
  assert.equal(collapsed.length, 1, "a closed Worked block does not mount any hidden descendants");

  const expanded = flattenTimelineRows(groups, new Map([[`work:${groups[0]!.kind === "work" ? groups[0]!.id : 0}`, true]]));
  assert.equal(expanded.filter((row) => row.kind === "subagent_summary").length, 4);
  assert.equal(expanded.filter((row) => row.kind === "subagent_summary" && row.open).length, 1, "only the small first-level subtree starts open");
  assert.equal(expanded.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "deep body"), false);
  assert.equal(expanded.some((row) => row.kind === "item" && row.item.kind === "file_edit" && row.item.path === "generated-0.txt"), false);
});

test("automatic subagent disclosure opens the first live child but keeps deep/empty/large trees lazy", () => {
  assert.equal(automaticSubagentOpen(0, 0), false, "an empty live Task does not mount an empty body");
  assert.equal(automaticSubagentOpen(0, 1), true, "the first streamed child auto-opens a first-level Task");
  assert.equal(automaticSubagentOpen(1, 1), false, "deeper agents remain lazy");
  assert.equal(automaticSubagentOpen(0, 40), true);
  assert.equal(automaticSubagentOpen(0, 41), false, "large trees remain collapsed");
  assert.equal(automaticSubagentOpenAfterChange(0, 0, 1, false, false), true, "an empty live Task opens on its first child");
  assert.equal(automaticSubagentOpenAfterChange(0, 40, 41, false, true), false, "an untouched live tree auto-collapses at the large threshold");
  assert.equal(automaticSubagentOpenAfterChange(0, 41, 42, true, true), true, "a user's disclosure choice remains sticky");
});

test("history prefix merges preserve work and coalesced text render keys", () => {
  const beforeWork = groupTimeline([
    { kind: "user_message", id: 1, text: "go" },
    { kind: "agent_thought", id: 10, sourceEndId: 10, text: "later" },
  ]);
  const afterWork = groupTimeline([
    { kind: "user_message", id: 1, text: "go" },
    { kind: "agent_thought", id: 9, sourceEndId: 10, text: "earlier later" },
  ]);
  assert.equal(beforeWork[1]!.kind, "work");
  assert.equal(afterWork[1]!.kind, "work");
  assert.equal(beforeWork[1]!.kind === "work" ? beforeWork[1]!.id : null, "user_message:1");
  assert.equal(afterWork[1]!.kind === "work" ? afterWork[1]!.id : null, "user_message:1");

  const before = flattenTimelineRows(groupTimeline([
    { kind: "agent_message", id: 10, sourceEndId: 10, text: "later" },
  ]), new Map());
  const after = flattenTimelineRows(groupTimeline([
    { kind: "agent_message", id: 9, sourceEndId: 10, text: "earlier later" },
  ]), new Map());
  assert.equal(stabilizeTimelineRowKeys(after, before)[0]!.key, before[0]!.key);

  const head = groupTimeline([{ kind: "agent_thought", id: 10, text: "work" }]);
  const recovered = stabilizeWorkGroupKeys(groupTimeline([
    { kind: "user_message", id: 9, text: "go" },
    { kind: "agent_thought", id: 10, text: "work" },
  ]), head);
  assert.equal(head[0]!.kind === "work" ? head[0]!.id : null, "head");
  assert.equal(recovered[1]!.kind === "work" ? recovered[1]!.id : null, "head");
  const openRows = flattenTimelineRows(recovered, new Map([["work:head", true]]));
  assert.equal(openRows.some((row) => row.kind === "item" && row.item.id === 10), true);
});

test("ordinary streaming updates project only the active tail row", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "scale", seq: sequence, ts: sequence, payload });
  };
  for (let index = 0; index < 4_999; index += 1) push({ kind: "user_message", text: `question ${index}` });
  push({ kind: "agent_message", text: "stream" });

  const disclosure = new Map<string, boolean>();
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  assert.equal(initial.incremental, false);
  assert.equal(initial.processedItems, 5_000);
  const untouched = initial.rows[1_000];
  const tailKey = initial.rows.at(-1)!.key;

  push({ kind: "agent_message", text: "ing" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows[1_000], untouched, "an unrelated historical row keeps object identity");
  assert.equal(update.rows.at(-1)!.key, tailKey, "the growing text row keeps its virtual key");
});

test("resumed interleaved messages update stable existing virtual rows", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "interleaved", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "agent_message", text: "A1", messageId: "a" });
  push({ kind: "agent_message", text: "B1", messageId: "b" });

  const disclosure = new Map<string, boolean>();
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  const initialKeys = initial.rows.map((row) => row.key);
  const untouchedSecondRow = initial.rows[1];

  push({ kind: "agent_message", text: "A2", messageId: "a" });
  const resumed = projector.project(builder.snapshot(), disclosure);
  assert.equal(resumed.incremental, true);
  assert.equal(resumed.processedItems, 1);
  assert.equal(resumed.rows.length, 2, "resuming a message does not add a virtualized row");
  assert.deepEqual(resumed.rows.map((row) => row.key), initialKeys, "copy controls and scroll anchors keep their row keys");
  assert.equal(resumed.rows[1], untouchedSecondRow, "the interleaved sibling row remains structurally shared");
  assert.equal(
    resumed.rows[0]?.kind === "item" && resumed.rows[0].item.kind === "agent_message"
      ? resumed.rows[0].item.text
      : null,
    "A1A2",
  );

  push({ kind: "agent_message", text: "B2", messageId: "b" });
  push({ kind: "agent_message", text: "A3", messageId: "a" });
  const batched = projector.project(builder.snapshot(), disclosure);
  assert.equal(batched.incremental, false, "multiple dirty rows take the defensive projection path");
  assert.deepEqual(
    batched.rows.map((row) => row.key),
    initialKeys,
    "batched interleaving also preserves copy controls and scroll anchors",
  );
  assert.deepEqual(
    batched.rows.map((row) => row.kind === "item" && row.item.kind === "agent_message" ? row.item.text : null),
    ["A1A2A3", "B1B2"],
  );
});

test("ambiguous duplicate tool ids retain distinct virtual keys", () => {
  const groups = groupTimeline([
    { kind: "tool_call", id: 1, toolCallId: "duplicate", title: "one", status: "completed", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "duplicate", title: "two", status: "completed", text: "" },
  ]);
  const workKey = groups[0]!.kind === "work" ? `work:${groups[0]!.id}` : "";
  const rows = flattenTimelineRows(groups, new Map([[workKey, true]]));
  const keys = rows.filter((row) => row.kind === "item").map((row) => row.key);
  assert.deepEqual(keys, ["item:tool:duplicate:1", "item:tool:duplicate:2"]);
});

test("a duplicate tool id key rewrite retains the anchored logical row", () => {
  const first = { kind: "tool_call" as const, id: 1, toolCallId: "duplicate", title: "one", status: "completed" as const, text: "" };
  const beforeGroups = groupTimeline([first]);
  const beforeWorkKey = beforeGroups[0]!.kind === "work" ? `work:${beforeGroups[0]!.id}` : "";
  const before = flattenTimelineRows(beforeGroups, new Map([[beforeWorkKey, true]]));
  const oldIndex = before.findIndex((row) => row.key === "item:tool:duplicate");
  assert.notEqual(oldIndex, -1);

  const afterGroups = groupTimeline([
    first,
    { kind: "tool_call", id: 2, toolCallId: "duplicate", title: "two", status: "completed", text: "" },
  ]);
  const afterWorkKey = afterGroups[0]!.kind === "work" ? `work:${afterGroups[0]!.id}` : "";
  const after = flattenTimelineRows(afterGroups, new Map([[afterWorkKey, true]]));
  const replacement = reanchorAtLogicalIndex(
    { key: "item:tool:duplicate", offset: -12, index: oldIndex },
    after.map((row) => row.key),
  );

  assert.deepEqual(replacement, { key: "item:tool:duplicate:1", offset: -12, index: oldIndex });
});

test("earlier subagent history does not disable later top-level tail projection", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "agents", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "completed" });
  push({ kind: "agent_message", text: "child", final: true, parentToolUseId: "task" });
  push({ kind: "user_message", text: "continue" });
  const disclosure = new Map<string, boolean>();
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  push({ kind: "agent_message", text: "top-level" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows.at(-1)!.kind, "item");
});

test("earlier resolved subagent history does not disable later top-level tool appends", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "agents-tools", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "completed" });
  push({ kind: "agent_message", text: "child", final: true, parentToolUseId: "task" });
  push({ kind: "user_message", text: "continue" });
  const disclosure = new Map<string, boolean>();
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  push({ kind: "tool_call", toolCallId: "ordinary", title: "Ordinary", status: "completed" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows.at(-1)!.kind, "work_summary");
});

test("a collapsed large work block updates counts without refolding the block", () => {
  const builder = new TimelineBuilder();
  for (let index = 1; index <= 5_000; index += 1) {
    builder.push({
      id: index,
      sessionId: "work",
      seq: index,
      ts: index,
      payload: { kind: "tool_call", toolCallId: `tool-${index}`, title: `tool ${index}`, status: "completed" },
    });
  }
  const disclosure = new Map<string, boolean>();
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  assert.equal(initial.rows.length, 1);
  assert.equal(initial.rows[0]!.kind === "work_summary" ? initial.rows[0]!.tools : 0, 5_000);
  const rows = initial.rows;

  builder.push({
    id: 5_001,
    sessionId: "work",
    seq: 5_001,
    ts: 5_001,
    payload: { kind: "tool_call", toolCallId: "tool-5001", title: "tool 5001", status: "completed" },
  });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows, rows, "the cache-owned row vector updates in place");
  assert.equal(update.rows[0]!.kind === "work_summary" ? update.rows[0]!.tools : 0, 5_001);
});

test("an active subagent text stream updates only its retained tail branch", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "child-stream", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" });
  push({ kind: "agent_message", text: "stream", parentToolUseId: "task" });

  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:task", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  const summaryKey = initial.rows.find((row) => row.kind === "subagent_summary")!.key;
  const rootRow = initial.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call")!;

  push({ kind: "agent_message", text: "ing", parentToolUseId: "task" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows.find((row) => row.kind === "subagent_summary")!.key, summaryKey);
  assert.equal(update.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call")!.key, rootRow.key);
  assert.equal(update.rows.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "streaming"), true);
});

test("a deeply nested subagent stream clones only the active ancestor chain", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "nested-stream", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "outer", title: "Outer", toolKind: "agent", status: "running" });
  push({ kind: "tool_call", toolCallId: "inner", title: "Inner", toolKind: "agent", status: "running", parentToolUseId: "outer" });
  push({ kind: "agent_message", text: "deep", parentToolUseId: "inner" });

  const disclosure = new Map<string, boolean>([
    ["work:head", true],
    ["agent:outer", true],
    ["agent:inner", true],
  ]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  const outerKey = initial.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "outer")!.key;
  const innerKey = initial.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "inner")!.key;

  push({ kind: "agent_message", text: " work", parentToolUseId: "inner" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "outer")!.key, outerKey);
  assert.equal(update.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "inner")!.key, innerKey);
  assert.equal(update.rows.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "deep work"), true);
});

test("an out-of-order root tool update retains the child it claimed after materializing", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "late-root", seq: sequence, ts: sequence, payload });
  };
  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:task", true]]);
  const projector = new IncrementalTimelineRows();
  push({ kind: "agent_message", text: "arrived first", final: true, parentToolUseId: "task" });
  projector.project(builder.snapshot(), disclosure);
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" });
  const materialized = projector.project(builder.snapshot(), disclosure);
  assert.equal(materialized.incremental, false, "claiming an older orphan uses the defensive topology pass");

  push({ kind: "tool_call_update", toolCallId: "task", status: "completed" });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, true);
  assert.equal(updated.processedItems, 1);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "arrived first"), true);
});

test("updating a final top-level tool does not delete an earlier nested root", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "root-tail", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "root", title: "Root", toolKind: "agent", status: "running" });
  push({ kind: "agent_message", text: "nested", final: true, parentToolUseId: "root" });
  push({ kind: "tool_call", toolCallId: "tail", title: "Tail", status: "running" });
  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:root", true]]);
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  push({ kind: "tool_call_update", toolCallId: "tail", status: "completed" });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, true);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "root"), true);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "nested"), true);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "tail"), true);
});

test("a nested insertion reports the exact earlier key-cache repair boundary", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "insert-boundary", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "root", title: "Root", toolKind: "agent", status: "running" });
  push({ kind: "tool_call", toolCallId: "later", title: "Later", status: "completed" });
  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:root", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  const laterKey = initial.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "later")!.key;

  push({ kind: "agent_message", text: "inserted", final: true, parentToolUseId: "root" });
  const updated = projector.project(builder.snapshot(), disclosure);
  const insertedIndex = updated.rows.findIndex((row) => row.kind === "item" && row.item.kind === "agent_message");
  assert.equal(updated.incremental, true);
  assert.equal(updated.keyDirtyFrom, insertedIndex);
  assert.equal(updated.rows[insertedIndex + 1]!.key, laterKey, "the later row shifts but retains identity");
});

test("the first appended child auto-opens an untouched live first-level agent", () => {
  const builder = new TimelineBuilder();
  builder.push({
    id: 1,
    sessionId: "auto-open",
    seq: 1,
    ts: 1,
    payload: { kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" },
  });
  const disclosure = new Map<string, boolean>([["work:head", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  assert.equal(initial.rows.find((row) => row.kind === "subagent_summary")?.open, false);

  builder.push({
    id: 2,
    sessionId: "auto-open",
    seq: 2,
    ts: 2,
    payload: { kind: "agent_message", text: "hello", final: true, parentToolUseId: "task" },
  });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.rows.find((row) => row.kind === "subagent_summary")?.open, true);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "hello"), true);
});

test("a placeholder upgraded to an agent tool rebuilds its structural summary row", () => {
  const builder = new TimelineBuilder();
  builder.push({
    id: 1,
    sessionId: "agent-upgrade",
    seq: 1,
    ts: 1,
    payload: { kind: "tool_call_update", toolCallId: "task", status: "running" },
  });
  const disclosure = new Map<string, boolean>([["work:head", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  assert.equal(initial.rows.some((row) => row.kind === "subagent_summary"), false);

  builder.push({
    id: 2,
    sessionId: "agent-upgrade",
    seq: 2,
    ts: 2,
    payload: { kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" },
  });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, false, "structural transitions use the defensive full projection");
  assert.equal(
    updated.rows.some((row) => row.kind === "subagent_summary" && row.tool.toolCallId === "task"),
    true,
  );
});

test("the first child of an untyped placeholder rebuilds its structural summary row", () => {
  const builder = new TimelineBuilder();
  builder.push({
    id: 1,
    sessionId: "placeholder-child",
    seq: 1,
    ts: 1,
    payload: { kind: "tool_call_update", toolCallId: "task", status: "running" },
  });
  const disclosure = new Map<string, boolean>([["work:head", true]]);
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  builder.push({
    id: 2,
    sessionId: "placeholder-child",
    seq: 2,
    ts: 2,
    payload: { kind: "agent_message", text: "visible child", final: true, parentToolUseId: "task" },
  });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, false, "a new structural summary uses the defensive full projection");
  assert.equal(
    updated.rows.some((row) => row.kind === "subagent_summary" && row.tool.toolCallId === "task"),
    true,
  );
  assert.equal(
    updated.rows.some((row) => row.kind === "item" && row.item.kind === "agent_message" && row.item.text === "visible child"),
    true,
  );
});

test("a nested placeholder upgraded to an agent tool rebuilds its nested summary row", () => {
  const builder = new TimelineBuilder();
  const push = (id: number, payload: SessionEventPayload) => builder.push({
    id,
    sessionId: "nested-agent-upgrade",
    seq: id,
    ts: id,
    payload,
  });
  push(1, { kind: "tool_call", toolCallId: "outer", title: "Outer", toolKind: "agent", status: "running" });
  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:outer", true]]);
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  push(2, {
    kind: "tool_call_update",
    toolCallId: "inner",
    title: "Inner",
    status: "running",
    parentToolUseId: "outer",
  });
  const placeholder = projector.project(builder.snapshot(), disclosure);
  assert.equal(placeholder.rows.some((row) => row.kind === "subagent_summary" && row.tool.toolCallId === "inner"), false);

  push(3, {
    kind: "tool_call",
    toolCallId: "inner",
    title: "Inner",
    toolKind: "agent",
    status: "running",
    parentToolUseId: "outer",
  });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, false, "nested structural transitions use the defensive full projection");
  assert.equal(
    updated.rows.some((row) => row.kind === "subagent_summary" && row.tool.toolCallId === "inner"),
    true,
  );
});

test("incremental child attachment never mutates the builder snapshot's raw root tool", () => {
  const builder = new TimelineBuilder();
  builder.push({
    id: 1,
    sessionId: "owned-root",
    seq: 1,
    ts: 1,
    payload: { kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" },
  });
  const first = builder.snapshot();
  const rawRoot = first[0];
  const projector = new IncrementalTimelineRows();
  const disclosure = new Map<string, boolean>();
  projector.project(first, disclosure);
  builder.push({
    id: 2,
    sessionId: "owned-root",
    seq: 2,
    ts: 2,
    payload: { kind: "agent_message", text: "child", final: true, parentToolUseId: "task" },
  });
  projector.project(builder.snapshot(), disclosure);
  assert.equal(rawRoot?.kind === "tool_call" ? rawRoot.children : undefined, undefined);
});

test("a wide active agent reuses its projector-owned child vector on append", () => {
  const builder = new TimelineBuilder();
  builder.push({
    id: 1,
    sessionId: "wide-agent",
    seq: 1,
    ts: 1,
    payload: { kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" },
  });
  for (let sequence = 2; sequence <= 5_001; sequence += 1) {
    builder.push({
      id: sequence,
      sessionId: "wide-agent",
      seq: sequence,
      ts: sequence,
      payload: { kind: "agent_message", text: `child ${sequence}`, final: true, parentToolUseId: "task" },
    });
  }
  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:task", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  const root = initial.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call")!;
  if (root.kind !== "item" || root.item.kind !== "tool_call") throw new Error("expected root tool");
  const children = root.item.children!;
  const oldRowLength = initial.rows.length;

  builder.push({
    id: 5_002,
    sessionId: "wide-agent",
    seq: 5_002,
    ts: 5_002,
    payload: { kind: "agent_message", text: "last child", final: true, parentToolUseId: "task" },
  });
  const updated = projector.project(builder.snapshot(), disclosure);
  const updatedRoot = updated.rows.find((row) => row.kind === "item" && row.item.kind === "tool_call")!;
  if (updatedRoot.kind !== "item" || updatedRoot.item.kind !== "tool_call") throw new Error("expected updated root tool");
  assert.equal(updated.incremental, true);
  assert.equal(updated.processedItems, 1);
  assert.equal(updatedRoot.item, root.item);
  assert.equal(updatedRoot.item.children, children);
  assert.equal(children.length, 5_001);
  assert.equal(updated.keyDirtyFrom, oldRowLength);
});

test("a newly inserted nested agent retains an indexed boundary for its next child", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "nested-boundary", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "root", title: "Root", toolKind: "agent", status: "running" });
  push({ kind: "tool_call", toolCallId: "later", title: "Later", status: "completed" });
  const disclosure = new Map<string, boolean>([
    ["work:head", true],
    ["agent:root", true],
    ["agent:inner", true],
  ]);
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  push({ kind: "tool_call", toolCallId: "inner", title: "Inner", toolKind: "agent", status: "running", parentToolUseId: "root" });
  projector.project(builder.snapshot(), disclosure);
  push({ kind: "agent_message", text: "deep child", final: true, parentToolUseId: "inner" });
  const updated = projector.project(builder.snapshot(), disclosure);
  const deepIndex = updated.rows.findIndex((row) => row.kind === "item" && row.item.kind === "agent_message");
  const laterIndex = updated.rows.findIndex((row) => row.kind === "item" && row.item.kind === "tool_call" && row.item.toolCallId === "later");
  assert.equal(updated.incremental, true);
  assert.equal(updated.processedItems, 1);
  assert.equal(deepIndex > 0 && deepIndex < laterIndex, true);
  assert.equal(updated.keyDirtyFrom, deepIndex);
});

test("an old plan update patches one indexed row after 5,000 later messages", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "old-plan", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "plan", entries: [{ content: "first", status: "in_progress" }] });
  for (let index = 0; index < 5_000; index += 1) {
    push({ kind: "user_message", text: `later ${index}` });
  }
  const disclosure = new Map<string, boolean>([["work:head", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  const untouchedTail = initial.rows.at(-1);

  push({ kind: "plan", entries: [{ content: "first", status: "completed" }] });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, true);
  assert.equal(updated.processedItems, 1);
  assert.equal(updated.rows.at(-1), untouchedTail);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "plan" && row.item.entries[0]?.status === "completed"), true);
});

test("an old nested progressive edit patches its indexed parent child", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "old-nested-edit", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running" });
  push({ kind: "file_edit", path: "src/a.ts", diff: "first", parentToolUseId: "task" });
  for (let index = 0; index < 100; index += 1) push({ kind: "user_message", text: `later ${index}` });
  const disclosure = new Map<string, boolean>([["work:head", true], ["agent:task", true]]);
  const projector = new IncrementalTimelineRows();
  projector.project(builder.snapshot(), disclosure);

  push({ kind: "file_edit", path: "src/a.ts", diff: "second", parentToolUseId: "task" });
  const updated = projector.project(builder.snapshot(), disclosure);
  assert.equal(updated.incremental, true);
  assert.equal(updated.processedItems, 1);
  assert.equal(updated.rows.some((row) => row.kind === "item" && row.item.kind === "file_edit" && row.item.diff === "second"), true);
});

test("message rows expose semantic recorded times, honest duration, and contextual copy actions", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "user_message", id: 1, text: "raw user text", createdAt: 1_700_000_000_000, durationMs: 1_250, durationSource: "observed" },
      { kind: "agent_message", id: 2, text: "**raw assistant text**", createdAt: 1_700_000_001_000 },
    ],
  }));
  assert.equal((html.match(/<time /g) ?? []).length, 2);
  assert.match(html, /dateTime="2023-11-14T22:13:20\.000Z"/);
  assert.match(html, /title="Recorded /);
  assert.match(html, /title="Approximate runner-recorded activity span"/);
  assert.match(html, />~1\.3s<\/span>/);
  assert.match(html, /aria-label="Approximate runner-recorded activity span, 1\.3s"/);
  assert.match(html, /aria-label="Copy user message"/);
  assert.match(html, /aria-label="Copy assistant message"/);
  assert.match(html, /<strong>raw assistant text<\/strong>/);
});

test("user rows prepare deliberate resend and expose edit-in-fork only for an eligible predecessor", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "user_message", id: 1, text: "first", turn: 1 },
      { kind: "conversation_checkpoint", id: 2, turn: 1 },
      { kind: "user_message", id: 3, text: "second", turn: 2 },
      { kind: "conversation_checkpoint", id: 4, turn: 2 },
    ],
    onEditAndResend: () => {},
    onEditInFork: () => {},
    editInForkTargets: new Map([[3, 1]]),
  }));

  assert.equal((html.match(/aria-label="Edit User Message as a New Turn"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="Edit User Message in a New Conversation Fork"/g) ?? []).length, 1);
  assert.match(html, /Edit &amp; Resend/);
  assert.match(html, /Edit in Fork/);
});
