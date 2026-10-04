import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import type { SessionEventPayload, SessionView } from "@wollipog/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveTimeline, groupTimeline, publishTimelineSnapshotDelta, SubagentTreeProjector, TimelineBuilder, type TimelineItem } from "../timeline.js";
import {
  automaticSubagentOpen,
  automaticSubagentOpenAfterChange,
  assistantForkTurns,
  EventTimeline,
  estimateTimelineRow,
  flattenTimelineRows,
  IncrementalTimelineRows,
  layoutTurns,
  messageActions,
  stabilizeTimelineRowKeys,
  summarizeTimelineTurns,
  TIMELINE_ROW_GAP,
  TIMELINE_TURN_GAP,
  turnActions,
  turnResponseText,
  turnSpanDescription,
  stabilizeWorkGroupKeys,
  permissionResolutionLabel,
  timelineFileSourceLocation,
  userRewindTurns,
  type TimelineRenderRow,
} from "./EventTimeline.js";
import { reanchorAtLogicalIndex } from "./MeasuredVirtualList.js";
import type { EditInForkAvailability } from "../session-actions.js";

// Vite supplies the JSX runtime in production; direct Node rendering needs the classic global
// expected by the repository's tsx test transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("timeline row estimates match one quiet step row", () => {
  const tool = {
    kind: "tool_call" as const,
    id: 1,
    toolCallId: "tool",
    title: "Tool",
    status: "completed",
    text: "",
  };
  const thought = { kind: "agent_thought" as const, id: 2, text: "Thinking" };
  assert.equal(estimateTimelineRow({ kind: "item", key: "tool", item: tool, inWork: false, depth: 0 }), 28);
  assert.equal(estimateTimelineRow({ kind: "item", key: "thought", item: thought, inWork: true, depth: 0 }), 28);
  assert.equal(estimateTimelineRow({ kind: "subagent_summary", key: "agent", tool, depth: 0, open: false }), 28);
  assert.equal(estimateTimelineRow({ kind: "subagent_output", key: "agent-output", tool, depth: 1 }), 28);
  assert.equal(estimateTimelineRow({
    kind: "work_summary",
    key: "work",
    tools: 1,
    edits: 0,
    thoughts: 0,
    failed: 0,
    autoApproved: 0,
    open: false,
  }), 28);
  const question = { kind: "question" as const, id: 3, requestId: "ask", questions: [{
    id: "choice", question: "Pick one", options: [{ label: "A" }, { label: "B" }],
  }] };
  assert.equal(estimateTimelineRow({ kind: "item", key: "question", item: question, inWork: false, depth: 0 }, "ask"), 308);
  assert.equal(estimateTimelineRow({ kind: "item", key: "orphan", item: question, inWork: false, depth: 0 }), 44);
  assert.equal(estimateTimelineRow({
    kind: "item", key: "answered-question", item: { ...question, answered: true }, inWork: false, depth: 0,
  }), 44);
});

test("auto-approved reviews expose an exact count and highest risk while expanded order stays exact", () => {
  const items: TimelineItem[] = [
    { kind: "review_decision", id: 10, reviewId: "first", reviewer: { kind: "policy", id: "routine" }, outcome: "allowed", riskLevel: "low" },
    { kind: "tool_call", id: 11, toolCallId: "search", title: "Search", status: "completed", text: "" },
    { kind: "review_decision", id: 12, reviewId: "second", reviewer: { kind: "agent", id: "guardian" }, outcome: "allowed", riskLevel: "high" },
  ];
  const groups = groupTimeline(items);
  const workKey = `work:${groups[0]!.kind === "work" ? groups[0]!.id : "missing"}`;
  const collapsed = flattenTimelineRows(groups, new Map());
  assert.deepEqual(collapsed[0], {
    kind: "work_summary",
    key: workKey,
    firstItemId: items[0]!.id,
    tools: 1,
    edits: 0,
    thoughts: 0,
    failed: 0,
    autoApproved: 2,
    highestReviewRisk: "high",
    open: false,
  });

  const expanded = flattenTimelineRows(groups, new Map([[workKey, true]]));
  assert.deepEqual(
    expanded.filter((row) => row.kind === "item").map((row) => row.kind === "item" ? row.item.id : -1),
    [10, 11, 12],
  );
  const html = renderToStaticMarkup(React.createElement(EventTimeline, { items }));
  assert.match(html, /2 Tool Calls Auto-Approved · High Risk/);
});

test("live approvals update one stable collapsed summary without rebuilding historical rows", () => {
  const builder = new TimelineBuilder();
  const projector = new IncrementalTimelineRows();
  const disclosure = new Map<string, boolean>();
  builder.push({
    id: 1, sessionId: "live-reviews", seq: 1, ts: 1,
    payload: { kind: "review_decision", reviewId: "low", reviewer: { kind: "policy" }, outcome: "allowed", riskLevel: "low" },
  });
  const first = projector.project(builder.snapshot(), disclosure);
  assert.equal(first.rows[0]?.kind === "work_summary" ? first.rows[0].autoApproved : null, 1);
  const key = first.rows[0]!.key;

  builder.push({
    id: 2, sessionId: "live-reviews", seq: 2, ts: 2,
    payload: { kind: "review_decision", reviewId: "high", reviewer: { kind: "agent" }, outcome: "allowed", riskLevel: "high" },
  });
  const second = projector.project(builder.snapshot(), disclosure);
  assert.equal(second.incremental, true);
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0]!.key, key);
  assert.deepEqual(
    second.rows[0]?.kind === "work_summary"
      ? [second.rows[0].autoApproved, second.rows[0].highestReviewRisk]
      : null,
    [2, "high"],
  );
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

test("an agent's call reveals as its agent row, since it has no step row of its own (#2183)", () => {
  const projector = new IncrementalTimelineRows();
  projector.project([
    { kind: "tool_call", id: 1, toolCallId: "outer", title: "Outer", toolKind: "agent", status: "running", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "inner", title: "Inner", toolKind: "agent", status: "running", text: "", parentToolUseId: "outer" },
    { kind: "agent_message", id: 3, text: "Nested result", parentToolUseId: "inner" },
  ], new Map());

  assert.deepEqual(projector.resolveRevealTarget(1), { rowKey: "agent:outer", disclosureKeys: ["work:head"] });
  assert.deepEqual(projector.resolveRevealTarget(2), { rowKey: "agent:inner", disclosureKeys: ["work:head", "agent:outer"] });
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

test("a turn interruption renders no row of its own and no error styling", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{ kind: "turn_interrupted", id: 1, createdAt: Date.UTC(2026, 7, 4, 12, 0, 0) }],
  }));
  assert.doesNotMatch(html, /Interrupted/);
  assert.doesNotMatch(html, /t-danger/);
});

test("historical transcript error rows are not assertive live regions", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{ kind: "error", id: 1, message: "Worktree verification failed" }],
  }));
  assert.equal((html.match(/role="alert"/g) ?? []).length, 0);
  assert.match(html, /Turn Failed/);
  assert.doesNotMatch(html, /Worktree verification failed/, "the raw message waits behind Show Details");
});

test("a canonical accepted steer keeps one quiet Steered the Current Turn fact under its bubble", () => {
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
  assert.equal((html.match(/data-status="steered"/g) ?? []).length, 1);
  // Inline success status (§11.2), outside the bubble, never a chip inside it.
  assert.match(html, /<\/div><div class="tl-receipt" data-status="steered"><span class="status[^"]*\bt-success\b[^"]*\binline\b[^"]*">Steered the Current Turn<\/span><\/div>/);
});

test("the pending question replaces its matching timeline card without a duplicate historical row", () => {
  const questions = [{
    id: "language",
    question: "Which language?",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];
  const session = {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    pendingApproval: {
      kind: "question",
      requestId: "ask-1",
      title: "Agent Questions",
      options: [],
      questions,
    },
  } as SessionView;
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{ kind: "question", id: 4, requestId: "ask-1", questions }],
    questionContext: {
      sessionId: session.id,
      pendingQuestion: { requestId: "ask-1", questions },
      questionInTimeline: true,
      runnerOnline: true,
    },
  }));

  assert.equal((html.match(/aria-label="Agent Questions"/g) ?? []).length, 1);
  assert.equal((html.match(/Which language\?/g) ?? []).length, 1);
  assert.doesNotMatch(html, /awaiting answer/);
  assert.match(html, /role="radiogroup"/);
});

test("a resolved question keeps one compact outcome card at the same timeline row", () => {
  const questions = [{ id: "language", question: "Which language?", options: [{ label: "TypeScript" }] }];
  const session = {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    pendingApproval: {
      kind: "question",
      requestId: "ask-1",
      title: "Agent Questions",
      options: [],
      questions,
    },
  } as SessionView;
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{
      kind: "question",
      id: 4,
      requestId: "ask-1",
      questions,
      answered: false,
      resolutionReason: "replaced",
    }],
    questionContext: {
      sessionId: session.id,
      pendingQuestion: { requestId: "ask-1", questions },
      questionInTimeline: true,
      runnerOnline: true,
    },
  }));

  assert.doesNotMatch(html, /aria-label="Agent Questions"/);
  assert.equal((html.match(/Which language\?/g) ?? []).length, 3,
    "the row's title, its accessible name and its collapsed complete-question body retain the text");
  assert.match(html, /<span class="status sm t-neutral inline tl-step-status">Replaced<\/span>/);
  assert.doesNotMatch(html, /→/);
  assert.doesNotMatch(html, /role="radiogroup"/);
});

