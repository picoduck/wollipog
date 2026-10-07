import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { memo, type MouseEvent } from "react";
import { useLongPress } from "./interactions.js";
import { sessionArchiveControlLabel } from "../archive-actions.js";
import { STALL_THRESHOLD_MS, showsActivityStrip, type SessionActivity } from "../activity.js";
import { relativeTime } from "../format.js";
import { formatReminderReturn } from "../reminder-schedule.js";
import { reminderBadgeDescription } from "../session-reminders.js";
import { sessionArchiveActionRefusal } from "../session-command-permissions.js";
import { sessionRowStatus } from "../session-row-status.js";
import { sessionDisplayTitle } from "../session-title.js";
import { useOptionalStoreSelector } from "../store.js";
import { displayBaseRef, pullRequestStateLabel, sessionBranchState } from "../worktree-identity.js";
import { AgentIcon } from "./AgentIcon.js";
import { ActivityStrip } from "./ActivityStrip.js";
import { SessionPinIndicator, ThreadDot } from "./common.js";
import { AlarmClockIcon, ArchiveIcon, BranchIcon, MoreHorizontalIcon, PullRequestIcon } from "./Icons.js";
import { SessionRowStatusBadge } from "./SessionRowStatusBadge.js";
import { sessionAgentLabel } from "./agent-options.js";
import { inboxThreadChildrenLabel, type InboxThreadChildren } from "../inbox.js";

export interface InboxRowProps {
  optionId: string;
  session: SessionView;
  projectName: string;
  selected: boolean;
  unread: boolean;
  pinned: boolean;
  /** A collapsed ancestor is promoted by a pin below it without claiming the ancestor is pinned. */
  containsPinned?: boolean;
  /**
   * 1-based position in the WHOLE inbox, not in the mounted window.
   *
   * A virtualized grid exposes only the rows it has mounted, so without this a screen reader reads
   * the tenth row of a two-hundred-session inbox as "row 1 of 12". It belongs on the `role="row"`
   * element; the virtualizer's positioned wrappers are presentational and expose nothing.
   */
  rowIndex: number;
  /**
   * The row's responsive shape (#2209). `true` is the phone's three-line card: the sender, the
   * title, then the status line. `false` is the two-line row of desktops and tablets, exactly
   * `--row-h-2` tall: the status line, then the title line.
   *
   * A PROP, not a `useIsMobile()` call in this component. The list already has to know the breakpoint
   * to pick its virtualization estimate, and reading it here as well would put one media
   * subscription on every mounted card and let the two answers disagree for a frame mid-resize.
   */
  threeRow: boolean;
  activity?: SessionActivity;
  stalled: boolean;
  /** The row clock. Rows that cannot change with time get 0, so they do not re-render every minute. */
  activityNow: number;
  reminder?: SessionReminderView;
  /**
   * The row's place in its thread (#896). `threadDepth` is 1 for a child rendered under its parent
   * and 0 otherwise; `threadLast` marks the last visible child, where the spine ends.
   * `threadChildren` is the parent's rollup, JSON-encoded: a STRING, so that a parent row whose
   * children have not changed compares equal under the memo below, exactly like the primitives.
   */
  threadDepth?: number;
  threadLast?: boolean;
  threadChildren?: string | null;
  threadCollapsed?: boolean;
  /** Whether archiving a running session stops it first, which decides the Archive button's label. */
  stopBeforeArchiveSupported?: boolean;
  /** Take the id, so the parent can pass ONE stable callback to every row. */
  onSelect: (sessionId: string) => void;
  onExpand: (sessionId: string) => void;
  onToggleThread?: (sessionId: string) => void;
  /** Right-click, long-press, the row's ⋯, or keyboard context menu for this row's session (#154). */
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }) => void;
  /** The row's trailing Snooze (#2214). Absent where the control plane has no reminders. */
  onSnooze?: (sessionId: string) => void;
  /** The row's trailing Archive (#2214). */
  onArchive?: (sessionId: string) => void;
}

/** When a row last did something: its newest event, else its last update, so no row shows "—". */
function inboxRowTimestamp(session: Pick<SessionView, "lastEventAt" | "updatedAt" | "createdAt">,
  activity?: Pick<SessionActivity, "lastEventAt">): number | null {
  return Math.max(session.lastEventAt ?? 0, activity?.lastEventAt ?? 0) || session.updatedAt || session.createdAt || null;
}

