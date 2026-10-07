import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CampaignIcon, ChevronLeftIcon, CloseIcon, CommandLineIcon, DiffIcon, FolderIcon, GlobeIcon, QuestionIcon, InboxIcon, JobsIcon, LockIcon, TeamIcon } from "./Icons.js";
import {
  pendingRequests,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type GitForgeInfo,
  type SessionView,
  type SourceLocation,
  type CreateWorkspaceReferenceRequest,
  type DescendantRequestView,
} from "@wollipog/protocol";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_KEY_STEP,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampRightPanelWidth,
  rightPanelOverlays,
  parseStoredRightPanelMode,
  parseStoredRightPanelWidth,
  resolveRightPanelDrag,
  type RightPanelMode,
} from "../right-panel.js";
import { FilesBrowser } from "./FilesPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { SideChatPanel } from "./SideChatPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import type { DiffFileFocus } from "./GitDiffViewer.js";
import type { GitStatus } from "./useGitStatus.js";
import { shortcutDisplay } from "../shortcuts.js";
import type { TimelineItem } from "../timeline.js";
import type { GovernanceDecision } from "../governance.js";
import { DecisionHistoryPanel } from "./DecisionHistoryPanel.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { focusSessionRequest } from "./SessionApproval.js";
import { dockRequests } from "./requests/RequestDock.js";
import { BackgroundWorkPanel } from "./BackgroundWorkPanel.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";
import { SessionRequestPanel, sessionRequestPanelKey, type DescendantRequestStatus } from "./SessionRequestPanel.js";
import { CampaignStatusPanel } from "./CampaignStatusPanel.js";
import { useIsMobile } from "./useIsMobile.js";
import type { CampaignStatusAvailability } from "../campaign-status.js";

/** Viewport-aware width ceiling: the panel may take at most ~40% of the window, so the
 * transcript + composer always keep a usable share on narrow/split-screen windows. */
function viewportPanelMax(): number {
  return Math.floor(window.innerWidth * 0.4);
}

const EMPTY_PARENT_TURN_EVENTS: ReadonlyMap<string, number> = new Map();
const EMPTY_GOVERNANCE_DECISIONS: readonly GovernanceDecision[] = [];
const HIDDEN_CAMPAIGN: CampaignStatusAvailability = { kind: "hidden" };

export function panelReturnFocusTarget(
  captured: HTMLElement | null,
  sessionId: string,
  root: ParentNode = document,
): HTMLElement | null {
  if (captured?.isConnected) return captured;
  const surface = [...root.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
    .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId);
  return surface?.querySelector<HTMLElement>(".composer-input") ?? null;
}

/**
 * The right side panel's app-level state. Lives in App.tsx (NOT inside the per-session-keyed
 * SessionDetail) so mode/width preferences and panel drafts survive navigation. Agents visibility
 * is limited to the current visit, even when old browser storage says it was open.
 */
export interface RightPanelState {
  open: boolean;
  mode: RightPanelMode;
  width: number;
  dragging: boolean;
  /** Ephemeral selection; provider tool ids can expire when event history resets. */
  subagentTarget: { sessionId: string; eventEpoch: number; subagentId: string; focusRequest?: number } | null;
  toggle: () => void;
  /** Open the panel on a mode; calling with the already-visible mode closes the panel (toggle). */
  openMode: (mode: RightPanelMode) => void;
  /** Ensure the panel is open on a mode (no toggle — for programmatic jumps like Commit-or-push). */
  show: (mode: RightPanelMode) => void;
  setMode: (mode: RightPanelMode) => void;
  setWidth: (fn: (w: number) => number) => void;
  setDragging: (d: boolean) => void;
  close: () => void;
  selectSubagent: (sessionId: string, eventEpoch: number, subagentId: string) => void;
  showSubagent: (sessionId: string, eventEpoch: number, subagentId: string) => void;
  consumeSubagentFocusRequest: (sessionId: string, eventEpoch: number, request: number) => void;
}