test("resolved question cards keep a concise summary and disclose complete rich text", () => {
  const signed = "https://evidence.example/private/capture.png?signature=secret#full";
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{
      kind: "question",
      id: 5,
      requestId: "ask-rich",
      answered: true,
      questions: [
        {
          id: "target",
          header: "Target",
          question: `Choose **one** target using ${signed}\n\n- staging\n- production`,
          context: "Keep `build-42` available.",
          options: [{ label: "Staging" }],
        },
        { id: "checks", question: "Select the checks.", options: [{ label: "Tests" }] },
      ],
    }],
  }));

  assert.match(html, /<details class="tl-step disclosure">/);
  assert.match(html, /<span class="tl-step-title"><span class="tl-step-verb">Target \(\+1 more\)<\/span><\/span>/, "line 1 is the header when there is one");
  assert.match(html, /<span class="status sm t-success inline tl-step-status">Answered<\/span>/);
  assert.doesNotMatch(html, /→|❓/);
  assert.doesNotMatch(html, /tl-step-detail/, "an answer an older control plane recorded has no answer line");
  assert.match(html, /<strong>one<\/strong>/);
  assert.match(html, /<li>staging<\/li>/);
  assert.match(html, /<code>build-42<\/code>/);
  assert.match(html, /href="https:\/\/evidence\.example\/private\/capture\.png\?signature=secret#full"/);
  assert.equal((html.match(/signature=secret/g) ?? []).length, 1);
});

test("delegated question and approval histories identify the controlling parent", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      {
        kind: "question", id: 6, requestId: "question", answered: true,
        resolvedByParentSessionId: "parent-session",
        questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
      },
      {
        kind: "permission", id: 7, requestId: "permission", title: "Run command",
        options: [{ optionId: "allow", name: "Allow" }],
        resolvedOptionId: "allow", resolvedByParentSessionId: "parent-session",
      },
    ],
  }));
  assert.match(html, /<span class="status sm t-success inline tl-step-status">Answered by Parent<\/span>/);
  assert.match(html, /Answered by parent session parent-sessi…\./);
  assert.match(html, /Approved by Parent parent-session/);
});

test("each settled turn has one More Turn Actions menu with Your Message then This Turn, and distinct glyphs", () => {
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "First question" },
    { kind: "checkpoint", id: 2, turn: 1 },
    { kind: "agent_message", id: 3, text: "First answer" },
    { kind: "conversation_checkpoint", id: 4, turn: 1 },
    { kind: "user_message", id: 5, text: "Second question" },
    { kind: "checkpoint", id: 6, turn: 2 },
    { kind: "agent_message", id: 7, text: "Second answer" },
    { kind: "conversation_checkpoint", id: 8, turn: 2 },
  ];
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items,
    onRewind: () => {},
    onFork: () => {},
    handoff: { open: () => {} },
    forkAvailabilityByTurn: new Map([
      [1, { available: false, offered: true, reason: "Claude Code can fork only its latest completed conversation checkpoint." }],
      [2, { available: true, forkTurn: 2 }],
    ]),
  }));

  assert.equal((html.match(/class="tl-turn-footer"/g) ?? []).length, 2, "one footer per settled turn");
  assert.equal((html.match(/aria-label="More Turn Actions"/g) ?? []).length, 2, "one turn menu per footer");
  assert.match(html, /<span class="tl-turn-label">Turn 1<\/span>[\s\S]*<span class="tl-turn-label">Turn 2<\/span>/);
  assert.equal((html.match(/aria-label="Fork After This Turn"/g) ?? []).length, 1,
    "the footer's hover cluster offers Fork only where it can be used");
  assert.match(html, /aria-label="Copy Response"[\s\S]*?aria-label="Fork After This Turn"[\s\S]*?aria-label="More Turn Actions"/,
    "Copy Response and Fork come before More Turn Actions");
  assert.match(html, /aria-label="More Message Actions"/, "each prompt has its own hover menu");
  assert.doesNotMatch(html, /<details|<summary|lucide-share|lucide-corner-up-left/,
    "no disclosure popover, and no borrowed Share or parent-folder glyph");

  const rewindTurns = userRewindTurns(items);
  const yourMessage = messageActions(items[0] as Extract<TimelineItem, { kind: "user_message" }>, {
    onRewind: () => {},
    rewindTurn: rewindTurns.get(1),
    onEditAndResend: () => {},
    onEditInFork: () => {},
    editInForkAvailability: { available: false, offered: true, reason: "Reconnect the runner before creating a fork." },
  });
  assert.deepEqual(yourMessage.map((action) => action.label),
    ["Copy Message", "Edit as a New Turn", "Edit in a Fork…", "Rewind Files to Before This Turn…"]);
  const thisTurn = turnActions({
    responseText: "First answer",
    forkAvailability: { available: false, offered: true, reason: "Claude Code can fork only its latest completed conversation checkpoint." },
    onFork: () => {},
    forkTurn: 1,
    handoff: { open: () => {} },
  });
  assert.deepEqual(thisTurn.map((action) => action.label),
    ["Copy Response", "Copy Response as Markdown", "Fork After This Turn…", "Hand Off After This Turn…"]);
  assert.equal(thisTurn[2]!.unavailableReason, "Claude Code can fork only its latest completed conversation checkpoint.");

  const glyph = (actions: readonly { key: string; icon: React.ReactNode }[], key: string) =>
    /class="lucide (lucide-[a-z-]+)/.exec(renderToStaticMarkup(actions.find((action) => action.key === key)!.icon))?.[1];
  const glyphs = [
    glyph(thisTurn, "fork"),
    glyph(yourMessage, "edit-in-fork"),
    glyph(yourMessage, "rewind"),
    glyph(thisTurn, "handoff"),
  ];
  assert.deepEqual(glyphs, ["lucide-git-fork", "lucide-git-branch-plus", "lucide-file-clock", "lucide-arrow-right-left"]);
  assert.equal(new Set(glyphs).size, 4, "Fork, Edit in a Fork, Rewind and Hand Off each draw their own glyph");
});

test("checkpoints stay in the model but render no Start Turn or End Turn separator", () => {
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "Prompt" },
    { kind: "checkpoint", id: 2, turn: 19 },
    { kind: "agent_message", id: 3, text: "Answer" },
    { kind: "conversation_checkpoint", id: 4, turn: 19 },
  ];
  const html = renderToStaticMarkup(React.createElement(EventTimeline, { items }));

  assert.doesNotMatch(html, /Start Turn|End Turn|role="separator"/);
  assert.equal((html.match(/role="listitem"/g) ?? []).length, 2, "the checkpoints occupy no row");
  const rows = flattenTimelineRows(groupTimeline(items), new Map());
  assert.deepEqual(rows.map((row) => row.key), ["item:user_message:1", "item:agent_message:3"]);
  assert.deepEqual([...userRewindTurns(items)], [[1, 19]], "rewind still reads the file checkpoint");
  assert.deepEqual([...assistantForkTurns(items)], [[3, 19]], "fork still reads the conversation checkpoint");
});

const historyDividers: TimelineItem[] = [
  { kind: "checkpoint_restored", id: 1, turn: 7 },
  { kind: "conversation_forked", id: 2, sourceSessionId: "source", turn: 8 },
  {
    kind: "conversation_forked", id: 3, sourceSessionId: "source", turn: 9,
    handoff: {
      sourceAgent: "Claude Code",
      destinationAgent: "Codex",
      disclosure: "Tool output and reasoning were omitted.",
    },
  },
  { kind: "provider_account_switched", id: 4, providerAccountId: "work", providerAccountLabel: "Work", automatic: true },
  { kind: "context_compacted", id: 5, trigger: "manual", preTokens: 48213 },
  { kind: "context_compacted", id: 6, trigger: "auto" },
];

test("rewind, fork, handoff and account dividers expose concise accessible semantics", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, { items: historyDividers }));

  assert.match(html, /class="tl-divider" role="separator" aria-label="Files Rewound to Before Turn 7" title="Files restored to the checkpoint before turn 7"/);
  assert.match(html, /class="tl-divider" role="separator" aria-label="Forked from Turn 8" title="Conversation forked from turn 8"/);
  assert.match(html, /class="tl-divider" role="separator" aria-label="Automatically Switched Account to Work" title="Provider conversation resumed with Work"/);
  assert.match(html, /class="tl-divider" role="separator" aria-label="Conversation Compacted" title="Earlier messages were summarized to free context \(48,213 tokens before\)\."/);
  assert.match(html, /class="tl-divider" role="separator" aria-label="Conversation Compacted Automatically" title="Earlier messages were summarized to free context\."/);
  const descriptionId = html.match(/aria-label="Handoff from Claude Code to Codex After Turn 9" aria-describedby="([^"]+)"/)?.[1];
  assert.ok(descriptionId, "the concise handoff separator names its visible secondary description");
  assert.ok(html.includes(`<p id="${descriptionId}" class="tl-divider-desc">Fresh provider conversation. Tool output and reasoning were omitted.</p>`));
  assert.doesNotMatch(html, /aria-label="[^"]*Tool output and reasoning/,
    "the longer handoff disclosure does not overload the separator name");
});

