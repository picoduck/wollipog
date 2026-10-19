import type { ReactNode } from "react";
import type { ProjectView, RunnerView } from "@wollipog/protocol";
import type { LocationMachineName } from "../project-management.js";
import { isLaunchableProjectLocation } from "../project-session-selection.js";
import { FolderIcon, InboxIcon, ShieldIcon } from "./Icons.js";
import { ActionsMenu, type ActionsMenuChoice, type PageAction, type PageMenuAction } from "./PageHeader.js";

/** ⋯'s name in the detail and in the phone detail bar (§9.1). */
export const PROJECT_ACTIONS_LABEL = "Project Actions";
/** Why the archive item waits (§9.1: a disabled item says why). */
export const NO_SESSIONS_TO_ARCHIVE = "No sessions to archive.";
/** Why an action waits while another change to this project is still saving. */
export const PROJECT_BUSY_REASON = "Wait for the current change to finish.";

function machineList(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Why New Session can't start in this project, or null when one of its locations can host a session.
 * The sentence shows as visible text under the title (§9.1), so it names what to fix.
 */
export function projectNewSessionBlocker(
  project: ProjectView,
  runners: ReadonlyMap<string, RunnerView>,
  machineName: LocationMachineName,
): string | null {
  if (project.locations.length === 0) return "Add a location to start sessions.";
  if (project.locations.some((location) => isLaunchableProjectLocation(location, runners))) return null;
  const offline = project.locations.filter((location) =>
    location.availability === "runner_offline" || runners.get(location.runnerId)?.status !== "online");
  if (offline.length === 0) return "None of this project's folders can be reached, so new sessions can't start.";
  const names = [...new Set(offline.map(machineName))];
  return `${machineList(names)} ${names.length === 1 ? "is" : "are"} offline, so new sessions can't start.`;
}

/**
 * The project detail's ⋯ items (#2959), in order: Copy Project ID, the archive item, and Delete
 * Project… last, after a separator, in danger text (§3.3). A viewer gets only Copy Project ID. The
 * archive item is named for what it will do and says why when there is nothing to archive.
 */
export function projectDetailMenu(project: ProjectView, state: { stopsRuntime: boolean; busy: boolean }, actions: {
  onCopyId: () => void;
  onArchive: (choice: ActionsMenuChoice) => void;
  onDelete: (choice: ActionsMenuChoice) => void;
}): PageMenuAction[] {
  const copy: PageMenuAction = { label: "Copy Project ID", onClick: actions.onCopyId };
  if (project.canManage === false) return [copy];
  const archiveReason = project.unarchivedSessionCount === 0 ? NO_SESSIONS_TO_ARCHIVE
    : state.busy ? PROJECT_BUSY_REASON : null;
  return [
    copy,
    {
      label: state.stopsRuntime ? "Archive and Stop Sessions…" : "Archive Sessions…",
      onClick: actions.onArchive,
      disabled: archiveReason !== null,
      ...(archiveReason ? { description: archiveReason } : {}),
    },
    {
      label: "Delete Project…",
      onClick: actions.onDelete,
      danger: true,
      disabled: state.busy,
      ...(state.busy ? { description: PROJECT_BUSY_REASON } : {}),
    },
  ];
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * The top of a project's detail (#2959): the name with New Session and ⋯ on one row, the reason New
 * Session can't start when it can't, and one meta line of neutral facts (§11.3). On a phone the
 * detail bar carries the name and the actions, so only the reason and the meta line show here.
 */
export function ProjectDetailHeader({ project, showTitle, newSession, blocker, menu, access }: {
  project: ProjectView;
  showTitle: boolean;
  newSession: PageAction;
  /** Why New Session is disabled, from `projectNewSessionBlocker`. */
  blocker: string | null;
  menu: PageMenuAction[];
  /** The access label, only where access is managed. */
  access: string | null;
}) {
  const running = project.activeSessionCount;
  const fact = (key: string, icon: ReactNode, value: string, label?: string) => (
    <li key={key}>
      {icon}
      {label && <span className="sr-only">{label}: </span>}
      {value}
    </li>
  );
  return (
    <header className="project-detail-head">
      {showTitle && (
        <div className="project-detail-title-row">
          <h2 className="project-detail-title" title={project.name} tabIndex={-1}>{project.name}</h2>
          <div className="actions">
            <button type="button" className="btn primary" disabled={newSession.disabled} onClick={newSession.onClick}>
              {newSession.label}
            </button>
            <ActionsMenu label={PROJECT_ACTIONS_LABEL} items={menu} />
          </div>
        </div>
      )}
      {blocker && <p className="project-detail-blocker">{blocker}</p>}
      <ul className="project-detail-meta" aria-label="Project Details">
        {fact("locations", <FolderIcon size={14} />, plural(project.locations.length, "Location"))}
        {fact("sessions", <InboxIcon size={14} />,
          `${plural(project.unarchivedSessionCount, "Session")}${running > 0 ? `, ${running} Running` : ""}`)}
        {access && fact("access", <ShieldIcon size={14} />, access, "Access")}
      </ul>
    </header>
  );
}
