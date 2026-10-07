import { forwardRef, useCallback, useMemo, useRef, type MutableRefObject } from "react";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { hasRecentActivity, type SessionActivity } from "../activity.js";
import { encodeResourceId } from "../navigation.js";
import type { InboxThreadPosition } from "../inbox.js";
import { useStoreSelector } from "../store.js";
import { InboxRow, type InboxRowProps } from "./InboxRow.js";
import { MeasuredVirtualList } from "./MeasuredVirtualList.js";
import { useIsMobile } from "./useIsMobile.js";

/**
 * One virtualization estimate per row shape (#2209), each that shape's whole height, so a restored
 * scroll position lands where it was even against rows that have not been measured yet. The two-line
 * desktop and tablet row is exactly `--row-h-2`, read from the stylesheet because density and a coarse
 * pointer change it. The phone's three-line card is the midpoint of its two densities, measured on the
 * virtualizer's own row wrapper, margins included, which is what it positions from: 96px compact and
 * 102px comfortable.
 *
 * The breakpoint change itself is safe for the cached measurements: a viewport width change opens a
 * new measurement epoch in MeasuredVirtualList, which invalidates offscreen sizes and re-seeds the
 * mounted rows from the DOM while holding the reader's logical anchor.
 */
const INBOX_ROW_ESTIMATE_THREE_ROW = 99;
/** `--row-h-2` at the default density on a fine pointer (docs/design-system.md §2.8). */
const ROW_H_2_FALLBACK = 56;

const estimateThreeRowInboxRow = () => INBOX_ROW_ESTIMATE_THREE_ROW;

/** The current `--row-h-2`, in pixels. */
function twoLineRowHeight(): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return ROW_H_2_FALLBACK;
  const value = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--row-h-2"));
  return Number.isFinite(value) && value > 0 ? value : ROW_H_2_FALLBACK;
}

/**
 * Whether a row reads the row clock (#2209). Running and Starting rows draw the strip; a row that
 * shows it only for recent activity must notice when its ten minutes pass; a stalled row says how long
 * it has been silent. Every other row reads 0, so the minute tick does not re-render it; the tick on
 * which recent activity lapses flips the reading to 0, and that re-render is what drops the strip.
 */
export function inboxRowReadsClock(
  session: Pick<SessionView, "status">,
  activity: SessionActivity | undefined,
  stalled: boolean,
  now: number,
): boolean {
  return session.status === "running" || session.status === "starting" || stalled || hasRecentActivity(activity, now);
}

export interface InboxListEntry {
  session: SessionView;
  projectName: string;
  unread: boolean;
  reminder?: SessionReminderView;
  /** Absent for a flat list; InboxView threads its rows before handing them here (#896). */
  thread?: InboxThreadPosition;
}

function ConnectedInboxRow(props: Omit<InboxRowProps, "activity" | "activityNow">) {
  const activity = useStoreSelector((state) => state.activity.get(props.session.id));
  const activityNow = useStoreSelector((state) =>
    inboxRowReadsClock(props.session, state.activity.get(props.session.id), props.stalled, state.activityNow)
      ? state.activityNow
      : 0);
  return <InboxRow {...props} activity={activity} activityNow={activityNow} />;
}