test("every history divider is one neutral label with a faint 14px icon and no glyph", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, { items: historyDividers }));
  const labels = [...html.matchAll(/<span class="tl-divider-label"><span class="tl-divider-icon" aria-hidden="true">(<svg[^>]*>)[\s\S]*?<\/svg><\/span>([^<]*)<\/span>/g)];
  assert.deepEqual(labels.map((match) => match[2]), [
    "Files Rewound to Before Turn 7",
    "Forked from Turn 8",
    "Handoff from Claude Code to Codex After Turn 9",
    "Automatically Switched Account to Work",
    "Conversation Compacted",
    "Conversation Compacted Automatically",
  ]);
  for (const [, svg] of labels) assert.match(svg!, /width="14"/);
  assert.deepEqual(labels.map(([, svg]) => svg!.match(/lucide-([a-z-]+)/)?.[1]),
    ["file-clock", "git-fork", "arrow-right-left", "circle-user-round", "fold-vertical", "fold-vertical"]);
  assert.doesNotMatch(html, /⤺|class="[^"]*(checkpoint|restored)/, "no retired glyph or teal checkpoint class remains");
});

test("the retired rewind glyph is gone from the transcript source", async () => {
  const { readFile } = await import("node:fs/promises");
  assert.doesNotMatch(await readFile(new URL("./EventTimeline.tsx", import.meta.url), "utf8"), /⤺/);
});

test("history dividers are neutral: no accent or teal in either theme", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.tl-divider[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 4, "the divider block is in the stylesheet");
  for (const [, , selector, body] of rules) {
    assert.doesNotMatch(body!, /--accent|--teal/, `${selector!.trim()} stays neutral`);
  }
  assert.doesNotMatch(css, /\.checkpoint-(line|label|description)|\.tl-checkpoint|\.tl-stderr/,
    "the checkpoint and red stderr rules are gone");
});

test("a fork or handoff links its source session only where the app can navigate", () => {
  const opened: string[] = [];
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: historyDividers,
    onOpenSession: (id: string) => opened.push(id),
  }));
  const forkDescription = html.match(/aria-label="Forked from Turn 8" aria-describedby="([^"]+)"/)?.[1];
  assert.ok(forkDescription, "the fork separator names its description");
  assert.match(html, new RegExp(`<p id="${forkDescription}" class="tl-divider-desc"><button type="button" class="link">Open Source Session</button></p>`));
  assert.equal((html.match(/<button type="button" class="link">Open Source Session<\/button>/g) ?? []).length, 2,
    "the fork and the handoff each link their source in the shared link style");
  const shared = renderToStaticMarkup(React.createElement(EventTimeline, { items: historyDividers }));
  assert.doesNotMatch(shared, /Open Source Session/, "a transcript that cannot navigate shows no link");
  assert.deepEqual(opened, []);
});

test("handoff dividers reserve space for their visible secondary description", () => {
  assert.equal(estimateTimelineRow({
    kind: "item",
    key: "handoff",
    item: {
      kind: "conversation_forked", id: 1, sourceSessionId: "source", turn: 4,
      handoff: { sourceAgent: "Claude Code", destinationAgent: "Codex", disclosure: "Bounded context." },
    },
    inWork: false,
    depth: 0,
  }), 76);
  assert.equal(estimateTimelineRow({
    kind: "item",
    key: "fork",
    item: { kind: "conversation_forked", id: 2, sourceSessionId: "source", turn: 4 },
    inWork: false,
    depth: 0,
  }), 52);
});

test("checkpoint projection maps only the owning canonical user message", () => {
  assert.deepEqual([...userRewindTurns([
    { kind: "user_message", id: 1, text: "first" },
    { kind: "checkpoint", id: 2, turn: 1 },
    { kind: "conversation_checkpoint", id: 3, turn: 1 },
    { kind: "user_message", id: 4, text: "second" },
    { kind: "user_message", id: 5, text: "steer", deliveryIntent: "steer" },
    { kind: "checkpoint", id: 6, turn: 2 },
    { kind: "error", id: 7, message: "cancelled" },
    { kind: "user_message", id: 8, text: "third after cancellation" },
    { kind: "checkpoint", id: 9, turn: 3 },
    { kind: "conversation_checkpoint", id: 10, turn: 3 },
    { kind: "checkpoint", id: 11, turn: 4 },
    { kind: "user_message", id: 12, text: "must not borrow an orphan checkpoint" },
    { kind: "stderr", id: 13, text: "Runner resumed orphaned background work automatically." },
    { kind: "checkpoint", id: 14, turn: 5 },
  ])], [[1, 1], [4, 2], [8, 3]]);
});

test("assistant fork-point projection ignores nested answers and cancelled turns", () => {
  const turns = assistantForkTurns([
    { kind: "user_message", id: 1, text: "one", turn: 1 },
    { kind: "agent_message", id: 2, text: "top-level one" },
    { kind: "agent_message", id: 3, text: "nested", parentToolUseId: "task" },
    { kind: "conversation_checkpoint", id: 4, turn: 1 },
    { kind: "user_message", id: 5, text: "cancelled" },
    { kind: "error", id: 6, message: "cancelled" },
    { kind: "conversation_checkpoint", id: 7, turn: 2 },
  ]);
  assert.deepEqual([...turns], [[2, 1]], "a checkpoint without a response gets no borrowed icon");
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

test("history hydration extends an auto-approval summary without changing its disclosure anchor", () => {
  const later = { kind: "review_decision" as const, id: 20, reviewId: "later", reviewer: { kind: "agent" as const }, outcome: "allowed" as const, riskLevel: "medium" as const };
  const previous = groupTimeline([later]);
  const recovered = stabilizeWorkGroupKeys(groupTimeline([
    { kind: "review_decision", id: 19, reviewId: "earlier", reviewer: { kind: "policy" }, outcome: "allowed", riskLevel: "low" },
    later,
  ]), previous);
  const previousKey = previous[0]!.kind === "work" ? `work:${previous[0].id}` : "missing";
  const recoveredKey = recovered[0]!.kind === "work" ? `work:${recovered[0].id}` : "missing";

  assert.equal(recoveredKey, previousKey);
  const rows = flattenTimelineRows(recovered, new Map());
  assert.deepEqual(
    rows[0]?.kind === "work_summary"
      ? [rows[0].autoApproved, rows[0].highestReviewRisk]
      : null,
    [2, "medium"],
  );
});

test("a disjoint prepended head block cannot steal the retained boundary key", () => {
  const previous = groupTimeline([
    { kind: "agent_thought", id: 66, text: "old boundary work" },
    { kind: "agent_message", id: 68, text: "old answer" },
  ]);
  const recovered = stabilizeWorkGroupKeys(groupTimeline([
    { kind: "agent_thought", id: 58, text: "new window head" },
    { kind: "agent_message", id: 60, text: "earlier answer" },
    { kind: "user_message", id: 65, text: "boundary question" },
    { kind: "agent_thought", id: 66, text: "old boundary work" },
    { kind: "agent_message", id: 68, text: "old answer" },
  ]), previous);
  const workIds = recovered.flatMap((group) => group.kind === "work" ? [group.id] : []);

  assert.deepEqual(workIds, ["head:agent_thought:58", "head"]);
  assert.equal(new Set(workIds).size, workIds.length, "every virtual work row keeps a unique key");
  assert.equal(workIds[1], previous[0]!.kind === "work" ? previous[0]!.id : null,
    "the old page-boundary block remains the logical anchor");
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
  assert.equal(initial.rows.some((row) => row.kind === "item" && row.item.kind === "tool_call"), false,
    "the agent's call has no step row of its own (#2183)");

  push({ kind: "agent_message", text: "ing", parentToolUseId: "task" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(update.rows.find((row) => row.kind === "subagent_summary")!.key, summaryKey);
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
  const agentKey = (rows: typeof initial.rows, id: string) =>
    rows.find((row) => row.kind === "subagent_summary" && row.tool.toolCallId === id)!.key;
  const outerKey = agentKey(initial.rows, "outer");
  const innerKey = agentKey(initial.rows, "inner");

  push({ kind: "agent_message", text: " work", parentToolUseId: "inner" });
  const update = projector.project(builder.snapshot(), disclosure);
  assert.equal(update.incremental, true);
  assert.equal(update.processedItems, 1);
  assert.equal(agentKey(update.rows, "outer"), outerKey);
  assert.equal(agentKey(update.rows, "inner"), innerKey);
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
  assert.equal(updated.rows.some((row) => row.kind === "subagent_summary" && row.tool.toolCallId === "root"), true);
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
  const root = initial.rows.find((row) => row.kind === "subagent_summary")!;
  if (root.kind !== "subagent_summary") throw new Error("expected root agent");
  const children = root.tool.children!;
  const oldRowLength = initial.rows.length;

  builder.push({
    id: 5_002,
    sessionId: "wide-agent",
    seq: 5_002,
    ts: 5_002,
    payload: { kind: "agent_message", text: "last child", final: true, parentToolUseId: "task" },
  });
  const updated = projector.project(builder.snapshot(), disclosure);
  const updatedRoot = updated.rows.find((row) => row.kind === "subagent_summary")!;
  if (updatedRoot.kind !== "subagent_summary") throw new Error("expected updated root agent");
  assert.equal(updated.incremental, true);
  assert.equal(updated.processedItems, 1);
  assert.equal(updatedRoot.tool, root.tool);
  assert.equal(updatedRoot.tool.children, children);
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
    push({ kind: "agent_message", text: `later ${index}`, final: true });
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

test("message rows carry no time; the turn footer holds one clock time, its span and contextual copy", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "user_message", id: 1, text: "raw user text", createdAt: 1_700_000_000_000, durationMs: 26_000, durationSource: "provider" },
      { kind: "agent_message", id: 2, text: "**raw assistant text**", createdAt: 1_700_000_001_000, lastActivityAt: 1_700_000_026_000 },
    ],
  }));
  assert.equal((html.match(/<time /g) ?? []).length, 1, "only the footer shows a time");
  assert.match(html, /<div class="tl-turn-footer"[^>]*>[\s\S]*<time dateTime="2023-11-14T22:13:46\.000Z"/,
    "the footer's clock is when the turn finished");
  assert.match(html, /role="tooltip">Started [^<]+, finished [^<]+ \(26s\)<\/span>/);
  assert.doesNotMatch(html.replace(/<span[^>]*role="tooltip">[^<]*<\/span>/, ""), /Recorded|Started|Last Activity|→|Ago/,
    "outside the footer's tooltip, no row names a time range or timestamp label");
  assert.match(html, /aria-label="Copy Message"/);
  assert.match(html, /aria-label="Copy Response"/);
  assert.match(html, /<strong>raw assistant text<\/strong>/);
});

