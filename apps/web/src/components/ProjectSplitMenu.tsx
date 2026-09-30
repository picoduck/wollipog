import { useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  sessionAttentionStatus,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import type { InboxSplit } from "../inbox.js";
import {
  archiveSessionsWithCompensation,
  sessionArchiveRequiresStop,
  setArchivedForSessions,
} from "../archive-actions.js";
import { archiveProjectWithFeedback } from "../project-actions.js";
import { useApi } from "../api-context.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { useFeedback, type ConfirmationDetailRow } from "./FeedbackProvider.js";
import { Modal, sessionLifecycleMeta } from "./common.js";
import { MoreHorizontalIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";

export interface ProjectSplitMenuProps {
  split: InboxSplit;
  /** The same split before the Inbox's Active or Snoozed filter. A durable Project archive runs on the
   * server over every unarchived session, snoozed or not, so its confirmation counts and lists these. */
  unfilteredSplit?: InboxSplit;
  active?: boolean;
  runner: RunnerView | undefined;
  stopBeforeArchiveSupported?: boolean;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onNewSession: (preset: NewSessionPreset) => void;
  onManageProject?: () => void;
}

/**
 * A row's badge: the attention a person owes the session, otherwise its lifecycle, including a Stop
 * already under way. One badge per row, attention first (§11.1). Attention is the shared human-owned
 * projection, so a request only a child agent or the Orchestrator owns does not claim the row, and a
 * campaign's human-owned requests do. A bare "input_required" status with no request behind it is
 * that projection's legacy fallback, which the lifecycle already says as "Awaiting Input".
 */
export function archiveRowStatus(session: SessionView): StatusMeta {
  const attention = sessionAttentionStatus(session);
  const legacyInput = attention?.kind === "input_required" && !session.pendingApproval &&
    !session.orchestratorCampaign?.pendingRequests?.human;
  if (attention && !legacyInput) return statusMeta("attention", attention.kind);
  return sessionLifecycleMeta(session.status, {
    archiveStatus: session.archiveStatus,
    stopOperation: session.stopOperation,
    historyQuarantine: session.historyQuarantine,
  });
}

/**
 * The sessions the split has loaded, and how many more the archive affects. A durable Project
 * archives every unarchived session server-side, including ones this split has not loaded, so they
 * join "and N more" (#2051).
 */
export function archiveDetailRows(
  sessions: readonly SessionView[],
  sessionCount: number,
): { rows: ConfirmationDetailRow[]; overflow: number } {
  const rows = sessions.map((session) => ({ label: session.title || "Untitled Session", status: archiveRowStatus(session) }));
  return { rows, overflow: Math.max(0, sessionCount - rows.length) };
}

/** Project actions owned by a Command Inbox project split. */
export function ProjectSplitMenu({
  split,
  unfilteredSplit,
  active = true,
  runner,
  stopBeforeArchiveSupported = true,
  pinned,
  onPinnedChange,
  onNewSession,
  onManageProject,
}: ProjectSplitMenuProps) {
  const api = useApi();
  const { confirm, showToast, showUndo } = useFeedback();
  const [open, setOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(split.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const menu = useAccessibleMenu(open, setOpen, "project-split-menu");

  const durableProject = split.project?.kind === "durable" ? split.project.project : null;
  const durableLocation = split.project?.kind === "durable" ? split.project.primaryLocation : null;
  const durableAvailableLocations = durableProject?.locations.filter((location) => location.availability === "available") ?? [];
  const legacyLocation = split.project?.kind === "legacy" ? split.project : null;
  if (!durableProject && !legacyLocation) return null;
  const entityLabel = durableProject ? "Project" : "Workspace";
  const actionsLabel = `${entityLabel} Actions for ${split.name}`;
  // What "Archive All Sessions" affects: a durable Project's every unarchived session, or exactly the
  // legacy workspace sessions shown here.
  const archiveScope = durableProject ? unfilteredSplit ?? split : split;
  const archiveCount = durableProject ? archiveScope.count : split.sessions.length;
  const archiveStopsRuntime = archiveScope.sessions.some((session) =>
    sessionArchiveRequiresStop(session, stopBeforeArchiveSupported));
  const runnerId = durableLocation?.runnerId ?? legacyLocation?.runnerId ?? null;
  const workspaceId = durableLocation?.workspaceId ?? legacyLocation?.workspaceId ?? null;
  const canManageProject = durableProject?.canManage !== false;

  const workspacePath = durableLocation?.path ?? runner?.workspaces.find((workspace) => workspace.id === workspaceId)?.path;
  const hostActionsSupported = runnerSupportsProtocol(runner?.protocolVersion, "hostActions");
  const hostActionsHint = runnerCapabilityRequirement(
    runner?.protocolVersion,
    "hostActions",
    "Host editor and file-manager actions",
  );
  // Native Windows cannot reveal a WSL path without distro context.
  const wslPathOnWindows = runner?.os === "windows" && !!workspacePath && workspacePath.startsWith("/");
  const locationUnavailableReason = durableProject && durableProject.locations.length === 0
    ? "Add a Project Location to use location actions."
    : durableProject && durableAvailableLocations.length === 0
      ? "No Project Locations are currently available."
      : durableProject && !durableLocation
        ? "Choose a default Location to use location actions."
        : !runnerId || !workspaceId
          ? "Add a Project Location to use location actions."
    : durableLocation?.availability === "runner_removed"
      ? "The runner for this Location was removed."
      : durableLocation?.availability === "workspace_missing"
        ? "This Location is no longer advertised by its runner."
        : durableLocation?.availability === "runner_offline" || runner?.status !== "online"
          ? "The runner for this Location is offline."
          : !workspacePath
            ? "The runner has not advertised this workspace."
            : null;
  const newSessionUnavailableReason = durableProject
    ? durableAvailableLocations.length === 0 ? locationUnavailableReason : null
    : locationUnavailableReason;
  const revealUnavailableReason = locationUnavailableReason ?? (wslPathOnWindows
    ? "WSL workspace paths cannot be revealed from the Project menu yet."
    : !hostActionsSupported
      ? hostActionsHint
      : null);
  const managementUnavailableReason = canManageProject ? null : "Project management permission is required.";
  const archiveUnavailableReason = archiveCount === 0
    ? `This ${entityLabel} has no unarchived sessions.`
    : managementUnavailableReason;
  const hasActionStatus = !!(locationUnavailableReason || revealUnavailableReason || managementUnavailableReason || archiveUnavailableReason);
  const statusId = `${menu.menuId}-status`;

  const focusTrigger = () => menu.triggerRef.current?.focus();
  const closeForLayer = () => {
    menu.close(false);
    focusTrigger();
  };
  const reportError = (action: string, cause: unknown) => {
    showToast(`${action}: ${(cause as Error).message}`, { tone: "error" });
  };

  const reveal = () => {
    menu.close(true);
    if (!workspacePath || !runnerId) return;
    void api.revealWorkspace(runnerId, workspacePath).catch((cause) => reportError("Could not reveal Location", cause));
  };

  const beginRename = () => {
    closeForLayer();
    setRenameDraft(split.name);
    setRenameError(null);
    setRenameOpen(true);
  };

  const closeRename = () => {
    if (renameBusy) return;
    setRenameOpen(false);
    window.setTimeout(focusTrigger, 0);
  };

  const rename = async () => {
    if (renameBusy) return;
    if (renameDraft === split.name) {
      closeRename();
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      if (durableProject) await api.updateProject(durableProject.id, { name: renameDraft });
      else if (runnerId && workspaceId) {
        // Empty is intentional for the legacy adapter: it resets the workspace display override.
        await api.renameWorkspace(runnerId, workspaceId, renameDraft);
      }
      setRenameOpen(false);
      window.setTimeout(focusTrigger, 0);
    } catch (cause) {
      setRenameError((cause as Error).message);
    } finally {
      setRenameBusy(false);
    }
  };

  const archiveAll = async () => {
    closeForLayer();
    const sessionIds = split.sessions.map((session) => session.id);
    const sessionCount = archiveCount;
    if (sessionCount === 0) return;
    const detail = archiveDetailRows(archiveScope.sessions, sessionCount);
    const accepted = await confirm({
      title: archiveStopsRuntime ? "Archive and Stop Sessions" : "Archive Sessions",
      message: archiveStopsRuntime
        ? sessionCount === 1
          ? `The session in “${split.name}” stops and moves to Archived Sessions, and its queued work is canceled. You can restore it, or use Snooze instead to keep it running.`
          : `All ${sessionCount} sessions in “${split.name}” stop and move to Archived Sessions, and their queued work is canceled. You can restore them, or use Snooze instead to keep them running.`
        : sessionCount === 1
          ? `The session in “${split.name}” moves to Archived Sessions. If it is still running, it is stopped first.`
          : `All ${sessionCount} sessions in “${split.name}” move to Archived Sessions. Any that are still running are stopped first.`,
      detailRows: detail.rows,
      detailRowsOverflow: detail.overflow,
      confirmLabel: archiveStopsRuntime ? "Archive and Stop" : "Archive Sessions",
      ...(archiveStopsRuntime ? { tone: "danger" as const } : {}),
    });
    if (!accepted) return;
    try {
      if (durableProject) {
        await archiveProjectWithFeedback({ projectId: durableProject.id, projectName: split.name, api, showToast, showUndo });
        return;
      }
      const outcome = await archiveSessionsWithCompensation(sessionIds, api.setArchived);
      if (!outcome.ok) {
        if (outcome.rollbackFailures > 0) {
          showToast(
            `Bulk archive partially completed; ${outcome.rollbackFailures} session${outcome.rollbackFailures === 1 ? " still needs" : "s still need"} recovery.`,
            {
              tone: "error",
              durationMs: 0,
              action: {
                label: "Restore Sessions",
                progress: "Restoring the sessions…",
                run: async () => {
                  const failures = await setArchivedForSessions(sessionIds, false, api.setArchived);
                  if (failures > 0) throw new Error(`${failures} session${failures === 1 ? "" : "s"} could not be restored`);
                },
              },
            },
          );
        }
        throw new Error(
          `Could not archive ${outcome.archiveFailures} session${outcome.archiveFailures === 1 ? "" : "s"}; ${outcome.rollbackFailures > 0 ? `${outcome.rollbackFailures} still need recovery` : "successful changes were rolled back"}.`,
        );
      }
      const pendingCount = outcome.pendingSessionIds.length;
      const failedCount = outcome.failedSessionIds.length;
      showUndo(failedCount > 0
        ? `${failedCount} session Stop${failedCount === 1 ? " has" : "s have"} failed in ${split.name}. Runtime capacity may still be held; use Retry Stop.`
        : pendingCount > 0
          ? `${pendingCount} session${pendingCount === 1 ? " is" : "s are"} waiting for runtime capacity to be released before archiving from ${split.name}.`
        : `${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} archived from ${split.name}.`, async () => {
        const failures = await setArchivedForSessions(sessionIds, false, api.setArchived);
        if (failures > 0) throw new Error(`${failures} session${failures === 1 ? "" : "s"} could not be restored`);
      });
    } catch (cause) {
      reportError(`Could not archive ${entityLabel.toLowerCase()} sessions`, cause);
    }
  };

  return (
    <div className="inbox-project-menu">
      <button
        ref={menu.triggerRef}
        type="button"
        className="inbox-project-menu-trigger"
        tabIndex={active ? 0 : -1}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        title={actionsLabel}
        aria-label={actionsLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        <MoreHorizontalIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={actionsLabel}
          aria-describedby={hasActionStatus ? statusId : undefined}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {durableProject && onManageProject && (
            <MenuItem
              data-menu-label="Manage Project…"
              onClick={() => {
                menu.close(false);
                onManageProject();
              }}
            >
              Manage Project…
            </MenuItem>
          )}
          <MenuItem
            data-menu-label={pinned ? `Unpin ${entityLabel}` : `Pin ${entityLabel}`}
            onClick={() => {
              menu.close(true);
              onPinnedChange(!pinned);
            }}
          >
            {pinned ? `Unpin ${entityLabel}` : `Pin ${entityLabel}`}
          </MenuItem>
          <MenuItem
            disabled={revealUnavailableReason !== null}
            title={revealUnavailableReason ?? undefined}
            onClick={reveal}
          >
            Reveal in File Manager
          </MenuItem>
          <MenuItem
            disabled={newSessionUnavailableReason !== null}
            title={newSessionUnavailableReason ?? undefined}
            onClick={() => {
              closeForLayer();
              if (durableProject) {
                onNewSession({
                  projectId: durableProject.id,
                  ...(durableLocation ? {
                    runnerId: durableLocation.runnerId,
                    workspaceId: durableLocation.workspaceId,
                    projectLocationId: durableLocation.id,
                  } : {}),
                });
                return;
              }
              if (runnerId && workspaceId) onNewSession({ runnerId, workspaceId, projectName: split.name });
            }}
          >
            {durableProject && durableAvailableLocations.length > 1 && !durableLocation ? "New Session" : "New Session Here"}
          </MenuItem>
          <MenuItem
            disabled={newSessionUnavailableReason !== null}
            title={newSessionUnavailableReason ?? undefined}
            onClick={() => {
              closeForLayer();
              if (durableProject) {
                onNewSession({
                  projectId: durableProject.id,
                  worktree: true,
                  ...(durableLocation ? {
                    runnerId: durableLocation.runnerId,
                    workspaceId: durableLocation.workspaceId,
                    projectLocationId: durableLocation.id,
                  } : {}),
                });
                return;
              }
              if (runnerId && workspaceId) onNewSession({ runnerId, workspaceId, worktree: true });
            }}
          >
            Create Permanent Worktree
          </MenuItem>
          <MenuItem
            disabled={!canManageProject}
            title={managementUnavailableReason ?? undefined}
            onClick={beginRename}
          >
            Rename {entityLabel}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            disabled={archiveCount === 0 || !canManageProject}
            title={archiveUnavailableReason ?? undefined}
            onClick={() => void archiveAll()}
          >
            {archiveStopsRuntime ? "Archive and Stop All Sessions" : "Archive All Sessions"}
          </MenuItem>
          {hasActionStatus && (
            <div id={statusId} className="menu-note" role="note">
              {locationUnavailableReason && <div><strong>Location Actions:</strong> {locationUnavailableReason}</div>}
              {!locationUnavailableReason && revealUnavailableReason && (
                <div><strong>Reveal:</strong> {revealUnavailableReason}</div>
              )}
              {managementUnavailableReason && (
                <div><strong>{entityLabel} Management:</strong> {managementUnavailableReason}</div>
              )}
              {!managementUnavailableReason && archiveUnavailableReason && (
                <div><strong>Archive:</strong> {archiveUnavailableReason}</div>
              )}
            </div>
          )}
        </MenuSurface>
      )}
      {renameOpen && (
        <Modal
          title={`Rename ${entityLabel}`}
          onClose={closeRename}
          footer={(
            <>
              <button type="button" className="btn" onClick={closeRename} disabled={renameBusy}>Cancel</button>
              <button type="submit" className="btn primary" form="rename-project-split-form" disabled={renameBusy}>
                {renameBusy ? "Saving…" : "Save"}
              </button>
            </>
          )}
        >
          <form
            id="rename-project-split-form"
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <label className="field-label" htmlFor="rename-project-split-name">{entityLabel} Name</label>
            <input
              id="rename-project-split-name"
              className="input"
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              disabled={renameBusy}
            />
            {renameError && <div className="form-error" role="alert">{renameError}</div>}
          </form>
        </Modal>
      )}
    </div>
  );
}
