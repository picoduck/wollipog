import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { StatusBadge, StatusCount } from "./StatusBadge.js";
import {
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type SessionReminderView,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { RenameSessionDialog } from "./RenameSessionDialog.js";
import { sessionAccountSwitchApplicable, SwitchAccountDialog } from "./SwitchAccountDialog.js";
import {
  archiveAndStopMessage,
  sessionArchiveActionLabel,
  sessionArchiveRequiresStop,
  sessionUnarchiveRestarts,
  unarchiveAndRestartFailureMessage,
} from "../archive-actions.js";
import { removeFromInstanceKeySet, SESSION_PIN_KEY } from "../pins.js";
import { discardComposerDraft } from "../composer-drafts.js";
import { useInstanceScope } from "../instance-scope.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { absoluteViewUrl, backLabel } from "../navigation.js";
import { reminderMenuActionLabel } from "../session-reminders.js";
import { requestTranscriptDownload } from "../transcript-download.js";
import { DEVELOPMENT_BUILD } from "../config.js";
import { pendingQueuedPromptCount, type ConversationForkAvailability } from "../session-actions.js";
import {
  ActiveSubagentsBadge,
  BackgroundDeliveryBadge,
  BackgroundWorkBadge,
  SessionStatusIndicators,
} from "./common.js";
import {
  useAccessibleMenu,
  useDismissiblePopover,
} from "./interactions.js";
import { MenuItem, MenuNote, MenuSeparator, MenuSurface } from "./Menu.js";
import { useFeedback } from "./FeedbackProvider.js";
import { TranscriptShareDialog } from "./TranscriptShareDialog.js";
import { ChevronLeftIcon, DownloadIcon, LinkIcon, MoreVerticalIcon, RefreshIcon, ShareIcon } from "./Icons.js";
import { useIsMobile } from "./useIsMobile.js";
import { windowDragRegion } from "../desktop-window.js";
import { sessionDisplayTitle } from "../session-title.js";
import { DETAIL_TITLE_READABLE_PX } from "./PageHeader.js";
import { sessionArchiveActionRefusal, sessionCommandRefusal } from "../session-command-permissions.js";

/** The badges the measured status row may hide into "+N": the lifecycle and change groups, and the
 * background-work and active-worker badges that sit directly in the row. */
export const MEASURED_STATUS_SELECTOR =
  ".session-status-indicators > .status, " +
  ".change-status-indicators > .status, " +
  ":scope > .status[data-group='background-work'], " +
  ":scope > .active-subagents-badge";

/**
 * The order badges are offered a place in the measured status row when it cannot hold them all
 * (#784).
 *
 * Background work is claimed first. It is authoritative and it has no other home on a phone — a
 * session waiting on an external job is invisible everywhere else on that screen — so the lifecycle
 * group and then the passive change statuses yield to it, rather than it taking a line of its own.
 * Within a tier the leftmost badge is claimed first, so what survives still reads left to right.
 *
 * Offering rather than reserving is the point: narrow phones shorten the badge's visible copy,
 * while this fitter still keeps any status that fits and moves the rest into `+N`. Clipping is
 * never an option, and the badge's accessible name remains complete in both locations.
 */
export function statusKeepOrder(items: HTMLElement[]): HTMLElement[] {
  // Workers are foreground work, so the active-subagents badge ranks with the lifecycle group they
  // run inside, not with background work.
  const tier = (item: HTMLElement) =>
    item.dataset["group"] === "background-work"
      ? 0
      : item.parentElement?.classList.contains("change-status-indicators") ? 2 : 1;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => tier(left.item) - tier(right.item) || left.index - right.index)
    .map(({ item }) => item);
}

/** The second line of an item that waits on another session action already running. */
const BUSY_REASON = "Available when the current action finishes.";
const NO_SESSION_LINK_REASON = "Open Wollipog in a browser to copy a link.";
/** A contributor hint, shown by development builds only (§17.2 keeps env var names out of releases). */
const DEVELOPMENT_LINK_HINT = "Development builds can set VITE_DASHBOARD_ORIGIN.";

