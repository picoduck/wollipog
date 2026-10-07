import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
import {
  archiveProjectWithFeedback,
  projectArchiveMessage,
  projectArchiveResultMessage,
  projectArchiveResultTone,
} from "../project-actions.js";
import { useApi } from "../api-context.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { useFeedback, type ConfirmationDetailRow } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { Modal, sessionLifecycleMeta } from "./common.js";
import { MoreHorizontalIcon } from "./Icons.js";
import { handleMenuKeyDown } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface, type MenuAnchor } from "./Menu.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import type { GroupTabMenuRequest } from "./SessionGroupTabs.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useIsMobile } from "./useIsMobile.js";

export interface ProjectSplitActionsProps {
  split: InboxSplit;
  /** The same split before the Inbox's Active or Snoozed filter. A durable Project archive runs on the
   * server over every unarchived session, snoozed or not, so its confirmation counts and lists these. */
  unfilteredSplit?: InboxSplit;
  runner: RunnerView | undefined;
  stopBeforeArchiveSupported?: boolean;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onNewSession: (preset: NewSessionPreset) => void;
  onManageProject?: () => void;
  /** Offered from a phone menu sheet: the archive confirmation replaces the sheet, and its Back
   * brings the sheet back (§7.5). */
  confirmBack?: { label: string; run: () => void };
}

export interface ProjectSplitMenuProps extends ProjectSplitActionsProps {
  /** Whether the project's tab is the selected one: only that tab shows ⋯ after it. */
  active?: boolean;
  /** The menu the tab row opened from the tab itself (a right-click, Shift+F10 or the context-menu
   * key), or null. */
  tabMenu?: GroupTabMenuRequest | null;
  onTabMenuClose?: () => void;
}

/** One project action, as a menu row. */
export interface ProjectAction {
  id: "new-session" | "rename" | "pin" | "worktree" | "reveal" | "manage" | "archive";
  /** Title Case; an action that opens a dialog ends in an ellipsis, navigation never does (§17.2). */
  label: string;
  /** Why the action is unavailable, shown as the row's second line (§9.1), or null when it is. */
  unavailableReason: string | null;
  danger?: boolean;
  /** Navigation leaves the page, so focus is not handed back to where the menu was opened. */
  navigates?: boolean;
  run: () => void;
}