test("turn summaries read the checkpoint number, span, usage, response and fork point", () => {
  const items: TimelineItem[] = [
    { kind: "agent_message", id: 1, text: "Before any prompt" },
    {
      kind: "user_message", id: 2, text: "first", createdAt: 1_000, turn: 3,
      turnUsage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 },
    },
    { kind: "checkpoint", id: 3, turn: 3 },
    { kind: "agent_message", id: 4, text: "Working on it.", createdAt: 2_000 },
    { kind: "tool_call", id: 5, toolCallId: "t", title: "Run", status: "completed", text: "", startedAt: 3_000, completedAt: 9_000 },
    { kind: "agent_message", id: 6, text: "nested", parentToolUseId: "t", createdAt: 4_000 },
    { kind: "agent_message", id: 7, text: "Done.", createdAt: 8_000 },
    { kind: "conversation_checkpoint", id: 8, turn: 3 },
    { kind: "checkpoint_restored", id: 9, turn: 2 },
    { kind: "user_message", id: 10, text: "second", createdAt: 20_000, durationMs: 5_000 },
    { kind: "user_message", id: 11, text: "steer", deliveryIntent: "steer", createdAt: 21_000 },
  ];
  const { segments } = summarizeTimelineTurns(items, assistantForkTurns(items));
  assert.deepEqual(segments.map((segment) => segment.key), [null, 2, 10], "a steering message does not open a turn");
  const first = segments[1]!;
  assert.equal(first.turn, 3);
  assert.equal(first.startedAt, 1_000);
  assert.equal(first.finishedAt, 9_000, "the latest recorded activity, nested work included");
  assert.equal(turnResponseText(first), "Working on it.\n\nDone.", "only top-level agent messages are copied");
  assert.equal(first.forkTurn, 3);
  assert.equal(first.usage?.costUsd, 0.5);
  assert.equal(first.hasAgentContent, true);
  const second = segments[2]!;
  assert.equal(second.hasAgentContent, false, "a prompt and a steer are not agent work");
  assert.equal(second.finishedAt, 25_000, "the recorded duration outlasts the last visible row (the steer at 21s)");
  assert.equal(segments[0]!.turn, undefined);
});

test("one footer follows each settled turn, before trailing history dividers, and never a running one", () => {
  const items: TimelineItem[] = [
    { kind: "agent_message", id: 1, text: "Subagent-style output before any prompt" },
    { kind: "user_message", id: 2, text: "first" },
    { kind: "agent_message", id: 3, text: "answer" },
    { kind: "conversation_checkpoint", id: 4, turn: 1 },
    { kind: "checkpoint_restored", id: 5, turn: 1 },
    { kind: "user_message", id: 6, text: "second" },
    { kind: "agent_thought", id: 7, text: "thinking" },
    { kind: "tool_call", id: 8, toolCallId: "t", title: "Run", status: "completed", text: "" },
  ];
  const rows = flattenTimelineRows(groupTimeline(items), new Map());
  const turns = summarizeTimelineTurns(items, assistantForkTurns(items));
  const settled = layoutTurns(rows, turns, false);
  assert.deepEqual([...settled.footers.keys()], ["item:agent_message:3", "work:user_message:6"],
    "the first footer sits before the rewind divider; unnumbered pre-prompt output gets none");
  assert.equal(settled.footers.get("item:agent_message:3")!.turn, 1);
  assert.deepEqual([...layoutTurns(rows, turns, true).footers.keys()], ["item:agent_message:3"],
    "the running turn has no footer");

  const gaps = rows.map((_, index) => settled.turnStarts.has(rows[index + 1]?.key ?? "") ? TIMELINE_TURN_GAP : TIMELINE_ROW_GAP);
  assert.deepEqual(gaps, [32, 12, 12, 32, 12, 12], "32px opens each new turn, 12px everywhere inside one");
});

test("an automatic continuation without a prompt is its own turn with its own footer and actions", () => {
  // Resumed background work: the runner emits a notice and a new numbered checkpoint, no prompt.
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "Start the migration" },
    { kind: "checkpoint", id: 2, turn: 1 },
    { kind: "agent_message", id: 3, text: "Started; it continues in the background." },
    { kind: "conversation_checkpoint", id: 4, turn: 1 },
    { kind: "stderr", id: 5, text: "Runner resumed orphaned background work automatically." },
    { kind: "checkpoint", id: 6, turn: 2 },
    { kind: "agent_message", id: 7, text: "The migration finished." },
    { kind: "conversation_checkpoint", id: 8, turn: 2 },
  ];
  const turns = summarizeTimelineTurns(items, assistantForkTurns(items));
  assert.deepEqual(turns.segments.map((segment) => [segment.key, segment.turn, segment.forkTurn]),
    [[null, undefined, undefined], [1, 1, 1], [5, 2, 2]]);
  const rows = flattenTimelineRows(groupTimeline(items), new Map());
  const settled = layoutTurns(rows, turns, false);
  assert.deepEqual([...settled.footers.values()].map((footer) => footer.turn), [1, 2]);
  assert.deepEqual([...layoutTurns(rows, turns, true).footers.values()].map((footer) => footer.turn), [1],
    "while the continuation runs, the earlier turn keeps its footer");
  assert.ok(settled.turnStarts.has(rows.find((row) => row.kind === "work_summary")!.key),
    "the continuation opens 32px below the earlier turn");

  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items,
    onFork: () => {},
    forkAvailabilityByTurn: new Map([1, 2].map((turn) => [turn, { available: true as const, forkTurn: turn }])),
  }));
  assert.equal((html.match(/aria-label="Fork After This Turn"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="More Turn Actions"/g) ?? []).length, 2);
});

