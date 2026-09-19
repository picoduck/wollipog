import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronLeftIcon, CommandLineIcon, DiffIcon, FolderIcon, GlobeIcon, HelpIcon, InboxIcon, JobsIcon, LockIcon, TeamIcon } from "./Icons.js";
import {
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
  parseStoredRightPanelMode,
  parseStoredRightPanelWidth,
  resolveRightPanelDrag,
  type RightPanelMode,
} from "../right-panel.js";
import { FilesBrowser } from "./FilesPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { SideChatPanel } from "./SideChatPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import type { GitStatus } from "./useGitStatus.js";
import { shortcutDisplay } from "../shortcuts.js";
import type { TimelineItem } from "../timeline.js";
import type { GovernanceDecision } from "../governance.js";
import { GovernanceHistoryPanel } from "./GovernanceHistoryPanel.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { focusSessionRequest, standaloneApprovalForReview } from "./SessionApproval.js";
import { BackgroundWorkPanel } from "./BackgroundWorkPanel.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";
import { SessionRequestPanel, type DescendantRequestStatus } from "./SessionRequestPanel.js";

/** Viewport-aware width ceiling: the panel may take at most ~40% of the window, so the
 * transcript + composer always keep a usable share on narrow/split-screen windows. */
function viewportPanelMax(): number {
  return Math.floor(window.innerWidth * 0.4);
}

const EMPTY_PARENT_TURN_EVENTS: ReadonlyMap<string, number> = new Map();
const EMPTY_GOVERNANCE_DECISIONS: readonly GovernanceDecision[] = [];

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
 * SessionDetail) so the open/mode/width prefs survive navigating between sessions; persisted
 * like every other wollipog.* pref (best-effort localStorage).
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

export function useRightPanelState(): RightPanelState {
  const [open, setOpen] = useState(() => {
    try {
      return loadBrowserStorageValue("wollipog.rightpanel.open") === "1";
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
  review: "Review",
  files: "Files",
  browser: "Browser",
  sidechat: "Side Chat",
  subagents: "Agents",
  background: "Background Work",
  governance: "Governance History",
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
  items,
  governanceDecisions = EMPTY_GOVERNANCE_DECISIONS,
  governanceAvailable = governanceDecisions.length > 0,
  governanceHasMore = false,
  governanceLoadingOlder = false,
  onLoadOlderGovernance,
  earlierActivityUnloaded = false,
  parentTurnEventIds = EMPTY_PARENT_TURN_EVENTS,
  onOpenParentTurn = () => undefined,
  backgroundInventoryError = null,
  onRetryBackgroundInventory,
  descendantRequests = [],
  descendantRequestStatus = "idle",
  selectedRequestKey = null,
  onSelectedRequestKeyChange = () => undefined,
  onSessionUpdate,
  onDescendantsUpdate = () => undefined,
  onOpenChildRequest = () => undefined,
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
  items: TimelineItem[];
  /** Consolidated, content-safe governance outcomes for this session, oldest-first. */
  governanceDecisions?: readonly GovernanceDecision[];
  governanceAvailable?: boolean;
  governanceHasMore?: boolean;
  governanceLoadingOlder?: boolean;
  onLoadOlderGovernance?: () => void;
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
  onSessionUpdate?: (session: SessionView) => void;
  onDescendantsUpdate?: () => void;
  onOpenChildRequest?: (request: DescendantRequestView) => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previouslyOpenRef = useRef(false);
  const filesSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionFiles");
  const terminalSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionShells");
  const filesHint = runnerCapabilityRequirement(runnerProtocolVersion, "sessionFiles", "Session file browsing");
  const terminalHint = runnerCapabilityRequirement(runnerProtocolVersion, "sessionShells", "Session terminal access");

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
        return onSessionUpdate ? (
          <SessionRequestPanel
            session={session}
            runnerOnline={runnerOnline}
            descendants={descendantRequests}
            descendantStatus={descendantRequestStatus}
            selectedKey={selectedRequestKey}
            onSelectedKeyChange={onSelectedRequestKeyChange}
            onSessionUpdate={onSessionUpdate}
            onDescendantsUpdate={onDescendantsUpdate}
            onOpenChild={onOpenChildRequest}
          />
        ) : null;
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
          />
        );
      case "governance":
        return (
          <GovernanceHistoryPanel
            decisions={governanceDecisions}
            hasMore={governanceHasMore}
            loadingOlder={governanceLoadingOlder}
            onLoadOlder={onLoadOlderGovernance}
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
      <div
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
      />
      <aside id="right-panel" className="right-panel" style={{ width: effectiveWidth }} aria-label={MODE_TITLES[state.mode]}>
        <div className="rp-head">
          {state.mode !== "launcher" && (
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
          <button type="button" className="icon-btn rp-close" onClick={state.close} title="Close Panel" aria-label="Close Panel">
            {state.mode === "requests" ? "Close" : "×"}
          </button>
        </div>
        {state.mode === "launcher" ? (
          <Launcher
            onPick={(m) => state.setMode(m)}
            onOpenTerminal={onOpenTerminal}
            filesSupported={filesSupported}
            filesHint={filesHint}
            terminalSupported={terminalSupported}
            terminalHint={terminalHint}
            backgroundAvailable={(session.backgroundJobs?.length ?? 0) > 0 ||
              session.backgroundJobsAvailable === true ||
              session.backgroundWorkTracking != null || session.backgroundWorkState != null}
            governanceAvailable={governanceAvailable}
            requestsAvailable={descendantRequests.length > 0 ||
              standaloneApprovalForReview(session.pendingApproval) !== null}
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
      {kbd && <span className="rp-kbd">{kbd}</span>}
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
  governanceAvailable,
  requestsAvailable,
}: {
  onPick: (mode: RightPanelMode) => void;
  onOpenTerminal: () => void;
  filesSupported: boolean;
  filesHint: string;
  terminalSupported: boolean;
  terminalHint: string;
  backgroundAvailable: boolean;
  governanceAvailable: boolean;
  requestsAvailable: boolean;
}) {
  return (
    <div className="rp-launcher">
      {(!filesSupported || !terminalSupported) && (
        <div className="hint warn" role="status">
          {!filesSupported && <div>{filesHint}</div>}
          {!terminalSupported && <div>{terminalHint}</div>}
        </div>
      )}
      <LauncherRow
        label="Requests"
        disabled={!requestsAvailable}
        hint="No requests are pending for this session or its descendants."
        onClick={() => onPick("requests")}
        icon={<InboxIcon size={14} />}
      />
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
        label="Governance History"
        disabled={!governanceAvailable}
        hint="No governance decisions have been recorded for this session."
        onClick={() => onPick("governance")}
        icon={<LockIcon size={14} />}
      />
      <LauncherRow
        label="Side Chat"
        onClick={() => onPick("sidechat")}
        icon={
          <HelpIcon size={14} />
        }
      />
    </div>
  );
}
