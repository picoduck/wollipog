import { forwardRef, useCallback, useRef, type MutableRefObject } from "react";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { isHeartbeatBusy, type SessionActivity } from "../activity.js";
import { encodeResourceId } from "../navigation.js";
import { useStoreSelector } from "../store.js";
import { InboxRow, type InboxRowProps } from "./InboxRow.js";
import { MeasuredVirtualList } from "./MeasuredVirtualList.js";

/**
 * A collapsed inbox row, measured. TanStack corrects from the real height on first paint, so these
 * only have to be close enough that the initial scrollbar is not absurd — and, since InboxView
 * restores an absolute `scrollTop`, close enough that a restore against unmeasured rows lands in
 * the same reading neighbourhood.
 *
 * Two numbers, not one, because #664 gave a session with an active worktree a third line. One
 * constant cannot be right for both, and an inbox of worktree sessions is the common case here:
 * every session created through the issue workflow requests a worktree. Measured across both
 * densities: two-line rows are 61-67px, three-line rows 82-88px, margins included.
 */
const INBOX_ROW_ESTIMATE = 64;
const INBOX_WORKTREE_ROW_ESTIMATE = 85;

const estimateInboxRow = ({ session }: InboxListEntry) =>
  session.worktrees?.some((worktree) => worktree.path === session.worktreePath)
    ? INBOX_WORKTREE_ROW_ESTIMATE
    : INBOX_ROW_ESTIMATE;

export interface InboxListEntry {
  session: SessionView;
  projectName: string;
  unread: boolean;
  reminder?: SessionReminderView;
}

export interface InboxEmptyState {
  title: string;
  description: string;
  showNewSession: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

function ConnectedInboxRow(props: Omit<InboxRowProps, "activity" | "activityNow">) {
  const activity = useStoreSelector((state) => state.activity.get(props.session.id));
  const activityNow = useStoreSelector((state) => isHeartbeatBusy(props.session.status) ? state.activityNow : 0);
  return <InboxRow {...props} activity={activity} activityNow={activityNow} />;
}

export const InboxList = forwardRef<HTMLDivElement, {
  entries: InboxListEntry[];
  selectedSessionId: string | null;
  pinnedSessionIds: ReadonlySet<string>;
  /** Test/story override. Production rows subscribe to their own activity entry. */
  activityBySession?: ReadonlyMap<string, SessionActivity>;
  stalledSessionIds: ReadonlySet<string>;
  /** Test/story override paired with `activityBySession`. */
  activityNow?: number;
  runningCount: number;
  queuedCount: number;
  startingCount: number;
  filtered: boolean;
  emptyState?: InboxEmptyState;
  onNewSession: () => void;
  onSelect: (sessionId: string) => void;
  onExpand: (sessionId: string) => void;
  onScrollPosition: (scrollTop: number) => void;
  onPointerTargetChange?: (pointerId: number, targeting: boolean, pointerType: string) => void;
  onPointerPressChange?: (pointerId: number, active: boolean, pointerType: string) => void;
  /** One stable callback shared by every row (#154); the keyboard path anchors at the row's box. */
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }) => void;
}>(function InboxList({
  entries,
  selectedSessionId,
  pinnedSessionIds,
  activityBySession,
  stalledSessionIds,
  activityNow,
  runningCount,
  queuedCount,
  startingCount,
  filtered,
  emptyState,
  onNewSession,
  onSelect,
  onExpand,
  onScrollPosition,
  onPointerTargetChange,
  onPointerPressChange,
  onSessionMenu,
}, ref) {
  // The scroll container is BOTH the forwarded ref (InboxView restores scrollTop through it) and
  // the virtualizer's viewport.
  //
  // A COMPOSED CALLBACK REF, not useImperativeHandle. Without a dependency array React tears the
  // handle down with `ref(null)` and republishes it on EVERY commit, even when the element is
  // identical — and InboxView's callback ref reapplies the cached scrollTop when it fires. After a
  // filter or reorder the virtualizer has just corrected scrollTop to hold the logical anchor, and
  // the republished ref overwrote that correction, jumping to a different row. With a dependency
  // array it was worse: `[]` froze the handle at the first render, which for the inbox is the empty
  // state that returns before attaching anything, so the forwarded ref stayed null forever.
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
  if (entries.length === 0) {
    return (
      <div className="inbox-zero" role="status" tabIndex={-1}>
        <div className="inbox-zero-mark" aria-hidden="true">✓</div>
        <strong>{filtered ? "No Matching Sessions" : emptyState?.title ?? "All Agents Unblocked"}</strong>
        <span>{filtered
          ? "Try a different search."
          : emptyState?.description ?? `Running: ${runningCount}. Queued: ${queuedCount}. Starting: ${startingCount}.`}</span>
        {!filtered && (emptyState?.showNewSession ?? true) && (
          <button type="button" className="btn primary sm" onClick={onNewSession}>
            New Session <kbd aria-hidden="true">C</kbd>
          </button>
        )}
        {!filtered && emptyState?.actionLabel && emptyState.onAction && (
          <button type="button" className="btn sm" onClick={emptyState.onAction}>{emptyState.actionLabel}</button>
        )}
      </div>
    );
  }

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
        // The list owns focus and points at its row through `aria-activedescendant`, so NO ROW ever
        // has DOM focus and the extractor's focused-row pin never fires. Without this the selected
        // row is unmounted as soon as it scrolls out, and the id in aria-activedescendant refers to
        // an element that does not exist — which is what keyboard navigation moves between.
        pinnedKey={selectedSessionId}
        preserveAnchor
        estimateSize={estimateInboxRow}
        scrollRef={listRef}
        overscan={6}
        rootRole="rowgroup"
        rowRole="presentation"
        renderItem={({ session, projectName, unread, reminder }, { index }) => {
          // The callbacks are passed THROUGH, not wrapped. `onSelect: () => onSelect(session.id)`
          // builds a new closure on every render, so every row's props differ by identity and the
          // memo compares unequal every time — the memoisation looked applied and did nothing.
          const rowProps = {
            optionId: `inbox-session-${encodeResourceId(session.id)}`,
            rowIndex: index + 1,
            session,
            projectName,
            selected: session.id === selectedSessionId,
            unread,
            reminder,
            pinned: pinnedSessionIds.has(session.id),
            stalled: stalledSessionIds.has(session.id),
            onSelect,
            onExpand,
            onSessionMenu,
          } satisfies Omit<InboxRowProps, "activity" | "activityNow">;
          return activityBySession && activityNow !== undefined
            ? <InboxRow {...rowProps} activity={activityBySession.get(session.id)} activityNow={activityNow} />
            : <ConnectedInboxRow {...rowProps} />;
        }}
      />
    </div>
  );
});
