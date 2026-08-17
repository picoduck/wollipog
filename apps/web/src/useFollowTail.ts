import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { VirtualScrollAnchor } from "./components/MeasuredVirtualList.js";
import { dispatchVirtualViewportIntent } from "./viewport-intent.js";

export const FOLLOW_TAIL_THRESHOLD_PX = 48;
export const FOLLOW_TAIL_RESUME_THRESHOLD_PX = 2;
export const FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS = 120;
export const FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS = 120;
const FOLLOW_TAIL_PROGRAMMATIC_SCROLL_MAX_MS = 2_000;
const FOLLOW_TAIL_SETTLE_FRAMES = 8;

export type FollowTailState = "following" | "paused" | "previewing";

export const FOLLOW_TAIL_LABELS: Readonly<Record<FollowTailState, string>> = {
  following: "Following Live Output",
  paused: "Paused",
  previewing: "Previewing",
};

export function followTailControlLabel(state: FollowTailState, stateLabel = FOLLOW_TAIL_LABELS[state]): string {
  return state === "following" ? stateLabel : `${stateLabel}, Follow Live Output`;
}

export function followTailControlTooltip(
  state: FollowTailState,
  readingKeysActive: boolean,
  followShortcut: string,
): string {
  if (state === "following") return FOLLOW_TAIL_LABELS.following;
  return readingKeysActive ? `Follow Live Output (${followShortcut})` : "Follow Live Output";
}

export function followTailSurfaceLabel(
  state: FollowTailState,
  mode: "preview" | "expanded",
  isMobile: boolean,
): string {
  if (state === "following") return FOLLOW_TAIL_LABELS.following;
  if (state === "previewing") return FOLLOW_TAIL_LABELS.previewing;
  if (isMobile) return FOLLOW_TAIL_LABELS.paused;
  return mode === "preview" ? "Paused" : FOLLOW_TAIL_LABELS.paused;
}

export interface FollowTailMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowTailKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface UseFollowTailOptions {
  /** The mounted transcript element. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Changes whenever streamed or optimistic transcript content changes. */
  contentRevision: unknown;
  /** The session itself is the reset boundary; display-mode changes are intentionally omitted. */
  sessionId: string;
  /** Separates saved reader positions for the same session on different instances. */
  persistenceScope?: string;
}

export interface FollowTailApi {
  state: FollowTailState;
  label: string;
  isFollowing: boolean;
  pause: () => void;
  preview: () => void;
  /** Claims viewport movement before Inbox paging starts its programmatic scroll. */
  beginProgrammaticScroll: (direction: "next" | "previous") => void;
  follow: () => void;
  /** Stable mount-time reader for the latest persisted logical anchor. */
  getInitialAnchor: () => VirtualScrollAnchor | null;
  onVisibleAnchorChange: (anchor: VirtualScrollAnchor) => void;
  onAnchorLost: (anchor: VirtualScrollAnchor) => void;
  onScroll: () => void;
  onWheel: (event: Pick<WheelEvent, "deltaY">) => void;
  onPointerMove: (event: Pick<PointerEvent, "buttons">) => void;
  onTouchStart: () => void;
  /** Returns true when the caller should consume the key event. */
  onKeyDown: (event: FollowTailKey) => boolean;
}

export function isAtFollowTailBottom(
  metrics: FollowTailMetrics,
  threshold = FOLLOW_TAIL_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function nextFollowTailState(
  state: FollowTailState,
  event: "pause" | "preview" | "resume",
): FollowTailState {
  if (event === "pause") return "paused";
  if (event === "preview") return "previewing";
  if (event === "resume") return "following";
  return state;
}

interface FollowTailSnapshot {
  state: FollowTailState;
  anchor: VirtualScrollAnchor | null;
}

const MAX_FOLLOW_TAIL_SNAPSHOTS = 200;
const followTailSnapshots = new Map<string, FollowTailSnapshot>();

function snapshotKey(scope: string, sessionId: string): string {
  return `${scope.length}:${scope}${sessionId}`;
}

function loadSnapshot(key: string): FollowTailSnapshot {
  const snapshot = followTailSnapshots.get(key);
  return snapshot ? { state: snapshot.state, anchor: snapshot.anchor && { ...snapshot.anchor } } : {
    state: "following",
    anchor: null,
  };
}

function storeSnapshot(key: string, snapshot: FollowTailSnapshot): void {
  followTailSnapshots.delete(key);
  followTailSnapshots.set(key, { state: snapshot.state, anchor: snapshot.anchor && { ...snapshot.anchor } });
  while (followTailSnapshots.size > MAX_FOLLOW_TAIL_SNAPSHOTS) {
    const oldest = followTailSnapshots.keys().next().value as string | undefined;
    if (oldest == null) break;
    followTailSnapshots.delete(oldest);
  }
}

function isUpwardReadingKey(event: FollowTailKey): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === "k" || event.key === "ArrowUp" || event.key === "PageUp" ||
    event.key === "Home" || (event.key === " " && event.shiftKey);
}

