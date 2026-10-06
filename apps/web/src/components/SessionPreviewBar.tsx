import React, { useRef } from "react";
import type { SessionView } from "@wollipog/protocol";
import { sessionStatusSummary } from "../status-meta.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionBranchState } from "../worktree-identity.js";
import { AgentIcon } from "./AgentIcon.js";
import { AlarmClockIcon, ArchiveIcon, BranchIcon, ComputerIcon, MoreHorizontalIcon } from "./Icons.js";
import { ConditionBadge } from "./SessionStatusButton.js";

/** Where the preview's ⋯ asks the Sessions list to open the session's context menu. */
export type PreviewSessionMenuOpener = (anchor: { x: number; y: number }, restoreTarget: () => HTMLElement | null) => void;

/**
 * The Sessions preview's detail bar and meta line (docs/design-system.md §4.3, §11.3; #2210).
 *
 * One 48px row: the one-line title, the session's one status badge (`sessionStatusSummary()`, the
 * ranking the session bar uses, with its plain "+N"), then Snooze and Archive as icon buttons, ⋯ for
 * the session's context menu and Open Session last. The preview is a quick look, so there is no back
 * button and the badge is not a control: the session's own bar is where a condition is acted on.
 *
 * Under it, one line of quiet facts: the machine, the branch when there is one, and the agent, each
 * after its 14px icon.
 */
export function SessionPreviewBar({
  session,
  runnerOnline,
  machineName,
  agentLabel,
  archiveLabel,
  onSnooze,
  onArchive,
  onSessionMenu,
  onOpen,
}: {
  session: SessionView;
  runnerOnline: boolean;
  machineName: string;
  agentLabel: string;
  /** `sessionArchiveActionLabel()`: the icon button's name and the start of its tooltip. */
  archiveLabel: string;
  /** Absent where the control plane has no reminders. */
  onSnooze?: () => void;
  onArchive?: () => void;
  onSessionMenu?: PreviewSessionMenuOpener;
  onOpen?: () => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  // The row's context: only what a Sessions row also knows, so the two badges agree.
  const { primary, more } = sessionStatusSummary(session, { runnerOnline });
  const title = sessionDisplayTitle(session.title);
  const branchState = sessionBranchState(session);
  const branch = branchState.kind === "branch" ? branchState.worktree.branch : null;
  return (
    <>
      <header className="detail-bar session-preview-bar">
        <div className="detail-bar-heading">
          <h2 className="detail-bar-title" title={title}>{title}</h2>
          <span className="detail-bar-status" title={`${primary.meta.label}${more > 0 ? ` and ${more} more` : ""}`}>
            <ConditionBadge condition={primary} />
            {more > 0 && (
              <>
                <span className="session-status-more" aria-hidden="true">+{more}</span>
                <span className="sr-only"> and {more} More</span>
              </>
            )}
          </span>
        </div>
        <div className="detail-bar-actions">
          {onSnooze && (
            <button type="button" className="icon-btn" aria-label="Snooze" title="Snooze (H)" onClick={onSnooze}>
              <AlarmClockIcon />
            </button>
          )}
          {onArchive && (
            <button type="button" className="icon-btn" aria-label={archiveLabel} title={`${archiveLabel} (E)`} onClick={onArchive}>
              <ArchiveIcon />
            </button>
          )}
          {onSessionMenu && (
            <button
              ref={moreRef}
              type="button"
              className="icon-btn"
              aria-label="More Actions"
              title="More Actions"
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onSessionMenu({ x: rect.left, y: rect.bottom }, () => moreRef.current);
              }}
            >
              <MoreHorizontalIcon />
            </button>
          )}
          {onOpen && (
            <button type="button" className="btn session-preview-open" title="Open Session (Enter)" onClick={onOpen}>
              Open Session
              <kbd aria-hidden="true">Enter</kbd>
            </button>
          )}
        </div>
      </header>
      <ul className="session-preview-facts" aria-label="Session Details">
        <li title={`Machine: ${machineName}`}>
          <ComputerIcon size={14} />
          <span className="sr-only">Machine: </span>
          <span className="session-preview-fact">{machineName}</span>
        </li>
        {branch && (
          <li title={`Branch: ${branch}`}>
            <BranchIcon size={14} />
            <span className="sr-only">Branch: </span>
            <span className="session-preview-fact">{branch}</span>
          </li>
        )}
        <li title={`Agent: ${agentLabel}`}>
          <AgentIcon driver={session.driver} agentName={session.agentName} size={14} />
          <span className="sr-only">Agent: </span>
          <span className="session-preview-fact">{agentLabel}</span>
        </li>
      </ul>
    </>
  );
}
