import { sessionAttentionStatus, type SessionReminderView, type SessionView } from "@wollipog/protocol";
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
import { BackgroundWorkBadge, quarantinedStatusMeta } from "./common.js";
import { sessionAgentLabel } from "./agent-options.js";
import { AttentionRequests } from "./AttentionRequests.js";
import type { View } from "../navigation.js";

export interface InboxRowProps {
  optionId: string;
  session: SessionView;
  projectName: string;
  selected: boolean;
  unread: boolean;
  pinned: boolean;
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
  /** Take the id, so the parent can pass ONE stable callback to every row. */
  onSelect: (sessionId: string) => void;
  onExpand: (sessionId: string) => void;
  onNavigate?: (view: View) => void;
  onSelectAttention?: (sessionId: string) => void;
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
  rowIndex,
  threeRow,
  activity,
  stalled,
  activityNow,
  reminder,
  onSelect,
  onExpand,
  onNavigate,
  onSelectAttention,
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
  const attention = sessionAttentionStatus(session);
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

  return (
    <div
      id={optionId}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      className={`inbox-row-shell${selected ? " selected" : ""}${unread ? " unread" : ""}${stalled ? " stalled" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        onSessionMenu(session.id, { x: event.clientX, y: event.clientY });
      }}
    >
      <div role="gridcell" className="inbox-row-primary-cell">
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
          {/* Line one's LEAD. On desktop this is a flex line holding the sender and the Git state,
              which is what lets the sender be the first thing to give up width when the signals
              column is wide — the priority the card had before #877, when the Git state owned a
              whole row. As three grid columns instead, the flexible one starved: a card with
              several attention pills lost its branch name entirely.
              On a phone the wrapper is `display: contents`, so the sender and the Git line fall
              back to being grid items at their own areas and #782's three-row card is untouched. */}
          <span className="inbox-row-lead">
            <span className="inbox-row-sender" title={`${agent} · ${projectName}`}>
              <AgentIcon driver={session.driver} agentName={session.agentName} size={16} />
              <span>{agent} · {projectName}</span>
            </span>
            {/* The Git line, on EVERY card (#782): a branch name, "No Branch", or "Branch Unavailable",
                never an absence. Before this it appeared only for a session with an active worktree
                and the background badge wrapped onto a line of its own, so the list stepped between
                two, three, and four rows and never said whether a card without a Git line had no
                branch or merely an unreported one.
                A phone keeps it as line three, sharing that line with the background badge. A desktop
                card puts it on line ONE, after the agent and project (#877): three rows of Git state,
                title, and sender cost roughly 85px per card where two cost about 64, and horizontal
                space is the one thing a desktop has and a phone does not. */}
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
            </span>
          </span>
          {/* The title line, and nothing else on it that can grow. The title box takes ALL the
              free width and fades at its own right edge, so whatever follows it is laid out at a
              fixed size against a fixed trailing position and can never be pushed past the row
              (#664). The message preview used to live here; it repeated the transcript's first line
              and was the reason the line ran out of room. It stays in `SessionView` for search.
              On a desktop card this is the LAST line, so the background badge rides here, directly
              left of the strip (#877); a phone keeps it on line three with the Git state. */}
          <span className="inbox-row-copy">
            <span className="inbox-row-title">{session.title}</span>
            {!threeRow && backgroundWorkBadge}
            {active && <ActivityStrip activity={activity} now={activityNow} compact className="inbox-row-activity" />}
          </span>
          <span className="inbox-row-signals">
            <span
              className={"inbox-status-pill " + (stopFailed ? "failed" : status.busy ? "running" : "activity")}
              title={"Activity: " + status.label}
              aria-label={"Activity: " + status.label}
            >
              {status.label}
            </span>
            {attention && (
              <span
                className="inbox-status-pill blocked"
                title={attention.description}
                aria-label={"Attention: " + attention.label}
              >
                {attention.label}
              </span>
            )}
            {extraSnoozedAttention && (
              <span
                className="inbox-status-pill blocked"
                title={extraSnoozedAttention.description}
                aria-label={`Attention: ${extraSnoozedAttention.label}`}
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
            {pinned && <span className="inbox-pin-indicator" aria-label="Pinned Session">●</span>}
            {unread && <span className="inbox-unread-badge" aria-label="Unread Activity">1</span>}
            <time dateTime={lastActivityAt ? new Date(lastActivityAt).toISOString() : undefined}>
              {relativeTime(lastActivityAt)}
            </time>
          </span>
        </button>
        <AttentionRequests session={session} onNavigate={onNavigate} keyboardActive={selected}
          onActivate={() => onSelectAttention?.(session.id)} />
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
