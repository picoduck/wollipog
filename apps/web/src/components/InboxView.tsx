import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type SessionView, type SetSessionReminderRequest, type SourceLocation } from "@wollipog/protocol";
import { sessionArchiveRequiresStop } from "../archive-actions.js";
import {
  INBOX_REORDER_SETTLE_MS,
  approvalOptionForIntent,
  buildInboxSplits,
  inboxProjectName,
  migrateInboxProjectPins,
  newSessionPresetForInboxSplit,
  inboxSelectionAfterMove,
  inboxSelectionAfterArchive,
  inboxSplitByKey,
  nextInboxSplitKey,
  repairInboxSelectionAfterSnapshot,
  extendInboxHeldOrder,
  reconcileInboxItems,
  reconcileInboxOrder,
  repairInboxSelectionForHeldOrder,
  shouldRestoreInboxScroll,
  type InboxApprovalIntent,
} from "../inbox.js";
import { loadKeySet, saveKeySet, SESSION_PIN_KEY } from "../pins.js";
import { loadSeen, markSeen, markUnread, saveSeen } from "../sessions-seen.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useInstanceScope } from "../instance-scope.js";
import { encodeResourceId } from "../navigation.js";
import { useApi } from "../api-context.js";
import { useFeedback } from "./FeedbackProvider.js";
import { InboxList, type InboxListEntry } from "./InboxList.js";
import { InboxShortcutRail } from "./InboxShortcutRail.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { InboxCreateMenu } from "./InboxCreateMenu.js";
import { ProjectSplitMenu } from "./ProjectSplitMenu.js";
import { SessionDetail } from "./SessionDetail.js";
import type { RightPanelState } from "./RightPanel.js";
import { useIsMobile } from "./useIsMobile.js";
import { useInboxKeys, type InboxKeyActions } from "../useInboxKeys.js";
import {
  sessionVisibleForReminderMode,
  sortSessionsForReminders,
  type ReminderInboxMode,
} from "../session-reminders.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { SearchIcon } from "./Icons.js";
import { sessionAgentLabel } from "./agent-options.js";
import { dispatchVirtualViewportIntent } from "../viewport-intent.js";
import type { PreviewNavigationControls } from "./usePreviewNavigationRegistration.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

const PROJECT_PIN_KEY = "wollipog.projects.pinned";
const SEEN_DWELL_MS = 1_500;
const inboxScrollPositions = new Map<string, number>();