export const InboxList = forwardRef<HTMLDivElement, {
  entries: InboxListEntry[];
  selectedSessionId: string | null;
  pinnedSessionIds: ReadonlySet<string>;
  pinnedAncestorSessionIds?: ReadonlySet<string>;
  /** Test/story override. Production rows subscribe to their own activity entry. */
  activityBySession?: ReadonlyMap<string, SessionActivity>;
  stalledSessionIds: ReadonlySet<string>;
  /** Test/story override paired with `activityBySession`. */
  activityNow?: number;
  onSelect: (sessionId: string) => void;
  onExpand: (sessionId: string) => void;
  onToggleThread?: (sessionId: string) => void;
  onScrollPosition: (scrollTop: number) => void;
  onPointerTargetChange?: (pointerId: number, targeting: boolean, pointerType: string) => void;
  onPointerPressChange?: (pointerId: number, active: boolean, pointerType: string) => void;
  /** One stable callback shared by every row (#154); the keyboard path anchors at the row's box. */
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }) => void;
  /** Each row's trailing Snooze and Archive (#2214): stable callbacks, like the ones above. */
  onSnooze?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  /** Decides the label of each row's Archive. */
  stopBeforeArchiveSupported?: boolean;
}>(function InboxList({
  entries,
  selectedSessionId,
  pinnedSessionIds,
  pinnedAncestorSessionIds = new Set(),
  activityBySession,
  stalledSessionIds,
  activityNow,
  onSelect,
  onExpand,
  onToggleThread,
  onScrollPosition,
  onPointerTargetChange,
  onPointerPressChange,
  onSessionMenu,
  onSnooze,
  onArchive,
  stopBeforeArchiveSupported = false,
}, ref) {
  // The breakpoint, read ONCE for the whole list rather than once per mounted card. The same answer
  // decides the rows' shape and the estimate the virtualizer positions unmeasured rows with, and
  // those two must never disagree: a list estimating 97px for rows that render at 56px puts a
  // restored scroll position most of a card out per row it has not measured yet. Only a phone keeps
  // the three-line card; desktops and tablets draw two-line rows (#2209).
  const threeRow = useIsMobile();
  const estimateTwoRowInboxRow = useMemo(() => {
    const height = twoLineRowHeight();
    return () => height;
  }, [threeRow]);
  // The scroll container is BOTH the forwarded ref (InboxView restores scrollTop through it) and
  // the virtualizer's viewport.
  //
  // A COMPOSED CALLBACK REF, not useImperativeHandle. Without a dependency array React tears the
  // handle down with `ref(null)` and republishes it on EVERY commit, even when the element is
  // identical — and InboxView's callback ref reapplies the cached scrollTop when it fires. After a
  // filter or reorder the virtualizer has just corrected scrollTop to hold the logical anchor, and
  // the republished ref overwrote that correction, jumping to a different row. With a dependency
  // array it was worse: `[]` froze the handle at the first render, which for the inbox was then an
  // empty state that returned before attaching anything, so the forwarded ref stayed null forever.
  // A callback ref fires only when the NODE changes, which is the actual event both sides want.
  const listRef = useRef<HTMLDivElement | null>(null);
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as MutableRefObject<HTMLDivElement | null>).current = node;
  }, [ref]);
  // Deliberately no scroll-into-view effect here. Keyboard navigation owns that:
  // moveSelection() in InboxView scrolls the newly selected row. A generic effect keyed on
  // selectedSessionId would also fire for mouse selection and on mount, fighting the scroll
  // position InboxView restores when collapsing out of the expanded view.
  return (
    <div
      ref={attachList}
      className="inbox-list measured-virtual-scroll"
      role="grid"
      aria-label="Sessions"
      aria-rowcount={entries.length}
      tabIndex={0}
      aria-activedescendant={selectedSessionId ? `inbox-session-${encodeResourceId(selectedSessionId)}` : undefined}
      onScroll={(event) => onScrollPosition(event.currentTarget.scrollTop)}
      onPointerEnter={(event) => onPointerTargetChange?.(event.pointerId, true, event.pointerType)}
      onPointerLeave={(event) => onPointerTargetChange?.(event.pointerId, false, event.pointerType)}
      onPointerDown={(event) => onPointerPressChange?.(event.pointerId, true, event.pointerType)}
      onPointerUp={(event) => onPointerPressChange?.(event.pointerId, false, event.pointerType)}
      onPointerCancel={(event) => onPointerPressChange?.(event.pointerId, false, event.pointerType)}
      onKeyDown={(event) => {
        // The platform context-menu interaction for the focused grid: the menu opens on the
        // ACTIVE row, anchored inside its box, and never navigates into the session.
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        if (selectedSessionId === null) return;
        const row = document.getElementById(`inbox-session-${encodeResourceId(selectedSessionId)}`);
        if (!row) return;
        event.preventDefault();
        const box = row.getBoundingClientRect();
        onSessionMenu(selectedSessionId, { x: box.left + 24, y: box.top + box.height / 2 });
      }}
    >
      {/* Virtualized, like the Board and the transcript already are. §F7 flagged this as the one
          unvirtualized list, and it is the longest: an inbox with 200 sessions mounted 200 rows,
          each with its own activity subscription. The scroll container stays THIS element so the
          restore-scroll-position contract in InboxView is unchanged, and the range extractor keeps
          the focused row mounted — aria-activedescendant points at a row that must exist. */}
      <MeasuredVirtualList
        items={entries}
        getKey={(entry) => entry.session.id}
        // The list owns selection through aria-activedescendant. Without this explicit selection
        // pin the selected row is unmounted as soon as it scrolls out, and the id in
        // aria-activedescendant refers to an element that does not exist — which is what keyboard
        // navigation moves between.
        pinnedKey={selectedSessionId}
        preserveAnchor
        estimateSize={threeRow ? estimateThreeRowInboxRow : estimateTwoRowInboxRow}
        scrollRef={listRef}
        overscan={6}
        rootRole="rowgroup"
        rowRole="presentation"
        renderItem={({ session, projectName, unread, reminder, thread }, { index }) => {
          // The callbacks are passed THROUGH, not wrapped. `onSelect: () => onSelect(session.id)`
          // builds a new closure on every render, so every row's props differ by identity and the
          // memo compares unequal every time — the memoisation looked applied and did nothing.
          const rowProps = {
            optionId: `inbox-session-${encodeResourceId(session.id)}`,
            rowIndex: index + 1,
            threeRow,
            session,
            projectName,
            selected: session.id === selectedSessionId,
            unread,
            reminder,
            pinned: pinnedSessionIds.has(session.id),
            containsPinned: Boolean(thread?.collapsed && pinnedAncestorSessionIds.has(session.id)),
            stalled: stalledSessionIds.has(session.id),
            threadDepth: thread?.depth ?? 0,
            threadLast: thread?.last ?? false,
            // A string, so a parent whose children have not changed keeps its memoised row.
            threadChildren: thread?.children ? JSON.stringify(thread.children) : null,
            threadCollapsed: thread?.collapsed ?? false,
            onSelect,
            onExpand,
            onToggleThread,
            onSessionMenu,
            onSnooze,
            onArchive,
            stopBeforeArchiveSupported,
          } satisfies Omit<InboxRowProps, "activity" | "activityNow">;
          return activityBySession && activityNow !== undefined
            ? <InboxRow {...rowProps} activity={activityBySession.get(session.id)} activityNow={activityNow} />
            : <ConnectedInboxRow {...rowProps} />;
        }}
      />
    </div>
  );
});