test("a continuation's usage report times the continuation, not the turn before it", () => {
  const event = (seq: number, ts: number, payload: SessionEventPayload) => ({ id: seq, sessionId: "s", seq, ts, payload });
  const items = deriveTimeline([
    event(1, 0, { kind: "user_message", text: "Start it" }),
    event(2, 1, { kind: "checkpoint", turn: 1, tree: "a" } as SessionEventPayload),
    event(3, 2_000, { kind: "agent_message", text: "Started.", final: true }),
    event(4, 3_000, { kind: "token_usage", inputTokens: 10, outputTokens: 2 }),
    event(5, 3_001, { kind: "conversation_checkpoint", turn: 1 }),
    event(6, 10_000, { kind: "stderr", text: "Runner resumed orphaned background work automatically." }),
    event(7, 10_001, { kind: "checkpoint", turn: 2, tree: "b" } as SessionEventPayload),
    event(8, 12_000, { kind: "agent_message", text: "Finished.", final: true }),
    event(9, 14_000, { kind: "token_usage", inputTokens: 20, outputTokens: 4 }),
    event(10, 14_001, { kind: "conversation_checkpoint", turn: 2 }),
  ]);
  const { segments } = summarizeTimelineTurns(items, assistantForkTurns(items));
  assert.deepEqual(segments.slice(1).map((segment) => [segment.turn, segment.finishedAt]), [[1, 3_000], [2, 14_000]]);
  assert.equal(segments[1]!.durationMs, 3_000, "the prompt's duration is its own turn's");

  // The file checkpoint is best effort; a continuation without one is timed the same way.
  const withoutCheckpoint = deriveTimeline([
    event(1, 0, { kind: "user_message", text: "Start it" }),
    event(3, 2_000, { kind: "agent_message", text: "Started.", final: true }),
    event(4, 3_000, { kind: "token_usage", inputTokens: 10, outputTokens: 2 }),
    event(5, 3_001, { kind: "conversation_checkpoint", turn: 1 }),
    event(6, 10_000, { kind: "stderr", text: "Runner resumed orphaned background work automatically." }),
    event(8, 12_000, { kind: "agent_message", text: "Finished.", final: true }),
    event(9, 14_000, { kind: "token_usage", inputTokens: 20, outputTokens: 4 }),
    event(10, 14_001, { kind: "conversation_checkpoint", turn: 2 }),
  ]);
  const unanchored = summarizeTimelineTurns(withoutCheckpoint, assistantForkTurns(withoutCheckpoint)).segments;
  assert.deepEqual(unanchored.slice(1).map((segment) => [segment.turn, segment.finishedAt]), [[1, 3_000], [2, 14_000]]);

  // A terminal report landing just after the prompt's own conversation checkpoint is still its turn's.
  const lateReport = deriveTimeline([
    event(1, 0, { kind: "user_message", text: "Run it" }),
    event(2, 2_000, { kind: "agent_message", text: "Done.", final: true }),
    event(3, 2_001, { kind: "conversation_checkpoint", turn: 1 }),
    event(4, 5_000, { kind: "token_usage", inputTokens: 10, outputTokens: 2 }),
  ]);
  assert.equal(summarizeTimelineTurns(lateReport, new Map()).segments[1]!.finishedAt, 5_000);

  // The same late ordering for a continuation, with and without its file checkpoint.
  for (const fileCheckpoint of [true, false]) {
    const late = deriveTimeline([
      event(1, 0, { kind: "user_message", text: "Start it" }),
      event(3, 2_000, { kind: "agent_message", text: "Started.", final: true }),
      event(4, 3_000, { kind: "token_usage", inputTokens: 10, outputTokens: 2 }),
      event(5, 3_001, { kind: "conversation_checkpoint", turn: 1 }),
      event(6, 10_000, { kind: "stderr", text: "Runner resumed orphaned background work automatically." }),
      ...(fileCheckpoint ? [event(7, 10_001, { kind: "checkpoint", turn: 2, tree: "b" } as SessionEventPayload)] : []),
      event(8, 12_000, { kind: "agent_message", text: "Finished.", final: true }),
      event(9, 12_001, { kind: "conversation_checkpoint", turn: 2 }),
      event(10, 14_000, { kind: "token_usage", inputTokens: 20, outputTokens: 4 }),
    ]);
    assert.deepEqual(summarizeTimelineTurns(late, new Map()).segments.slice(1).map((segment) => segment.finishedAt),
      [3_000, 14_000], `late continuation report, file checkpoint ${fileCheckpoint}`);
  }

  // A tail-first page that starts at the earlier turn's conversation checkpoint, without its prompt.
  const page = deriveTimeline([
    event(5, 3_001, { kind: "conversation_checkpoint", turn: 1 }),
    event(6, 10_000, { kind: "stderr", text: "Runner resumed orphaned background work automatically." }),
    event(8, 12_000, { kind: "agent_message", text: "Finished.", final: true }),
    event(9, 14_000, { kind: "token_usage", inputTokens: 20, outputTokens: 4 }),
    event(10, 14_001, { kind: "conversation_checkpoint", turn: 2 }),
  ]);
  const paged = summarizeTimelineTurns(page, new Map()).segments;
  assert.deepEqual(paged.map((segment) => [segment.turn, segment.finishedAt]), [[1, undefined], [2, 14_000]]);
});

test("a continuation's tokens and cost land on its own footer, not the turn before it", () => {
  const event = (seq: number, ts: number, payload: SessionEventPayload) => ({ id: seq, sessionId: "s", seq, ts, payload });
  const prompt = (usage: { inputTokens: number; outputTokens: number; costUsd: number }) => [
    event(1, 0, { kind: "user_message", text: "Start the migration" }),
    event(2, 1, { kind: "checkpoint", turn: 1, tree: "a" } as SessionEventPayload),
    event(3, 2_000, { kind: "agent_message", text: "Started; it continues in the background.", final: true }),
    event(4, 3_000, { kind: "token_usage", ...usage }),
    event(5, 3_001, { kind: "conversation_checkpoint", turn: 1 }),
  ];
  const resumed = event(6, 10_000, { kind: "stderr", text: "Runner resumed orphaned background work automatically." });
  const fileCheckpoint = event(7, 10_001, { kind: "checkpoint", turn: 2, tree: "b" } as SessionEventPayload);
  const finished = event(8, 12_000, { kind: "agent_message", text: "The migration finished.", final: true });
  const continuationUsage = event(9, 14_000, { kind: "token_usage", inputTokens: 4_000, outputTokens: 800, costUsd: 0.05 });
  const completed = event(10, 14_001, { kind: "conversation_checkpoint", turn: 2 });
  const footerUsage = (items: TimelineItem[]) =>
    [...renderToStaticMarkup(React.createElement(EventTimeline, { items }))
      .matchAll(/class="tl-turn-usage"[^>]*>([^<]*)</g)].map((match) => match[1]);
  const usageOf = (items: TimelineItem[]) => summarizeTimelineTurns(items, new Map()).segments
    .filter((segment) => segment.turn !== undefined)
    .map((segment) => [segment.turn, segment.usage?.inputTokens, segment.usage?.outputTokens, segment.usage?.costUsd]);

  const items = deriveTimeline([
    ...prompt({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 }),
    resumed, fileCheckpoint, finished, continuationUsage, completed,
  ]);
  assert.deepEqual(footerUsage(items), ["1.2k tok · $0.01", "4.8k tok · $0.05"]);
  assert.deepEqual(usageOf(items), [[1, 1_000, 200, 0.01], [2, 4_000, 800, 0.05]],
    "the footers together hold every parentless report exactly once");

  // A continuation without a file checkpoint, and a report landing after its conversation checkpoint.
  const unanchored = deriveTimeline([
    ...prompt({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 }),
    resumed, finished, continuationUsage, completed,
  ]);
  assert.deepEqual(usageOf(unanchored), [[1, 1_000, 200, 0.01], [2, 4_000, 800, 0.05]], "no file checkpoint");
  for (const withFileCheckpoint of [true, false]) {
    const late = deriveTimeline([
      ...prompt({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 }),
      resumed, ...(withFileCheckpoint ? [fileCheckpoint] : []), finished, completed, continuationUsage,
    ]);
    assert.deepEqual(usageOf(late), [[1, 1_000, 200, 0.01], [2, 4_000, 800, 0.05]],
      `late continuation report, file checkpoint ${withFileCheckpoint}`);
  }

  // A tail-first page that starts after the prompt: the continuation still owns its counters.
  const page = deriveTimeline([prompt({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 })[4]!,
    resumed, finished, continuationUsage, completed]);
  assert.deepEqual(usageOf(page), [[1, undefined, undefined, undefined], [2, 4_000, 800, 0.05]], "paged");

  // A continuation settling in more than one report sums them, as a prompted turn does.
  const split = deriveTimeline([
    ...prompt({ inputTokens: 600, outputTokens: 100, costUsd: 0.004 }),
    event(4.5, 3_000, { kind: "token_usage", inputTokens: 400, outputTokens: 100, costUsd: 0.006 }),
    resumed, fileCheckpoint, finished,
    event(9, 13_000, { kind: "token_usage", inputTokens: 1_000, outputTokens: 300, costUsd: 0.02 }),
    event(9.5, 14_000, { kind: "token_usage", inputTokens: 3_000, outputTokens: 500, costUsd: 0.03 }),
    completed,
  ].sort((a, b) => a.seq - b.seq));
  assert.deepEqual(footerUsage(split), ["1.2k tok · $0.01", "4.8k tok · $0.05"], "several reports per turn");

  // A cancelled turn records no conversation checkpoint: a stopped continuation without a file
  // checkpoint keeps its counters on its stop, whether they land before or after it.
  const stop = event(11, 13_000, { kind: "turn_interrupted" });
  for (const order of ["before", "after"] as const) {
    const report = event(order === "before" ? 10 : 12, order === "before" ? 12_500 : 13_500,
      { kind: "token_usage", inputTokens: 4_000, outputTokens: 800, costUsd: 0.05 });
    const stopped = deriveTimeline([
      ...prompt({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 }),
      resumed, finished, ...(order === "before" ? [report, stop] : [stop, report]),
    ]);
    const segments = summarizeTimelineTurns(stopped, new Map()).segments.slice(1);
    assert.deepEqual(segments.map((segment) => [segment.stopped !== undefined, segment.usage?.inputTokens, segment.finishedAt]),
      [[false, 1_000, 3_000], [true, 4_000, order === "before" ? 13_000 : 13_500]], `stopped continuation, report ${order}`);
    assert.deepEqual(footerUsage(stopped), ["1.2k tok · $0.01", "4.8k tok · $0.05"], `stopped continuation footer, report ${order}`);
  }

  // A refusal or provider error records neither a conversation checkpoint nor a stop, so such a
  // continuation without a file checkpoint has no footer of its own: the turn before it keeps its
  // counters rather than dropping them, before and after the next prompt.
  const refused = [
    ...prompt({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 }),
    resumed, finished, continuationUsage,
  ];
  const next = [
    event(20, 20_000, { kind: "user_message", text: "Check the logs" }),
    event(21, 22_000, { kind: "agent_message", text: "The logs are clean.", final: true }),
    event(22, 23_000, { kind: "token_usage", inputTokens: 500, outputTokens: 100, costUsd: 0.02 }),
    event(23, 23_001, { kind: "conversation_checkpoint", turn: 2 }),
  ];
  assert.deepEqual(footerUsage(deriveTimeline(refused)), ["6.0k tok · $0.06"], "an unanchored continuation's counters are held");
  const afterRefusal = deriveTimeline([...refused, ...next]);
  assert.deepEqual(footerUsage(afterRefusal), ["6.0k tok · $0.06", "600 tok · $0.02"], "the next prompt does not drop them");
  const totals = summarizeTimelineTurns(afterRefusal, new Map()).segments.reduce(
    (sum, segment) => [sum[0]! + (segment.usage?.inputTokens ?? 0) + (segment.usage?.outputTokens ?? 0), sum[1]! + (segment.usage?.costUsd ?? 0)],
    [0, 0],
  );
  assert.equal(totals[0], 6_600);
  assert.ok(Math.abs(totals[1]! - 0.08) < 1e-9, `summed cost ${totals[1]}`);
});