export function useRightPanelState(navigationScope: string | null = null, attentionNavigation = false): RightPanelState {
  const [open, setOpen] = useState(() => {
    try {
      return parseStoredRightPanelMode(loadBrowserStorageValue("wollipog.rightpanel.mode")) !== "subagents" &&
        loadBrowserStorageValue("wollipog.rightpanel.open") === "1";
    } catch {
      return false;
    }
  });
  const [mode, setMode] = useState<RightPanelMode>(() => {
    try {
      return parseStoredRightPanelMode(loadBrowserStorageValue("wollipog.rightpanel.mode"));
    } catch {
      return "launcher";
    }
  });
  const [width, setWidthRaw] = useState(() => {
    try {
      return parseStoredRightPanelWidth(loadBrowserStorageValue("wollipog.rightpanel.width"));
    } catch {
      return RIGHT_PANEL_DEFAULT_WIDTH;
    }
  });
  const [dragging, setDragging] = useState(false);
  const [subagentTarget, setSubagentTarget] = useState<RightPanelState["subagentTarget"]>(null);
  const nextSubagentFocusRequest = useRef(0);
  const [previousNavigation, setPreviousNavigation] = useState({ scope: navigationScope, attention: attentionNavigation });
  // Adjust before children render, so navigation cannot commit an Agents panel for the new visit.
  // Other panel preferences and all session-scoped scratch stay intact.
  if (previousNavigation.scope !== navigationScope || previousNavigation.attention !== attentionNavigation) {
    setPreviousNavigation({ scope: navigationScope, attention: attentionNavigation });
    // Targeting another request in the same visit keeps deliberate panel state and focus intact.
    // Returning from attention to the ordinary route starts a transcript-first visit.
    if (mode === "subagents" && (previousNavigation.scope !== navigationScope || !attentionNavigation)) setOpen(false);
  }

  // Persist once a value settles — not on every pointermove during a drag.
  useEffect(() => {
    if (dragging) return;
    try {
      saveBrowserStorageValue("wollipog.rightpanel.open", open ? "1" : "0");
      saveBrowserStorageValue("wollipog.rightpanel.mode", mode);
      saveBrowserStorageValue("wollipog.rightpanel.width", String(width));
    } catch {
      /* localStorage unavailable — panel prefs are best-effort */
    }
  }, [open, mode, width, dragging]);

  return {
    open,
    mode,
    width,
    dragging,
    subagentTarget,
    toggle: () => setOpen((o) => !o),
    openMode: (m) => {
      setOpen((o) => !(o && mode === m));
      setMode(m);
    },
    show: (m) => {
      setOpen(true);
      setMode(m);
    },
    setMode,
    setWidth: (fn) => setWidthRaw((w) => fn(w)),
    setDragging,
    close: () => setOpen(false),
    selectSubagent: (sessionId, eventEpoch, subagentId) => {
      setSubagentTarget({
        sessionId,
        eventEpoch,
        subagentId,
      });
    },
    showSubagent: (sessionId, eventEpoch, subagentId) => {
      setSubagentTarget({
        sessionId,
        eventEpoch,
        subagentId,
        focusRequest: ++nextSubagentFocusRequest.current,
      });
      setOpen(true);
      setMode("subagents");
    },
    consumeSubagentFocusRequest: (sessionId, eventEpoch, request) => {
      setSubagentTarget((current) => {
        if (current?.sessionId !== sessionId || current.eventEpoch !== eventEpoch ||
            current.focusRequest !== request) return current;
        const { focusRequest: _consumed, ...target } = current;
        return target;
      });
    },
  };
}

const MODE_TITLES: Record<RightPanelMode, string> = {
  launcher: "Panel",
  requests: "Requests",
  campaign: "Campaign Status",
  review: "Review",
  files: "Files",
  browser: "Browser",
  sidechat: "Side Chat",
  subagents: "Agents",
  background: "Background Work",
  decisions: "Decision History",
};

/**
 * Desktop-style right side panel: a toggleable, resizable column beside the chat.
 * The launcher empty state lists the destinations; each mode swaps the body in place.
 * Session-scoped mode bodies are keyed by session id by the caller so their local state
 * (paths, inputs) never bleeds across a navigation.
 */