export function inboxSessionMatchesQuery(
  session: SessionView,
  normalizedQuery: string,
  projectName: string,
): boolean {
  if (!normalizedQuery) return true;
  return [
    session.title,
    session.preview,
    sessionAgentLabel(session.agentName, session.driver, session.agentId),
    session.agentName,
    projectName,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
}

export function pageInboxPreview(
  scroll: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop" | "scrollTo"> &
    Partial<Pick<HTMLElement, "dispatchEvent">> | null | undefined,
  direction: "next" | "previous",
  beginProgrammaticScroll: ((direction: "next" | "previous") => void) | null | undefined,
): void {
  if (!scroll) return;
  const canMove = direction === "next"
    ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 0.5
    : scroll.scrollTop > 0.5;
  if (!canMove) return;
  dispatchVirtualViewportIntent(scroll);
  beginProgrammaticScroll?.(direction);
  const target = scroll.scrollTop + (direction === "next" ? 1 : -1) * scroll.clientHeight;
  // Following live output can leave a browser-native smooth scroll in flight after its scheduled
  // follow frames are canceled. A discrete keyboard page must replace that animation atomically;
  // starting another smooth scroll can be coalesced with the older one and leave the viewport
  // untouched in Chromium.
  scroll.scrollTo({ top: target, behavior: "auto" });
}

export interface InboxViewProps {
  expandedSessionId?: string | null;
  sourceLocation?: SourceLocation;
  /** App-shell control cluster forwarded into the expanded session's unified bar on desktop. */
  topbarControls?: ReactNode;
  rightPanel: RightPanelState;
  onOpenTerminal: () => void;
  pinnedOpen: boolean;
  focusComposerSessionId?: string | null;
  onComposerFocusConsumed?: () => void;
  onExpand?: (sessionId: string, focusComposer: boolean) => void;
  onCollapse?: () => void;
  onNewSession?: (preset?: NewSessionPreset) => void;
  onShortcutNewSessionPresetChange?: (preset?: NewSessionPreset) => void;
}

export function InboxView({
  expandedSessionId = null,
  sourceLocation,
  topbarControls,
  rightPanel,
  onOpenTerminal,
  pinnedOpen,
  focusComposerSessionId = null,
  onComposerFocusConsumed,
  onExpand,
  onCollapse,
  onNewSession,
  onShortcutNewSessionPresetChange,
}: InboxViewProps) {
  const api = useApi();
  const { confirm, showToast, showUndo } = useFeedback();
  const sessions = useStoreSelector((state) => state.sessions);
  const projects = useStoreSelector((state) => state.projects);
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  const sessionRemindersSupported = useStoreSelector((state) => state.sessionRemindersSupported);
  const reminders = useStoreSelector((state) => state.reminders);
  const accessScopeManagementSupported = useStoreSelector((state) => state.accessScopeManagementSupported);
  const stopBeforeArchiveSupported = useStoreSelector((state) => state.stopBeforeArchiveSupported);
  const stalledIndex = useStoreSelector((state) => state.stalledSessionIds);
  const stalledRevision = useStoreSelector((state) => state.stalledRevision);
  const runners = useStoreSelector((state) => state.runners);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const inbox = useStoreSelector((state) => state.inbox);
  const {
    navigate,
    loadSession,
    setInboxPersistenceEnabled,
    setInboxSelection,
    setInboxSplit,
    setInboxRatio,
  } = useStoreActions();
  const instanceScope = useInstanceScope();
  const isMobile = useIsMobile();
  // Rows must not move while the user is reading or aiming at the list, and neither breakpoint can
  // key that on live input: touch has no pre-contact hover signal, and a desktop pointer rests
  // still for long stretches while its owner scans the Inbox. So the collapsed Inbox holds its
  // displayed order for the whole browsing interval on both. Mobile retains that lease for the
  // whole collapsed interval: browsers can emit transient blur/visibility changes while their
  // chrome or OS surfaces move without ending the user's visual targeting. Treating those as a
  // safe boundary let live activity reorder an open phone Inbox and made the virtualizer preserve
  // the old logical anchor by changing scrollTop. Desktop can reliably use leaving the tab/window
  // (`inboxAway`) as a boundary. Both breakpoints also reconcile when a session expands and after
  // the deliberate structural actions folded into structuralOrderKey below.
  // Focus and visibility are tracked apart, not folded into one flag: a page can be made visible
  // again while its window stays unfocused, and a shared flag would let that visibility event
  // re-arm the lease and turn the eventual focus into a no-op, stranding a stale order.
  const [windowBlurred, setWindowBlurred] = useState(() => !document.hasFocus());
  const [documentHidden, setDocumentHidden] = useState(() => document.visibilityState === "hidden");
  const inboxAway = windowBlurred || documentHidden;
  const browsingOrderLease = expandedSessionId === null && (isMobile || !inboxAway);
  const browsingOrderLeaseRef = useRef(browsingOrderLease);
  browsingOrderLeaseRef.current = browsingOrderLease;
  const [seen, setSeen] = useState(() => loadSeen(instanceScope));
  const [pinnedProjects, setPinnedProjects] = useState(() => loadKeySet(PROJECT_PIN_KEY, instanceScope));
  const [pinnedSessions, setPinnedSessions] = useState(() => loadKeySet(SESSION_PIN_KEY, instanceScope));
  const [query, setQuery] = useState("");
  // The INPUT stays on `query` so typing is never dropped a frame; the filtering reads the deferred
  // value, so a keystroke in a 200-session inbox does not block on re-filtering and re-rendering
  // the list before the character appears.
  const deferredQuery = useDeferredValue(query);
  const [creatingProject, setCreatingProject] = useState(false);
  const [reminderMode, setReminderMode] = useState<ReminderInboxMode>("ordinary");
  const [snoozeSessionId, setSnoozeSessionId] = useState<string | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const [heldOrder, setHeldOrder] = useState<string[] | null>(null);
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(() => new Set());
  const busySessionIdsRef = useRef(new Set<string>());
  const viewRef = useRef<HTMLDivElement>(null);
  const previewNavigationRef = useRef<PreviewNavigationControls | null>(null);
  const registerPreviewNavigation = useCallback((controls: PreviewNavigationControls | null) => {
    previewNavigationRef.current = controls;
  }, []);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragPointerRef = useRef<number | null>(null);
  const dragRatioRef = useRef<number | null>(null);
  const seenTimerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const targetPointerIdsRef = useRef(new Set<number>());
  const activePointerIdsRef = useRef(new Set<number>());
  const structuralOrderKeyRef = useRef<string | null>(null);
  const liveIdsRef = useRef<string[]>([]);
  const displayedIdsRef = useRef<string[]>([]);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousSurfaceRef = useRef<{ expanded: boolean; sessionId: string | null } | null>(null);
  const expandedSessionIdRef = useRef(expandedSessionId);
  expandedSessionIdRef.current = expandedSessionId;
  const mountedRef = useRef(true);
  const selectedSessionIdRef = useRef(inbox.selectedSessionId);
  selectedSessionIdRef.current = inbox.selectedSessionId;

  const clearHeldOrder = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setHeldOrder(null);
  }, []);

  const beginBusy = useCallback((sessionId: string) => {
    if (busySessionIdsRef.current.has(sessionId)) return false;
    busySessionIdsRef.current.add(sessionId);
    setBusySessionIds(new Set(busySessionIdsRef.current));
    return true;
  }, []);
  const endBusy = useCallback((sessionId: string) => {
    busySessionIdsRef.current.delete(sessionId);
    setBusySessionIds(new Set(busySessionIdsRef.current));
  }, []);

  const selectSession = useCallback((sessionId: string | null, splitKey: string | null, repair = false) => {
    setInboxSelection(sessionId, splitKey, !isMobile, repair);
  }, [isMobile, setInboxSelection]);
  const selectSplit = useCallback((splitKey: string | null) => {
    clearHeldOrder();
    setInboxSplit(splitKey, !isMobile);
  }, [clearHeldOrder, isMobile, setInboxSplit]);

  useLayoutEffect(() => {
    setInboxPersistenceEnabled(!isMobile);
  }, [isMobile, setInboxPersistenceEnabled]);

  const captureListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) node.scrollTop = inboxScrollPositions.get(instanceScope) ?? 0;
  }, [instanceScope]);


  // Escape's focus handoff has to wait for the DEFERRED query to catch up, not just the immediate
  // one. Clearing `query` re-renders urgently with the OLD deferredQuery, so the zero state is
  // still mounted a frame later — the handoff focused `.inbox-zero`, and the deferred commit then
  // replaced that node with `.inbox-list`, dropping focus to <body>. Before deferral, clearing the
  // query remounted the list before the frame ran, which is why this is new.
  // STATE, not a ref. A ref mutation schedules nothing: pressing Escape in an ALREADY-empty search
  // box left `setQuery("")` a no-op, no dependency changed, and the effect never ran — so focus
  // stayed in the input, the typing context stayed active, and every Inbox shortcut stayed disabled.
  // The request has to be something React can see change.
  const [exitPending, setExitPending] = useState(false);
  useEffect(() => {
    if (!exitPending || query !== "" || deferredQuery !== "") return;
    setExitPending(false);
    (listRef.current ?? viewRef.current?.querySelector<HTMLElement>(".inbox-zero"))?.focus();
  }, [exitPending, query, deferredQuery]);

  const exitSearch = useCallback(() => {
    setQuery("");
    setExitPending(true);
  }, []);

  // Typing CANCELS a pending handoff. Escape on a nonempty query, then a new search before the
  // deferred value converged, used to leave the request armed: clearing the second search with
  // Backspace fired the stale handoff and stole focus out of the box the user was still typing in.
  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setExitPending(false);
  }, []);

  useEffect(() => {
    window.addEventListener("wollipog:clear-inbox-query", exitSearch);
    return () => window.removeEventListener("wollipog:clear-inbox-query", exitSearch);
  }, [exitSearch]);

  useEffect(() => {
    setSeen(loadSeen(instanceScope));
    setPinnedProjects(loadKeySet(PROJECT_PIN_KEY, instanceScope));
    setPinnedSessions(loadKeySet(SESSION_PIN_KEY, instanceScope));
  }, [instanceScope]);

  useEffect(() => {
    if (!projectsSupported) return;
    const stored = loadKeySet(PROJECT_PIN_KEY, instanceScope);
    const migrated = migrateInboxProjectPins(stored, projects.values());
    if (stored.size === migrated.size && [...stored].every((key) => migrated.has(key))) return;
    saveKeySet(PROJECT_PIN_KEY, migrated, instanceScope);
    setPinnedProjects(migrated);
  }, [instanceScope, projects, projectsSupported]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (seenTimerRef.current !== null) window.clearTimeout(seenTimerRef.current);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);

  // The store mutates its bounded stall index in place for O(1) event updates. Snapshot it only
  // when membership changes; ordinary heartbeat pulses never rebuild Inbox splits or rows.
  const stalledSessionIds = useMemo(() => new Set(stalledIndex), [stalledIndex, stalledRevision]);

  const snoozedCount = useMemo(() => [...reminders.values()].filter((reminder) => {
    const session = sessions.get(reminder.sessionId);
    return reminder.state === "pending" && session !== undefined && !session.archived;
  }).length, [reminders, sessions]);
  const splits = useMemo(() => {
    const baseSplits = buildInboxSplits(
      sessions.values(),
      pinnedProjects,
      pinnedSessions,
      stalledSessionIds,
      projects.values(),
      projectsSupported,
    );
    return baseSplits.map((split) => {
      const visibleSessions = split.sessions.filter((session) => sessionVisibleForReminderMode(
        session, reminders.get(session.id), reminderMode,
      ));
      // Durable Project counts can exceed the locally loaded catalog. Preserve that server-owned
      // total in the ordinary Inbox, subtracting only reminder-hidden rows we can prove locally.
      const hiddenLocalCount = split.sessions.length - visibleSessions.length;
      const count = reminderMode === "snoozed"
        ? visibleSessions.length
        : Math.max(0, split.count - hiddenLocalCount);
      return {
        ...split,
        sessions: sortSessionsForReminders(visibleSessions, reminders, reminderMode),
        count,
      };
    });
  }, [pinnedProjects, pinnedSessions, projects, projectsSupported, reminderMode, reminders, sessions, stalledSessionIds]);
  const activeSplit = inboxSplitByKey(splits, inbox.splitKey);
  const activityCounts = useMemo(() => (activeSplit?.sessions ?? []).reduce(
    (counts, session) => {
      if (session.status === "running") counts.running += 1;
      else if (session.status === "queued") counts.queued += 1;
      else if (session.status === "starting") counts.starting += 1;
      return counts;
    },
    { running: 0, queued: 0, starting: 0 },
  ), [activeSplit?.sessions]);
  const activeNewSessionPreset = useMemo<NewSessionPreset | undefined>(
    () => newSessionPresetForInboxSplit(activeSplit),
    [activeSplit],
  );
  useEffect(() => {
    onShortcutNewSessionPresetChange?.(activeNewSessionPreset);
    return () => onShortcutNewSessionPresetChange?.(undefined);
  }, [activeNewSessionPreset, onShortcutNewSessionPresetChange]);
  const activeSessionIds = useMemo(
    () => (activeSplit?.sessions ?? []).map((session) => session.id),
    [activeSplit?.sessions],
  );
  const repairedSelection = heldOrder
    ? repairInboxSelectionForHeldOrder(
        snapshotLoaded, activeSessionIds, heldOrder, inbox.selectedSessionId, inbox.selectionCleared,
      )
    : repairInboxSelectionAfterSnapshot(snapshotLoaded, activeSplit, inbox.selectedSessionId);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (expandedSessionId && sessions.has(expandedSessionId)) {
      const activeContainsExpanded = activeSplit?.sessions.some((session) => session.id === expandedSessionId) === true;
      const destinationSplit = activeContainsExpanded ? activeSplit?.key ?? null : null;
      if (!activeContainsExpanded && inbox.splitKey !== null) {
        selectSplit(null);
        return;
      }
      if (inbox.selectedSessionId !== expandedSessionId) {
        selectSession(expandedSessionId, destinationSplit);
      }
      return;
    }
    if (activeSplit?.key !== inbox.splitKey) {
      const shouldRestoreTabFocus = document.activeElement === document.body;
      selectSession(repairedSelection, activeSplit?.key ?? null, true);
      if (shouldRestoreTabFocus) {
        window.requestAnimationFrame(() => tabRefs.current.get(activeSplit?.key ?? "all")?.focus());
      }
      return;
    }
    if (repairedSelection !== inbox.selectedSessionId) {
      selectSession(repairedSelection, activeSplit?.key ?? null, true);
    }
  }, [activeSplit, expandedSessionId, inbox.selectedSessionId, inbox.splitKey, repairedSelection, selectSession, selectSplit, sessions, snapshotLoaded]);

  const selectedSession = repairedSelection ? sessions.get(repairedSelection) ?? null : null;

  useEffect(() => {
    if (seenTimerRef.current !== null) window.clearTimeout(seenTimerRef.current);
    seenTimerRef.current = null;
    if (!selectedSession) return;
    const sessionId = selectedSession.id;
    const seenAt = selectedSession.lastEventAt ?? selectedSession.updatedAt;
    seenTimerRef.current = window.setTimeout(() => {
      const next = markSeen(loadSeen(instanceScope), sessionId, seenAt);
      saveSeen(next, instanceScope);
      setSeen(next);
      seenTimerRef.current = null;
    }, SEEN_DWELL_MS);
    return () => {
      if (seenTimerRef.current !== null) window.clearTimeout(seenTimerRef.current);
      seenTimerRef.current = null;
    };
  }, [instanceScope, selectedSession?.id, selectedSession?.lastEventAt, selectedSession?.updatedAt]);

  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
  const liveEntries = useMemo<InboxListEntry[]>(() => (activeSplit?.sessions ?? [])
    .filter((session) => inboxSessionMatchesQuery(
      session,
      normalizedQuery,
      inboxProjectName(session, projectsSupported ? projects : undefined),
    ))
    .map((session) => ({
      session,
      projectName: inboxProjectName(session, projectsSupported ? projects : undefined),
      unread: seen[session.id] != null && session.lastEventAt != null && session.lastEventAt > seen[session.id]!,
      reminder: reminders.get(session.id),
    })), [activeSplit?.sessions, normalizedQuery, projects, projectsSupported, reminders, seen]);
  const liveIds = useMemo(() => liveEntries.map((entry) => entry.session.id), [liveEntries]);
  liveIdsRef.current = liveIds;
  const structuralOrderKey = JSON.stringify([
    instanceScope,
    isMobile,
    reminderMode,
    activeSplit?.key ?? null,
    normalizedQuery,
    [...pinnedSessions].sort(),
    [...pinnedProjects].sort(),
  ]);
  useLayoutEffect(() => {
    if (structuralOrderKeyRef.current === null) {
      structuralOrderKeyRef.current = structuralOrderKey;
      return;
    }
    if (structuralOrderKeyRef.current === structuralOrderKey) return;
    structuralOrderKeyRef.current = structuralOrderKey;
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setHeldOrder(browsingOrderLease
      || targetPointerIdsRef.current.size > 0 || activePointerIdsRef.current.size > 0
      ? liveIdsRef.current
      : null);
  }, [browsingOrderLease, structuralOrderKey]);

  useLayoutEffect(() => {
    setHeldOrder((current) => {
      // Capture the order the browsing interval starts with. Every later live update is projected
      // through it, so incoming activity changes row content without moving rows. Deliberate
      // group, filter, and pin changes still replace the lease through structuralOrderKey above.
      if (!current) return browsingOrderLease ? liveIds : current;
      const extended = extendInboxHeldOrder(current, liveIds, selectedSessionIdRef.current);
      return extended.length === current.length && extended.every((id, index) => id === current[index])
        ? current
        : extended;
    });
  }, [liveIds, browsingOrderLease]);

  const entries = useMemo(() => {
    if (!heldOrder) return liveEntries;
    return reconcileInboxItems(heldOrder, liveEntries, (entry) => entry.session.id);
  }, [heldOrder, liveEntries]);
  const displayedIds = useMemo(() => entries.map((entry) => entry.session.id), [entries]);
  displayedIdsRef.current = displayedIds;
  const orderUpdateAvailable = !isMobile && heldOrder !== null && (
    displayedIds.length !== liveIds.length || displayedIds.some((id, index) => id !== liveIds[index])
  );
  const displayedSelection = repairedSelection && displayedIds.includes(repairedSelection) ? repairedSelection : null;
  const displayedSelectedSession = displayedSelection ? sessions.get(displayedSelection) ?? null : null;
  const expanded = expandedSessionId !== null;
  useEffect(() => {
    if (!expanded) return;
    activePointerIdsRef.current.clear();
    targetPointerIdsRef.current.clear();
    clearHeldOrder();
  }, [clearHeldOrder, expanded]);
  const surfaceSessionId = expandedSessionId ?? selectedSession?.id ?? null;

  useLayoutEffect(() => {
    const previous = previousSurfaceRef.current;
    if (previous?.expanded === expanded && previous.sessionId === surfaceSessionId) return;
    const frame = window.requestAnimationFrame(() => {
      previousSurfaceRef.current = { expanded, sessionId: surfaceSessionId };
      if (expanded) {
        if (focusComposerSessionId !== surfaceSessionId) {
          viewRef.current?.querySelector<HTMLElement>(".detail-scroll")?.focus();
        }
      } else if (shouldRestoreInboxScroll(previous, expanded)) {
        // See shouldRestoreInboxScroll: restoring on every selection change overwrote the scroll
        // that moveSelection() had just performed, one animation frame earlier.
        if (listRef.current) listRef.current.scrollTop = inboxScrollPositions.get(instanceScope) ?? 0;
        listRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, focusComposerSessionId, instanceScope, surfaceSessionId]);

  const scheduleOrderRelease = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      if (browsingOrderLeaseRef.current) {
        settleTimerRef.current = null;
        return;
      }
      if (targetPointerIdsRef.current.size > 0 || activePointerIdsRef.current.size > 0) {
        settleTimerRef.current = null;
        return;
      }
      setHeldOrder(null);
      settleTimerRef.current = null;
    }, INBOX_REORDER_SETTLE_MS);
  }, []);

  useLayoutEffect(() => {
    if (browsingOrderLease) return;
    // Leaving ends pointer ownership outright. A pointer resting over the list keeps its entry
    // until a pointerout that a backgrounded page never delivers, and platforms that hide a page
    // without a window blur would otherwise strand the hold and skip the boundary entirely.
    if (inboxAway) {
      activePointerIdsRef.current.clear();
      targetPointerIdsRef.current.clear();
      clearHeldOrder();
      return;
    }
    if (targetPointerIdsRef.current.size > 0 || activePointerIdsRef.current.size > 0) return;
    clearHeldOrder();
  }, [clearHeldOrder, browsingOrderLease, inboxAway]);


  const holdDisplayedOrder = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setHeldOrder((current) => current ?? displayedIdsRef.current);
  }, []);

  const holdOrderAfterNavigation = useCallback(() => {
    holdDisplayedOrder();
    scheduleOrderRelease();
  }, [holdDisplayedOrder, scheduleOrderRelease]);

  const applyCanonicalOrder = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setHeldOrder([...liveIdsRef.current]);
    window.requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  }, []);

  const handlePointerTargetChange = useCallback((pointerId: number, targeting: boolean) => {
    if (targeting) {
      targetPointerIdsRef.current.add(pointerId);
      holdDisplayedOrder();
      return;
    }
    targetPointerIdsRef.current.delete(pointerId);
    if (targetPointerIdsRef.current.size === 0 && activePointerIdsRef.current.size === 0) scheduleOrderRelease();
  }, [holdDisplayedOrder, scheduleOrderRelease]);

  const handlePointerPressChange = useCallback((pointerId: number, active: boolean, pointerType: string) => {
    if (active) {
      activePointerIdsRef.current.add(pointerId);
      holdDisplayedOrder();
      return;
    }
    if (!activePointerIdsRef.current.delete(pointerId)) return;
    if (pointerType === "touch") targetPointerIdsRef.current.delete(pointerId);
    if (targetPointerIdsRef.current.size === 0 && activePointerIdsRef.current.size === 0) scheduleOrderRelease();
  }, [holdDisplayedOrder, scheduleOrderRelease]);

  // A hidden tab or an unfocused window is not a browsing interval, so it is the desktop Inbox's
  // safe boundary: the hold is dropped there and re-established on return, which is when canonical
  // recency ordering is re-adopted. Nothing snaps out from under a returning click, because a
  // pointer entering the list re-holds the order at `pointerover`, before focus follows the press.
  useEffect(() => {
    const leaveInbox = () => setWindowBlurred(true);
    const enterInbox = () => setWindowBlurred(false);
    const trackVisibility = () => setDocumentHidden(document.visibilityState === "hidden");
    // Seed from the document as well as the events: a window reloaded in the background, or one
    // hidden before this mounted, gets no blur or hidden event to announce the state it is in.
    setWindowBlurred(!document.hasFocus());
    trackVisibility();
    window.addEventListener("blur", leaveInbox);
    window.addEventListener("focus", enterInbox);
    document.addEventListener("visibilitychange", trackVisibility);
    return () => {
      window.removeEventListener("blur", leaveInbox);
      window.removeEventListener("focus", enterInbox);
      document.removeEventListener("visibilitychange", trackVisibility);
    };
  }, []);

  useEffect(() => {
    const finishPointer = (event: PointerEvent) => {
      handlePointerPressChange(event.pointerId, false, event.pointerType);
    };
    const finishAllPointers = () => {
      if (activePointerIdsRef.current.size === 0 && targetPointerIdsRef.current.size === 0) return;
      activePointerIdsRef.current.clear();
      targetPointerIdsRef.current.clear();
      scheduleOrderRelease();
    };
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", finishAllPointers);
    return () => {
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      window.removeEventListener("blur", finishAllPointers);
    };
  }, [handlePointerPressChange, scheduleOrderRelease]);

  useEffect(() => {
    if (liveIds.length > 0) return;
    activePointerIdsRef.current.clear();
    targetPointerIdsRef.current.clear();
    scheduleOrderRelease();
  }, [liveIds.length, scheduleOrderRelease]);

  const moveSelection = useCallback((direction: "next" | "previous") => {
    if (!activeSplit) return;
    holdOrderAfterNavigation();
    const next = inboxSelectionAfterMove(displayedIds, displayedSelection, direction);
    if (!next) return;
    selectSession(next, activeSplit.key);
    listRef.current?.focus();
    window.requestAnimationFrame(() => {
      document.getElementById(`inbox-session-${encodeResourceId(next)}`)?.scrollIntoView({ block: "nearest" });
    });
  }, [activeSplit, displayedIds, displayedSelection, holdOrderAfterNavigation, selectSession]);

  const expand = useCallback((sessionId: string, focusComposer = false) => {
    selectSession(sessionId, activeSplit?.key ?? null);
    if (onExpand) onExpand(sessionId, focusComposer);
    else navigate({ name: "session", id: sessionId });
  }, [activeSplit?.key, navigate, onExpand, selectSession]);

  const handleSelect = useCallback((sessionId: string) => {
    if (isMobile) {
      expand(sessionId);
      return;
    }
    selectSession(sessionId, activeSplit?.key ?? null);
    listRef.current?.focus();
  }, [isMobile, expand, selectSession, activeSplit?.key]);

  const togglePin = useCallback((sessionId: string) => {
    clearHeldOrder();
    const next = loadKeySet(SESSION_PIN_KEY, instanceScope);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    saveKeySet(SESSION_PIN_KEY, next, instanceScope);
    setPinnedSessions(next);
  }, [clearHeldOrder, instanceScope]);

  const setProjectPinned = useCallback((split: NonNullable<typeof activeSplit>, enabled: boolean) => {
    clearHeldOrder();
    // Reload before writing so another tab or surface cannot be overwritten by stale React state.
    const next = loadKeySet(PROJECT_PIN_KEY, instanceScope);
    const keys = [split.key, ...(split.project?.kind === "durable" ? split.project.legacyKeys : [])]
      .filter((key): key is string => key !== null);
    for (const key of keys) next.delete(key);
    if (enabled && split.key !== null) next.add(split.key);
    saveKeySet(PROJECT_PIN_KEY, next, instanceScope);
    setPinnedProjects(next);
  }, [clearHeldOrder, instanceScope]);

  const focusSplit = useCallback((splitKey: string | null) => {
    selectSplit(splitKey);
    window.requestAnimationFrame(() => tabRefs.current.get(splitKey ?? "all")?.focus());
  }, [selectSplit]);

  const onTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, splitKey: string | null) => {
    const keys = splits.map((split) => split.key);
    let next: string | null | undefined;
    if (event.key === "ArrowRight") next = nextInboxSplitKey(keys, splitKey, "next");
    else if (event.key === "ArrowLeft") next = nextInboxSplitKey(keys, splitKey, "previous");
    else if (event.key === "Home") next = keys[0];
    else if (event.key === "End") next = keys.at(-1);
    else return;
    event.preventDefault();
    if (next !== undefined) focusSplit(next);
  }, [focusSplit, splits]);

  const setUnread = useCallback((sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (seenTimerRef.current !== null) window.clearTimeout(seenTimerRef.current);
    seenTimerRef.current = null;
    const next = markUnread(loadSeen(instanceScope), sessionId, session.lastEventAt);
    saveSeen(next, instanceScope);
    setSeen(next);
  }, [instanceScope, sessions]);

  const saveReminder = useCallback(async (sessionId: string, request: SetSessionReminderRequest) => {
    const previous = reminders.get(sessionId);
    const updated = await api.setReminder(sessionId, request);
    showUndo(previous ? "Reminder updated." : "Session snoozed.", async () => {
      if (previous) {
        await api.setReminder(sessionId, {
          scheduledFor: previous.scheduledFor,
          timeZone: previous.timeZone,
          originalExpression: previous.originalExpression,
          wakePolicy: previous.wakePolicy,
          expectedRevision: updated.revision,
          expectedReminderId: updated.reminderId,
          ...(previous.state === "fired" && previous.firedAt !== undefined && previous.wakeReason !== undefined
            ? { restoreFired: { firedAt: previous.firedAt, wakeReason: previous.wakeReason } }
            : {}),
        });
      } else {
        await api.removeReminder(sessionId, updated.revision, updated.reminderId);
      }
    });
  }, [api, reminders, showUndo]);

  const removeReminder = useCallback(async (
    sessionId: string,
    expectedRevision: number,
    expectedReminderId: string,
  ) => {
    const previous = reminders.get(sessionId);
    if (!previous) return;
    await api.removeReminder(sessionId, expectedRevision, expectedReminderId);
    showUndo("Reminder removed.", async () => {
      await api.setReminder(sessionId, {
        scheduledFor: previous.scheduledFor,
        timeZone: previous.timeZone,
        originalExpression: previous.originalExpression,
        wakePolicy: previous.wakePolicy,
        expectedRevision: 0,
        ...(previous.state === "fired" && previous.firedAt !== undefined && previous.wakeReason !== undefined
          ? { restoreFired: { firedAt: previous.firedAt, wakeReason: previous.wakeReason } }
          : {}),
      });
    });
  }, [api, reminders, showUndo]);

  const archive = useCallback(async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (!beginBusy(sessionId)) return;
    const selectionAtRequest = selectedSessionIdRef.current;
    try {
      if (sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)) {
        const retrying = session.archiveStatus === "stop_failed";
        const accepted = await confirm({
          title: retrying ? "Retry stopping this session?" : "Archive and stop this session?",
          message: retrying
            ? "The previous Stop failed and runtime capacity may still be held. Retry the same archive operation?"
            : "The session will move to Archived Sessions after its runtime stops. Queued work will be canceled and runtime capacity will be released. To keep work running outside the Inbox, use Snooze instead.",
          confirmLabel: retrying ? "Retry Stop" : "Archive and Stop",
          tone: "danger",
        });
        if (!accepted) return;
      }
      const updated = session.archiveStatus === "stop_failed"
        ? await api.retryStop(sessionId)
        : await api.setArchived(sessionId, true);
      loadSession(updated);
      if (updated.archiveStatus === "stop_pending") {
        showUndo("Archive requested. Stop is pending until runtime capacity is released.", async () => {
          const restored = await api.setArchived(sessionId, false);
          loadSession(restored);
        });
        return;
      }
      if (updated.archiveStatus === "stop_failed") {
        showToast("Stop failed. Runtime capacity may still be held. Use Retry Stop.");
        return;
      }
      const archiveSelection = inboxSelectionAfterArchive(
        displayedIds,
        sessionId,
        selectionAtRequest,
        selectedSessionIdRef.current,
      );
      if (archiveSelection.apply) {
        selectSession(archiveSelection.sessionId, activeSplit?.key ?? null);
        if (mountedRef.current && expandedSessionIdRef.current === sessionId) {
          if (archiveSelection.sessionId) onExpand?.(archiveSelection.sessionId, false);
          else onCollapse?.();
        }
      }
      showUndo("Session archived.", async () => {
        const restored = await api.setArchived(sessionId, false);
        loadSession(restored);
      });
    } catch (cause) {
      showToast(`Could not archive session: ${(cause as Error).message}`, { tone: "error" });
    } finally {
      endBusy(sessionId);
    }
  }, [activeSplit?.key, api, beginBusy, confirm, displayedIds, endBusy, loadSession, onCollapse, onExpand, selectSession, sessions, showToast, showUndo, stopBeforeArchiveSupported]);

  const decide = useCallback(async (sessionId: string, intent: InboxApprovalIntent) => {
    const targetSession = sessions.get(sessionId);
    if (!targetSession?.pendingApproval) return;
    if (!beginBusy(targetSession.id)) return;
    const approval = targetSession.pendingApproval;
    try {
      if (approval.kind === "question") {
        if (intent === "approve") {
          showToast("Choose answers in the preview before submitting this request.");
          return;
        }
        const updated = await api.answerQuestion(targetSession.id, { requestId: approval.requestId, answers: {}, action: "dismiss" });
        loadSession(updated);
        return;
      }
      const option = approvalOptionForIntent(approval, intent);
      if (!option) {
        showToast(`No safe one-key ${intent === "approve" ? "approval" : "denial"} is available for this request.`);
        return;
      }
      const updated = await api.approve(targetSession.id, { requestId: approval.requestId, optionId: option.optionId });
      loadSession(updated);
    } finally {
      endBusy(targetSession.id);
    }
  }, [api, beginBusy, endBusy, loadSession, sessions, showToast]);

  const hopExpanded = useCallback((direction: "next" | "previous") => {
    if (!expandedSessionId) return;
    holdOrderAfterNavigation();
    const next = inboxSelectionAfterMove(displayedIds, expandedSessionId, direction);
    if (!next || next === expandedSessionId) return;
    selectSession(next, activeSplit?.key ?? null);
    onExpand?.(next, false);
  }, [activeSplit?.key, displayedIds, expandedSessionId, holdOrderAfterNavigation, onExpand, selectSession]);

  const keyActions = useMemo<InboxKeyActions>(() => ({
    next: () => moveSelection("next"),
    previous: () => moveSelection("previous"),
    expand: () => { if (displayedSelection) expand(displayedSelection); },
    nextSplit: () => selectSplit(nextInboxSplitKey(splits.map((split) => split.key), activeSplit?.key ?? null, "next")),
    previousSplit: () => selectSplit(nextInboxSplitKey(splits.map((split) => split.key), activeSplit?.key ?? null, "previous")),
    approve: () => { if (displayedSelection) void decide(displayedSelection, "approve").catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" })); },
    deny: () => { if (displayedSelection) void decide(displayedSelection, "deny").catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" })); },
    archive: () => { if (displayedSelection) void archive(displayedSelection); },
    snooze: () => { if (displayedSelection && sessionRemindersSupported) setSnoozeSessionId(displayedSelection); },
    pin: () => { if (displayedSelection) togglePin(displayedSelection); },
    unread: () => { if (displayedSelection) setUnread(displayedSelection); },
    reply: () => { if (displayedSelection) expand(displayedSelection, true); },
    resumeFollow: () => {
      const controls = previewNavigationRef.current;
      if (!controls) return false;
      controls.follow();
      return true;
    },
    pageDown: () => {
      const scroll = viewRef.current?.querySelector<HTMLElement>(".detail-scroll");
      pageInboxPreview(scroll, "next", previewNavigationRef.current?.beginProgrammaticScroll);
    },
    pageUp: () => {
      const scroll = viewRef.current?.querySelector<HTMLElement>(".detail-scroll");
      pageInboxPreview(scroll, "previous", previewNavigationRef.current?.beginProgrammaticScroll);
    },
  }), [activeSplit?.key, archive, decide, displayedSelection, expand, moveSelection, selectSplit, sessionRemindersSupported, setUnread, showToast, splits, togglePin]);
  useInboxKeys(!isMobile && !expanded, keyActions);

  const ratio = dragRatio ?? inbox.splitRatio;
  const activeProjectId = activeSplit?.project?.kind === "durable" ? activeSplit.project.project.id : undefined;
  const activeDurableProject = activeSplit?.project?.kind === "durable" ? activeSplit.project.project : null;
  const activeAvailableLocations = activeDurableProject?.locations.filter((location) => location.availability === "available") ?? [];
  const updateDragRatio = (clientY: number) => {
    const rect = viewRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const next = Math.min(0.75, Math.max(0.25, (clientY - rect.top) / rect.height));
    dragRatioRef.current = next;
    setDragRatio(next);
  };
  const onSplitterPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobile || event.button !== 0) return;
    dragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateDragRatio(event.clientY);
  };
  const finishSplitterDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPointerRef.current !== event.pointerId) return;
    dragPointerRef.current = null;
    if (dragRatioRef.current !== null) setInboxRatio(dragRatioRef.current);
    dragRatioRef.current = null;
    setDragRatio(null);
  };

  return (
    <div className={`inbox-view${expanded ? " expanded" : ""}`} ref={viewRef} data-focus-zone={expanded ? "detail" : "list"}>
      <section
        className="inbox-list-pane"
        style={{ height: isMobile ? "100%" : `${ratio * 100}%` }}
        aria-label="Command Inbox"
        aria-hidden={expanded || undefined}
        inert={expanded || undefined}
      >
        <div className="inbox-toolbar">
          <div className="inbox-tabs" role="tablist" aria-label="Inbox Groups">
            {splits.map((split) => {
              const active = split.key === activeSplit?.key;
              const hasMenu = split.project !== null;
              const durableProjectId = split.project?.kind === "durable" ? split.project.project.id : undefined;
              const pinned = split.key !== null && (pinnedProjects.has(split.key) ||
                (split.project?.kind === "durable" && split.project.legacyKeys.some((key) => pinnedProjects.has(key))));
              return (
                <div className={`inbox-tab-group${hasMenu ? " has-menu" : ""}`} role="presentation" key={split.key ?? "all"}>
                  <button
                    type="button"
                    ref={(node) => {
                      const refKey = split.key ?? "all";
                      if (node) tabRefs.current.set(refKey, node);
                      else tabRefs.current.delete(refKey);
                    }}
                    role="tab"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    className={`inbox-tab${active ? " active" : ""}`}
                    onClick={() => selectSplit(split.key)}
                    onKeyDown={(event) => onTabKeyDown(event, split.key)}
                    title="Switch Inbox Group (Tab / Shift+Tab)"
                  >
                    {split.name}
                    <span className="inbox-tab-count">{split.count}</span>
                    {split.blockedCount > 0 && (
                      <span className="inbox-tab-count blocked" aria-label={`${split.blockedCount} Blocked`}>
                        {split.blockedCount} ⚠
                      </span>
                    )}
                    {split.stalledCount > 0 && (
                      <span className="inbox-tab-count stalled" aria-label={`${split.stalledCount} Stalled`}>
                        {split.stalledCount} Stalled
                      </span>
                    )}
                  </button>
                  {hasMenu && (
                    <ProjectSplitMenu
                      split={split}
                      active={active}
                      runner={runners.get(
                        split.project?.kind === "durable"
                          ? split.project.primaryLocation?.runnerId ?? ""
                          : split.project?.runnerId ?? "",
                      )}
                      stopBeforeArchiveSupported={stopBeforeArchiveSupported}
                      pinned={pinned}
                      onPinnedChange={(enabled) => setProjectPinned(split, enabled)}
                      onNewSession={(preset) => onNewSession?.(preset)}
                      onManageProject={durableProjectId ? () => navigate({ name: "projects", id: durableProjectId }) : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="inbox-toolbar-actions">
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {orderUpdateAvailable ? "A newer Inbox order is available." : ""}
            </span>
            {orderUpdateAvailable && (
              <button
                type="button"
                className="btn sm inbox-order-update"
                title="Apply the latest session order."
                onClick={applyCanonicalOrder}
              >
                Apply New Order
              </button>
            )}
            {sessionRemindersSupported && (
              <SegmentedControl<ReminderInboxMode>
                className="inbox-reminder-view"
                label="Reminder View"
                value={reminderMode}
                options={[
                  { value: "ordinary", label: "Inbox" },
                  { value: "snoozed", label: `Snoozed (${snoozedCount})` },
                ]}
                onChange={setReminderMode}
              />
            )}
            <InboxCreateMenu
              onNewSession={() => onNewSession?.(activeNewSessionPreset)}
              onNewProject={projectsSupported ? () => setCreatingProject(true) : undefined}
            />
            <label className={`inbox-search${query ? " has-query" : ""}`}>
              <span className="sr-only">Search Sessions</span>
              <SearchIcon size={15} />
              <input
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  exitSearch();
                }}
                placeholder="Search sessions"
              />
              <span className="inbox-search-key" aria-hidden="true">/</span>
            </label>
          </div>
        </div>
        <InboxList
          ref={captureListRef}
          entries={entries}
          selectedSessionId={displayedSelection}
          pinnedSessionIds={pinnedSessions}
          stalledSessionIds={stalledSessionIds}
          runningCount={activityCounts.running}
          queuedCount={activityCounts.queued}
          startingCount={activityCounts.starting}
          filtered={normalizedQuery.length > 0}
          emptyState={reminderMode === "snoozed"
            ? {
              title: "No Snoozed Sessions",
              description: "Snoozed sessions and their pending reminder times appear here.",
              showNewSession: false,
            } : activeSplit?.kind === "project"
            ? activeDurableProject && activeDurableProject.locations.length === 0
              ? {
                title: "No Project Locations",
                description: "Add a Location to this Project before starting a session.",
                showNewSession: false,
                actionLabel: "Add Location",
                onAction: () => navigate({ name: "projects", id: activeProjectId }),
              }
              : activeDurableProject && activeAvailableLocations.length === 0
                ? {
                  title: "No Available Locations",
                  description: "Bring a linked machine online or update this Project’s Locations.",
                  showNewSession: false,
                  actionLabel: "Manage Locations",
                  onAction: () => navigate({ name: "projects", id: activeProjectId }),
                }
                : activeSplit.count > 0
                  ? {
                    title: "Loading Sessions",
                    description: `${activeSplit.count} ${activeSplit.count === 1 ? "session is" : "sessions are"} still syncing.`,
                    showNewSession: false,
                  }
                  : {
                    title: "No Sessions Yet",
                    description: `Start a session in ${activeSplit.name}.`,
                    showNewSession: true,
                  }
            : activeSplit?.kind === "no_project"
              ? {
                title: "No Sessions Without a Project",
                description: "Sessions not assigned to a Project appear here.",
                showNewSession: false,
              }
              : undefined}
          onNewSession={() => onNewSession?.(activeNewSessionPreset)}
          onSelect={handleSelect}
          onExpand={expand}
          onScrollPosition={(scrollTop) => inboxScrollPositions.set(instanceScope, scrollTop)}
          onPointerTargetChange={handlePointerTargetChange}
          onPointerPressChange={handlePointerPressChange}
        />
        <footer className="inbox-activity-footer" aria-label="Inbox Status and Shortcuts">
          <div className="inbox-activity-summary" aria-label="Inbox Activity Summary">
            <span>{activityCounts.running} Running</span>
            <span>{activityCounts.queued} Queued</span>
            <span>{activityCounts.starting} Starting</span>
            <span className="blocked">{activeSplit?.blockedCount ?? 0} Blocked</span>
            <span className="stalled" aria-live="polite">{activeSplit?.stalledCount ?? 0} Stalled</span>
          </div>
          <InboxShortcutRail
            session={displayedSelectedSession}
            pinned={displayedSelection ? pinnedSessions.has(displayedSelection) : false}
            stopBeforeArchiveSupported={stopBeforeArchiveSupported}
            busy={displayedSelection ? busySessionIds.has(displayedSelection) : false}
            onApprove={() => {
              if (displayedSelection) void decide(displayedSelection, "approve")
                .catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" }));
            }}
            onDeny={() => {
              if (displayedSelection) void decide(displayedSelection, "deny")
                .catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" }));
            }}
            onReply={() => { if (displayedSelection) expand(displayedSelection, true); }}
            onExpand={() => { if (displayedSelection) expand(displayedSelection); }}
            onTogglePin={() => { if (displayedSelection) togglePin(displayedSelection); }}
            onMarkUnread={() => { if (displayedSelection) setUnread(displayedSelection); }}
            onArchive={() => { if (displayedSelection) void archive(displayedSelection); }}
            {...(sessionRemindersSupported ? {
              onSnooze: () => { if (displayedSelection) setSnoozeSessionId(displayedSelection); },
            } : {})}
          />
        </footer>
      </section>

      {(!isMobile || expanded) && (
        <>
          <div
            className="inbox-splitter"
            role="separator"
            aria-label="Resize Inbox Preview"
            aria-orientation="horizontal"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(ratio * 100)}
            tabIndex={0}
            onPointerDown={onSplitterPointerDown}
            onPointerMove={(event) => {
              if (dragPointerRef.current === event.pointerId) updateDragRatio(event.clientY);
            }}
            onPointerUp={finishSplitterDrag}
            onLostPointerCapture={finishSplitterDrag}
            onDoubleClick={() => setInboxRatio(0.4)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") setInboxRatio(ratio - 0.05);
              else if (event.key === "ArrowDown") setInboxRatio(ratio + 0.05);
              else if (event.key === "Home") setInboxRatio(0.25);
              else if (event.key === "End") setInboxRatio(0.75);
              else return;
              event.preventDefault();
            }}
          />
          <div className="inbox-preview-pane" style={{ height: expanded ? "100%" : `${(1 - ratio) * 100}%` }} data-focus-zone="detail">
            {surfaceSessionId ? (
              <SessionDetail
                key={surfaceSessionId}
                sessionId={surfaceSessionId}
                mode={expanded ? "expanded" : "preview"}
                sourceLocation={expanded ? sourceLocation : undefined}
                topbarControls={expanded ? topbarControls : undefined}
                rightPanel={rightPanel}
                onOpenTerminal={onOpenTerminal}
                pinnedOpen={pinnedOpen}
                focusComposer={focusComposerSessionId === surfaceSessionId}
                onComposerFocusConsumed={onComposerFocusConsumed}
                onBack={onCollapse}
                onExpand={() => expand(surfaceSessionId)}
                onNextSession={() => hopExpanded("next")}
                onPreviousSession={() => hopExpanded("previous")}
                onApprove={() => { void decide(surfaceSessionId, "approve").catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" })); }}
                onDeny={() => { void decide(surfaceSessionId, "deny").catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" })); }}
                onArchive={() => { void archive(surfaceSessionId); }}
                {...(sessionRemindersSupported ? {
                  onSnooze: () => setSnoozeSessionId(surfaceSessionId),
                } : {})}
                onPreviewNavigationReady={expanded ? undefined : registerPreviewNavigation}
              />
            ) : (
              <div className="inbox-preview-empty" tabIndex={-1}>
                <strong>Select a Session</strong>
                <span>Choose a card to preview live activity.</span>
              </div>
            )}
          </div>
        </>
      )}
      {creatingProject && (
        <CreateProjectDialog
          accessScopeManagementSupported={accessScopeManagementSupported}
          onClose={() => setCreatingProject(false)}
          onCreated={(project) => {
            setCreatingProject(false);
            showToast(`Created ${project.name}.`);
          }}
        />
      )}
      {snoozeSessionId && sessionRemindersSupported && (
        <SnoozeDialog
          key={snoozeSessionId}
          reminder={reminders.get(snoozeSessionId)}
          onClose={() => setSnoozeSessionId(null)}
          onSave={(request) => saveReminder(snoozeSessionId, request)}
          onRemove={(expectedRevision, expectedReminderId) =>
            removeReminder(snoozeSessionId, expectedRevision, expectedReminderId)}
        />
      )}
    </div>
  );
}