/** Copies `text`, falling back to a selected hidden field where the Clipboard API is unavailable
 * (a plain-HTTP dashboard). The fallback moves focus, which the caller restores. A refused write
 * settles late; when `current()` says the person has moved on by then, the fallback is skipped so
 * it cannot take focus from what they opened since, and the result is `null`. */
async function writeClipboardText(text: string, current: () => boolean): Promise<boolean | null> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!current()) return null;
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.readOnly = true;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      fallback.remove();
    }
  }
}

/**
 * The responsive Session bar (docs/design-system.md §4.3). Desktop keeps one 48px row: Back, the
 * project menu button, the title, the statuses, then Share / More Actions and the shell controls.
 * Mobile identity moves into the app topbar, leaving this component as the single status/action
 * line above the transcript.
 */
export function SessionHeader({
  session,
  onBack,
  runnerOnline,
  machineName,
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
  const { confirm, showToast, showUndo } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [hiddenStatusCount, setHiddenStatusCount] = useState(0);
  // Set when a focused badge is measured out of the row before its `+N` trigger exists to take the
  // focus; the effect below hands it over once that trigger has rendered.
  const focusDisclosureRef = useRef(false);
  const [moveProjectOpen, setMoveProjectOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [switchAccountDialogOpen, setSwitchAccountDialogOpen] = useState(false);
  const statusesRef = useRef<HTMLDivElement>(null);
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
  const statusLayoutKey = JSON.stringify([
    session.status,
    session.pendingApproval,
    session.orchestratorCampaign?.pendingRequests,
    session.archiveStatus,
    session.archiveOperation,
    session.stopOperation,
    session.backgroundWorkState,
    session.backgroundWorkTracking,
    session.backgroundDeliveries?.find((delivery) => delivery.watchdogState)?.watchdogState,
    runnerOnline,
    activeSubagents?.count,
    descendantRequests?.count,
  ]);
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
  const backgroundDeliveryState = session.backgroundDeliveries
    ?.find((delivery) => delivery.watchdogState)?.watchdogState;
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
  const archiveReason = busy ? BUSY_REASON : archiveRefusal;
  const restartReason = busy ? BUSY_REASON : restartRefusal;
  const stopReason = busy ? BUSY_REASON : stopRefusal;
  // Archiving that also stops the session asks first, so only that label takes the ellipsis.
  const archiveAction = sessionArchiveActionLabel(session, stopBeforeArchiveSupported, unarchiveAndRestartSupported);
  const archiveLabel = !session.archived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)
    ? `${archiveAction}…`
    : archiveAction;
  const signOutOffered = session.driver === "acp" && !terminal && runnerOnline && logoutSupported && providerLogoutSupported;
  const renderBackgroundWork = () => visibleBackgroundWorkState && (
    <BackgroundWorkBadge state={visibleBackgroundWorkState} compact responsiveCompact announce={false}
      onOpen={onOpenBackgroundWork ? () => {
        // A direct badge stays mounted; only restore focus when dismissing its popover copy.
        closeStatusPopover(statusPopoverOpen);
        onOpenBackgroundWork();
      } : undefined} />
  );
  const renderNoninteractiveStatuses = () => (
    <>
      <SessionStatusIndicators
        session={session}
        disconnected={!runnerOnline}
        onOpenAttention={onOpenAttention ? () => {
          closeStatusPopover(false);
          onOpenAttention();
        } : undefined}
        onOpenCampaignRequests={onOpenCampaignRequests ? () => {
          closeStatusPopover(false);
          onOpenCampaignRequests();
        } : undefined}
      />
      {descendantRequests && descendantRequests.count > 0 && !session.orchestratorCampaign?.pendingRequests && (
        <StatusBadge
          tone="warning"
          label="Descendant Requests"
          ariaLabel={`Descendant Requests: ${descendantRequests.count} Unresolved`}
          ariaControls="right-panel"
          title="Open Descendant Requests"
          onClick={() => {
            closeStatusPopover(false);
            descendantRequests.onOpen();
          }}
        >
          <StatusCount>{descendantRequests.count}</StatusCount>
        </StatusBadge>
      )}
      {renderBackgroundWork()}
      {backgroundDeliveryState && (
        <BackgroundDeliveryBadge state={backgroundDeliveryState} onOpen={onOpenBackgroundWork ? () => {
          closeStatusPopover(statusPopoverOpen);
          onOpenBackgroundWork();
        } : undefined} />
      )}
    </>
  );
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

  useLayoutEffect(() => {
    const container = statusesRef.current;
    if (!container) return;

    const statusItems = () => Array.from(container.querySelectorAll<HTMLElement>(MEASURED_STATUS_SELECTOR));
    const measure = () => {
      const items = statusItems();
      // Measuring applies candidate sets, so every badge is briefly `display: none` — including the
      // one the row keeps — and a `display: none` element cannot hold focus. Chromium runs its focus
      // fixup at the next rendering update, by which time the winner is visible again, but that is
      // an implementation detail to lean on rather than a guarantee. Remember what was focused and
      // put focus back where it belongs once the row has settled.
      const focusedBadge = items.find((item) => item === document.activeElement) ?? null;
      // Each measurement decides the handover afresh, so a pending one from a previous measurement
      // can never outlive the layout that asked for it.
      focusDisclosureRef.current = false;
      for (const item of items) item.hidden = false;
      if (!isMobile || items.length === 0) {
        setHiddenStatusCount(0);
        return;
      }

      const containerBox = container.getBoundingClientRect();
      const shareTrigger = shareMenu.triggerRef.current;
      const overflowTrigger = statusPopover.triggerRef.current;
      if (!shareTrigger) return;
      const actions = shareTrigger.closest<HTMLElement>(".detail-actions");
      const actionsStyle = actions ? getComputedStyle(actions) : null;
      const gap = Number.parseFloat(actionsStyle?.columnGap || actionsStyle?.gap || "0") || 0;
      const overflowWidth = overflowTrigger?.getBoundingClientRect().width ??
        shareTrigger.getBoundingClientRect().width;
      const occupiedOverflowWidth = overflowTrigger ? overflowWidth + gap : 0;
      const availableWithoutTrigger = containerBox.width + occupiedOverflowWidth;
      const availableWithTrigger = Math.max(0, availableWithoutTrigger - overflowWidth - gap);
      // The row's right edge, measured from the container's own left. An item past the container's
      // clip still has real geometry, and the container's left never moves: only its width changes
      // with the disclosure trigger, which the two budgets above already account for.
      const usedWidth = () => {
        let right = 0;
        for (const item of items) {
          if (item.hidden) continue;
          right = Math.max(right, item.getBoundingClientRect().right - containerBox.left);
        }
        return right;
      };

      if (usedWidth() <= availableWithoutTrigger + 0.5) {
        setHiddenStatusCount(0);
        restoreRowFocus(focusedBadge);
        return;
      }

      // Claim the row in priority order and keep a badge only if the row still fits with it in.
      // Re-measured every time rather than cut as a suffix of one initial layout: a badge's
      // position depends on which badges BEFORE it are in the row, so what fits is only knowable
      // with the candidate set actually applied.
      for (const item of items) item.hidden = true;
      let hiddenCount = items.length;
      for (const item of statusKeepOrder(items)) {
        item.hidden = false;
        if (usedWidth() > availableWithTrigger + 0.5) item.hidden = true;
        else hiddenCount -= 1;
      }
      setHiddenStatusCount(hiddenCount);
      restoreRowFocus(focusedBadge);
    };

    /**
     * Keyboard focus follows the badge: back onto it when the row keeps it, and onto the disclosure
     * that now holds it when the row does not. Without this, a resize or a live status change drops
     * the user at <body>, where the next Tab restarts from the top of the document.
     */
    function restoreRowFocus(focusedBadge: HTMLElement | null) {
      if (!focusedBadge || document.activeElement === focusedBadge) return;
      if (!focusedBadge.hidden) {
        focusedBadge.focus();
        return;
      }
      const trigger = statusPopover.triggerRef.current;
      if (trigger) trigger.focus();
      else focusDisclosureRef.current = true;
    }

    measure();
    if (typeof ResizeObserver === "undefined") return;
    let cancelled = false;
    let measurementFrame: number | null = null;
    const scheduleMeasure = () => {
      if (cancelled || measurementFrame !== null) return;
      measurementFrame = window.requestAnimationFrame(() => {
        measurementFrame = null;
        if (!cancelled) measure();
      });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    const header = container.closest<HTMLElement>(".session-bar");
    if (header) observer.observe(header);
    void document.fonts?.ready.then(scheduleMeasure);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (measurementFrame !== null) window.cancelAnimationFrame(measurementFrame);
    };
  }, [isMobile, statusLayoutKey, shareMenu.triggerRef, statusPopover.triggerRef]);

  // In the compact tier the title keeps a readable width before the statuses give way (§15.2), but
  // never more than its own text: a short title must not reserve empty space. Its natural width is
  // its scroll width, which does not depend on how far the bar has squeezed it — once the previous
  // floor is lifted, since a floor wider than a new, shorter title would widen its box and be read
  // back as its width.
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const measure = () => {
      title.style.removeProperty("--session-title-readable");
      title.style.setProperty("--session-title-readable", `${Math.min(DETAIL_TITLE_READABLE_PX, title.scrollWidth)}px`);
    };
    measure();
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [displayTitle, isMobile]);

  useEffect(() => {
    if (!focusDisclosureRef.current) return;
    // The measurement that set the flag ran in a layout effect, so the commit that renders the
    // trigger has not happened yet and this effect first sees the old state. Hold the flag rather
    // than spending it on a null ref; the next measurement clears it if the row changes its mind.
    const trigger = statusPopover.triggerRef.current;
    if (!trigger) return;
    focusDisclosureRef.current = false;
    // Only claim focus nobody else has taken. This effect runs a commit after the measurement, and
    // in that window the user may have focused something else — a menu, a dialog, the composer —
    // which a bare focus() would yank them out of. Same rule as the async action path below:
    // reclaim a dropped focus, never move a live one.
    if (document.activeElement === document.body || document.activeElement === null) {
      trigger.focus();
    }
  });

  useEffect(() => {
    if (hiddenStatusCount === 0 && statusPopoverOpen) {
      closeStatusPopover(false);
      shareMenu.triggerRef.current?.focus();
    }
  }, [hiddenStatusCount, statusPopoverOpen]);

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
                if (!await confirm({ title: "Sign Out", message: "New sessions with this agent will need to sign in again. Its credentials stay on the runner host.", confirmLabel: "Sign Out", tone: "danger", returnFocus: menu.triggerRef })) return;
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
              // No Undo: re-archiving a relaunched session without a Stop would hide live work.
              void run(async () => {
                try {
                  await api.unarchiveAndRestart(session.id);
                  showToast("Session restored and restarting.");
                } catch (cause) {
                  const failure = unarchiveAndRestartFailureMessage(cause);
                  showToast(failure.message, { tone: "error" });
                  // The server may have restored and relaunched this session before the
                  // response was lost; the header would otherwise keep showing it archived.
                  // The reload can fail for the very reason the outcome was unconfirmed —
                  // the toast already says so, and an escaping rejection would be unhandled.
                  if (failure.ambiguous) {
                    try {
                      await onReloadSession?.();
                    } catch {
                      /* the session state stays as it was; the toast already reports the uncertainty */
                    }
                  }
                }
              });
              return;
            }
            void run(async () => {
              const nextArchived = !session.archived;
              if (nextArchived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)) {
                const retrying = session.archiveStatus === "stop_failed";
                const accepted = await confirm({
                  title: retrying ? "Retry Stop" : "Archive and Stop Session",
                  message: archiveAndStopMessage(session.title, retrying),
                  confirmLabel: retrying ? "Retry Stop" : "Archive and Stop",
                  tone: "danger",
                });
                if (!accepted) return;
              }
              const updated = nextArchived && session.archiveStatus === "stop_failed"
                ? await api.retryStop(session.id)
                : await api.setArchived(session.id, nextArchived);
              const message = !nextArchived
                ? "Session restored."
                : updated.archiveStatus === "stop_pending"
                  ? "Archive requested. Stop is pending until runtime capacity is released."
                  : updated.archiveStatus === "stop_failed"
                    ? "Stop failed. Runtime capacity may still be held."
                    : "Session archived.";
              showUndo(message, async () => {
                await api.setArchived(session.id, !nextArchived);
              });
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
                  message: "The agent process ends and every queued message is discarded. To interrupt only the active turn, use Stop Turn in the composer.",
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
                if (!await confirm({ title: "Delete Session", message: "This session and its history are permanently removed. This cannot be undone.", confirmLabel: "Delete Session", tone: "danger", returnFocus: menu.triggerRef })) return;
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
      <div className="session-header-statuses" ref={statusesRef}>
        {renderNoninteractiveStatuses()}
        {activeSubagents && (
          <ActiveSubagentsBadge count={activeSubagents.count} onOpen={activeSubagents.onOpen} workers={activeSubagents.workers} />
        )}
      </div>
      {visibleBackgroundWorkState && (
        <span className="sr-only">
          <BackgroundWorkBadge state={visibleBackgroundWorkState} compact responsiveCompact />
        </span>
      )}
      <div className="detail-actions">
        {hiddenStatusCount > 0 && (
          <div className="overflow-menu">
            <button
              ref={statusPopover.triggerRef}
              className={`icon-btn${actionSize} session-header-action session-status-overflow-trigger`}
              type="button"
              onClick={() => {
                if (!statusPopoverOpen) {
                  closeShareMenu(false);
                  closeMenu(false);
                }
                statusPopover.toggle();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  closeShareMenu(false);
                  closeMenu(false);
                }
                statusPopover.onTriggerKeyDown(event);
              }}
              aria-label={`+${hiddenStatusCount}: Show ${hiddenStatusCount} Hidden ${hiddenStatusCount === 1 ? "Status" : "Statuses"}`}
              title={`Show ${hiddenStatusCount} Hidden ${hiddenStatusCount === 1 ? "Status" : "Statuses"}`}
              aria-haspopup="dialog"
              aria-expanded={statusPopoverOpen}
              aria-controls={statusPopover.panelId}
            >
              +{hiddenStatusCount}
            </button>
            {statusPopoverOpen && (
              <MenuSurface
                surfaceRef={statusPopover.panelRef}
                anchor={{ trigger: statusPopover.triggerRef }}
                id={statusPopover.panelId}
                kind="popover"
                role="dialog"
                label="Session Statuses"
                align="end"
                onDismiss={() => closeStatusPopover(true)}
                onKeyDown={statusPopover.onPanelKeyDown}
              >
                <div
                  className="session-status-popover-content"
                  role="group"
                  tabIndex={0}
                  aria-label="All Session Statuses"
                >
                  {renderNoninteractiveStatuses()}
                  {activeSubagents && (
                    <ActiveSubagentsBadge
                      count={activeSubagents.count}
                      workers={activeSubagents.workers}
                      onOpen={() => {
                        closeStatusPopover(false);
                        activeSubagents.onOpen();
                      }}
                    />
                  )}
                </div>
              </MenuSurface>
            )}
          </div>
        )}
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