export function RightPanel({
  state,
  session,
  sourceLocation,
  attentionTarget,
  onOpenSourceLocation,
  onClearSourceLocation,
  runnerOnline,
  runnerProtocolVersion,
  git,
  forge,
  onOpenTerminal,
  onInsertSideChatDraft,
  onAttachWorkspaceReference,
  reviewFocus,
  onReviewFocusHandled,
  items,
  decisionHistory = EMPTY_GOVERNANCE_DECISIONS,
  decisionHistoryStatus = "ready",
  onRetryDecisionHistory,
  decisionHistoryHasMore = false,
  decisionHistoryLoadingOlder = false,
  onLoadOlderDecisions,
  transcriptItemForDecision,
  onShowDecisionInTranscript,
  earlierActivityUnloaded = false,
  parentTurnEventIds = EMPTY_PARENT_TURN_EVENTS,
  onOpenParentTurn = () => undefined,
  backgroundInventoryError = null,
  onRetryBackgroundInventory,
  descendantRequests = [],
  descendantRequestStatus = "idle",
  selectedRequestKey = null,
  onSelectedRequestKeyChange = () => undefined,
  onDescendantsUpdate = () => undefined,
  onOpenChildRequest = () => undefined,
  onRetryDescendantRequests,
  campaignAvailability = HIDDEN_CAMPAIGN,
  onOpenSession = () => undefined,
}: {
  state: RightPanelState;
  session: SessionView;
  sourceLocation?: SourceLocation;
  attentionTarget?: import("../navigation.js").AttentionTarget;
  onOpenSourceLocation: (location: SourceLocation) => void;
  onClearSourceLocation: () => void;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  git: GitStatus;
  forge?: GitForgeInfo | null;
  /** The Terminal launcher row opens the bottom dock — the app's single terminal surface. */
  onOpenTerminal: () => void;
  /** Explicitly prepares the primary composer; never sends it. */
  onInsertSideChatDraft: (text: string) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  /** The file a transcript edit's Open in Review asked the Review tab to show (#2187). */
  reviewFocus?: DiffFileFocus | null;
  onReviewFocusHandled?: () => void;
  items: TimelineItem[];
  /** Every content-safe decision in this session, oldest-first (#2213). */
  decisionHistory?: readonly GovernanceDecision[];
  decisionHistoryStatus?: "loading" | "error" | "ready";
  onRetryDecisionHistory?: () => void;
  decisionHistoryHasMore?: boolean;
  decisionHistoryLoadingOlder?: boolean;
  onLoadOlderDecisions?: () => void;
  /** The loaded transcript row that shows a decision's request, if any. */
  transcriptItemForDecision?: (decision: GovernanceDecision) => number | undefined;
  onShowDecisionInTranscript?: (itemId: number) => void;
  /** The transcript is showing a bounded window with older turns still unloaded. */
  earlierActivityUnloaded?: boolean;
  /** Loaded parent turns that can be revealed directly in the virtual transcript. */
  parentTurnEventIds?: ReadonlyMap<string, number>;
  onOpenParentTurn?: (eventId: number) => void;
  backgroundInventoryError?: string | null;
  onRetryBackgroundInventory?: () => void;
  descendantRequests?: readonly DescendantRequestView[];
  descendantRequestStatus?: DescendantRequestStatus;
  selectedRequestKey?: string | null;
  onSelectedRequestKeyChange?: (key: string | null) => void;
  onDescendantsUpdate?: () => void;
  onOpenChildRequest?: (request: DescendantRequestView) => void;
  /** Checks the child requests again after they could not be loaded. */
  onRetryDescendantRequests?: () => void;
  /** Whether this session belongs to an issue campaign whose status the panel can show (#2417). */
  campaignAvailability?: CampaignStatusAvailability;
  /** Opens another session from a panel link, keeping the panel and its mode. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previouslyOpenRef = useRef(false);
  const filesSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionFiles");
  const terminalSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionShells");
  const filesHint = runnerCapabilityRequirement(runnerProtocolVersion, "sessionFiles", "session file browsing");
  const terminalHint = runnerCapabilityRequirement(runnerProtocolVersion, "sessionShells", "session terminal access");

  useLayoutEffect(() => {
    const wasOpen = previouslyOpenRef.current;
    previouslyOpenRef.current = state.open;
    if (!wasOpen && state.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    if (!wasOpen || state.open) return;
    const target = panelReturnFocusTarget(returnFocusRef.current, session.id);
    returnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      // An overlay that replaced the panel (the phone's Pinned Summary sheet, #2147) owns focus by
      // now; pulling it back to the opener behind that dialog's scrim would escape its focus trap.
      if (document.activeElement?.closest('[aria-modal="true"]')) return;
      // Attention navigation can dismiss a phone panel and focus the exact docked request in the
      // same frame. That completed focus transfer takes precedence over returning to the opener.
      if (document.activeElement?.closest("[data-session-request-focus]")) return;
      if (target?.isConnected) target.focus();
    });
  }, [session.id, state.open]);

  // Viewport-aware ceiling as STATE (the rendered width and the separator's ARIA range both
  // re-derive from it) — the stored width PREFERENCE is left untouched, so a temporary window
  // shrink never clobbers the size the user chose. Same stance as the shell dock's height.
  const [viewportMax, setViewportMax] = useState(() => viewportPanelMax());
  useEffect(() => {
    const onWinResize = () => setViewportMax(viewportPanelMax());
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  // The row the chat column and the panel share (`.detail-columns`), measured before paint so the
  // panel never shows docked for a frame where it overlays (§15.2; #2725). Its width does not depend
  // on the panel's presentation, so overlaying cannot flip the answer back.
  const asideRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Whether keyboard focus is on the resize handle, which an overlay removes (#2725). A blur that
  // comes from the handle being removed leaves this set, so focus can move on to Close Panel.
  const resizerFocused = useRef(false);
  const [columnsWidth, setColumnsWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const columns = asideRef.current?.parentElement;
    if (!state.open || !columns) return;
    // A row with no width has not been laid out (or is hidden); it docks, as before measuring.
    const measure = () => setColumnsWidth(columns.getBoundingClientRect().width || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(columns);
    return () => observer.disconnect();
  }, [state.open]);
  const phone = useIsMobile();
  // Every mode docks or overlays by the same rule; a phone's panel is full-screen (styles.css).
  const overlay = state.open && !phone && columnsWidth !== null &&
    rightPanelOverlays(columnsWidth, clampRightPanelWidth(state.width, viewportMax));
  // A drag that widens the panel into an overlay loses its handle; end the drag with it.
  useEffect(() => {
    if (!overlay || !dragRef.current) return;
    dragRef.current = null;
    state.setDragging(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay]);
  // Keyboard resizing past the chat's room removes the focused handle; focus stays in the panel, on
  // Close Panel, rather than falling to the page.
  useLayoutEffect(() => {
    if (!overlay || !resizerFocused.current) return;
    resizerFocused.current = false;
    closeRef.current?.focus();
  }, [overlay]);

  // Guard against a mid-drag unmount: closing the panel (shortcut/header button)
  // unmounts the resizer mid-drag and the lostpointercapture never reaches React.
  useEffect(() => {
    if (!state.open) {
      dragRef.current = null;
      state.setDragging(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open]);

  useEffect(() => {
    if (!state.open || state.mode !== "requests") return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      // A modal opened from inside this panel (the enlarged evidence image) owns Escape. Both
      // listeners sit on window and this one registered first, so without yielding here it would
      // close the panel out from under the dialog and mark the event handled before the dialog saw it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      state.close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [state]);

  const sessionEventEpoch = session.eventEpoch ?? 0;
  useEffect(() => {
    const target = state.subagentTarget;
    if (target?.focusRequest === undefined ||
        (target.sessionId === session.id && target.eventEpoch === sessionEventEpoch)) return;
    state.consumeSubagentFocusRequest(target.sessionId, target.eventEpoch, target.focusRequest);
    // The focus intent belongs to exactly one mounted session generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, sessionEventEpoch, state.subagentTarget]);

  // Campaign Status belongs to campaign sessions. Arriving at an unrelated session returns the panel
  // to the launcher, still open, rather than showing another campaign or an empty body.
  const campaignHidden = campaignAvailability.kind === "hidden";
  useLayoutEffect(() => {
    if (campaignHidden && state.mode === "campaign") state.setMode("launcher");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignHidden, state.mode]);

  if (!state.open) return null;

  // What actually renders: the preference clamped to the live viewport ceiling. Gestures
  // start from THIS (what the user sees), and only gestures write the preference back.
  const effectiveWidth = clampRightPanelWidth(state.width, viewportMax);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startWidth: effectiveWidth };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — drag still works while over the handle */
    }
    state.setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.buttons === 0) {
      // Self-heal a missed drag-end: no buttons held means hover, not drag.
      dragRef.current = null;
      state.setDragging(false);
      return;
    }
    state.setWidth(() => resolveRightPanelDrag(d.startWidth, e.clientX - d.startX, viewportMax).width);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    state.setDragging(false);
    const r = resolveRightPanelDrag(d.startWidth, e.clientX - d.startX, viewportMax);
    if (r.collapse) {
      // Snap closed, but keep the pre-drag width so reopening restores a sane size.
      state.close();
      state.setWidth(() => d.startWidth);
    } else {
      state.setWidth(() => r.width);
    }
  };
  // Capture can be lost without a pointerup (alt-tab, device removal), and touch/pen input
  // can fire pointercancel — end the drag cleanly on both paths.
  const onLostCapture = () => {
    dragRef.current = null;
    state.setDragging(false);
  };
  const onResizerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Left edge: ArrowLeft grows the panel, ArrowRight shrinks it. Step from the VISIBLE
    // width so the first keypress on a viewport-clamped panel adjusts by one step, not a jump.
    if (e.key === "ArrowLeft") state.setWidth(() => clampRightPanelWidth(effectiveWidth + RIGHT_PANEL_KEY_STEP, viewportMax));
    else if (e.key === "ArrowRight") state.setWidth(() => clampRightPanelWidth(effectiveWidth - RIGHT_PANEL_KEY_STEP, viewportMax));
    else if (e.key === "Home") state.setWidth(() => clampRightPanelWidth(RIGHT_PANEL_MAX_WIDTH, viewportMax));
    else if (e.key === "End") state.setWidth(() => RIGHT_PANEL_MIN_WIDTH);
    else return;
    e.preventDefault();
  };

  // The session's own requests are on its request dock (#2179); this panel lists its descendants'.
  // A request's detail has its own "‹ All Requests" (#2206), so the head's back control leaves while
  // one is shown; a selection the list no longer holds (unavailable, or still loading) shows none.
  const requestDetailShown = state.mode === "requests" && selectedRequestKey !== null &&
    descendantRequests.some((request) => sessionRequestPanelKey(request.sessionId, request.occurrenceId) === selectedRequestKey);
  const ownRequests = dockRequests(pendingRequests(session.pendingApproval));
  const ownRequestKey = (request: (typeof ownRequests)[number]) =>
    sessionRequestPanelKey(session.id, request.occurrenceId ?? request.requestId);

  /**
   * Every non-launcher mode owns a body. The switch is exhaustive on purpose: adding a mode to
   * RIGHT_PANEL_MODES without a body here is a compile error, which is what replaced the old
   * trailing "Coming soon." fallback that leaked a placeholder hint into real modes (#1201).
   */
  const modeBody = (mode: Exclude<RightPanelMode, "launcher">): ReactNode => {
    switch (mode) {
      case "files":
        return filesSupported ? (
          <FilesBrowser
            session={session}
            runnerOnline={runnerOnline}
            runnerProtocolVersion={runnerProtocolVersion}
            location={sourceLocation}
            onOpenLocation={onOpenSourceLocation}
            onClearLocation={onClearSourceLocation}
            onAttachWorkspaceReference={onAttachWorkspaceReference}
          />
        ) : (
          <div className="hint warn">{filesHint}</div>
        );
      case "requests":
        return (
          <SessionRequestPanel
            session={session}
            descendants={descendantRequests}
            descendantStatus={descendantRequestStatus}
            selectedKey={selectedRequestKey}
            onSelectedKeyChange={onSelectedRequestKeyChange}
            onDescendantsUpdate={onDescendantsUpdate}
            onOpenChild={onOpenChildRequest}
            onRetry={onRetryDescendantRequests}
            onOpenDecisionHistory={() => state.setMode("decisions")}
          />
        );
      case "campaign":
        return campaignAvailability.kind === "hidden" ? null : (
          <CampaignStatusPanel
            session={session}
            availability={campaignAvailability}
            onOpenSession={onOpenSession}
            findRequest={(target) => {
              // The request the blocker names, else one pending on the item's own child session.
              // Never another child's: an item with no listed request offers its child instead.
              // The named occurrence wins wherever it is listed; only then the child-session fallback.
              if (target.occurrenceId) {
                const ownNamed = ownRequests.find((request) => (request.occurrenceId ?? request.requestId) === target.occurrenceId);
                if (ownNamed) return ownRequestKey(ownNamed);
                const named = descendantRequests.find((request) => request.occurrenceId === target.occurrenceId);
                if (named) return sessionRequestPanelKey(named.sessionId, named.occurrenceId);
              }
              if (!target.sessionId) return null;
              if (target.sessionId === session.id) return ownRequests[0] ? ownRequestKey(ownRequests[0]) : null;
              const child = descendantRequests.find((request) => request.sessionId === target.sessionId);
              return child ? sessionRequestPanelKey(child.sessionId, child.occurrenceId) : null;
            }}
            onOpenRequest={(requestKey) => {
              // The session's own request opens on its dock card; a descendant's in this panel.
              const own = ownRequests.find((request) => ownRequestKey(request) === requestKey);
              if (own) {
                // As the Agents panel's Open Request in Session: on a phone the panel covers the dock.
                state.close();
                window.requestAnimationFrame(() => focusSessionRequest(session.id, own.requestId));
                return;
              }
              onSelectedRequestKeyChange(requestKey);
              state.show("requests");
            }}
          />
        );
      case "review":
        return (
          <ReviewPanel
            session={session}
            runnerOnline={runnerOnline}
            runnerProtocolVersion={runnerProtocolVersion}
            git={git}
            forge={forge}
            onOpenSourceLocation={onOpenSourceLocation}
            onAttachWorkspaceReference={onAttachWorkspaceReference}
            focus={reviewFocus}
            onFocusHandled={onReviewFocusHandled}
          />
        );
      case "decisions":
        return (
          <DecisionHistoryPanel
            key={session.id}
            decisions={decisionHistory}
            status={decisionHistoryStatus}
            onRetry={onRetryDecisionHistory}
            hasMore={decisionHistoryHasMore}
            loadingOlder={decisionHistoryLoadingOlder}
            onLoadOlder={onLoadOlderDecisions}
            transcriptItemFor={transcriptItemForDecision}
            onShowInTranscript={onShowDecisionInTranscript}
          />
        );
      case "browser":
        return <BrowserPanel session={session} />;
      case "sidechat":
        return <SideChatPanel session={session} runnerOnline={runnerOnline} onInsertDraft={onInsertSideChatDraft} />;
      case "subagents":
        return (
          <AgentsPanel
            attentionTarget={attentionTarget}
            key={`${session.id}:${sessionEventEpoch}`}
            onOpenPrimaryRequest={(requestId) => {
              state.close();
              window.requestAnimationFrame(() => focusSessionRequest(session.id, requestId));
            }}
            runnerProtocolVersion={runnerProtocolVersion}
            parentTurnEventIds={parentTurnEventIds}
            onOpenParentTurn={onOpenParentTurn}
            inventoryError={backgroundInventoryError}
            onRetryInventory={onRetryBackgroundInventory}
            session={session}
            items={items}
            runnerOnline={runnerOnline}
            earlierActivityUnloaded={earlierActivityUnloaded}
            requestedId={state.subagentTarget?.sessionId === session.id &&
              state.subagentTarget.eventEpoch === sessionEventEpoch
              ? state.subagentTarget.subagentId
              : null}
            focusRequest={state.subagentTarget?.sessionId === session.id &&
              state.subagentTarget.eventEpoch === sessionEventEpoch
              ? state.subagentTarget.focusRequest
              : undefined}
            onFocusRequestHandled={(request) => {
              state.consumeSubagentFocusRequest(session.id, sessionEventEpoch, request);
            }}
            onSelect={(subagentId) => state.selectSubagent(session.id, sessionEventEpoch, subagentId)}
          />
        );
      case "background":
        return (
          <BackgroundWorkPanel
            session={session}
            runnerOnline={runnerOnline}
            runnerProtocolVersion={runnerProtocolVersion}
            parentTurnEventIds={parentTurnEventIds}
            onOpenParentTurn={onOpenParentTurn}
            inventoryError={backgroundInventoryError}
            onRetryInventory={onRetryBackgroundInventory}
          />
        );
      default: {
        const unhandled: never = mode;
        throw new Error(`right panel mode without a body: ${String(unhandled)}`);
      }
    }
  };

  return (
    <>
      {/* An overlaying panel has no handle: it keeps the width chosen while docked (#2725). */}
      {!overlay && <div
        className="right-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Panel"
        aria-controls="right-panel"
        aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
        aria-valuemax={clampRightPanelWidth(Number.MAX_SAFE_INTEGER, viewportMax)}
        aria-valuenow={effectiveWidth}
        aria-valuetext={`${effectiveWidth} pixels`}
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onLostCapture}
        onLostPointerCapture={onLostCapture}
        onKeyDown={onResizerKeyDown}
        onDoubleClick={() => state.setWidth(() => RIGHT_PANEL_DEFAULT_WIDTH)}
        onFocus={() => { resizerFocused.current = true; }}
        onBlur={(event) => { if (event.currentTarget.isConnected) resizerFocused.current = false; }}
      />}
      {/* Where docking would leave the chat column under 480px, every mode opens over the transcript
          from the right, over a scrim a press on which closes the panel as Close Panel does (§15.2;
          #2206, #2725). */}
      {overlay && <div className="rp-scrim" aria-hidden="true" onClick={state.close} />}
      <aside
        ref={asideRef}
        id="right-panel"
        className="right-panel"
        data-mode={state.mode}
        data-presentation={overlay ? "overlay" : "docked"}
        style={{ width: effectiveWidth }}
        aria-label={MODE_TITLES[state.mode]}
      >
        <div className="rp-head">
          {state.mode !== "launcher" && !requestDetailShown && (
            <button
              type="button"
              className="icon-btn rp-back"
              onClick={() => state.setMode("launcher")}
              title="Back to Panel List"
              aria-label="Back to Panel List"
            >
              <ChevronLeftIcon />
            </button>
          )}
          <span className="rp-title">
            {MODE_TITLES[state.mode]}
            {state.mode === "review" && git.status && (
              <span className="rp-subtitle">
                {git.status.branch} · {git.status.files.length} Change{git.status.files.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
          <button ref={closeRef} type="button" className="icon-btn rp-close" onClick={state.close} title="Close Panel" aria-label="Close Panel">
            <CloseIcon />
          </button>
        </div>
        {state.mode === "launcher" ? (
          <Launcher
            onPick={(m) => {
              // The Requests row opens the list, never a request left open from an earlier visit.
              if (m === "requests") onSelectedRequestKeyChange(null);
              state.setMode(m);
            }}
            onOpenTerminal={onOpenTerminal}
            filesSupported={filesSupported}
            filesHint={filesHint}
            terminalSupported={terminalSupported}
            terminalHint={terminalHint}
            backgroundAvailable={(session.backgroundJobs?.length ?? 0) > 0 ||
              session.backgroundJobsAvailable === true ||
              session.backgroundWorkTracking != null || session.backgroundWorkState != null}
            campaignAvailability={campaignAvailability}
          />
        ) : (
          <div className="rp-body">{modeBody(state.mode)}</div>
        )}
      </aside>
    </>
  );
}

/** One launcher row: icon, label, right-aligned shortcut hint — the Codex empty state. */
function LauncherRow({
  icon,
  label,
  kbd,
  disabled,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  kbd?: string;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" className="rp-row" disabled={disabled} title={disabled ? hint : undefined} onClick={onClick}>
      <span className="rp-row-icon">{icon}</span>
      <span>{label}</span>
      {kbd && <kbd className="rp-kbd">{kbd}</kbd>}
    </button>
  );
}

/**
 * The Campaign Status row. Unlike the older rows, its unavailability reason is visible text and the
 * row's accessible description (the direction of #1261), and it stays focusable through
 * `aria-disabled` so a keyboard user reaches the reason too.
 */
function CampaignStatusLauncherRow({ unavailableReason, onClick }: { unavailableReason: string | null; onClick: () => void }) {
  const reasonId = useId();
  return (
    <button
      type="button"
      className="rp-row"
      aria-disabled={unavailableReason ? "true" : undefined}
      aria-describedby={unavailableReason ? reasonId : undefined}
      onClick={unavailableReason ? undefined : onClick}
    >
      <span className="rp-row-icon"><CampaignIcon size={14} /></span>
      <span className="rp-row-text">
        <span>Campaign Status</span>
        {unavailableReason && <span className="rp-row-reason" id={reasonId}>{unavailableReason}</span>}
      </span>
    </button>
  );
}

function Launcher({
  onPick,
  onOpenTerminal,
  filesSupported,
  filesHint,
  terminalSupported,
  terminalHint,
  backgroundAvailable,
  campaignAvailability,
}: {
  onPick: (mode: RightPanelMode) => void;
  onOpenTerminal: () => void;
  filesSupported: boolean;
  filesHint: string;
  terminalSupported: boolean;
  terminalHint: string;
  backgroundAvailable: boolean;
  campaignAvailability: CampaignStatusAvailability;
}) {
  return (
    <div className="rp-launcher">
      {(!filesSupported || !terminalSupported) && (
        <div className="hint warn" role="status">
          {!filesSupported && <div>{filesHint}</div>}
          {!terminalSupported && <div>{terminalHint}</div>}
        </div>
      )}
      {/* Always available: with nothing pending it opens "Nothing Waiting" (#2206). */}
      <LauncherRow
        label="Requests"
        onClick={() => onPick("requests")}
        icon={<InboxIcon size={14} />}
      />
      {campaignAvailability.kind !== "hidden" && (
        <CampaignStatusLauncherRow
          unavailableReason={campaignAvailability.kind === "unavailable" ? campaignAvailability.reason : null}
          onClick={() => onPick("campaign")}
        />
      )}
      <LauncherRow
        label="Background Work"
        disabled={!backgroundAvailable}
        hint="No background-work capability or history is available for this session."
        onClick={() => onPick("background")}
        icon={<JobsIcon size={14} />}
      />
      <LauncherRow
        label="Review"
        kbd={shortcutDisplay("open-review")}
        onClick={() => onPick("review")}
        icon={
          <DiffIcon size={14} />
        }
      />
      <LauncherRow
        label="Terminal"
        kbd={shortcutDisplay("toggle-terminal")}
        disabled={!terminalSupported}
        hint={terminalHint}
        onClick={onOpenTerminal}
        icon={
          <CommandLineIcon size={14} />
        }
      />
      <LauncherRow
        label="Browser"
        onClick={() => onPick("browser")}
        icon={
          <GlobeIcon size={14} />
        }
      />
      <LauncherRow
        label="Files"
        kbd={shortcutDisplay("open-files")}
        disabled={!filesSupported}
        hint={filesHint}
        onClick={() => onPick("files")}
        icon={
          <FolderIcon size={14} />
        }
      />
      <LauncherRow
        label="Agents"
        onClick={() => onPick("subagents")}
        icon={
          <TeamIcon size={14} />
        }
      />
      <LauncherRow
        label="Decision History"
        onClick={() => onPick("decisions")}
        icon={<LockIcon size={14} />}
      />
      <LauncherRow
        label="Side Chat"
        onClick={() => onPick("sidechat")}
        icon={
          <QuestionIcon size={14} />
        }
      />
    </div>
  );
}