test("late subagent output stays with its parent tool's turn and never opens another", () => {
  const event = (seq: number, ts: number, payload: SessionEventPayload) => ({ id: seq, sessionId: "s", seq, ts, payload });
  const task = { kind: "tool_call", toolCallId: "task", title: "Agent", toolKind: "agent", status: "in_progress" } as SessionEventPayload;
  // A detached child speaks after the prompt's conversation checkpoint, before its late usage report.
  const detached = deriveTimeline([
    event(1, 0, { kind: "user_message", text: "Investigate" }),
    event(2, 1_000, task),
    event(3, 2_000, { kind: "agent_message", text: "Delegated.", final: true }),
    event(4, 2_100, { kind: "conversation_checkpoint", turn: 1 }),
    event(5, 3_000, { kind: "agent_message", text: "Child note", final: true, parentToolUseId: "task" }),
    event(6, 5_000, { kind: "token_usage", inputTokens: 10, outputTokens: 2 }),
  ]);
  const one = summarizeTimelineTurns(detached, new Map()).segments;
  assert.deepEqual(one.map((segment) => segment.key), [null, 1], "the child's message opens no turn");
  assert.equal(one[1]!.finishedAt, 5_000, "the late report still times the prompt's turn");

  // A child launched in turn 1 speaks after turn 2 completed.
  const later = deriveTimeline([
    event(1, 0, { kind: "user_message", text: "Start a task" }),
    event(2, 1_000, task),
    event(3, 2_000, { kind: "agent_message", text: "Started.", final: true }),
    event(4, 2_100, { kind: "conversation_checkpoint", turn: 1 }),
    event(5, 10_000, { kind: "user_message", text: "Meanwhile, something else" }),
    event(6, 12_000, { kind: "agent_message", text: "Done.", final: true }),
    event(7, 12_100, { kind: "conversation_checkpoint", turn: 2 }),
    event(8, 20_000, { kind: "agent_message", text: "Task finding", final: true, parentToolUseId: "task" }),
  ]);
  const two = summarizeTimelineTurns(later, new Map());
  assert.deepEqual(two.segments.slice(1).map((segment) => segment.finishedAt), [20_000, 12_000]);
  assert.equal(two.segmentOf.get(8), 1, "the finding belongs to turn 1, where its row nests");
});

test("an empty terminal usage report settles a turn that produced nothing else", () => {
  const events = [
    { id: 1, sessionId: "s", seq: 1, ts: 1_000, payload: { kind: "user_message", text: "Anything?" } },
    { id: 2, sessionId: "s", seq: 2, ts: 3_000, payload: { kind: "token_usage" } },
  ] as never[];
  const items = deriveTimeline(events);
  const inactive = renderToStaticMarkup(React.createElement(EventTimeline, { items, sessionActive: false }));
  assert.equal((inactive.match(/class="tl-turn-footer"/g) ?? []).length, 1);
  assert.match(inactive, /\(2\.0s\)/);
  const active = renderToStaticMarkup(React.createElement(EventTimeline, { items, sessionActive: true }));
  assert.doesNotMatch(active, /tl-turn-footer/);
});

test("the footer tooltip names the start, finish and duration it has", () => {
  const at = (minute: number, second: number) => Date.UTC(2026, 6, 13, 0, minute, second);
  assert.match(turnSpanDescription({ startedAt: at(25, 38), finishedAt: at(26, 4) }),
    /^Started \d{1,2}:25:38\s?[AP]M, finished \d{1,2}:26:04\s?[AP]M \(26s\)$/);
  assert.match(turnSpanDescription({ finishedAt: at(26, 4) }), /^Finished \d{1,2}:26:04\s?[AP]M$/);
  assert.equal(turnSpanDescription({}), "");
});

test("a turn finishes at its terminal usage report when that lands after the last visible row", () => {
  const at = (second: number) => Date.UTC(2026, 9, 2, 10, 0, second);
  const event = (seq: number, ts: number, payload: SessionEventPayload) => ({ id: seq, sessionId: "s", seq, ts, payload });
  const items = deriveTimeline([
    event(1, at(0), { kind: "user_message", text: "Run it" }),
    event(2, at(30), { kind: "agent_message", text: "Done.", final: true }),
    // Codex's turn.completed reports usage half a minute after the final reply.
    event(3, at(60), { kind: "token_usage", inputTokens: 10, outputTokens: 4 }),
  ]);
  const summary = summarizeTimelineTurns(items, new Map()).segments[1]!;
  assert.equal(summary.finishedAt, at(60));
  assert.match(turnSpanDescription(summary), /^Started \d{1,2}:00:00\s?[AP]M, finished \d{1,2}:01:00\s?[AP]M \(1m 0s\)$/,
    "the clock, the finish and the duration agree");

  // Only the first report stamps the prompt's duration; a live mid-turn report must not hide the
  // terminal one that follows the final reply.
  const live = deriveTimeline([
    event(1, at(0), { kind: "user_message", text: "Run it" }),
    event(2, at(10), { kind: "token_usage", inputTokens: 5, outputTokens: 1 }),
    event(3, at(30), { kind: "agent_message", text: "Done.", final: true }),
    event(4, at(60), { kind: "token_usage", inputTokens: 10, outputTokens: 4 }),
  ]);
  assert.equal(summarizeTimelineTurns(live, new Map()).segments[1]!.finishedAt, at(60));
});

test("a settled turn that produced only usage keeps its footer under the prompt", () => {
  const events = [
    { id: 1, sessionId: "s", seq: 1, ts: 1_000, payload: { kind: "user_message", text: "Compact the context" } },
    { id: 2, sessionId: "s", seq: 2, ts: 1_001, payload: { kind: "checkpoint", turn: 4, tree: "t" } },
    { id: 3, sessionId: "s", seq: 3, ts: 2_000, payload: { kind: "token_usage", inputTokens: 900, outputTokens: 10, costUsd: 0.01 } },
    { id: 4, sessionId: "s", seq: 4, ts: 2_001, payload: { kind: "conversation_checkpoint", turn: 4 } },
  ] as never[];
  const settled = renderToStaticMarkup(React.createElement(EventTimeline, { items: deriveTimeline(events) }));
  assert.equal((settled.match(/class="tl-turn-footer"/g) ?? []).length, 1);
  assert.match(settled, /<span class="tl-turn-label">Turn 4<\/span>/);
  assert.match(settled, /\$0\.01/);
  const running = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: deriveTimeline(events.slice(0, 2)),
    sessionActive: false,
  }));
  assert.doesNotMatch(running, /tl-turn-footer/, "a prompt with nothing settled yet has no footer");
});

test("replies no turn footer copies keep their own Copy", () => {
  const subagentOutput = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [{ kind: "agent_message", id: 1, text: "Subagent finding", parentToolUseId: "task" }],
  }));
  assert.equal((subagentOutput.match(/aria-label="Copy Response"/g) ?? []).length, 1,
    "a subagent transcript has no prompt, so no footer, and its reply keeps Copy");
  assert.doesNotMatch(subagentOutput, /tl-turn-footer/);

  const session = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "user_message", id: 1, text: "Prompt" },
      { kind: "agent_message", id: 2, text: "Answer" },
      { kind: "conversation_checkpoint", id: 3, turn: 1 },
    ],
  }));
  assert.equal((session.match(/aria-label="Copy Response"/g) ?? []).length, 1,
    "a turn's own replies are copied once, from its footer");
  assert.match(session, /class="tl-turn-footer"[\s\S]*aria-label="Copy Response"/);
});

test("every message and turn action button's accessible name equals its tooltip (#2167)", () => {
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items: [
      { kind: "user_message", id: 1, text: "Prompt" },
      { kind: "checkpoint", id: 2, turn: 1 },
      { kind: "agent_message", id: 3, text: "Answer" },
      { kind: "conversation_checkpoint", id: 4, turn: 1 },
    ],
    onRewind: () => {},
    onFork: () => {},
    onEditAndResend: () => {},
    handoff: { open: () => {} },
    forkAvailabilityByTurn: new Map([[1, { available: true as const, forkTurn: 1 }]]),
  }));
  const groups = [...html.matchAll(/<div class="tl-message-actions[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[1]!);
  assert.equal(groups.length, 2, "the message cluster and the footer's actions");
  const buttons = groups.flatMap((group) => [...group.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]));
  const names = buttons.map((button) => {
    const name = /aria-label="([^"]+)"/.exec(button)?.[1];
    assert.equal(/title="([^"]+)"/.exec(button)?.[1], name, `${button} names itself as its tooltip does`);
    return name;
  });
  assert.deepEqual(names, [
    "Copy Message", "Edit as a New Turn", "More Message Actions",
    "Copy Response", "Fork After This Turn", "More Turn Actions",
  ]);
});