export function isFollowTailResumeKey(event: FollowTailKey): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === "End" || (event.shiftKey && event.key.toLowerCase() === "g");
}

/** Owns the following/paused transition rules and all automatic bottom-scroll requests. */
export function useFollowTail({
  scrollRef,
  contentRevision,
  sessionId,
  persistenceScope = "default",
}: UseFollowTailOptions): FollowTailApi {
  const initialKey = snapshotKey(persistenceScope, sessionId);
  const initialSnapshotRef = useRef<FollowTailSnapshot | undefined>(undefined);
  if (!initialSnapshotRef.current) initialSnapshotRef.current = loadSnapshot(initialKey);
  const [, setState] = useState<FollowTailState>(initialSnapshotRef.current.state);
  const stateRef = useRef<FollowTailState>(initialSnapshotRef.current.state);
  const anchorRef = useRef<VirtualScrollAnchor | null>(initialSnapshotRef.current.anchor);
  const activeKeyRef = useRef(initialKey);
  const previousSessionIdRef = useRef(sessionId);
  const followFrameRef = useRef<number | null>(null);
  const followFramesRemainingRef = useRef(0);
  const resizeFollowOwnsScrollRef = useRef(false);
  const scrollIntentTimerRef = useRef<number | null>(null);
  const viewportGeometryRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
  const programmaticScrollRef = useRef<{
    direction: "next" | "previous";
    settleTimer: number | null;
    maxTimer: number;
  } | null>(null);

  const currentKey = snapshotKey(persistenceScope, sessionId);
  if (activeKeyRef.current !== currentKey) {
    const restored = loadSnapshot(currentKey);
    activeKeyRef.current = currentKey;
    stateRef.current = restored.state;
    anchorRef.current = restored.anchor;
  }

  const persist = useCallback(() => {
    storeSnapshot(activeKeyRef.current, { state: stateRef.current, anchor: anchorRef.current });
  }, []);

  const transition = useCallback((event: "pause" | "preview" | "resume") => {
    const next = nextFollowTailState(stateRef.current, event);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    storeSnapshot(activeKeyRef.current, { state: next, anchor: anchorRef.current });
  }, []);

  /**
   * Samples viewport geometry and reports whether it changed since the previous sample. A scroll
   * event that coincides with a geometry change is layout-driven — composer growth, a panel
   * resize, or the browser clamping scrollTop after the viewport grew — never reader intent.
   */
  const consumeViewportGeometryChange = useCallback((metrics: FollowTailMetrics): boolean => {
    const previous = viewportGeometryRef.current;
    viewportGeometryRef.current = { scrollHeight: metrics.scrollHeight, clientHeight: metrics.clientHeight };
    return previous != null &&
      (previous.scrollHeight !== metrics.scrollHeight || previous.clientHeight !== metrics.clientHeight);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight });
  }, [scrollRef]);

  const cancelScheduledFollow = useCallback(() => {
    followFramesRemainingRef.current = 0;
    resizeFollowOwnsScrollRef.current = false;
    if (followFrameRef.current != null) {
      window.cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
  }, []);

  const cancelScheduledScrollIntent = useCallback(() => {
    if (scrollIntentTimerRef.current == null) return;
    window.clearTimeout(scrollIntentTimerRef.current);
    scrollIntentTimerRef.current = null;
  }, []);

  const cancelProgrammaticScroll = useCallback(() => {
    const ownership = programmaticScrollRef.current;
    if (!ownership) return;
    if (ownership.settleTimer != null) window.clearTimeout(ownership.settleTimer);
    window.clearTimeout(ownership.maxTimer);
    programmaticScrollRef.current = null;
  }, []);

  const finishProgrammaticScroll = useCallback(() => {
    const ownership = programmaticScrollRef.current;
    if (!ownership) return;
    const direction = ownership.direction;
    cancelProgrammaticScroll();
    const element = scrollRef.current;
    if (direction === "next" && element && stateRef.current !== "following" &&
        isAtFollowTailBottom(element, FOLLOW_TAIL_RESUME_THRESHOLD_PX)) {
      transition("resume");
    }
  }, [cancelProgrammaticScroll, scrollRef, transition]);

  const scheduleFollow = useCallback((ownsResizeScroll = false) => {
    if (stateRef.current !== "following") return;
    // A virtualized streaming row can finish measuring several frames after the content commit.
    // Keep a bounded convergence window alive; every later mutation/resize refreshes that window.
    // Explicit reader intent cancels it synchronously through pause().
    followFramesRemainingRef.current = FOLLOW_TAIL_SETTLE_FRAMES;
    if (ownsResizeScroll) resizeFollowOwnsScrollRef.current = true;
    if (followFrameRef.current != null) return;
    const advance = () => {
      followFrameRef.current = null;
      if (stateRef.current !== "following") {
        followFramesRemainingRef.current = 0;
        resizeFollowOwnsScrollRef.current = false;
        return;
      }
      if (scrollIntentTimerRef.current != null) {
        if (!resizeFollowOwnsScrollRef.current) return;
        cancelScheduledScrollIntent();
      }
      scrollToBottom();
      followFramesRemainingRef.current -= 1;
      if (followFramesRemainingRef.current > 0) {
        followFrameRef.current = window.requestAnimationFrame(advance);
      } else {
        resizeFollowOwnsScrollRef.current = false;
      }
    };
    followFrameRef.current = window.requestAnimationFrame(advance);
  }, [cancelScheduledScrollIntent, scrollToBottom]);

  const pause = useCallback(() => {
    cancelProgrammaticScroll();
    cancelScheduledFollow();
    cancelScheduledScrollIntent();
    transition("pause");
  }, [cancelProgrammaticScroll, cancelScheduledFollow, cancelScheduledScrollIntent, transition]);
  const preview = useCallback(() => {
    cancelProgrammaticScroll();
    cancelScheduledFollow();
    cancelScheduledScrollIntent();
    transition("preview");
  }, [cancelProgrammaticScroll, cancelScheduledFollow, cancelScheduledScrollIntent, transition]);
  const beginProgrammaticScroll = useCallback((direction: "next" | "previous") => {
    preview();
    programmaticScrollRef.current = {
      direction,
      settleTimer: null,
      maxTimer: window.setTimeout(finishProgrammaticScroll, FOLLOW_TAIL_PROGRAMMATIC_SCROLL_MAX_MS),
    };
  }, [finishProgrammaticScroll, preview]);
  const follow = useCallback(() => {
    cancelProgrammaticScroll();
    transition("resume");
    dispatchVirtualViewportIntent(scrollRef.current);
    scrollToBottom();
    scheduleFollow();
  }, [cancelProgrammaticScroll, scheduleFollow, scrollRef, scrollToBottom, transition]);

  const onWheel = useCallback((event: Pick<WheelEvent, "deltaY">) => {
    if (event.deltaY < 0) {
      pause();
      return;
    }
    cancelProgrammaticScroll();
  }, [cancelProgrammaticScroll, pause]);
  const onPointerMove = useCallback((event: Pick<PointerEvent, "buttons">) => {
    if ((event.buttons & 1) !== 0) pause();
  }, [pause]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const layoutDriven = consumeViewportGeometryChange(element);
    const ownership = programmaticScrollRef.current;
    if (ownership) {
      const atBottom = isAtFollowTailBottom(element, FOLLOW_TAIL_RESUME_THRESHOLD_PX);
      if ((ownership.direction === "previous" && atBottom) ||
          (ownership.direction === "next" && !atBottom)) {
        if (ownership.settleTimer != null) window.clearTimeout(ownership.settleTimer);
        ownership.settleTimer = null;
        return;
      }
      if (ownership.settleTimer != null) window.clearTimeout(ownership.settleTimer);
      ownership.settleTimer = window.setTimeout(
        finishProgrammaticScroll,
        FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS,
      );
      return;
    }
    if (stateRef.current !== "following") {
      cancelScheduledScrollIntent();
      // A clamped scrollTop after the viewport grew (for example composer shrink) lands exactly on
      // the bottom without any reader intent; only a scroll with settled geometry may resume.
      if (!layoutDriven && isAtFollowTailBottom(element, FOLLOW_TAIL_RESUME_THRESHOLD_PX)) {
        transition("resume");
      }
      return;
    }
    if (isAtFollowTailBottom(element)) {
      cancelScheduledScrollIntent();
      transition("resume");
      return;
    }
    if (stateRef.current !== "following" || scrollIntentTimerRef.current != null) return;
    // Variable-height virtualizer corrections can span several animation frames. Give their
    // ResizeObserver follow request a brief window to cancel this fallback; without one, a bare
    // reader scroll (for example a platform scrollbar or assistive technology) should pause.
    scrollIntentTimerRef.current = window.setTimeout(() => {
      scrollIntentTimerRef.current = null;
      const current = scrollRef.current;
      if (current && stateRef.current === "following" && !isAtFollowTailBottom(current)) {
        pause();
      }
    }, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS);
  }, [cancelScheduledScrollIntent, consumeViewportGeometryChange, finishProgrammaticScroll, pause, scrollRef, transition]);

  const onKeyDown = useCallback((event: FollowTailKey) => {
    if (isFollowTailResumeKey(event)) {
      follow();
      return true;
    }
    if (isUpwardReadingKey(event)) pause();
    return false;
  }, [follow, pause]);

  useLayoutEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setState(stateRef.current);
    if (stateRef.current === "following") {
      scrollToBottom();
      scheduleFollow();
    }
  }, [scheduleFollow, scrollToBottom, sessionId]);

  useLayoutEffect(() => {
    if (stateRef.current !== "following") return;
    scrollToBottom();
    scheduleFollow();
  }, [contentRevision, scheduleFollow, scrollToBottom]);

  // Virtualized rows are measured after React commits. The first content-revision scroll can
  // therefore target the OLD scrollHeight; observe the rendered transcript's actual size and
  // follow again once those late measurements land. Character-data observation also covers a
  // streaming chunk whose existing row grows before the virtualizer publishes its new height.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observed = new Set<Element>();
    const resizeObserver = new ResizeObserver(() => {
      // Refresh the geometry sample so the next bare scroll is judged against the settled layout.
      const current = scrollRef.current;
      if (current) consumeViewportGeometryChange(current);
      // A measured geometry change explains an otherwise bare scroll event. It owns this one
      // correction; ordinary content-settle frames do not cancel reader intent.
      cancelScheduledScrollIntent();
      // Re-pin in this same pre-paint delivery: this frame's animation callbacks already ran, so
      // deferring the first correction would paint one frame off the tail (the composer bounce).
      if (stateRef.current === "following") scrollToBottom();
      scheduleFollow(true);
    });
    // Panel and window resizing changes the reader border box before every virtual row necessarily
    // publishes a new height. Observe the viewport itself so following owns the complete reflow
    // window and a layout-driven scroll event cannot be misclassified as reader intent.
    resizeObserver.observe(element);
    const observeChildren = () => {
      for (const child of element.children) {
        if (observed.has(child)) continue;
        observed.add(child);
        resizeObserver.observe(child);
      }
    };
    observeChildren();
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      observeChildren();
      scheduleFollow();
    });
    mutationObserver?.observe(element, { childList: true, subtree: true, characterData: true });
    scheduleFollow();
    return () => {
      mutationObserver?.disconnect();
      resizeObserver.disconnect();
    };
  }, [cancelScheduledScrollIntent, consumeViewportGeometryChange, scrollRef, scheduleFollow, scrollToBottom, sessionId]);

  useLayoutEffect(() => () => {
    persist();
    cancelProgrammaticScroll();
    cancelScheduledFollow();
    cancelScheduledScrollIntent();
  }, [cancelProgrammaticScroll, cancelScheduledFollow, cancelScheduledScrollIntent, persist]);

  const onVisibleAnchorChange = useCallback((anchor: VirtualScrollAnchor) => {
    anchorRef.current = anchor;
    storeSnapshot(activeKeyRef.current, { state: stateRef.current, anchor });
  }, []);

  const onAnchorLost = useCallback((anchor: VirtualScrollAnchor) => {
    if (anchorRef.current?.key !== anchor.key) return;
    anchorRef.current = null;
    follow();
  }, [follow]);

  const getInitialAnchor = useCallback(() =>
    stateRef.current === "following" ? null : anchorRef.current, []);

  const currentState = stateRef.current;

  return {
    state: currentState,
    label: FOLLOW_TAIL_LABELS[currentState],
    isFollowing: currentState === "following",
    pause,
    preview,
    beginProgrammaticScroll,
    follow,
    getInitialAnchor,
    onVisibleAnchorChange,
    onAnchorLost,
    onScroll,
    onWheel,
    onPointerMove,
    onTouchStart: pause,
    onKeyDown,
  };
}
