import React, { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import {
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type ProviderAccountDefinition,
  type SessionReminderView,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { RenameSessionDialog } from "./RenameSessionDialog.js";
import { sessionAccountSwitchApplicable, SwitchAccountDialog } from "./SwitchAccountDialog.js";
import {
  archiveAndStopMessage,
  archiveResultMessage,
  archiveResultTone,
  sessionArchiveActionLabel,
  sessionArchiveRequiresStop,
  sessionUnarchiveRestarts,
} from "../archive-actions.js";
import { removeFromInstanceKeySet, SESSION_PIN_KEY } from "../pins.js";
import { discardComposerDraft } from "../composer-drafts.js";
import { useInstanceScope } from "../instance-scope.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { absoluteViewUrl, backLabel } from "../navigation.js";
import { reminderMenuActionLabel } from "../session-reminders.js";
import { requestTranscriptDownload } from "../transcript-download.js";
import { DEVELOPMENT_BUILD } from "../config.js";
import { shortcutDisplay } from "../shortcuts.js";
import { pendingQueuedPromptCount, type ConversationForkAvailability } from "../session-actions.js";
import { backgroundWorkAccessibleName } from "./common.js";
import {
  useAccessibleMenu,
  useDismissiblePopover,
} from "./interactions.js";
import { MenuItem, MenuNote, MenuSeparator, MenuSurface } from "./Menu.js";
import { useFeedback } from "./FeedbackProvider.js";
import { TranscriptShareDialog } from "./TranscriptShareDialog.js";
import { ChevronLeftIcon, DownloadIcon, LinkIcon, MoreVerticalIcon, RefreshIcon, ShareIcon } from "./Icons.js";
import { useIsCoarsePointer, useIsMobile } from "./useIsMobile.js";
import { windowDragRegion } from "../desktop-window.js";
import { sessionDisplayTitle } from "../session-title.js";
import { deleteSessionMessage, signOutOfAgentMessage, stopSessionMessage } from "../session-confirmation-copy.js";
import { sessionAgentLabel } from "./agent-options.js";
import { sessionArchiveActionRefusal, sessionCommandRefusal } from "../session-command-permissions.js";
import { unarchiveSession } from "../session-unarchive.js";
import { writeClipboardText } from "../clipboard.js";
import { sessionStatusSummary } from "../status-meta.js";
import { SessionStatusButton } from "./SessionStatusButton.js";
import { useBackgroundDeliveryStep } from "./useBackgroundDeliveryStep.js";

/** The second line of an item that waits on another session action already running. */
const BUSY_REASON = "Available when the current action finishes.";
const NO_SESSION_LINK_REASON = "Open Wollipog in a browser to copy a link.";
/** A contributor hint, shown by development builds only (§17.2 keeps env var names out of releases). */
const DEVELOPMENT_LINK_HINT = "Development builds can set VITE_DASHBOARD_ORIGIN.";

/**
 * The responsive Session bar (docs/design-system.md §4.3). Desktop keeps one 48px row: Back, the
 * project menu button, the title, the Session Status control, then Share / More Actions and the
 * shell controls.
 * Mobile identity moves into the app topbar, leaving this component as the single status/action
 * line above the transcript.
 */
export function SessionHeader({
  session,
  onBack,
  runnerOnline,
  machineName,
  machineAccounts,
  onOpenConnections,
  runnerProtocolVersion,
  providerLogoutSupported,
  stopBeforeArchiveSupported,
  unarchiveAndRestartSupported = false,
  onReloadSession,
  exportReady,
  onArchive,
  onSnooze,
  reminder,
  onDismissReminder,
  forkAvailability,
  onFork,
  forkShortcutRef,
  projectControl,
  projectName,
  projectLabel = "Project",
  onOpenProject,
  renderMoveProjectDialog,
  topbarControls,
  activeSubagents,
  descendantRequests,
  onOpenBackgroundWork,
  onOpenAttention,
  onOpenCampaignRequests,
  titleId,
  developmentBuild = DEVELOPMENT_BUILD,
}: {
  session: SessionView;
  onBack: () => void;
  runnerOnline: boolean;
  /** The session's machine, named in the reasons its items are unavailable. */
  machineName?: string;
  /** The machine's provider accounts, which Switch Account lists and checks the session's against. */
  machineAccounts?: readonly ProviderAccountDefinition[];
  /** Opens Connections, where Switch Account sends a person with no other account. */
  onOpenConnections?: () => void;
  runnerProtocolVersion: number | null | undefined;
  providerLogoutSupported: boolean;
  stopBeforeArchiveSupported: boolean;
  /** The control plane owns one preflighted Unarchive and Restart; absent on older control planes. */
  unarchiveAndRestartSupported?: boolean;
  /** Re-read this session from the server after an outcome the client could not confirm. */
  onReloadSession?: () => Promise<void>;
  exportReady: boolean;
  onArchive?: () => void;
  onSnooze?: () => void;
  reminder?: SessionReminderView;
  onDismissReminder?: () => void;
  forkAvailability?: ConversationForkAvailability;
  onFork?: () => void;
  /** Holds Fork Conversation…'s action while the item is offered and enabled, and null otherwise,
   * so the Session Reading F key runs exactly what the item would (#2272). Given only where that key
   * is live, so the item shows its keycap only there. */
  forkShortcutRef?: MutableRefObject<(() => void) | null>;
  /** The project menu button, drawn before the title above the compact tier. */
  projectControl?: ReactNode;
  /** The session's Project (or Workspace) name; absent when it has none. */
  projectName?: string;
  /** Compatibility control planes group sessions by Workspace instead of Project. */
  projectLabel?: "Project" | "Workspace";
  /** Opens the Project's page. */
  onOpenProject?: () => void;
  renderMoveProjectDialog?: (options: {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
  /** App-shell control cluster (editor, pinned summary, terminal, side panel) when this bar
   * replaces the top-level app bar on desktop. */
  topbarControls?: ReactNode;
  /** Live structured subagents remain visible even while the parent awaits its next prompt. */
  activeSubagents?: { count: number; onOpen: () => void; workers?: boolean };
  /** Consolidated unresolved descendant requests owned by the dedicated request panel. */
  descendantRequests?: { count: number; onOpen: () => void };
  /** Opens the inspectable managed-job inventory. */
  onOpenBackgroundWork?: () => void;
  onOpenAttention?: () => void;
  onOpenCampaignRequests?: () => void;
  /** Set when this bar owns the page heading (`page-title` focus-rescue anchor). */
  titleId?: string;
  /** Contributor hints (the dashboard-origin build variable) appear only in development builds. */
  developmentBuild?: boolean;
}) {
  const api = useApi();
  const instances = useInstances();
  const instanceScope = useInstanceScope();
  const isMobile = useIsMobile();
  const coarsePointer = useIsCoarsePointer();
  const { confirm, showToast, showUndo } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [moveProjectOpen, setMoveProjectOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [switchAccountDialogOpen, setSwitchAccountDialogOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const projectSlotRef = useRef<HTMLDivElement>(null);
  // Where the project button is hidden (the compact tier, §15.2) or absent (phones), its actions
  // lead More Actions instead. The stylesheet decides the tier, so it is read as the menu opens.
  const [projectInMenu, setProjectInMenu] = useState(false);
  const displayTitle = sessionDisplayTitle(session.title) || "Session";
  // On a phone the action line's icon buttons are the small size: 36px with a borrowed 44px hit
  // area on touch (§2.8, §15.1).
  const actionSize = isMobile ? " sm" : "";
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "session-actions-menu");
  const shareMenu = useAccessibleMenu(shareMenuOpen, setShareMenuOpen, "session-share-menu");
  const statusPopover = useDismissiblePopover(
    statusPopoverOpen,
    setStatusPopoverOpen,
    "session-status-popover",
  );
  const terminal = isTerminal(session.status);
  const showRetryStop = session.stopOperation?.status === "stop_failed" && !session.archiveStatus;
  const showRestart = terminal && runnerOnline && session.stopOperation?.status !== "stop_failed" &&
    !sessionUnarchiveRestarts(session, unarchiveAndRestartSupported);
  // A command the server would refuse this person stays listed but disabled, with the reason (#1843).
  const stopRefusal = sessionCommandRefusal(session, "stop");
  const restartRefusal = sessionCommandRefusal(session, "restart");
  const archiveRefusal = sessionArchiveActionRefusal(session);
  const renameRefusal = sessionCommandRefusal(session, "rename");
  const visibleBackgroundWorkState = session.backgroundWorkState === "resumed"
    ? undefined
    : session.backgroundWorkState;
  const reprocessSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionReprocess");
  const logoutSupported = runnerSupportsProtocol(runnerProtocolVersion, "acpLogout");
  const accountSwitchSupported = runnerSupportsProtocol(
    runnerProtocolVersion,
    "sessionProviderAccountSwitch",
  );
  const accountSwitchApplicable = sessionAccountSwitchApplicable(session);
  const dashboardOrigin = instancePublicOrigin(instances);
  const internalSessionUrl = dashboardOrigin
    ? absoluteViewUrl(dashboardOrigin, { name: "session", id: session.id })
    : null;
  // Every disabled menu item says why on its second line, in the person's terms (§9.1, §9.3).
  const runnerUpdateReason = `Update Wollipog on ${machineName || "this machine"} to use this.`;
  const transcriptReason = busy ? BUSY_REASON : exportReady ? null : "Available when the transcript finishes loading.";
  const sessionLinkReason = transcriptReason ?? (internalSessionUrl ? null : developmentBuild
    ? `${NO_SESSION_LINK_REASON} ${DEVELOPMENT_LINK_HINT}`
    : NO_SESSION_LINK_REASON);
  const switchAccountReason = busy
    ? BUSY_REASON
    : !runnerOnline ? `${machineName || "This machine"} is offline.` : accountSwitchSupported ? null : runnerUpdateReason;
  const reprocessReason = busy ? BUSY_REASON : reprocessSupported ? null : runnerUpdateReason;
  const signOutReason = busy
    ? BUSY_REASON
    : session.status !== "idle"
      ? "Available when the agent is idle."
      : pendingQueuedPromptCount(session.queued) > 0 ? "Available when queued messages are sent." : null;
  const forkOffered = forkAvailability !== undefined && (forkAvailability.available || forkAvailability.offered);
  const forkReason = busy ? BUSY_REASON : forkAvailability?.available === false ? forkAvailability.reason : null;
  const forkShortcut = forkOffered && forkReason === null ? onFork ?? null : null;
  useLayoutEffect(() => {
    if (!forkShortcutRef) return;
    forkShortcutRef.current = forkShortcut;
    return () => { forkShortcutRef.current = null; };
  }, [forkShortcut, forkShortcutRef]);
  const archiveReason = busy ? BUSY_REASON : archiveRefusal;
  const restartReason = busy ? BUSY_REASON : restartRefusal;
  const stopReason = busy ? BUSY_REASON : stopRefusal;
  // Archiving that also stops the session asks first, so only that label takes the ellipsis.
  const archiveAction = sessionArchiveActionLabel(session, stopBeforeArchiveSupported, unarchiveAndRestartSupported);
  const archiveLabel = !session.archived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)
    ? `${archiveAction}…`
    : archiveAction;
  const signOutOffered = session.driver === "acp" && !terminal && runnerOnline && logoutSupported && providerLogoutSupported;
  const statusSummary = sessionStatusSummary(session, {
    runnerOnline,
    descendantRequests: descendantRequests?.count,
    activeWorkers: activeSubagents?.count,
  });
  const deliveryStep = useBackgroundDeliveryStep({
    session,
    condition: statusSummary.conditions.find((condition) => condition.kind === "background_delivery"),
    runnerOnline,
    runnerProtocolVersion,
    returnFocusRef: statusPopover.triggerRef,
  });
  const closeMenu = (restoreFocus = false) => {
    menu.close(restoreFocus);
  };

  // Hands an action to a confirmation the caller opens itself (Fork's Create Fork, the Sessions
  // list's Archive and Stop). The confirmation returns focus to whatever held it as it opened, so
  // the trigger takes focus now rather than after the menu item has gone.
  const closeMenuToTrigger = () => {
    menu.close(false);
    menu.triggerRef.current?.focus();
  };

  const projectFolded = () => {
    if (isMobile) return true;
    const slot = projectSlotRef.current;
    return slot !== null && getComputedStyle(slot).display === "none";
  };

  const closeShareMenu = (restoreFocus = false) => {
    shareMenu.close(restoreFocus);
  };

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const closeStatusPopover = (restoreFocus = false) => {
    statusPopover.close(restoreFocus);
  };

  const run = async (
    fn: () => Promise<unknown>,
    returnFocusRef: RefObject<HTMLButtonElement | null> = menu.triggerRef,
  ) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      // A failure is an error toast with the server's sentence (§13.1); the bar holds no note.
      showToast(error instanceof Error ? error.message : String(error), { tone: "error" });
    } finally {
      setBusy(false);
      // Async menu actions disable the ⋯ trigger while they run, so a restoration queued at
      // menu close or confirmation settle can no-op against the disabled button and strand
      // focus on <body>. Reclaim it once the trigger is enabled again — but only when focus
      // was actually dropped, so a user who moved on is not yanked back (regression coverage).
      window.setTimeout(() => {
        if (document.activeElement === document.body || document.activeElement === null) {
          returnFocusRef.current?.focus();
        }
      }, 0);
    }
  };

  // Re-import an adopted session: re-parse its original CLI transcript with the current formatter.
  // The control plane broadcasts a session_events_reset, so every open dashboard swaps in the fresh
  // timeline (no manual refetch needed), and that new timeline is the result: no toast repeats it.
  const reprocess = () => {
    closeMenu(true); // the invoking menu item unmounts; the ⋯ trigger is the durable focus home
    void run(() => api.reprocessSession(session.id));
  };

  const downloadTranscript = (format: "json" | "markdown") => {
    closeShareMenu(true);
    void run(async () => {
      const { blob, filename } = await api.transcriptExport(session.id, format);
      requestTranscriptDownload(blob, filename);
      showToast("Transcript exported.", { tone: "success" });
    }, shareMenu.triggerRef);
  };

  const copySessionLink = async (url: string) => {
    // The menu closes now, not when the write settles, so a slow clipboard can never close a menu
    // opened in the meantime. A refusal falls back only while the copy still owns the interaction:
    // the bar is mounted and focus is on the item that started it (a refusal can be synchronous: a
    // plain-HTTP page has no Clipboard API), the Share trigger it is handed to, or nowhere. Anything
    // opened since (Share again, More Actions, a dialog) or leaving the page makes it stale.
    const invoker = document.activeElement;
    closeShareMenu(true);
    const copyStillCurrent = () => mountedRef.current && (document.activeElement === null ||
      document.activeElement === document.body || document.activeElement === invoker ||
      document.activeElement === shareMenu.triggerRef.current);
    const copied = await writeClipboardText(url, copyStillCurrent);
    if (copied === null) return;
    // The fallback's selection dropped focus; hand it back to the trigger it came from.
    if (document.activeElement === document.body || document.activeElement === null) {
      shareMenu.triggerRef.current?.focus();
    }
    if (copied) showToast("Link copied.", { tone: "success" });
    else showToast("Couldn't copy the link.", { tone: "error" });
  };

  // More Actions (§9.1): no section labels, a separator between groups, destructive items last.
  const moreActionGroups = (
    [
      // Where the project button is folded away (the compact tier) or absent (phones).
      (isMobile || projectInMenu) && (onOpenProject || renderMoveProjectDialog) ? [
        projectName && onOpenProject && (
          <MenuItem
            key="open-project"
            onClick={() => {
              closeMenu(false);
              onOpenProject();
            }}
          >
            Open {projectName}
          </MenuItem>
        ),
        renderMoveProjectDialog && (
          <MenuItem
            key="move-project"
            onClick={() => {
              closeMenu(false);
              setMoveProjectOpen(true);
            }}
          >
            {projectName ? `Move to Another ${projectLabel}…` : `Move to a ${projectLabel}…`}
          </MenuItem>
        ),
      ] : [],
      [
        <MenuItem
          key="rename"
          disabled={renameRefusal !== null}
          description={renameRefusal ?? undefined}
          descriptionId="session-rename-caution"
          onClick={() => {
            if (renameRefusal !== null) return;
            closeMenu(false);
            setRenameDialogOpen(true);
          }}
        >
          Rename…
        </MenuItem>,
        // Snoozing hides a session from the Sessions list, which an archived session has already left.
        onSnooze && !session.archived && (
          <MenuItem
            key="reminder"
            disabled={busy}
            description={busy ? BUSY_REASON : undefined}
            onClick={() => {
              closeMenu(false);
              onSnooze();
            }}
          >
            {reminderMenuActionLabel(reminder)}
          </MenuItem>
        ),
        reminder?.state === "fired" && onDismissReminder && (
          <MenuItem
            key="dismiss-reminder"
            disabled={busy}
            description={busy ? BUSY_REASON : undefined}
            onClick={() => {
              closeMenu(true);
              onDismissReminder();
            }}
          >
            Dismiss Reminder
          </MenuItem>
        ),
        // Shown wherever this session can fork at all; a temporary block keeps it, disabled, with
        // its reason (#1864).
        forkOffered && onFork && (
          <MenuItem
            key="fork"
            disabled={forkReason !== null}
            description={forkReason ?? undefined}
            trail={forkShortcutRef && !coarsePointer ? <kbd>{shortcutDisplay("session-reading-fork")}</kbd> : undefined}
            onClick={() => {
              if (forkReason !== null) return;
              closeMenuToTrigger();
              onFork();
            }}
          >
            Fork Conversation…
          </MenuItem>
        ),
        accountSwitchApplicable && (
          <MenuItem
            key="switch-account"
            disabled={switchAccountReason !== null}
            description={switchAccountReason ?? undefined}
            onClick={() => {
              if (switchAccountReason !== null) return;
              closeMenu(false);
              setSwitchAccountDialogOpen(true);
            }}
          >
            Switch Account…
          </MenuItem>
        ),
      ],
      [
        session.adopted && (
          <MenuItem
            key="reprocess"
            icon={<RefreshIcon size={16} />}
            disabled={reprocessReason !== null}
            description={reprocessReason ?? undefined}
            onClick={() => {
              if (reprocessReason === null) reprocess();
            }}
          >
            Reprocess Transcript
          </MenuItem>
        ),
        signOutOffered && (
          <MenuItem
            key="sign-out"
            disabled={signOutReason !== null}
            description={signOutReason ?? undefined}
            onClick={() => {
              if (signOutReason !== null) return;
              closeMenu(false);
              void (async () => {
                if (!await confirm({
                  title: "Sign Out",
                  message: signOutOfAgentMessage(sessionAgentLabel(session.agentName, session.driver, session.agentId), machineName),
                  confirmLabel: "Sign Out",
                  tone: "danger",
                  returnFocus: menu.triggerRef,
                })) return;
                void run(async () => {
                  await api.logoutAgent(session.id);
                  showToast("Signed out.", { tone: "success" });
                });
              })();
            }}
          >
            Sign Out of Agent…
          </MenuItem>
        ),
      ],
      [
        <MenuItem
          key="archive"
          disabled={archiveReason !== null}
          description={archiveReason ?? undefined}
          descriptionId="session-archive-caution"
          onClick={() => {
            if (archiveReason !== null) return;
            if (!session.archived && onArchive) {
              closeMenuToTrigger();
              onArchive();
              return;
            }
            closeMenu(true);
            if (sessionUnarchiveRestarts(session, unarchiveAndRestartSupported)) {
              void run(() => unarchiveSession({
                sessionId: session.id,
                restarts: true,
                api,
                showToast,
                showUndo,
                reloadSession: onReloadSession,
              }));
              return;
            }
            void run(async () => {
              const nextArchived = !session.archived;
              if (nextArchived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)) {
                const retrying = session.archiveStatus === "stop_failed";
                // Repeating a stop the person already asked for is the safe path, so Retry Stop is
                // not destructive and opens on its primary (§7.4). Snooze is the harmless
                // alternative to archiving, offered beside it on desktop.
                const accepted = await confirm({
                  title: retrying ? "Retry Stop" : "Archive and Stop Session",
                  message: archiveAndStopMessage(session.title, retrying),
                  confirmLabel: retrying ? "Retry Stop" : "Archive and Stop",
                  tone: retrying ? "default" : "danger",
                  ...(!retrying && onSnooze ? { secondaryAction: { label: "Snooze Instead…", run: onSnooze } } : {}),
                });
                if (!accepted) return;
              }
              const updated = nextArchived && session.archiveStatus === "stop_failed"
                ? await api.retryStop(session.id)
                : await api.setArchived(session.id, nextArchived);
              const message = nextArchived ? archiveResultMessage(updated.archiveStatus) : "Session restored.";
              showUndo(message, async () => {
                await api.setArchived(session.id, !nextArchived);
              }, nextArchived ? archiveResultTone(updated.archiveStatus) : "success");
            });
          }}
        >
          {archiveLabel}
        </MenuItem>,
        showRestart && (
          <MenuItem
            key="restart"
            disabled={restartReason !== null}
            description={restartReason ?? undefined}
            onClick={() => {
              if (restartReason !== null) return;
              closeMenu(true);
              void run(() => api.restart(session.id));
            }}
          >
            Restart Session
          </MenuItem>
        ),
      ],
      // Process-lifecycle destruction stays last and in --danger-text (§3.3). Stop Session keeps its
      // confirmation, so one extra menu click loses no safety; the frequent Stop Turn lives on the
      // composer's send button. Delete remains archived-only, one deliberate step beyond the inbox.
      [
        showRetryStop && (
          <MenuItem
            key="retry-stop"
            danger
            disabled={stopReason !== null}
            description={stopReason ?? undefined}
            onClick={() => {
              if (stopReason !== null) return;
              closeMenu(true);
              void run(() => api.retryStop(session.id));
            }}
          >
            Retry Stop
          </MenuItem>
        ),
        !terminal && (
          <MenuItem
            key="stop"
            danger
            disabled={stopReason !== null}
            description={stopReason ?? undefined}
            onClick={() => {
              if (stopReason !== null) return;
              closeMenu(false);
              void (async () => {
                if (!await confirm({
                  title: "Stop Session",
                  message: stopSessionMessage(session.title, pendingQueuedPromptCount(session.queued)),
                  confirmLabel: "Stop Session",
                  tone: "danger",
                  returnFocus: menu.triggerRef,
                })) return;
                await run(() => api.stop(session.id));
              })();
            }}
          >
            Stop Session…
          </MenuItem>
        ),
        session.archived && (
          <MenuItem
            key="delete"
            danger
            disabled={busy}
            description={busy ? BUSY_REASON : undefined}
            onClick={() => {
              closeMenu(false);
              void (async () => {
                if (!await confirm({
                  title: "Delete Session",
                  message: deleteSessionMessage(session.title),
                  confirmLabel: "Delete Session",
                  tone: "danger",
                  returnFocus: menu.triggerRef,
                })) return;
                void run(async () => {
                  await api.deleteSession(session.id);
                  removeFromInstanceKeySet(SESSION_PIN_KEY, instanceScope, session.id); // a deleted session must not resurrect as pinned
                  void discardComposerDraft(session.id, instanceScope);
                  onBack(); // don't strand the user on a deleted session
                });
              })();
            }}
          >
            Delete Session…
          </MenuItem>
        ),
      ],
    ] satisfies Array<Array<React.ReactElement | false | null | undefined | "">>
  ).map((group) => group.filter((item): item is React.ReactElement => Boolean(item)))
    .filter((group) => group.length > 0);

  // Focus restoration after dialogs is owned by Modal's returnFocusRef (the durable header
  // trigger); the menu item that launched them unmounts with the menu and cannot take focus back.
  const closeShareDialog = () => {
    setShareDialogOpen(false);
  };

  return (
    // On a phone this is the second line under the app bar, which already takes the safe area, so
    // it does not take `.detail-bar`'s phone geometry.
    <header className={isMobile ? "session-bar" : "detail-bar session-bar"} {...windowDragRegion()}>
      {!isMobile && (
        <>
          <button type="button" className="icon-btn detail-bar-back" onClick={onBack} title={backLabel("inbox")} aria-label={backLabel("inbox")}>
            <ChevronLeftIcon />
          </button>
          {projectControl && (
            <div ref={projectSlotRef} className="session-bar-project">
              {projectControl}
              <span className="session-bar-sep" aria-hidden="true">/</span>
            </div>
          )}
          <h1
            ref={titleRef}
            className="detail-bar-title session-bar-title"
            id={titleId}
            tabIndex={titleId ? -1 : undefined}
            title={displayTitle}
          >
            {displayTitle}
          </h1>
        </>
      )}
      <SessionStatusButton
        summary={statusSummary}
        open={statusPopoverOpen}
        popover={statusPopover}
        onToggle={() => {
          if (!statusPopoverOpen) {
            closeShareMenu(false);
            closeMenu(false);
          }
          statusPopover.toggle();
        }}
        onTriggerKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            closeShareMenu(false);
            closeMenu(false);
          }
          statusPopover.onTriggerKeyDown(event);
        }}
        titleRef={isMobile ? undefined : titleRef}
        small={isMobile}
        actions={{
          onOpenAttention,
          onOpenCampaignRequests: onOpenCampaignRequests ?? onOpenAttention,
          onOpenDescendantRequests: descendantRequests?.onOpen,
          onOpenBackgroundWork,
          onOpenWorkers: activeSubagents?.onOpen,
          deliveryStep,
        }}
      />
      {/* Background work changes are announced politely wherever the badge shows (#784). The region
          stays mounted, so its first state is announced too, and it is text, not a second badge. */}
      <span className="sr-only" data-live="background-work" role="status" aria-live="polite">
        {visibleBackgroundWorkState ? backgroundWorkAccessibleName(visibleBackgroundWorkState) : ""}
      </span>
      <div className="detail-actions">
        <div className="overflow-menu">
          <button
            ref={shareMenu.triggerRef}
            className={`icon-btn${actionSize} session-header-action`}
            onClick={() => {
              if (!shareMenuOpen) {
                closeMenu(false);
                closeStatusPopover(false);
              }
              shareMenu.toggle();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                closeMenu(false);
                closeStatusPopover(false);
              }
              shareMenu.onTriggerKeyDown(event);
            }}
            disabled={busy}
            title="Share"
            aria-label="Share"
            aria-haspopup="menu"
            aria-expanded={shareMenuOpen}
            aria-controls={shareMenu.menuId}
          >
            <ShareIcon size={16} />
          </button>
          {shareMenuOpen && (
            <MenuSurface
              surfaceRef={shareMenu.menuRef}
              anchor={{ trigger: shareMenu.triggerRef }}
              id={shareMenu.menuId}
              label="Share"
              align="end"
              onDismiss={() => closeShareMenu(true)}
              onKeyDown={shareMenu.onMenuKeyDown}
            >
              <MenuItem
                icon={<ShareIcon size={16} />}
                disabled={transcriptReason !== null}
                description={transcriptReason ?? "Create a read-only link anyone can open."}
                onClick={() => {
                  if (transcriptReason !== null) return;
                  closeShareMenu(false);
                  setShareDialogOpen(true);
                }}
              >
                Share Transcript…
              </MenuItem>
              <MenuItem
                icon={<LinkIcon size={16} />}
                disabled={sessionLinkReason !== null}
                description={sessionLinkReason ?? "Opens this page for people who already use this Wollipog."}
                onClick={() => {
                  if (sessionLinkReason === null && internalSessionUrl) void copySessionLink(internalSessionUrl);
                }}
              >
                Copy Session Link
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<DownloadIcon size={16} />}
                disabled={transcriptReason !== null}
                description={transcriptReason ?? "Save a readable copy of the conversation."}
                onClick={() => {
                  if (transcriptReason === null) downloadTranscript("markdown");
                }}
              >
                Export as Markdown
              </MenuItem>
              <MenuItem
                icon={<DownloadIcon size={16} />}
                disabled={transcriptReason !== null}
                description={transcriptReason ?? "Save every event for other tools to read."}
                onClick={() => {
                  if (transcriptReason === null) downloadTranscript("json");
                }}
              >
                Export as JSON
              </MenuItem>
              <MenuNote>Shared and exported transcripts are redacted, but can still include secrets or source code.</MenuNote>
            </MenuSurface>
          )}
        </div>
        <div className="overflow-menu">
            <button
              ref={menu.triggerRef}
              className={`icon-btn${actionSize} session-header-action`}
              onClick={() => {
                if (!menuOpen) {
                  closeShareMenu(false);
                  closeStatusPopover(false);
                  setProjectInMenu(projectFolded());
                }
                menu.toggle();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  closeShareMenu(false);
                  closeStatusPopover(false);
                }
                if (!menuOpen) setProjectInMenu(projectFolded());
                menu.onTriggerKeyDown(event);
              }}
              disabled={busy}
              title="More Actions"
              aria-label="More Actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menu.menuId}
            >
              <MoreVerticalIcon size={16} />
            </button>
            {menuOpen && (
              <MenuSurface
                surfaceRef={menu.menuRef}
                anchor={{ trigger: menu.triggerRef }}
                id={menu.menuId}
                label="More Actions"
                // The phone sheet is titled with the session it acts on.
                head={isMobile ? <div className="menu-head" aria-hidden="true">{displayTitle}</div> : undefined}
                align="end"
                onDismiss={() => closeMenu(true)}
                onKeyDown={menu.onMenuKeyDown}
              >
                {moreActionGroups.map((group, index) => (
                  <React.Fragment key={index}>
                    {index > 0 && <MenuSeparator />}
                    {group}
                  </React.Fragment>
                ))}
              </MenuSurface>
            )}
          </div>
        {topbarControls && (
          <>
            <span className="detail-actions-divider" aria-hidden="true" />
            <div className="topbar-actions">{topbarControls}</div>
          </>
        )}
        {shareDialogOpen && <TranscriptShareDialog sessionId={session.id} onClose={closeShareDialog} returnFocusRef={shareMenu.triggerRef} />}
        {renameDialogOpen && (
          <RenameSessionDialog
            session={session}
            onClose={() => setRenameDialogOpen(false)}
            onRenamed={() => showToast("Session renamed.", { tone: "success" })}
            returnFocusRef={menu.triggerRef}
          />
        )}
        {switchAccountDialogOpen && (
          <SwitchAccountDialog
            session={session}
            machineName={machineName}
            machineAccounts={machineAccounts}
            onOpenConnections={onOpenConnections}
            onClose={() => setSwitchAccountDialogOpen(false)}
            onSwitched={(scheduled) => {
              showToast(scheduled ? "The account switches after the current turn." : "Account switched.", {
                tone: "success",
              });
            }}
            returnFocusRef={menu.triggerRef}
          />
        )}
        {moveProjectOpen && renderMoveProjectDialog?.({
          onClose: () => setMoveProjectOpen(false),
          returnFocusRef: menu.triggerRef,
        })}
      </div>
    </header>
  );
}