function InboxRowInner({
  optionId,
  session,
  projectName,
  selected,
  unread,
  pinned,
  containsPinned = false,
  rowIndex,
  threeRow,
  activity,
  stalled,
  activityNow,
  reminder,
  threadDepth = 0,
  threadLast = false,
  threadChildren = null,
  threadCollapsed = false,
  stopBeforeArchiveSupported = false,
  onSelect,
  onExpand,
  onToggleThread,
  onSessionMenu,
  onSnooze,
  onArchive,
}: InboxRowProps) {
  const longPress = useLongPress(({ x, y }) => onSessionMenu(session.id, { x, y }));
  // A surface without a store (a harness page) cannot see the runner, so it keeps the conservative
  // delivery wording rather than claiming the runner is offline.
  const runnerOnline = useOptionalStoreSelector((state) => state.runners.get(session.runnerId)?.status !== "offline") ?? true;
  const lastActivityAt = session.attention?.meaningfulAt ?? inboxRowTimestamp(session, activity);
  const status = sessionRowStatus(session, {
    runnerOnline,
    reminder,
    stalledForMs: stalled
      ? activityNow > 0 && lastActivityAt !== null ? Math.max(STALL_THRESHOLD_MS, activityNow - lastActivityAt) : STALL_THRESHOLD_MS
      : undefined,
  });
  const strip = showsActivityStrip(session.status, activity, activityNow);
  const agent = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const title = sessionDisplayTitle(session.title);
  const branchState = sessionBranchState(session);
  const worktree = branchState.kind === "branch" ? branchState.worktree : null;
  const baseRef = worktree ? displayBaseRef(worktree) : null;

  const children: InboxThreadChildren | null = threadChildren ? JSON.parse(threadChildren) as InboxThreadChildren : null;
  const childrenLabel = children ? inboxThreadChildrenLabel(children) : null;
  /* The family chip: one dot per child and the rollup, on the title line of a parent card. It reads
     the same whether the thread is expanded or collapsed, which is the point of putting the rollup
     on the parent — a collapsed thread can never hide a waiting child (#896). Its tint follows the
     attention colour only while a child is waiting. A span, not a button: it lives inside the row
     button, and the chevron beside the row is the control; clicking here merely forwards to it. */
  const familyChip = children && childrenLabel ? (
    <span
      className={`inbox-thread-family${children.waiting > 0 ? " waiting" : ""}`}
      title={childrenLabel}
      onClick={(event) => {
        if (!onToggleThread) return;
        event.stopPropagation();
        onToggleThread(session.id);
      }}
    >
      <span className="inbox-thread-dots" aria-hidden="true">
        {children.children.map((child) => <ThreadDot key={child.id} state={child.state} title={child.title} />)}
      </span>
      <span className="inbox-thread-family-text">{childrenLabel}</span>
    </span>
  ) : null;

  const sender = (
    <span className="inbox-row-sender" title={`${agent} · ${projectName}`}>
      <AgentIcon driver={session.driver} agentName={session.agentName} size={16} />
      <span>{agent} · {projectName}</span>
    </span>
  );
  /* The branch, only when there is one (#2209): a session without a branch says nothing rather than
     "No Branch" on every row. Meta items each lead with their 14px icon (§11.3); the base reads
     "from <ref>" and the pull request is its state word, both neutral. */
  const branch = worktree ? (
    <span className="inbox-row-git">
      <span className="inbox-row-branch" title={`Branch: ${worktree.branch}`}>
        <BranchIcon size={14} />
        <span className="sr-only">Branch: </span>
        <span className="inbox-row-branch-name">{worktree.branch}</span>
      </span>
      {baseRef && <span className="inbox-row-base" title={`Based on ${baseRef}`}>from {baseRef}</span>}
      {worktree.pullRequest && (
        <span className="inbox-row-pr" title={`Pull request: ${pullRequestStateLabel(worktree.pullRequest.state).toLowerCase()}`}>
          <PullRequestIcon size={14} />
          <span className="sr-only">Pull Request: </span>
          {pullRequestStateLabel(worktree.pullRequest.state)}
        </span>
      )}
    </span>
  ) : null;
  const badge = <SessionRowStatusBadge status={status} />;
  const activityStrip = strip
    ? <ActivityStrip activity={activity} now={activityNow} compact className="inbox-row-activity" />
    : null;
  const flags = pinned || containsPinned || unread ? (
    <span className="inbox-row-flags">
      {pinned ? <SessionPinIndicator /> : containsPinned ? <SessionPinIndicator contains /> : null}
      {unread && <span className="inbox-unread-dot" role="img" aria-label="Unread Activity" title="Unread activity" />}
    </span>
  ) : null;
  /* A snoozed row's time cell says when it returns, behind an alarm clock, instead of how long ago
     it last did something (#2209). */
  const pendingReminder = reminder?.state === "pending" ? reminder : null;
  const time = pendingReminder ? (
    <span className="inbox-row-time snoozed" title={reminderBadgeDescription(pendingReminder)}>
      <AlarmClockIcon size={14} />
      {pendingReminder.scheduleKind === "someday" ? (
        <>
          <span className="sr-only">Snoozed: </span>
          Someday
        </>
      ) : (
        <>
          <span className="sr-only">Snoozed Until </span>
          {formatReminderReturn(pendingReminder.scheduledFor, pendingReminder.timeZone)}
        </>
      )}
    </span>
  ) : (
    <time className="inbox-row-time" dateTime={lastActivityAt ? new Date(lastActivityAt).toISOString() : undefined}>
      {relativeTime(lastActivityAt)}
    </time>
  );
  /* The row's trailing actions (#2214, §3.3, §5.2): Snooze, Archive and ⋯, after the row button
     rather than in it, since a button cannot nest a button. A fine pointer sees them on hover or
     focus-within, over the row's own fill at the end of the title line, so the status and the time
     stay in view; a coarse pointer sees only ⋯, always, in a column the row keeps free for it. The
     list owns the keyboard, so none is a tab stop, and a press never takes focus from the list.
     Each tooltip names the key that does the same from the list. */
  const archiveLabel = sessionArchiveControlLabel(session, stopBeforeArchiveSupported);
  const archiveRefusal = sessionArchiveActionRefusal(session);
  const keepListFocus = (event: MouseEvent) => event.preventDefault();
  const actions = (
    <span className="inbox-row-actions">
      {onSnooze && (
        <button
          type="button"
          tabIndex={-1}
          className="icon-btn sm inbox-row-action"
          aria-label="Snooze"
          title="Snooze (H)"
          onMouseDown={keepListFocus}
          onClick={() => onSnooze(session.id)}
        >
          <AlarmClockIcon />
        </button>
      )}
      {onArchive && (
        <button
          type="button"
          tabIndex={-1}
          className="icon-btn sm inbox-row-action"
          aria-label={archiveLabel}
          // A refused person keeps the button, which says why and does nothing (#1857).
          aria-disabled={archiveRefusal !== null || undefined}
          title={archiveRefusal ?? `${archiveLabel} (E)`}
          onMouseDown={keepListFocus}
          onClick={() => onArchive(session.id)}
        >
          <ArchiveIcon />
        </button>
      )}
      <button
        type="button"
        tabIndex={-1}
        className="icon-btn inbox-row-action inbox-row-more"
        aria-label="More Actions"
        title="More Actions (Shift+F10)"
        aria-haspopup="menu"
        onMouseDown={keepListFocus}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          onSessionMenu(session.id, { x: box.left, y: box.bottom });
        }}
      >
        <MoreHorizontalIcon />
      </button>
    </span>
  );
  const titleLine = (
    <span className="inbox-row-copy">
      <span className="inbox-row-title">{title}</span>
      {familyChip}
    </span>
  );

  return (
    <div
      id={optionId}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      // Phones never show a selected row (§5.2): opening one pushes a route, so on return the last
      // opened row is not highlighted. The grid still knows which row is active.
      className={`inbox-row-shell${threeRow ? " stacked" : ""}${selected && !threeRow ? " selected" : ""}${
        unread ? " unread" : ""}${stalled ? " stalled" : ""}${children ? " thread-parent" : ""}${
        threadDepth > 0 ? " thread-child" : ""}${threadLast ? " thread-last" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        onSessionMenu(session.id, { x: event.clientX, y: event.clientY });
      }}
    >
      <div role="gridcell" className="inbox-row-primary-cell">
        {/* The chevron is a SIBLING of the row button, absolutely positioned into the card's leading
            padding: a button cannot nest a button, and the list owns the keyboard (t toggles), so
            it is not a tab stop. */}
        {children && (
          <button
            type="button"
            tabIndex={-1}
            className="inbox-thread-toggle"
            aria-expanded={!threadCollapsed}
            aria-label={threadCollapsed ? "Expand Thread" : "Collapse Thread"}
            title={`${threadCollapsed ? "Expand" : "Collapse"} Thread (T)`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => { event.stopPropagation(); onToggleThread?.(session.id); }}
          >
            <span aria-hidden="true">▶</span>
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          className="inbox-row"
          onMouseDown={(event) => event.preventDefault()}
          {...longPress.handlers}
          onClick={() => { if (!longPress.consumeSuppressedClick()) onSelect(session.id); }}
          onDoubleClick={() => { if (!longPress.consumeSuppressedClick()) onExpand(session.id); }}
          title={`Select ${title}`}
        >
          {/* Two shapes (#2209), each in reading order. Desktop and tablet: the status line (the
              sender, which gives up width first, the branch, then the badge, the strip, the flags
              and the time), then the title line, which holds the title and the family chip and
              nothing else. A phone keeps its three-line card: the sender with the flags, the title,
              then the status line with the badge, the strip, the branch and the time. The strip is
              on the status line in both, never on the title line. */}
          {threeRow ? (
            <>
              <span className="inbox-row-line inbox-row-sender-line">{sender}{flags}</span>
              {titleLine}
              <span className="inbox-row-line inbox-row-status-line">{badge}{activityStrip}{branch}{time}</span>
            </>
          ) : (
            <>
              <span className="inbox-row-line inbox-row-status-line">
                {sender}
                {branch}
                <span className="inbox-row-trail">{badge}{activityStrip}{flags}{time}</span>
              </span>
              {titleLine}
            </>
          )}
        </button>
        {actions}
      </div>
    </div>
  );
}

/**
 * Memoised: this renders once per row, and its parent re-renders on every store update — a session
 * status change anywhere in the inbox re-rendered every row in it. The props are primitives and
 * stable callbacks, so a shallow compare is the right guard.
 */
export const InboxRow = memo(InboxRowInner);