test("user rows prepare deliberate resend and expose edit-in-fork only for an eligible predecessor", () => {
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "first", turn: 1 },
    { kind: "conversation_checkpoint", id: 2, turn: 1 },
    { kind: "user_message", id: 3, text: "second", turn: 2 },
    { kind: "conversation_checkpoint", id: 4, turn: 2 },
  ];
  const availability = new Map<number, EditInForkAvailability>([[3, { available: true, forkTurn: 1 }]]);
  const html = renderToStaticMarkup(React.createElement(EventTimeline, {
    items,
    onEditAndResend: () => {},
    onEditInFork: () => {},
    editInForkAvailabilityByItem: availability,
  }));

  assert.equal((html.match(/aria-label="Edit as a New Turn"/g) ?? []).length, 2, "each prompt's hover cluster offers it");
  assert.equal((html.match(/title="Edit as a New Turn"/g) ?? []).length, 2, "its tooltip matches its name");
  assert.equal((html.match(/aria-label="More Message Actions"/g) ?? []).length, 2);
  const labels = (id: number) => messageActions(items.find((item) => item.id === id) as Extract<TimelineItem, { kind: "user_message" }>, {
    onEditAndResend: () => {},
    onEditInFork: () => {},
    editInForkAvailability: availability.get(id),
  }).map((action) => action.label);
  assert.deepEqual(labels(1), ["Copy Message", "Edit as a New Turn"]);
  assert.deepEqual(labels(3), ["Copy Message", "Edit as a New Turn", "Edit in a Fork…"]);
});

test("an offered but unusable Edit in Fork stays listed, disabled and says why (#1869)", () => {
  const reason = "Reconnect the runner before creating a fork.";
  const item = { kind: "user_message", id: 3, text: "second", turn: 2 } as Extract<TimelineItem, { kind: "user_message" }>;
  const editInFork = (availability: EditInForkAvailability) => messageActions(item, {
    onEditInFork: () => { throw new Error("an unavailable Edit in Fork must not open"); },
    editInForkAvailability: availability,
  }).find((action) => action.key === "edit-in-fork");

  const offered = editInFork({ available: false, offered: true, reason });
  assert.ok(offered, "the action stays listed");
  assert.equal(offered.label, "Edit in a Fork…");
  assert.equal(offered.unavailableReason, reason);
  assert.equal(offered.onSelect, undefined, "it cannot be selected");

  assert.equal(editInFork({
    available: false, offered: false, reason: "Historical edit-and-fork is available only for Codex App Server sessions.",
  }), undefined, "a message that can never be edited in a fork does not list it");
});

test("an unusable Edit as a New Turn stays listed on every user message, disabled and says why (#1876)", () => {
  const reason = "Runner is offline.";
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "first", turn: 1 },
    { kind: "user_message", id: 2, text: "second", turn: 2 },
  ];
  const render = (editAndResendUnavailableReason?: string) => renderToStaticMarkup(React.createElement(EventTimeline, {
    items,
    onEditAndResend: () => { throw new Error("an unavailable Edit as a New Turn must not open"); },
    editAndResendUnavailableReason,
  }));

  const blocked = render(reason);
  assert.doesNotMatch(blocked, /aria-label="Edit as a New Turn"/,
    "no hover button for an action that cannot be used; the menu says why");
  assert.equal((blocked.match(/aria-label="More Message Actions"/g) ?? []).length, 2, "every message keeps its menu");
  for (const item of items) {
    const edit = messageActions(item as Extract<TimelineItem, { kind: "user_message" }>, {
      onEditAndResend: () => {},
      editAndResendUnavailableReason: reason,
    }).find((action) => action.key === "edit");
    assert.equal(edit?.unavailableReason, reason);
  }

  const usable = render();
  assert.equal((usable.match(/aria-label="Edit as a New Turn"/g) ?? []).length, 2);
});

test("only never-offered runner authentication outcomes get readable resolution labels", () => {
  assert.equal(permissionResolutionLabel([], "auth:select-account"), "Another Account Selected");
  assert.equal(permissionResolutionLabel([], "auth:automatic-retry"), "Rechecked Automatically");
  assert.equal(permissionResolutionLabel([{ optionId: "trust" }], "trust"), "trust",
    "an offered option keeps its established raw id display");
  assert.equal(permissionResolutionLabel([{ optionId: "auth:select-account" }], "auth:select-account"),
    "auth:select-account", "a provider option that reuses a runner id is still shown raw");
  assert.equal(permissionResolutionLabel([], "toString"), "toString",
    "an id matching an inherited property is never replaced");
});

/** Every incremental projection must equal a from-scratch one: folding retries may only ever cost
 * a full rebuild, never a stale row or ledger. */
function assertMatchesFullProjection(projector: IncrementalTimelineRows, items: TimelineItem[], disclosure: Map<string, boolean>) {
  const incremental = projector.project(items, disclosure);
  const full = new IncrementalTimelineRows().project(items, disclosure);
  assert.deepEqual(incremental.rows, full.rows);
  return incremental;
}

test("streamed retries fold into one row while every incremental projection matches a full one", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "retries", seq: sequence, ts: 1_000 * sequence, payload });
  };
  const projector = new IncrementalTimelineRows();
  push({ kind: "user_message", text: "Ship it" });
  push({ kind: "tool_call", toolCallId: "a1", title: "Bash: npm test", toolKind: "execute", status: "in_progress" });
  const first = projector.project(builder.snapshot(), new Map());
  const workKey = first.rows.find((row) => row.kind === "work_summary")!.key;
  const disclosure = new Map([[workKey, true]]);
  const ledger = (rows: readonly TimelineRenderRow[]) => {
    const summary = rows.find((row) => row.kind === "work_summary");
    return summary?.kind === "work_summary" ? [summary.tools, summary.failed] : null;
  };
  const steps = (rows: readonly TimelineRenderRow[]) => rows.flatMap((row) => row.kind === "item" && row.inWork
    ? [[row.key, row.item.id, row.attempts?.map((attempt) => attempt.id) ?? null]]
    : []);

  assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
  push({ kind: "tool_call_update", toolCallId: "a1", status: "failed", text: "Exit code 1" });
  let projection = assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
  assert.deepEqual(ledger(projection.rows), [1, 1], "a status change in place recounts the ledger");

  push({ kind: "tool_call", toolCallId: "a2", title: "Bash: npm test", toolKind: "execute", status: "in_progress" });
  projection = assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
  assert.deepEqual(steps(projection.rows), [["item:tool:a1", 4, [2, 4]]], "the second attempt folds under the first attempt's key");
  assert.deepEqual(ledger(projection.rows), [1, 0], "a running retry is not a failure yet");

  push({ kind: "tool_call_update", toolCallId: "a2", status: "failed", text: "Exit code 1" });
  push({ kind: "tool_call", toolCallId: "a3", title: "Bash: npm test", toolKind: "execute", status: "in_progress" });
  push({ kind: "tool_call_update", toolCallId: "a3", status: "failed", text: "Exit code 1" });
  projection = assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
  assert.deepEqual(steps(projection.rows), [["item:tool:a1", 6, [2, 4, 6]]]);
  assert.deepEqual(ledger(projection.rows), [1, 1]);

  push({ kind: "tool_call", toolCallId: "lint", title: "Bash: npm run lint", toolKind: "execute", status: "completed" });
  push({ kind: "agent_message", text: "Tests still fail.", final: true });
  projection = assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
  assert.deepEqual(steps(projection.rows).map((step) => step[0]), ["item:tool:a1", "item:tool:lint"]);
  assert.deepEqual(ledger(projection.rows), [2, 1]);
  assert.equal(projector.resolveRevealTarget(4)?.rowKey, "item:tool:a1", "every attempt reveals its folded row");
});

test("a subagent's retried call folds under its agent too", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "nested-retries", seq: sequence, ts: 1_000 * sequence, payload });
  };
  const projector = new IncrementalTimelineRows();
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "in_progress" });
  const workKey = projector.project(builder.snapshot(), new Map()).rows[0]!.key;
  const disclosure = new Map([[workKey, true]]);
  for (const id of ["c1", "c2"]) {
    push({ kind: "tool_call", toolCallId: id, title: "Read: a.ts", toolKind: "read", status: "in_progress", parentToolUseId: "task" });
    assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
    push({ kind: "tool_call_update", toolCallId: id, status: "failed", parentToolUseId: "task" });
    assertMatchesFullProjection(projector, builder.snapshot(), disclosure);
  }
  const rows = projector.project(builder.snapshot(), disclosure).rows;
  const nested = rows.filter((row) => row.kind === "item" && row.depth === 1);
  assert.equal(nested.length, 1);
  assert.deepEqual(nested[0]!.kind === "item" ? nested[0]!.attempts?.map((attempt) => attempt.toolCallId) : null, ["c1", "c2"]);
});

