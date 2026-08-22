import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { memo } from "react";
import { isHeartbeatBusy, type SessionActivity } from "../activity.js";
import { relativeTime, statusMeta } from "../format.js";
import { reminderBadgeLabel } from "../session-reminders.js";
import { AgentIcon } from "./AgentIcon.js";
import { ActivityStrip } from "./ActivityStrip.js";
import { sessionAgentLabel } from "./agent-options.js";

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
  activity?: SessionActivity;
  stalled: boolean;
  activityNow: number;
  reminder?: SessionReminderView;
  /** Take the id, so the parent can pass ONE stable callback to every row. */
  onSelect: (sessionId: string) => void;
  onExpand: (sessionId: string) => void;
}

function InboxRowInner({
  optionId,
  session,
  projectName,
  selected,
  unread,
  pinned,
  rowIndex,
  activity,
  stalled,
  activityNow,
  reminder,
  onSelect,
  onExpand,
}: InboxRowProps) {
  const status = session.archiveStatus === "stop_pending"
    ? { label: "Stop Pending", className: "st-running", busy: true }
    : session.archiveStatus === "stop_failed"
      ? { label: "Stop Failed", className: "st-failed", busy: false }
    : statusMeta(session.status);
  const blocked = session.pendingApproval != null || session.status === "input_required";
  const active = isHeartbeatBusy(session.status);
  const diffReady = session.column === "review" && !blocked && !status.busy;
  const agent = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const lastActivityAt = Math.max(session.lastEventAt ?? 0, activity?.lastEventAt ?? 0) || null;

  return (
    <div
      id={optionId}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      className={`inbox-row-shell${selected ? " selected" : ""}${unread ? " unread" : ""}${stalled ? " stalled" : ""}`}
    >
      <div role="gridcell" className="inbox-row-primary-cell">
        <button
          type="button"
          tabIndex={-1}
          className="inbox-row"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(session.id)}
          onDoubleClick={() => onExpand(session.id)}
          title={`Select ${session.title}`}
        >
          <span className="inbox-row-sender" title={`${agent} · ${projectName}`}>
            <AgentIcon driver={session.driver} agentName={session.agentName} size={16} />
            <span>{agent} · {projectName}</span>
          </span>
          <span className="inbox-row-copy">
            <span className="inbox-row-title">{session.title}</span>
            {session.preview && <span className="inbox-row-snippet"> — {session.preview}</span>}
            {active && <ActivityStrip activity={activity} now={activityNow} compact className="inbox-row-activity" />}
          </span>
          <span className="inbox-row-signals">
            {blocked ? (
              <span className="inbox-status-pill blocked">
                {session.pendingApproval?.kind === "authentication" ? "Authentication Required" : "Approval"}
              </span>
            ) : status.busy ? (
              <span className="inbox-status-pill running">{status.label}</span>
            ) : diffReady ? (
              <span className="inbox-diff-chip">Diff Ready</span>
            ) : null}
            {reminder && (
              <span className="inbox-status-pill reminder">{reminderBadgeLabel(reminder, activityNow || Date.now())}</span>
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
