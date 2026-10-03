import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentQuestion } from "@wollipog/protocol";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline, type TimelineRevealRequest } from "../components/EventTimeline.js";
import {
  VirtualMeasurementCommitTestProvider,
  type VirtualScrollAnchor,
} from "../components/MeasuredVirtualList.js";
import { useFollowTail } from "../useFollowTail.js";
import { TranscriptTailControl, transcriptTailView } from "../components/TranscriptTailControl.js";
import "../styles.css";

const sentence = "A long transcript message must wrap naturally when the side panel narrows the reader, without colliding with the next message or its timestamp. ";
const longToken = "transcript_overflow_identifier_".repeat(12);
const pendingOverflowQuestions: AgentQuestion[] = [{
  id: "overflow-live-question-1",
  question: `Choose the live destination for ${longToken}`,
  options: [{
    label: `Destination ${longToken}`,
    description: `A live option description containing ${longToken}`,
  }],
}];
const structuredItems: TimelineItem[] = [
  {
    kind: "user_message",
    id: 201,
    text: `Please inspect ${longToken}`,
    images: [{
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    }],
    createdAt: Date.now() - 12_000,
  },
  {
    kind: "agent_thought",
    id: 210,
    text: `Reasoning about a long digest ${longToken}`,
    createdAt: Date.now() - 11_500,
    completedAt: Date.now() - 11_250,
  },
  {
    kind: "review_decision",
    id: 212,
    reviewId: "overflow-review-low",
    reviewer: { kind: "policy", id: "fixture-policy" },
    outcome: "allowed",
    riskLevel: "low",
    rationale: "Read-only inspection is permitted.",
    createdAt: Date.now() - 11_100,
  },
  {
    kind: "tool_call",
    id: 202,
    toolCallId: "overflow-tool",
    title: `Inspect ${longToken}`,
    toolKind: "read",
    status: "completed",
    text: `tool-output:${longToken}`,
    startedAt: Date.now() - 11_000,
    completedAt: Date.now() - 10_000,
  },
  {
    kind: "review_decision",
    id: 213,
    reviewId: "overflow-review-high",
    reviewer: { kind: "agent", id: "fixture-reviewer" },
    outcome: "allowed",
    riskLevel: "high",
    rationale: "The bounded fixture operation is permitted.",
    createdAt: Date.now() - 9_900,
  },
  {
    kind: "file_edit",
    id: 203,
    path: `/workspace/${longToken}/result.ts`,
    diff: `@@ -1 +1 @@\n-${longToken}\n+${longToken}-updated`,
  },
  {
    kind: "plan",
    id: 204,
    entries: [{ content: `Verify ${longToken}`, status: "in_progress" }],
  },
  {
    kind: "review_decision",
    id: 205,
    reviewId: "overflow-review",
    reviewer: { kind: "agent", id: "fixture-reviewer" },
    outcome: "escalated",
    riskLevel: "high",
    rationale: `The review rationale contains ordinary wrapping prose and ${longToken}.`,
  },
  {
    kind: "permission",
    id: 206,
    requestId: "overflow-permission",
    title: `Run ${longToken}`,
    options: [],
    resolvedOptionId: "allow_once",
    context: { input: `command --target ${longToken}` },
  },
  {
    kind: "question",
    id: 207,
    requestId: "overflow-question",
    questions: [{
      id: "overflow-question-1",
      question: `Which destination should receive ${longToken}?`,
      options: [],
    }, {
      id: "overflow-question-2",
      question: `Should the recap preserve ${longToken}?`,
      options: [],
    }],
    answered: true,
  },
  {
    kind: "question",
    id: 211,
    requestId: "overflow-live-question",
    questions: pendingOverflowQuestions,
  },
  {
    kind: "agent_message",
    id: 208,
    text: [
      `Ordinary prose must wrap beside a long identifier: ${longToken}.`,
      "",
      `Inline code \`${longToken}\` and [a long link](https://example.test/${longToken}) stay contained.`,
      "",
      "| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |",
      "",
      "```typescript",
      `const overflowFixtureIdentifier = "${longToken}";`,
      "```",
    ].join("\n"),
    createdAt: Date.now() - 4_000,
    lastActivityAt: Date.now() - 3_000,
    completedAt: Date.now() - 2_000,
  },
  { kind: "turn_interrupted", id: 209, createdAt: Date.now() - 1_000 },
];
// The markdown scenario (#2152): one reply with every block the type-scale rules cover, and a user
// message whose markdown renders inline.
const markdownItems: TimelineItem[] = [
  {
    kind: "user_message",
    id: 501,
    text: [
      "Please check `apps/web/src/components/Markdown.tsx` and:",
      "- keep **tables** whole",
      "- add a code header",
      "",
      "# Not a heading",
    ].join("\n"),
    createdAt: Date.now() - 6_000,
  },
  {
    kind: "agent_message",
    id: 502,
    text: [
      "# Review Notes",
      "",
      "The transcript markdown now sits on the type scale.",
      "",
      "## Summary",
      "",
      "| File | Lines | Added | Removed | Change |",
      "| --- | ---: | ---: | ---: | --- |",
      "| `apps/web/src/components/EventTimeline.tsx` | 124 | +24 | -3 | Renders user messages through the inline markdown profile |",
      "| `apps/web/src/components/Markdown.tsx` | 318 | +201 | -96 | Adds the code header, table wrapper and task boxes |",
      "| `apps/web/src/styles.css` | 162 | +118 | -64 | Moves the markdown rules onto tokens |",
      "",
      "### Code",
      "",
      "```typescript",
      "export function separatorBreaks(text: string): string[] {",
      "  return text.split(/(?<=[/._])/); // break after a slash, dot or underscore",
      "}",
      "```",
      "",
      "#### Checklist",
      "",
      "- [x] Headings on the type scale",
      "- [x] Table cells kept whole",
      "- [ ] Evidence reviewed",
    ].join("\n"),
    createdAt: Date.now() - 5_000,
    completedAt: Date.now() - 4_000,
  },
];
// The work ledger scenario (#2168): two settled turns. The first ran a nested agent; the second ran
// four commands, one of them failed and one retried twice before it passed, and one edit.
const ledgerStart = Date.now() - 600_000;
const ledgerTool = (
  id: number, title: string, toolKind: string, status: string, startSeconds: number, seconds: number, text = "",
  parentToolUseId?: string,
): TimelineItem => ({
  kind: "tool_call", id, toolCallId: `ledger-${id}`, title, toolKind, status, text,
  startedAt: ledgerStart + startSeconds * 1_000,
  lastActivityAt: ledgerStart + (startSeconds + seconds) * 1_000,
  completedAt: ledgerStart + (startSeconds + seconds) * 1_000,
  ...(parentToolUseId ? { parentToolUseId } : {}),
});
const validateFailure = "Exit code 1\n> app@1.4.0 validate\nChecking release manifest\nError: compatibility marker 1.3 does not match 1.4";
const ledgerItems: TimelineItem[] = [
  { kind: "user_message", id: 601, text: "Update the header copy.", createdAt: ledgerStart },
  ledgerTool(602, "Read: /workspace/app/src/components/Header.tsx", "read", "completed", 1, 1, "export function Header() {"),
  { kind: "file_edit", id: 603, path: "/workspace/app/src/components/Header.tsx", diff: "@@ -4 +4 @@\n-  <h1>Sessions</h1>\n+  <h1>Your Sessions</h1>" },
  ledgerTool(604, "Task: audit header copy", "agent", "completed", 3, 6),
  ledgerTool(605, "Grep: Sessions", "search", "completed", 4, 1, "src/components/Header.tsx:4", "ledger-604"),
  ledgerTool(606, "Bash: npm test -- header", "execute", "completed", 10, 7, "PASS src/components/Header.test.tsx"),
  { kind: "agent_message", id: 607, text: "Updated the header copy and its test.", createdAt: ledgerStart + 18_000 },
  { kind: "user_message", id: 611, text: "Run the full suite and fix what fails.", createdAt: ledgerStart + 60_000 },
  { kind: "agent_thought", id: 612, text: "Install first, then validate the release before the tests.", createdAt: ledgerStart + 61_000, completedAt: ledgerStart + 63_000 },
  ledgerTool(613, "Bash: npm ci", "execute", "completed", 63, 4, "added 412 packages"),
  ledgerTool(614, "Read: /workspace/app/src/release.ts", "read", "completed", 67, 1, "export const marker = \"1.3\";"),
  { kind: "file_edit", id: 615, path: "/workspace/app/src/release.ts", diff: "@@ -1 +1 @@\n-export const marker = \"1.3\";\n+export const marker = \"1.4\";" },
  ledgerTool(616, "Bash: npm run validate", "execute", "failed", 68, 3, validateFailure),
  ledgerTool(617, "Bash: npm run validate", "execute", "failed", 72, 3, validateFailure),
  ledgerTool(618, "Bash: npm run validate", "execute", "completed", 76, 3, "Release manifest valid"),
  ledgerTool(619, "Bash: npm test", "execute", "failed", 80, 6, "Exit code 1\nPASS src/release.test.ts\nFAIL src/header.test.ts\nError: expected \"Your Sessions\" to be \"Sessions\""),
  { kind: "agent_message", id: 620, text: "Validation passes after the marker fix; one header test still expects the old copy.", createdAt: ledgerStart + 87_000 },
];
// History dividers and Agent Logs (#2184): a turn whose only work is a harness boot line, the four
// history dividers, and a turn whose commands sit beside a stderr line.
const historyStart = Date.now() - 900_000;
const historyItems: TimelineItem[] = [
  { kind: "user_message", id: 701, text: "Start the release check.", createdAt: historyStart },
  { kind: "stderr", id: 702, text: "codex-cli 0.48.0 starting (model gpt-5.5, sandbox workspace-write)\n" },
  { kind: "agent_message", id: 703, text: "Started the release check; it runs in the background.", createdAt: historyStart + 4_000 },
  { kind: "conversation_checkpoint", id: 704, turn: 1 },
  { kind: "checkpoint_restored", id: 705, turn: 1 },
  { kind: "conversation_forked", id: 706, sourceSessionId: "release-check", turn: 1 },
  {
    kind: "conversation_forked", id: 707, sourceSessionId: "release-check", turn: 1,
    handoff: {
      sourceAgent: "Claude Code",
      destinationAgent: "Codex",
      // The shape conversation-handoff.ts writes: several sentences, so the description wraps.
      disclosure: "Portable visible dialogue through checkpoint event 12; 9 events or messages omitted (including tools, reasoning, questions, approvals and pending prompts). Dialogue was not truncated. Provider-private state and environment metadata are not transferred.",
    },
  },
  { kind: "provider_account_switched", id: 708, providerAccountId: "work", providerAccountLabel: "Work", automatic: true },
  { kind: "user_message", id: 711, text: "Run the tests.", createdAt: historyStart + 60_000 },
  ledgerTool(712, "Bash: npm test", "execute", "completed", 61, 6, "PASS src/release.test.ts\nPASS src/header.test.ts"),
  { kind: "stderr", id: 713, text: "npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported\nnpm warn deprecated rimraf@3.0.2\n" },
  ledgerTool(714, "Bash: npm run lint", "execute", "completed", 68, 3, "No problems found"),
  { kind: "agent_message", id: 715, text: "All tests and lint pass.", createdAt: historyStart + 72_000 },
  { kind: "conversation_checkpoint", id: 716, turn: 2 },
];
type TranscriptItem = Extract<TimelineItem, { kind: "agent_message" | "user_message" }>;
const baseItems: TranscriptItem[] = Array.from({ length: 30 }, (_, index) => index % 2 === 0
  ? { kind: "agent_message" as const, id: index + 1, text: `${index + 1}. ${sentence.repeat(30)}`, createdAt: Date.now() - index * 1_000 }
  : { kind: "user_message" as const, id: index + 1, text: `${index + 1}. ${sentence.repeat(22)}`, createdAt: Date.now() - index * 1_000 });

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const disabledFollowScrollRef = useRef<HTMLDivElement>(null);
  const followTailEnabled = useMemo(() => new URLSearchParams(window.location.search).get("follow") === "1", []);
  const revealFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("reveal") === "1", []);
  const offsetFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("offset") === "1", []);
  const deferredMeasurementFixture = useMemo(() => new URLSearchParams(window.location.search).get("defer") === "1", []);
  const predecessorRerenderFixture = useMemo(() => new URLSearchParams(window.location.search).get("predecessor-rerender") === "1", []);
  const overflowFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("overflow") === "1", []);
  const markdownFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("markdown") === "1", []);
  const ledgerFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("ledger") === "1", []);
  const questionHistoryFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("question-history") === "1", []);
  const historyFixtureEnabled = useMemo(() => new URLSearchParams(window.location.search).get("history") === "1", []);
  const [panelWidth, setPanelWidth] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  const [noticeMounted, setNoticeMounted] = useState(true);
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  const [headStreamTicks, setHeadStreamTicks] = useState(0);
  const [tailStreamTicks, setTailStreamTicks] = useState(0);
  const [liveReplyTicks, setLiveReplyTicks] = useState(0);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [sessionId, setSessionId] = useState("alpha");
  const [historyPrepend, setHistoryPrepend] = useState<Record<string, number>>({ alpha: 0, beta: 0 });
  const [historyReplacement, setHistoryReplacement] = useState<Record<string, number>>({ alpha: 0, beta: 0 });
  const [historyLimit, setHistoryLimit] = useState<Record<string, number | undefined>>({});
  const currentHistoryPrepend = historyPrepend[sessionId] ?? 0;
  const currentHistoryReplacement = historyReplacement[sessionId] ?? 0;
  const currentHistoryLimit = historyLimit[sessionId];
  const historyKey = `${sessionId}:${historyEpoch}`;
  // Make predecessor changes and a list-owned prop commit together, as they can in Session Detail.
  // This deterministically exercises the child layout effect before MutationObserver delivery.
  const timelineAriaLabel = predecessorRerenderFixture
    ? noticeMounted
      ? "Session Activity with Notice"
      : "Session Activity without Notice"
    : undefined;
  const [anchor, setAnchor] = useState<VirtualScrollAnchor | null>(null);
  const [revealRequest, setRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const [revealOutcome, setRevealOutcome] = useState("none");
  const revealSequenceRef = useRef(0);
  const anchorRef = useRef<VirtualScrollAnchor | null>(null);
  const getFixtureInitialAnchor = useCallback(() => anchorRef.current, []);
  const items = useMemo(() => {
    if (overflowFixtureEnabled) return structuredItems;
    if (markdownFixtureEnabled) return markdownItems;
    if (ledgerFixtureEnabled) return ledgerItems;
    if (historyFixtureEnabled) return historyItems;
    const prefix = Array.from({ length: currentHistoryPrepend }, (_, index): TimelineItem => ({
      kind: "agent_message",
      id: -(index + 1),
      text: `Recovered ${sessionId} history ${index + 1}. ${sentence.repeat(2)}`,
      createdAt: Date.now() - 100_000 - index * 1_000,
    }));
    const current = baseItems.map((item, index) => {
      const replacementId = currentHistoryReplacement === 0
        ? item.id
        : currentHistoryReplacement * 1_000 + item.id;
      if (index === 0 && item.kind === "agent_message") {
        return { ...item, id: replacementId, text: `${sessionId}. ${item.text}${sentence.repeat(headStreamTicks)}` };
      }
      if (index === baseItems.length - 1 && item.kind === "user_message") {
        return { ...item, id: replacementId, text: item.text + sentence.repeat(tailStreamTicks) };
      }
      return { ...item, id: replacementId };
    });
    const revealItems: TimelineItem[] = revealFixtureEnabled ? [
      { kind: "user_message", id: 100, text: "Reveal fixture boundary" },
      { kind: "tool_call", id: 101, toolCallId: "reveal-outer", title: "Outer Agent", toolKind: "agent", status: "running", text: "" },
      { kind: "tool_call", id: 102, toolCallId: "reveal-inner", title: "Inner Agent", toolKind: "agent", status: "running", text: "", parentToolUseId: "reveal-outer" },
      { kind: "agent_message", id: 103, text: "Deep reveal destination", parentToolUseId: "reveal-inner" },
      { kind: "user_message", id: 104, text: "Reveal fixture tail" },
      ...Array.from({ length: 12 }, (_, index): TimelineItem => ({
        kind: "agent_message",
        id: 105 + index,
        text: `Later transcript row ${index + 1}. ${sentence.repeat(4)}`,
      })),
    ] : [];
    const historicalQuestions: TimelineItem[] = questionHistoryFixtureEnabled ? [0, 1].map((index) => ({
      kind: "question",
      id: 301 + index,
      requestId: `historical-question-${index}`,
      answered: true,
      questions: [{
        id: `destination-${index}`,
        question: `Choose **destination ${index + 1}** for the release.`,
        context: "Verify `staging` first.\n\n- Review the [release checklist](https://example.test/checklist).\n- Confirm the selected destination.",
        options: [],
      }],
    })) : [];
    // A reply that starts streaming below the current tail: its row top stays inside the viewport
    // while it grows, so TanStack does not compensate scrollTop for its growth.
    const liveReply: TimelineItem[] = liveReplyTicks > 0 ? [{
      kind: "agent_message",
      id: 400,
      text: `Live reply. ${sentence.repeat(liveReplyTicks)}`,
      createdAt: Date.now(),
    }] : [];
    const complete = [...prefix, ...historicalQuestions, ...current, ...liveReply, ...revealItems];
    return currentHistoryLimit == null ? complete : complete.slice(0, currentHistoryLimit);
  }, [currentHistoryLimit, currentHistoryPrepend, currentHistoryReplacement, headStreamTicks, historyFixtureEnabled, ledgerFixtureEnabled, liveReplyTicks, markdownFixtureEnabled, overflowFixtureEnabled, questionHistoryFixtureEnabled, revealFixtureEnabled, sessionId, tailStreamTicks]);
  const followTail = useFollowTail({
    scrollRef: followTailEnabled ? scrollRef : disabledFollowScrollRef,
    contentRevision: `${sessionId}:${currentHistoryPrepend}:${currentHistoryReplacement}:${currentHistoryLimit ?? "all"}:${headStreamTicks}:${tailStreamTicks}:${liveReplyTicks}`,
    sessionId,
    persistenceScope: "timeline-reflow-e2e",
    rows: items,
  });
  const resizeTailAfterAnchorWindow = useCallback(() => {
    let frames = 12;
    const advance = () => {
      frames -= 1;
      if (frames > 0) {
        requestAnimationFrame(advance);
        return;
      }
      const tail = scrollRef.current?.querySelector<HTMLElement>("[data-virtual-key='item:user_message:30']");
      if (tail) tail.style.paddingBottom = "212px";
    };
    requestAnimationFrame(advance);
  }, []);
  const streamTailAndScroll = useCallback((behavior: ScrollBehavior, distance: number) => {
    setTailStreamTicks((ticks) => ticks + 1);
    // React commits the stream synchronously at the end of this click. Queueing the travel first
    // makes it land inside the virtual list's post-commit anchor-settle window.
    requestAnimationFrame(() => scrollRef.current?.scrollBy({ top: distance, behavior }));
  }, []);
  const captureAnchor = useCallback((next: VirtualScrollAnchor) => {
    if (followTailEnabled) followTail.onVisibleAnchorChange(next);
    anchorRef.current = next;
    setAnchor((current) => current?.key === next.key && Math.abs(current.offset - next.offset) < 0.1
      ? current
      : next);
  }, [followTail.onVisibleAnchorChange, followTailEnabled]);
  const handleAnchorLost = useCallback((lost: VirtualScrollAnchor) => {
    followTail.onAnchorLost(lost);
    setAnchor((current) => {
      if (current?.key !== lost.key) return current;
      anchorRef.current = null;
      return null;
    });
  }, [followTail.onAnchorLost]);
  const handleReveal = useCallback((
    requestId: number,
    outcome: "revealed" | "unresolved" | "cancelled",
  ) => {
    setRevealRequest(null);
    setRevealOutcome(`${requestId}:${outcome}`);
    if (outcome === "unresolved") followTail.follow();
  }, [followTail.follow]);
  return (
    <main style={{ display: "flex", width: "100vw", height: "100vh", background: "var(--bg)" }}>
      <section style={{ display: "flex", minWidth: 0, flex: 1, flexDirection: "column" }}>
        <div
          className="detail-scroll measured-virtual-scroll"
          ref={scrollRef}
          data-testid="reader"
          data-anchor-key={anchor?.key}
          data-anchor-offset={anchor?.offset}
          data-follow-tail-state={followTailEnabled ? followTail.state : undefined}
          data-session-id={sessionId}
          data-tail-stream-ticks={tailStreamTicks}
          onScroll={followTailEnabled ? followTail.onScroll : undefined}
          onWheel={followTailEnabled ? followTail.onWheel : undefined}
          onPointerMove={followTailEnabled ? followTail.onPointerMove : undefined}
          onTouchStart={followTailEnabled ? followTail.onTouchStart : undefined}
          onKeyDown={followTailEnabled ? (event) => {
            if (!followTail.onKeyDown(event)) return;
            event.preventDefault();
            event.stopPropagation();
          } : undefined}
          tabIndex={0}
        >
          {offsetFixtureEnabled && noticeMounted && (
            <div
              data-testid="width-sensitive-prefix"
              style={{
                alignItems: "center",
                background: "var(--surface-raised)",
                borderBottom: "1px solid var(--border)",
                boxSizing: "border-box",
                display: "flex",
                flex: "none",
                height: noticeExpanded ? 240 : Math.round((window.innerWidth - panelWidth) / 8),
                padding: "16px 20px",
              }}
            >
              Width-Sensitive Context Above the Timeline
            </div>
          )}
          <VirtualMeasurementCommitTestProvider deferred={deferredMeasurementFixture}>
            <EventTimeline
              items={items}
              workspaceRoot={ledgerFixtureEnabled ? "/workspace/app" : undefined}
              onOpenSession={historyFixtureEnabled ? openFixtureSession : undefined}
              ariaLabel={timelineAriaLabel}
              revealRequest={revealRequest}
              onRevealHandled={handleReveal}
              scrollRef={scrollRef}
              historyKey={historyKey}
              getInitialAnchor={followTailEnabled ? followTail.getInitialAnchor : getFixtureInitialAnchor}
              preserveAnchor={!followTailEnabled || !followTail.isFollowing}
              onVisibleAnchorChange={captureAnchor}
              onAnchorLost={followTailEnabled ? handleAnchorLost : undefined}
              questionContext={overflowFixtureEnabled ? {
                sessionId: "overflow-fixture",
                pendingQuestion: {
                  requestId: "overflow-live-question",
                  questions: pendingOverflowQuestions,
                },
                questionInTimeline: true,
                runnerOnline: true,
                showKeyHints: false,
              } : undefined}
            />
          </VirtualMeasurementCommitTestProvider>
        </div>
        {/* The real floating control (#2153), so painted-frame tests cover it coming and going. */}
        {followTailEnabled && (
          <TranscriptTailControl
            view={transcriptTailView({
              hasTail: items.length > 0,
              offscreenNotSent: 0,
              recovering: false,
              following: followTail.isFollowing,
              newRows: followTail.newRowCount,
            })}
            shortcut="End"
            readerRef={scrollRef}
            onJump={followTail.follow}
            onShowNotSent={() => {}}
            onFocusLost={() => scrollRef.current?.focus({ preventScroll: true })}
          />
        )}
        {/* Stands in for the auto-growing composer: a sibling below the reader in the same flex
            column, so its height changes resize the transcript viewport exactly like a draft
            wrapping onto more lines (and shrinking back) does in SessionDetail. */}
        {composerHeight > 0 && (
          <div
            data-testid="composer-spacer"
            style={{ flex: "none", height: composerHeight, borderTop: "1px solid var(--border)" }}
          />
        )}
      </section>
      <nav hidden={overflowFixtureEnabled} style={{ position: "fixed", zIndex: 2, top: questionHistoryFixtureEnabled ? undefined : 4, bottom: questionHistoryFixtureEnabled ? 4 : undefined, right: 4 }}>
        <button type="button" data-testid="close-panel" onClick={() => setPanelWidth(0)}>Close Panel</button>
        <button type="button" data-testid="medium-panel" onClick={() => setPanelWidth(460)}>Medium Panel</button>
        <button type="button" data-testid="wide-panel" onClick={() => setPanelWidth(540)}>Wide Panel</button>
        {offsetFixtureEnabled && (
          <>
            <button type="button" data-testid="toggle-notice-height" onClick={() => setNoticeExpanded((expanded) => !expanded)}>
              Toggle Notice Height
            </button>
            <button type="button" data-testid="toggle-notice-mount" onClick={() => setNoticeMounted((mounted) => !mounted)}>
              Toggle Notice Mount
            </button>
          </>
        )}
        <label>
          Panel Width
          <input
            aria-label="Panel Width"
            data-testid="panel-resizer"
            type="range"
            min="320"
            max="600"
            value={panelWidth || 460}
            onInput={(event) => setPanelWidth(Number(event.currentTarget.value))}
          />
        </label>
        <button type="button" data-testid="stream" onClick={() => setHeadStreamTicks((ticks) => ticks + 1)}>Stream Head</button>
        <button type="button" data-testid="stream-tail" onClick={() => setTailStreamTicks((ticks) => ticks + 1)}>Stream Tail</button>
        <button type="button" data-testid="stream-live-reply" onClick={() => setLiveReplyTicks((ticks) => ticks + 1)}>Stream Live Reply</button>
        <button type="button" data-testid="stream-tail-scroll" onClick={() => streamTailAndScroll("auto", 180)}>Stream Tail and Scroll</button>
        <button type="button" data-testid="stream-tail-smooth-page" onClick={() => {
          const distance = scrollRef.current?.clientHeight ?? 0;
          streamTailAndScroll("smooth", distance);
        }}>Stream Tail and Smooth Page</button>
        <button type="button" data-testid="resize-tail-late" onClick={resizeTailAfterAnchorWindow}>Resize Tail Late</button>
        {revealFixtureEnabled && <button type="button" data-testid="reveal-deep-event" onClick={() => {
          followTail.preview();
          revealSequenceRef.current += 1;
          setRevealRequest({ eventId: 103, requestId: revealSequenceRef.current, historyKey });
        }}>Reveal Deep Event</button>}
        {revealFixtureEnabled && <button type="button" data-testid="reveal-missing-event" onClick={() => {
          followTail.preview();
          revealSequenceRef.current += 1;
          setRevealRequest({ eventId: 999_999, requestId: revealSequenceRef.current, historyKey });
        }}>Reveal Missing Event</button>}
        {revealFixtureEnabled && <button type="button" data-testid="cancel-reveal" onClick={() => {
          followTail.preview();
          revealSequenceRef.current += 1;
          const request = { eventId: 103, requestId: revealSequenceRef.current, historyKey };
          flushSync(() => setRevealRequest(request));
          scrollRef.current?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
        }}>Cancel Reveal</button>}
        <button type="button" data-testid="session-alpha" onClick={() => setSessionId("alpha")}>Session Alpha</button>
        <button type="button" data-testid="session-beta" onClick={() => setSessionId("beta")}>Session Beta</button>
        <button type="button" data-testid="prepend-history" onClick={() => setHistoryPrepend((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? 0) + 3,
        }))}>Prepend History</button>
        <button type="button" data-testid="prepend-alpha-history" onClick={() => setHistoryPrepend((current) => ({
          ...current,
          alpha: (current.alpha ?? 0) + 3,
        }))}>Prepend Alpha History</button>
        <button type="button" data-testid="replace-history" onClick={() => {
          setHistoryReplacement((current) => ({
            ...current,
            [sessionId]: (current[sessionId] ?? 0) + 1,
          }));
          setHistoryLimit((current) => ({ ...current, [sessionId]: 3 }));
          setHistoryEpoch((epoch) => epoch + 1);
        }}>Replace History</button>
        <button type="button" data-testid="grow-composer" onClick={() => setComposerHeight((height) => height + 72)}>Grow Composer</button>
        <button type="button" data-testid="shrink-composer" onClick={() => setComposerHeight(0)}>Shrink Composer</button>
        {followTailEnabled && <button type="button" data-testid="pause-follow" onClick={followTail.pause}>Pause</button>}
        {followTailEnabled && <button type="button" data-testid="preview-follow" onClick={followTail.preview}>Preview</button>}
        {followTailEnabled && <button type="button" data-testid="resume-follow" onClick={followTail.follow}>Jump to Latest</button>}
        <button type="button" data-testid="remount" onClick={() => setHistoryEpoch((epoch) => epoch + 1)}>Remount</button>
      </nav>
      <output data-testid="reveal-outcome" hidden>{revealOutcome}</output>
      {panelWidth > 0 && <aside data-testid="panel" data-width={panelWidth} style={{ width: panelWidth, flex: "none" }} />}
    </main>
  );
}

const openFixtureSession = (sessionId: string) => { document.body.dataset.openedSession = sessionId; };

const fixtureTheme = new URLSearchParams(window.location.search).get("theme");
if (fixtureTheme === "light" || fixtureTheme === "dark") document.documentElement.setAttribute("data-theme", fixtureTheme);
createRoot(document.getElementById("root")!).render(<Fixture />);
