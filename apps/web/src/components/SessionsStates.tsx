import React from "react";
import {
  sessionsLoadingMessage,
  sessionsSituationMessage,
  sessionsSituationOffersNewSession,
  sessionsSituationTitle,
  sessionsSkeletonRows,
  type SessionsSituation,
} from "../sessions-states.js";
import { AlarmClockIcon, CloudOffIcon, FolderIcon, InboxIcon, MapPinOffIcon, PlusIcon } from "./Icons.js";
import { State } from "./State.js";

function situationIcon(situation: SessionsSituation) {
  switch (situation.kind) {
    case "first-run":
    case "project-empty":
      return <InboxIcon size={24} />;
    case "no-location":
    case "location-unavailable":
      return <MapPinOffIcon size={24} />;
    case "location-offline":
      return <CloudOffIcon size={24} />;
    case "no-project":
      return <FolderIcon size={24} />;
    case "snoozed":
    case "all-snoozed":
      return <AlarmClockIcon size={24} />;
  }
}

/**
 * The Sessions page's state for an empty group (#2220, docs/design-system.md §12.1): one icon, a
 * Title Case title, a sentence and the next step as `.btn.lg` actions. New Session is the primary
 * only where the header hides its own (§12.1); the others are secondary, beside the header's.
 */
export function SessionsSituationState({
  situation,
  newSessionShortcut,
  onNewSession,
  onNewProject,
  onManageProject,
  onShowActive,
  onShowSnoozed,
}: {
  situation: SessionsSituation;
  newSessionShortcut?: string;
  onNewSession: () => void;
  /** Absent where Projects are unavailable, which drops New Project…. */
  onNewProject?: () => void;
  /** The Project's page, where its Locations are added and managed. */
  onManageProject?: () => void;
  onShowActive: () => void;
  onShowSnoozed: () => void;
}) {
  const newSession = sessionsSituationOffersNewSession(situation) && (
    <button type="button" className="btn primary lg" aria-keyshortcuts={newSessionShortcut} onClick={onNewSession}>
      <PlusIcon />
      {situation.kind === "project-empty" ? "New Session Here" : "New Session"}
    </button>
  );
  const actions = (() => {
    switch (situation.kind) {
      case "first-run":
        return <>{newSession}{onNewProject && <button type="button" className="btn lg" onClick={onNewProject}>New Project…</button>}</>;
      case "project-empty":
      case "no-project":
        return newSession;
      case "no-location":
        return onManageProject && <button type="button" className="btn lg" onClick={onManageProject}>Add Location</button>;
      case "location-offline":
      case "location-unavailable":
        return onManageProject && <button type="button" className="btn lg" onClick={onManageProject}>Manage Locations</button>;
      case "snoozed":
        return <button type="button" className="btn lg" onClick={onShowActive}>Show Active Sessions</button>;
      case "all-snoozed":
        return <button type="button" className="btn lg" onClick={onShowSnoozed}>Show Snoozed Sessions</button>;
    }
  })();
  return (
    <State
      icon={situationIcon(situation)}
      title={sessionsSituationTitle(situation)}
      headingLevel={2}
      actions={actions || undefined}
    >
      {sessionsSituationMessage(situation)}
    </State>
  );
}

/**
 * The list while a group's sessions are still arriving (§12.3): a status line over skeleton rows
 * at the real row's height and anatomy, never a state card. One live region says it once.
 */
export function SessionsListSkeleton({ count, threeRow }: { count: number | null; threeRow: boolean }) {
  const message = sessionsLoadingMessage(count);
  return (
    <div className="inbox-skeleton" tabIndex={-1}>
      <p className="inbox-list-status" role="status">{message}</p>
      <div className="inbox-skeleton-rows" aria-hidden="true">
        {Array.from({ length: sessionsSkeletonRows(count) }, (_, index) => (
          <div className={`row row-2 inbox-skeleton-row${threeRow ? " stacked" : ""}`} key={index}>
            <span className="row-body">
              <span className="skeleton-bar title" />
              <span className="skeleton-bar" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The preview's placeholder while the list loads (§12.3): a skeleton of its bar, and no sentence.
 * It is the reading zone's F6 landing spot then, so it is named; only the bar is decorative, and the
 * list's status line is what announces the load.
 */
export function SessionsPreviewSkeleton() {
  return (
    <div className="inbox-preview-skeleton" role="group" aria-label="Session Preview" tabIndex={-1}>
      <span className="skeleton-bar title" aria-hidden="true" />
    </div>
  );
}