test("a run of work holding only Agent Logs renders only with Show Agent Logs on (#2184)", () => {
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "Start" },
    { kind: "stderr", id: 2, text: "codex 1.2.3 booting" },
    { kind: "agent_message", id: 3, text: "Started." },
    { kind: "user_message", id: 4, text: "Test it" },
    { kind: "tool_call", id: 5, toolCallId: "test", title: "Bash: npm test", toolKind: "execute", status: "completed", text: "" },
    { kind: "stderr", id: 6, text: "warning: deprecated flag" },
    { kind: "agent_message", id: 7, text: "Passed." },
  ];
  const groups = groupTimeline(items);
  const open = new Map(groups.flatMap((group) => group.kind === "work" ? [[`work:${group.id}`, true] as const] : []));
  const inWork = (rows: TimelineRenderRow[]) => rows.flatMap((row) => row.kind === "item" && row.inWork ? [row.item.id] : []);

  const hidden = flattenTimelineRows(groups, open, false);
  assert.equal(hidden.filter((row) => row.kind === "work_summary").length, 1, "only the run with a command renders");
  assert.deepEqual(inWork(hidden), [5, 6], "an Agent Log beside other work always renders");

  const shown = flattenTimelineRows(groups, open, true);
  assert.equal(shown.filter((row) => row.kind === "work_summary").length, 2, "the boot line's run renders when asked");
  assert.deepEqual(inWork(shown), [2, 5, 6]);
  assert.deepEqual(flattenTimelineRows(groups, open), shown, "a caller that does not choose keeps every row");
});

test("the incremental projector hides an Agent Log run until other work joins it, and follows the setting", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "agent-logs", seq: sequence, ts: sequence, payload });
  };
  const disclosure = new Map<string, boolean>();
  const fresh = (showAgentLogs: boolean) =>
    new IncrementalTimelineRows().project(builder.snapshot(), disclosure, showAgentLogs).rows;
  const projector = new IncrementalTimelineRows();

  push({ kind: "user_message", text: "Start" });
  push({ kind: "stderr", text: "codex 1.2.3 booting\n" });
  let projection = projector.project(builder.snapshot(), disclosure, false);
  assert.deepEqual(projection.rows.map((row) => row.kind), ["item"], "the boot-only run has no ledger line");
  assert.equal(projector.resolveRevealTarget(2), null, "a hidden Agent Log has no row to reveal");

  push({ kind: "stderr", text: "model: gpt\n" });
  projection = projector.project(builder.snapshot(), disclosure, false);
  assert.deepEqual(projection.rows, fresh(false), "more harness output keeps the run hidden");

  push({ kind: "tool_call", toolCallId: "ls", title: "Bash: ls", toolKind: "execute", status: "completed" } as SessionEventPayload);
  projection = projector.project(builder.snapshot(), disclosure, false);
  assert.deepEqual(projection.rows, fresh(false), "other work joining the run reveals its ledger line");
  assert.equal(projection.rows.filter((row) => row.kind === "work_summary").length, 1);
  assert.ok(projector.resolveRevealTarget(2), "the Agent Log is reachable once its run renders");

  push({ kind: "agent_message", text: "Listed." });
  push({ kind: "user_message", text: "Again" });
  push({ kind: "stderr", text: "codex reconnected\n" });
  projection = projector.project(builder.snapshot(), disclosure, false);
  assert.deepEqual(projection.rows, fresh(false), "a new boot-only run appended at the tail stays hidden");
  assert.equal(projection.rows.filter((row) => row.kind === "work_summary").length, 1);

  const shown = projector.project(builder.snapshot(), disclosure, true);
  assert.equal(shown.incremental, false, "turning the setting on re-projects every row");
  assert.deepEqual(shown.rows, fresh(true));
  assert.equal(shown.rows.filter((row) => row.kind === "work_summary").length, 2);
  const hiddenAgain = projector.project(builder.snapshot(), disclosure, false);
  assert.deepEqual(hiddenAgain.rows, fresh(false), "and turning it off hides the run again");
});

const agentRowShape = (rows: readonly TimelineRenderRow[]) => rows.map((row) =>
  row.kind === "item" ? `${row.key}@${row.depth}` : row.kind === "work_summary" ? row.key : `${row.key}@${row.depth}`);

test("an open agent's call output follows its steps, and a new step goes before it (#2183)", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "agent-output", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "task", title: "Task", toolKind: "agent", status: "running", text: '{"description":"Audit gates"}' });
  push({ kind: "agent_message", text: "first", final: true, parentToolUseId: "task" });
  const disclosure = new Map<string, boolean>([["work:head", true]]);
  const projector = new IncrementalTimelineRows();
  const initial = projector.project(builder.snapshot(), disclosure);
  assert.deepEqual(agentRowShape(initial.rows), [
    "work:head",
    "agent:task@0",
    "item:agent_message:2@1",
    "agent-output:task@1",
  ]);

  push({ kind: "agent_message", text: "second", final: true, parentToolUseId: "task" });
  const appended = projector.project(builder.snapshot(), disclosure);
  assert.equal(appended.incremental, true, "a new step of an agent with output stays on the incremental path");
  assert.deepEqual(agentRowShape(appended.rows), [
    "work:head",
    "agent:task@0",
    "item:agent_message:2@1",
    "item:agent_message:3@1",
    "agent-output:task@1",
  ]);
  assert.deepEqual(agentRowShape(appended.rows), agentRowShape(new IncrementalTimelineRows().project(builder.snapshot(), disclosure).rows),
    "the incremental rows equal a fresh projection");

  push({ kind: "tool_call_update", toolCallId: "task", status: "completed", text: "All gates pass." });
  const completed = projector.project(builder.snapshot(), disclosure);
  const output = completed.rows.find((row) => row.kind === "subagent_output");
  assert.equal(output?.kind === "subagent_output" ? output.tool.status : null, "completed", "the output row carries the settled call");
  assert.equal(output?.kind === "subagent_output" ? output.tool.text.endsWith("All gates pass.") : false, true);
  const summary = completed.rows.find((row) => row.kind === "subagent_summary");
  assert.equal(summary?.kind === "subagent_summary" ? summary.tool.status : null, "completed");
});

test("an agent's output row appears when its call first reports output, and closes with the agent (#2183)", () => {
  const builder = new TimelineBuilder();
  let sequence = 0;
  const push = (payload: SessionEventPayload) => {
    sequence += 1;
    builder.push({ id: sequence, sessionId: "agent-late-output", seq: sequence, ts: sequence, payload });
  };
  push({ kind: "tool_call", toolCallId: "task", title: "Coordinate Release Audit", toolKind: "agent", status: "running" });
  push({ kind: "agent_message", text: "working", final: true, parentToolUseId: "task" });
  const disclosure = new Map<string, boolean>([["work:head", true]]);
  const projector = new IncrementalTimelineRows();
  assert.equal(projector.project(builder.snapshot(), disclosure).rows.some((row) => row.kind === "subagent_output"), false,
    "a call without output has no output row");

  push({ kind: "tool_call_update", toolCallId: "task", status: "failed", text: "Agent failed: quota exhausted" });
  const failed = projector.project(builder.snapshot(), disclosure);
  assert.deepEqual(agentRowShape(failed.rows), ["work:head", "agent:task@0", "item:agent_message:2@1", "agent-output:task@1"]);

  const closed = projector.project(builder.snapshot(), new Map([["work:head", true], ["agent:task", false]]));
  assert.deepEqual(agentRowShape(closed.rows), ["work:head", "agent:task@0"], "collapsing the agent hides its output with its steps");
});

test("an in-place update of one of two agent calls sharing an id reaches its own agent and output rows (#2183)", () => {
  const agentCall = (id: number, status: string, text: string): TimelineItem =>
    ({ kind: "tool_call", id, toolCallId: "duplicate", title: `Agent ${id}`, toolKind: "agent", status, text });
  const before: TimelineItem[] = [agentCall(1, "running", "input"), agentCall(2, "running", "input")];
  const disclosure = new Map<string, boolean>([
    ["work:head", true],
    ["agent:duplicate:1", true],
    ["agent:duplicate:2", true],
  ]);
  const projector = new IncrementalTimelineRows();
  projector.project(before, disclosure);

  const after: TimelineItem[] = [agentCall(1, "completed", "result"), before[1]!];
  publishTimelineSnapshotDelta(after, { previous: before, dirtyFrom: 0, dirtyIndexes: [0], dirtyHasParentItems: false });
  const updated = projector.project(after, disclosure);
  const fresh = new IncrementalTimelineRows().project(after, disclosure);
  const view = (rows: readonly TimelineRenderRow[]) => rows.map((row) => row.kind === "work_summary"
    ? row.key
    : row.kind === "item" ? `${row.key}:${row.item.kind}` : `${row.key}:${row.tool.status}:${row.tool.text}`);
  assert.deepEqual(view(updated.rows), view(fresh.rows), "the retained rows equal a fresh projection");
  assert.deepEqual(view(updated.rows), [
    "work:head",
    "agent:duplicate:1:completed:result",
    "agent-output:duplicate:1:completed:result",
    "agent:duplicate:2:running:input",
    "agent-output:duplicate:2:running:input",
  ]);
});
