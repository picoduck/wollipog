import { useState } from "react";
import { createPortal } from "react-dom";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type RunnerView,
} from "@wollipog/protocol";
import type { InboxSplit } from "../inbox.js";
import {
  archiveSessionsWithCompensation,
  sessionArchiveRequiresStop,
  setArchivedForSessions,
} from "../archive-actions.js";
import { archiveProjectWithFeedback } from "../project-actions.js";
import { useApi } from "../api-context.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./common.js";
import { MoreHorizontalIcon } from "./Icons.js";
import { useAccessibleMenu, useAnchoredMenuStyle } from "./interactions.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";

export interface ProjectSplitMenuProps {
  split: InboxSplit;
  active?: boolean;
  runner: RunnerView | undefined;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onNewSession: (preset: NewSessionPreset) => void;
  onManageProject?: () => void;
}

/** Project actions owned by a Command Inbox project split. */
export function ProjectSplitMenu({
  split,
  active = true,
  runner,
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
  const menuStyle = useAnchoredMenuStyle(open, menu.triggerRef, {
    desiredWidth: 236,
    // This is intentionally a maximum: actions and the availability/status note are conditional.
    // Above-flipped menus anchor their rendered bottom edge, so shorter variants remain adjacent.
    desiredHeight: 280,
    align: "start",
  });

  const durableProject = split.project?.kind === "durable" ? split.project.project : null;
  const durableLocation = split.project?.kind === "durable" ? split.project.primaryLocation : null;
  const durableAvailableLocations = durableProject?.locations.filter((location) => location.availability === "available") ?? [];
  const legacyLocation = split.project?.kind === "legacy" ? split.project : null;
  if (!durableProject && !legacyLocation) return null;
  const entityLabel = durableProject ? "Project" : "Workspace";
  const actionsLabel = `${entityLabel} Actions for ${split.name}`;
  const archiveStopsRuntime = split.sessions.some(sessionArchiveRequiresStop);
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
  const archiveUnavailableReason = (durableProject ? split.count : split.sessions.length) === 0
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
    const sessionCount = durableProject ? split.count : sessionIds.length;
    if (sessionCount === 0) return;
    const accepted = await confirm({
      title: `${archiveStopsRuntime ? "Archive and stop" : "Archive"} ${sessionCount} session${sessionCount === 1 ? "" : "s"}?`,
      message: archiveStopsRuntime
        ? `Sessions will move to Archived Sessions after their runtimes stop. Queued work will be canceled and runtime capacity will be released.${durableProject ? " The server applies the same stop-before-archive rule to Project sessions that are not currently loaded." : ""} To keep work running outside the Inbox, use Snooze instead.`
        : `Move every session in “${split.name}” to Archived. The server will still stop any session that can hold runtime capacity before archiving it.`,
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
      showUndo(`${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} archived from ${split.name}.`, async () => {
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
      {open && createPortal((
        <>
          <div className="menu-backdrop" onClick={() => menu.close(true)} aria-hidden="true" />
          <div
            id={menu.menuId}
            ref={menu.menuRef}
            className="menu-pop inbox-project-menu-pop"
            role="menu"
            aria-label={actionsLabel}
            aria-describedby={hasActionStatus ? statusId : undefined}
            onKeyDown={menu.onMenuKeyDown}
            style={menuStyle}
          >
            {durableProject && onManageProject && (
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                data-menu-label="Manage Project…"
                onClick={() => {
                  menu.close(false);
                  onManageProject();
                }}
              >
                Manage Project…
              </button>
            )}
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              data-menu-label={pinned ? `Unpin ${entityLabel}` : `Pin ${entityLabel}`}
              onClick={() => {
                menu.close(true);
                onPinnedChange(!pinned);
              }}
            >
              {pinned ? `Unpin ${entityLabel}` : `Pin ${entityLabel}`}
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              disabled={revealUnavailableReason !== null}
              title={revealUnavailableReason ?? undefined}
              onClick={reveal}
            >
              Reveal in File Manager
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
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
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
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
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              disabled={!canManageProject}
              title={managementUnavailableReason ?? undefined}
              onClick={beginRename}
            >
              Rename {entityLabel}
            </button>
            <button
              type="button"
              className="menu-item danger"
              role="menuitem"
              disabled={(durableProject ? split.count : split.sessions.length) === 0 || !canManageProject}
              title={archiveUnavailableReason ?? undefined}
              onClick={() => void archiveAll()}
            >
              {archiveStopsRuntime ? "Archive and Stop All Sessions" : "Archive All Sessions"}
            </button>
            {hasActionStatus && (
              <div id={statusId} className="inbox-project-location-status" role="note">
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
          </div>
        </>
      ), document.body)}
      {renameOpen && (
        <Modal
          title={`Rename ${entityLabel}`}
          onClose={closeRename}
          footer={(
            <>
              <button type="button" className="btn ghost" onClick={closeRename} disabled={renameBusy}>Cancel</button>
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
