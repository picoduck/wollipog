import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { memo } from "react";
import { useLongPress } from "./interactions.js";
import { isHeartbeatBusy, type SessionActivity } from "../activity.js";
import { relativeTime, statusMeta } from "../format.js";
import {
  reminderBadgeDescription,
  reminderBadgeLabel,
  snoozedSessionAttentionReason,
} from "../session-reminders.js";
import { branchStateLabel, displayBaseRef, pullRequestStateLabel, sessionBranchState } from "../worktree-identity.js";
import { AgentIcon } from "./AgentIcon.js";
import { ActivityStrip } from "./ActivityStrip.js";
import { AttentionPills, BackgroundWorkBadge, SessionPinIndicator, ThreadDot, quarantinedStatusMeta } from "./common.js";
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
   * The card's responsive shape. `true` is #782's three-row phone card; `false` is #877's two-row
   * desktop card, which lifts the Git state onto line one and moves the background-work badge onto
   * the title line, immediately left of the activity strip.
   *
   * A PROP, not a `useIsMobile()` call in this component. The list already has to know the breakpoint
   * to pick its virtualization estimate, and reading it here as well would put one media
   * subscription on every mounted card and let the two answers disagree for a frame mid-resize.
   */
  threeRow: boolean;
  activity?: SessionActivity;
  stalled: boolean;
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
  /** Take the id, so the parent can pass ONE stable callback to every row. */
  onSelect: (sessionId: string) => void;
  onExpand: (sessionId: string) => void;
  onToggleThread?: (sessionId: string) => void;
  /** Right-click, long-press, or keyboard context menu for this row's session (#154). */
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }) => void;
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
  onSelect,
  onExpand,
  onToggleThread,
  onSessionMenu,
}: InboxRowProps) {
  const longPress = useLongPress(({ x, y }) => onSessionMenu(session.id, { x, y }));
  const stopStatus = session.stopOperation?.status ?? session.archiveStatus;
  const stopFailed = stopStatus === "stop_failed";
  const status = stopStatus === "stop_pending"
    ? { label: "Stopping", className: "st-running", busy: true }
    : stopFailed
      ? { label: "Stop Failed", className: "st-failed", busy: false }
      : quarantinedStatusMeta(session.status, session.historyQuarantine) ?? statusMeta(session.status);
  const snoozedAttention = reminder?.state === "pending" ? snoozedSessionAttentionReason(session) : null;
  const extraSnoozedAttention = snoozedAttention?.kind === "orphaned_background_work" ||
      snoozedAttention?.kind === "background_delivery_watchdog"
    ? snoozedAttention
    : null;
  const active = isHeartbeatBusy(session.status);
  const agent = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const lastActivityAt = Math.max(session.lastEventAt ?? 0, activity?.lastEventAt ?? 0) || null;
  // #782: the card's third line is unconditional. Deriving the state up front is what makes it so —
  // the row no longer asks "is there a worktree?" but "what can this card honestly say about Git?".
  const branchState = sessionBranchState(session);
  const activeWorktree = branchState.kind === "branch" ? branchState.worktree : null;
  const worktreeBaseRef = activeWorktree ? displayBaseRef(activeWorktree) : null;
  const backgroundWork = session.backgroundWorkState && session.backgroundWorkState !== "resumed"
    ? session.backgroundWorkState
    : null;
  // ONE badge, rendered into whichever line the current shape puts it on (#877). Two copies hidden
  // by media query would put the same words in the row's accessible name twice on any engine that
  // walks a `display: none` subtree, and would make the badge's own count a lie to every test.
  const backgroundWorkBadge = backgroundWork
    ? (
      <span className="inbox-row-background-work">
        <BackgroundWorkBadge state={backgroundWork} compact announce={false} />
      </span>
    )
    : null;

  /* ONE time element, rendered into whichever line the current shape puts it on (#934), for the
     same reason the background badge is built this way (#877): two copies hidden by a media query
     would say the instant twice in the row's accessible name.
     The stacked shape puts it at the trailing edge of line three, where the branch has room to
     give way, so line one is the sender and its pills alone and the agent's name survives beside
     the icon. That is also why the compact "15m" form #916 needed is gone: line three can afford
     the suffix. The two-row desktop shape keeps it in the signals column, where it always was. */
  const timeLabel = (
    <time dateTime={lastActivityAt ? new Date(lastActivityAt).toISOString() : undefined}>
      {relativeTime(lastActivityAt)}
    </time>
  );

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

  // The sender and the Git line are named rather than written inline because the two card shapes
  // place them differently: a desktop card puts both inside the lead on line one, and a phone keeps
  // the sender on line one and the Git line on line three, with the title between them.
  const senderLine = (
    <span className="inbox-row-sender" title={`${agent} · ${projectName}`}>
      <AgentIcon driver={session.driver} agentName={session.agentName} size={16} />
      <span>{agent} · {projectName}</span>
    </span>
  );
  /*
   * The Git line, on EVERY card (#782): a branch name, "No Branch", or "Branch Unavailable", never
   * an absence. Before that it appeared only for a session with an active worktree and the
   * background badge wrapped onto a line of its own, so the list stepped between two, three, and
   * four rows and never said whether a card without a Git line had no branch or merely an
   * unreported one.
   *
   * A phone keeps it as line three, sharing that line with the background badge and, since #934,
   * the relative time. A desktop card
   * puts it on line one, after the agent and project (#877): three rows of Git state, title, and
   * sender spend about 94px per card saying what two say in 73, and horizontal space is the one
   * thing a desktop has and a phone does not.
   */
  const gitLine = (
    <span className="inbox-row-meta">
      <span className="inbox-row-git">
        {/* The word the line stands for, so the row's accessible name carries the Git state. */}
        <span className="sr-only">Branch: </span>
        {activeWorktree ? (
          <>
            <span className="inbox-row-branch" title={`Branch: ${activeWorktree.branch}`}>
              {activeWorktree.branch}
            </span>
            {worktreeBaseRef && (
              <span className="inbox-row-base">
                {/* The arrow is decoration; assistive technology gets the word it stands for. */}
                <span className="sr-only">Base: </span>
                <span aria-hidden="true">← </span>
                {worktreeBaseRef}
              </span>
            )}
            {activeWorktree.pullRequest && (
              <span
                className={"inbox-row-pr-pill " + (activeWorktree.pullRequest.state === "open"
                  ? "open"
                  : activeWorktree.pullRequest.state === "merged" ? "merged" : "closed")}
                aria-label={`Pull Request: ${pullRequestStateLabel(activeWorktree.pullRequest.state)}`}
              >
                {pullRequestStateLabel(activeWorktree.pullRequest.state)} PR
              </span>
            )}
          </>
        ) : (
          /* Words, not an absence and not a colour: the label itself is the whole signal, and
             the subdued italic only reinforces what it already says in text. */
          <span
            className={`inbox-row-branch-state ${branchState.kind}`}
            title={branchState.kind === "none"
              ? "This session is not working on a Git branch."
              : "This session's branch state has not been reported by its runner."}
          >
            {branchStateLabel(branchState)}
          </span>
        )}
      </span>
      {threeRow && backgroundWorkBadge}
      {threeRow && timeLabel}
    </span>
  );
  return (
    <div
      id={optionId}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      className={`inbox-row-shell${selected ? " selected" : ""}${unread ? " unread" : ""}${stalled ? " stalled" : ""}${
        children ? " thread-parent" : ""}${threadDepth > 0 ? " thread-child" : ""}${threadLast ? " thread-last" : ""}`}
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
          title={`Select ${session.title}`}
        >
          {/* Line one's LEAD, on a desktop card only: a flex line holding the sender and the Git
              state, which is what lets the sender be the first to give up width when the signals
              column is wide — the priority the card had before #877, when the Git state owned a
              whole row. As three grid columns instead, the FLEXIBLE one starved, and a card with
              several attention pills lost its branch name outright.
              A phone renders no wrapper at all, so its children keep #782's order: sender, then
              title, then Git state. Wrapping them on a phone too and dissolving the box with
              `display: contents` laid out identically to the pixel, but `display: contents` does
              not reorder the accessibility tree: the row then ANNOUNCED sender, branch, title
              while SHOWING sender, title, branch. */}
          {threeRow ? senderLine : <span className="inbox-row-lead">{senderLine}{gitLine}</span>}
          {/* The title line, and nothing else on it that can grow. The title box takes ALL the
              free width and fades at its own right edge, so whatever follows it is laid out at a
              fixed size against a fixed trailing position and can never be pushed past the row
              (#664). The message preview used to live here; it repeated the transcript's first line
              and was the reason the line ran out of room. It stays in `SessionView` for search.
              On a desktop card this is the LAST line, so the background badge rides here, directly
              left of the strip (#877); a phone keeps it on line three with the Git state. */}
          <span className="inbox-row-copy">
            <span className="inbox-row-title">{session.title}</span>
            {familyChip}
            {!threeRow && backgroundWorkBadge}
            {active && <ActivityStrip activity={activity} now={activityNow} compact className="inbox-row-activity" />}
          </span>
          {threeRow && gitLine}
          <span className="inbox-row-signals">
            <span
              className={"inbox-status-pill " + (stopFailed ? "failed" : status.busy ? "running" : "activity")}
              title={"Activity: " + status.label}
              aria-label={"Activity: " + status.label}
            >
              {status.label}
            </span>
            <AttentionPills session={session} compact={threeRow} />
            {extraSnoozedAttention && (
              <span
                className={`inbox-status-pill ${extraSnoozedAttention.kind === "background_delivery_watchdog" &&
                  extraSnoozedAttention.severity === "pending" ? "background-delivery-pending" : "blocked"}`}
                title={extraSnoozedAttention.description}
                aria-label={extraSnoozedAttention.kind === "background_delivery_watchdog"
                  ? extraSnoozedAttention.accessibleName
                  : `Attention: ${extraSnoozedAttention.label}`}
              >
                {extraSnoozedAttention.label}
              </span>
            )}
            {reminder && (
              <span
                className="inbox-status-pill reminder"
                title={reminderBadgeDescription(reminder)}
                aria-label={`Reminder: ${reminder.state === "fired"
                  ? reminderBadgeDescription(reminder)
                  : reminderBadgeLabel(reminder)}`}
              >
                {reminderBadgeLabel(reminder)}
              </span>
            )}
            {stalled && (
              <span className="inbox-status-pill stalled" aria-label="Stalled: No Activity for at Least 10 Minutes">
                Stalled
              </span>
            )}
            {pinned ? <SessionPinIndicator /> : containsPinned ? <SessionPinIndicator contains /> : null}
            {unread && <span className="inbox-unread-badge" aria-label="Unread Activity">1</span>}
            {!threeRow && timeLabel}
          </span>
        </button>
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