export interface ProjectSplitActions {
  /** The project's name: the phone sheet's title. */
  name: string;
  /** "<Name> Actions": the ⋯ trigger's and the menu's accessible name. */
  label: string;
  /** The actions in menu order, one array per group between separators. */
  groups: ProjectAction[][];
  /** The Rename dialog while it is open. Render it wherever the actions are offered. */
  dialogs: ReactNode;
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

/** How long type-ahead keeps gathering letters, as the shared menu hook does. */
const TYPEAHEAD_MS = 500;

const sessionsWord = (count: number) => `${count} Session${count === 1 ? "" : "s"}`;

/**
 * A project's actions (#2199), for any menu that offers them: the tab row's ⋯ and right-click menu,
 * and the phone app bar's ⋯ sheet. Groups, in order: New Session Here; Rename, Pin, Create Permanent
 * Worktree and Reveal in File Manager (not on phones); Manage Project; the archive, last and in the
 * danger style (§9.1). Choosing an action runs it after the menu has handed focus back to where it
 * was opened, so a dialog it opens returns focus there.
 */
export function useProjectSplitActions(props: ProjectSplitActionsProps | null): ProjectSplitActions | null {
  const api = useApi();
  const { confirm, showToast, showUndo } = useFeedback();
  const phone = useIsMobile();
  // The group Rename was opened for. The dialog belongs to that group: a caller that follows the
  // current group (the phone app bar) can change it under the open dialog (Back), and the dialog must
  // then close rather than rename whichever project is current.
  const identity = props ? props.split.key : undefined;
  const [renaming, setRenaming] = useState<InboxSplit["key"] | undefined>(undefined);
  if (renaming !== undefined && renaming !== identity) setRenaming(undefined);
  // Null for a group with no project (All, No Project), so a caller that follows the current group
  // keeps one hook call as the group changes.
  if (!props) return null;
  const {
    split,
    unfilteredSplit,
    runner,
    stopBeforeArchiveSupported = true,
    pinned,
    onPinnedChange,
    onNewSession,
    onManageProject,
    confirmBack,
  } = props;

  const durableProject = split.project?.kind === "durable" ? split.project.project : null;
  const durableLocation = split.project?.kind === "durable" ? split.project.primaryLocation : null;
  const durableAvailableLocations = durableProject?.locations.filter((location) => location.availability === "available") ?? [];
  const legacyLocation = split.project?.kind === "legacy" ? split.project : null;
  if (!durableProject && !legacyLocation) return null;
  const entityLabel = durableProject ? "Project" : "Workspace";
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
    "host editor and file-manager actions",
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

  const reportError = (action: string, cause: unknown) => {
    showToast(`${action}: ${(cause as Error).message}`, { tone: "error" });
  };

  const newSession = (worktree: boolean) => {
    if (durableProject) {
      onNewSession({
        projectId: durableProject.id,
        ...(worktree ? { worktree: true } : {}),
        ...(durableLocation ? {
          runnerId: durableLocation.runnerId,
          workspaceId: durableLocation.workspaceId,
          projectLocationId: durableLocation.id,
        } : {}),
      });
      return;
    }
    if (!runnerId || !workspaceId) return;
    onNewSession(worktree ? { runnerId, workspaceId, worktree: true } : { runnerId, workspaceId, projectName: split.name });
  };

  const reveal = () => {
    if (!workspacePath || !runnerId) return;
    void api.revealWorkspace(runnerId, workspacePath).catch((cause) => reportError("Could not reveal Location", cause));
  };

  const rename = async (name: string) => {
    if (durableProject) await api.updateProject(durableProject.id, { name });
    // Empty is intentional for the legacy adapter: it resets the workspace display override.
    else if (runnerId && workspaceId) await api.renameWorkspace(runnerId, workspaceId, name);
  };

  const archiveAll = async () => {
    const sessionIds = split.sessions.map((session) => session.id);
    const sessionCount = archiveCount;
    if (sessionCount === 0) return;
    const detail = archiveDetailRows(archiveScope.sessions, sessionCount);
    const accepted = await confirm({
      title: archiveStopsRuntime ? `Archive and Stop ${sessionsWord(sessionCount)}` : `Archive ${sessionsWord(sessionCount)}`,
      message: projectArchiveMessage({
        projectName: split.name,
        count: sessionCount,
        stops: archiveStopsRuntime,
        onProjectPage: false,
      }),
      detailRows: detail.rows,
      detailRowsOverflow: detail.overflow,
      confirmLabel: archiveStopsRuntime ? "Archive and Stop" : "Archive Sessions",
      ...(archiveStopsRuntime ? { tone: "danger" as const } : {}),
      ...(confirmBack ? { back: confirmBack } : {}),
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
      const counts = {
        archived: sessionIds.length,
        pending: outcome.pendingSessionIds.length,
        failed: outcome.failedSessionIds.length,
      };
      showUndo(projectArchiveResultMessage(split.name, counts), async () => {
        const failures = await setArchivedForSessions(sessionIds, false, api.setArchived);
        if (failures > 0) throw new Error(`${failures} session${failures === 1 ? "" : "s"} could not be restored`);
      }, projectArchiveResultTone(counts));
    } catch (cause) {
      reportError(`Could not archive ${entityLabel.toLowerCase()} sessions`, cause);
    }
  };

  const groups: ProjectAction[][] = [
    [{
      id: "new-session",
      label: durableProject && durableAvailableLocations.length > 1 && !durableLocation ? "New Session" : "New Session Here",
      unavailableReason: newSessionUnavailableReason,
      run: () => newSession(false),
    }],
    [
      {
        id: "rename",
        label: `Rename ${entityLabel}…`,
        unavailableReason: managementUnavailableReason,
        run: () => setRenaming(split.key),
      },
      {
        id: "pin",
        label: pinned ? `Unpin ${entityLabel}` : `Pin ${entityLabel}`,
        unavailableReason: null,
        run: () => onPinnedChange(!pinned),
      },
      {
        id: "worktree",
        label: "Create Permanent Worktree…",
        unavailableReason: newSessionUnavailableReason,
        run: () => newSession(true),
      },
      // A phone has no file manager to reveal in.
      ...(phone ? [] : [{
        id: "reveal" as const,
        label: "Reveal in File Manager",
        unavailableReason: revealUnavailableReason,
        run: reveal,
      }]),
    ],
    ...(durableProject && onManageProject ? [[{
      id: "manage" as const,
      label: "Manage Project",
      unavailableReason: null,
      navigates: true,
      run: onManageProject,
    }]] : []),
    [{
      id: "archive",
      label: archiveStopsRuntime ? "Archive and Stop All Sessions…" : "Archive All Sessions…",
      unavailableReason: archiveUnavailableReason,
      danger: true,
      run: () => void archiveAll(),
    }],
  ];

  return {
    name: split.name,
    label: `${split.name} Actions`,
    groups,
    dialogs: renaming === split.key && (
      <RenameProjectDialog
        entityLabel={entityLabel}
        currentName={split.name}
        rename={rename}
        onClose={() => setRenaming(undefined)}
      />
    ),
  };
}

/** A project's actions as menu rows, its groups split by separators. */
export function ProjectMenuItems({ groups, onChoose }: {
  groups: readonly (readonly ProjectAction[])[];
  onChoose: (action: ProjectAction) => void;
}) {
  return groups.filter((group) => group.length > 0).map((group, index) => (
    <Fragment key={group[0]!.id}>
      {index > 0 && <MenuSeparator />}
      {group.map((action) => (
        <MenuItem
          key={action.id}
          data-menu-label={action.label}
          danger={action.danger}
          disabled={action.unavailableReason !== null}
          description={action.unavailableReason ?? undefined}
          onClick={() => onChoose(action)}
        >
          {action.label}
        </MenuItem>
      ))}
    </Fragment>
  ));
}

/**
 * A project tab's actions (#2199): ⋯ after the selected tab, and the same menu at a right-click,
 * Shift+F10 or the context-menu key on any project tab, which leaves the selection where it is. The
 * menu hands focus back to whatever opened it: ⋯, or the tab. On a phone it is the shared bottom
 * sheet, titled with the project's name (§9.2).
 */
export function ProjectSplitMenu({ active = true, tabMenu = null, onTabMenuClose, ...props }: ProjectSplitMenuProps) {
  const actions = useProjectSplitActions(props);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [openFocus, setOpenFocus] = useState<"first" | "last">("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = `project-menu-${useId().replace(/:/g, "")}`;
  const typeahead = useRef({ text: "", at: 0 });
  const tab = tabMenu?.tab ?? null;
  const anchor = useMemo<MenuAnchor>(() => {
    if (tabMenu?.point) return { point: tabMenu.point };
    if (tab) return { trigger: { current: tab } };
    return { trigger: triggerRef };
  }, [tab, tabMenu?.point]);
  const open = tabMenu !== null || (triggerOpen && active);

  // ⋯ leaves with the selection, and its menu with it.
  useEffect(() => {
    if (!active) setTriggerOpen(false);
  }, [active]);

  useEffect(() => {
    if (!open) return;
    // Every opening starts a fresh type-ahead search, however the last one ended: a dismissal, a
    // choice, or the selection or the tab's request going away.
    typeahead.current = { text: "", at: 0 };
    const items = [...menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
    // A menu whose every item is unavailable takes focus itself, so Escape and the arrows still reach it.
    ((openFocus === "last" ? items.at(-1) : items[0]) ?? menuRef.current)?.focus();
  }, [open, openFocus, tabMenu]);

  if (!actions) return null;

  const close = (restoreFocus: boolean) => {
    const opener = tabMenu ? tabMenu.tab : triggerRef.current;
    if (tabMenu) onTabMenuClose?.();
    setTriggerOpen(false);
    if (restoreFocus) opener?.focus();
  };
  const choose = (action: ProjectAction) => {
    close(!action.navigates);
    action.run();
  };
  // Type-ahead gathers the letters typed within half a second ("pin" stays on Pin Project), as the
  // shared menu hook does; Escape, Tab and the arrows are the shared menu keys.
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key.length !== 1 || event.key === " " || event.ctrlKey || event.metaKey || event.altKey) {
      handleMenuKeyDown(event, close);
      return;
    }
    const now = Date.now();
    const buffer = typeahead.current;
    buffer.text = (now - buffer.at > TYPEAHEAD_MS ? "" : buffer.text) + event.key.toLocaleLowerCase();
    buffer.at = now;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    for (let offset = 1; offset <= items.length; offset += 1) {
      const item = items[(Math.max(current, -1) + offset) % items.length]!;
      if (item.dataset.menuLabel?.toLocaleLowerCase().startsWith(buffer.text)) {
        event.preventDefault();
        item.focus();
        return;
      }
    }
  };

  return (
    <>
      {active && (
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn sm inbox-project-actions"
          title={actions.label}
          aria-label={actions.label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            setOpenFocus("first");
            setTriggerOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setOpenFocus(event.key === "ArrowUp" ? "last" : "first");
            setTriggerOpen(true);
          }}
        >
          <MoreHorizontalIcon />
        </button>
      )}
      {open && (
        <MenuSurface
          surfaceRef={menuRef}
          anchor={anchor}
          id={menuId}
          // The phone sheet's title is the project's name; the menu is named like its trigger.
          label={actions.name}
          aria-label={actions.label}
          tabIndex={-1}
          onDismiss={() => close(true)}
          onKeyDown={onMenuKeyDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          <ProjectMenuItems groups={actions.groups} onChoose={choose} />
        </MenuSurface>
      )}
      {actions.dialogs}
    </>
  );
}

const RENAME_FORM_ID = "rename-project-form";
const RENAME_FIELD_ID = "rename-project-name";
const RENAME_HELPER_ID = "rename-project-name-helper";
const RENAME_ERROR_ID = "rename-project-name-error";

/**
 * Rename Project (§7.2, §8.5): one Name field whose helper an error replaces. An empty or unchanged
 * name is refused on the field, and a request that fails says why in the same place. The primary
 * keeps its label and shows a spinner while the rename runs (§3.1).
 *
 * A legacy Workspace (a control plane without Projects) keeps its one reset: an empty name clears
 * the display override, so it is accepted and the helper says so.
 */
function RenameProjectDialog({ entityLabel, currentName, rename, onClose }: {
  entityLabel: "Project" | "Workspace";
  currentName: string;
  rename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const noun = entityLabel.toLowerCase();
  const resettable = entityLabel === "Workspace";
  const [draft, setDraft] = useState(currentName);
  const [edited, setEdited] = useState(false);
  // What is wrong with the name as typed, and why the last request failed. A failure stays until the
  // name is edited or submitted again; leaving the field does not answer it.
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const error = invalid ?? failure;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const nameError = (value: string) => {
    const name = value.trim();
    const refused = name === "" ? !resettable : name === currentName;
    return refused ? `Enter a name for the ${noun}.` : null;
  };

  const close = () => {
    if (busyRef.current) return;
    onClose();
  };

  const submit = async () => {
    if (busyRef.current) return;
    const problem = nameError(draft);
    setInvalid(problem);
    setFailure(null);
    setEdited(true);
    if (problem) {
      fieldRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await rename(draft.trim());
      busyRef.current = false;
      onClose();
    } catch (cause) {
      busyRef.current = false;
      setFailure((cause as Error).message);
      fieldRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Rename ${entityLabel}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={RENAME_FORM_ID} busy={busy}
            progress={`Renaming the ${noun}…`}>
            Rename {entityLabel}
          </BusyButton>
        </>
      )}
    >
      <form
        id={RENAME_FORM_ID}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <div className="field-head"><label htmlFor={RENAME_FIELD_ID}>Name</label></div>
          <input
            ref={fieldRef}
            id={RENAME_FIELD_ID}
            autoFocus
            autoComplete="off"
            value={draft}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? RENAME_ERROR_ID : RENAME_HELPER_ID}
            // Read-only rather than disabled while renaming, so a field submitted with Enter keeps focus.
            readOnly={busy}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              setEdited(true);
              setFailure(null);
              // An error showing clears as soon as the value is valid (§8.5).
              if (invalid) setInvalid(nameError(next));
            }}
            onBlur={() => { if (edited && !busyRef.current) setInvalid(nameError(draft)); }}
          />
          {error
            ? <FieldError id={RENAME_ERROR_ID}>{error}</FieldError>
            : (
              <p className="field-helper" id={RENAME_HELPER_ID}>
                {resettable ? "Leave empty to use the folder name." : `Changes the name everywhere this ${noun} appears.`}
              </p>
            )}
        </div>
      </form>
    </Modal>
  );
}
