import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline, type TimelineRevealRequest } from "../components/EventTimeline.js";
import {
  VirtualMeasurementCommitTestProvider,
  type VirtualScrollAnchor,
} from "../components/MeasuredVirtualList.js";
import { useFollowTail } from "../useFollowTail.js";
import "../styles.css";

const sentence = "A long transcript message must wrap naturally when the side panel narrows the reader, without colliding with the next message or its timestamp. ";
const longToken = "transcript_overflow_identifier_".repeat(12);
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
  const [panelWidth, setPanelWidth] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  const [noticeMounted, setNoticeMounted] = useState(true);
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  const [headStreamTicks, setHeadStreamTicks] = useState(0);
  const [tailStreamTicks, setTailStreamTicks] = useState(0);
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
    const complete = [...prefix, ...current, ...revealItems];
    return currentHistoryLimit == null ? complete : complete.slice(0, currentHistoryLimit);
  }, [currentHistoryLimit, currentHistoryPrepend, currentHistoryReplacement, headStreamTicks, overflowFixtureEnabled, revealFixtureEnabled, sessionId, tailStreamTicks]);
  const followTail = useFollowTail({
    scrollRef: followTailEnabled ? scrollRef : disabledFollowScrollRef,
    contentRevision: `${sessionId}:${currentHistoryPrepend}:${currentHistoryReplacement}:${currentHistoryLimit ?? "all"}:${headStreamTicks}:${tailStreamTicks}`,
    sessionId,
    persistenceScope: "timeline-reflow-e2e",
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
              ariaLabel={timelineAriaLabel}
              revealRequest={revealRequest}
              onRevealHandled={handleReveal}
              scrollRef={scrollRef}
              historyKey={historyKey}
              getInitialAnchor={followTailEnabled ? followTail.getInitialAnchor : getFixtureInitialAnchor}
              preserveAnchor={!followTailEnabled || !followTail.isFollowing}
              onVisibleAnchorChange={captureAnchor}
              onAnchorLost={followTailEnabled ? handleAnchorLost : undefined}
            />
          </VirtualMeasurementCommitTestProvider>
        </div>
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
      <nav hidden={overflowFixtureEnabled} style={{ position: "fixed", zIndex: 2, top: 4, right: 4 }}>
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
        {followTailEnabled && <button type="button" data-testid="resume-follow" onClick={followTail.follow}>Follow Live Output</button>}
        <button type="button" data-testid="remount" onClick={() => setHistoryEpoch((epoch) => epoch + 1)}>Remount</button>
      </nav>
      <output data-testid="reveal-outcome" hidden>{revealOutcome}</output>
      {panelWidth > 0 && <aside data-testid="panel" data-width={panelWidth} style={{ width: panelWidth, flex: "none" }} />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
