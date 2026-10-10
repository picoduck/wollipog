import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CampaignIcon, ChevronDownIcon, ChevronLeftIcon, CloseIcon, CommandLineIcon, DiffIcon, FolderIcon, GlobeIcon, GridIcon, QuestionIcon, InboxIcon, JobsIcon, LockIcon, TeamIcon } from "./Icons.js";
import { Maximize2Icon, Minimize2Icon } from "./Icons.js";
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
  rightPanelDragCeiling,
  rightPanelOverlays,
  parseStoredRightPanelExpanded,
  parseStoredRightPanelMode,
  parseStoredRightPanelWidth,
  resolveRightPanelDrag,
  type RightPanelMode,
} from "../right-panel.js";
import { FilesBrowser, requestGoToFileFocus } from "./FilesPanel.js";
import { Notice } from "./Notice.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { SideChatPanel } from "./SideChatPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import type { DiffFileFocus } from "./GitDiffViewer.js";
import type { VisibleForgeFacts } from "../pinned-summary.js";
import type { GitStatus } from "./useGitStatus.js";
import { shortcutDisplay } from "../shortcuts.js";
import { useSessionChanges } from "../store.js";
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
import { useIsCoarsePointer, useIsMobile } from "./useIsMobile.js";
import type { CampaignStatusAvailability } from "../campaign-status.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import {
  BACKGROUND_WORK_UNAVAILABLE,
  SESSION_TOOL_GROUPS,
  SESSION_TOOLS,
  sessionTool,
  sessionToolAvailability,
  type SessionToolContext,
  type SessionToolId,
} from "../session-tools.js";

const EMPTY_PARENT_TURN_EVENTS: ReadonlyMap<string, number> = new Map();
const EMPTY_GOVERNANCE_DECISIONS: readonly GovernanceDecision[] = [];
const HIDDEN_CAMPAIGN: CampaignStatusAvailability = { kind: "hidden" };

/**
 * Where focus goes when the panel closes: the control that opened it, else the session's composer.
 * A phone's panel replaces its session app bar, toggle included, and the composer (#2843), so when
 * the opener is gone it returns to the conversation itself, where focusing the composer would raise
 * the software keyboard nobody asked for.
 */
export function panelReturnFocusTarget(
  captured: HTMLElement | null,
  sessionId: string,
  root: ParentNode = document,
  phone = false,
): HTMLElement | null {
  if (captured?.isConnected) return captured;
  const surface = [...root.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
    .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId);
  return surface?.querySelector<HTMLElement>(phone ? ".detail-scroll" : ".composer-input") ?? null;
}

/**
 * Whether a layer above the panel owns Escape: a modal dialog, or an open menu or popover, which
 * the shell closes through its backdrop (§16.2).
 */
function escapeTakenAbovePanel(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"], .menu-backdrop'));
}

/** The header's action slot, once it is mounted. Only RightPanel provides it (and tests). */
export const PanelActionSlotContext = createContext<HTMLElement | null>(null);

/**
 * The side panel header's action slot (#2843): the one extension point through which a tool puts
 * its own actions in the 48px header, between the tool switcher and Expand Panel (on a phone, after
 * the switcher). A tool renders this anywhere inside its body; its children are portalled into the
 * header, in order, and leave with the tool. Use `.icon-btn` buttons (32px, 44px on touch) with a
 * Title Case `aria-label` and the same `title`; a pushed page's Back, an About popover and similar
 * per-tool controls (#2856) belong here rather than in a second bar inside the body.
 *
 * Outside the side panel it renders nothing.
 */
export function PanelHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(PanelActionSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/**
 * A tool's own Escape layer on its body (§16.2): a selection such as Review's Select Lines (#2849).
 * While one is registered, Escape inside the panel goes to it instead of restoring or closing the
 * panel; menus, popovers and dialogs above the panel still take it first.
 */
export const PanelEscapeLayerContext = createContext<{ current: (() => void) | null } | null>(null);

/** Take Escape inside the side panel while `onEscape` is set. Outside the panel it does nothing. */
export function usePanelEscapeLayer(onEscape: (() => void) | null): void {
  const layer = useContext(PanelEscapeLayerContext);
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;
  const active = onEscape !== null;
  useLayoutEffect(() => {
    if (!layer || !active) return;
    const take = () => handlerRef.current?.();
    layer.current = take;
    return () => {
      if (layer.current === take) layer.current = null;
    };
  }, [layer, active]);
}

/** What a tool's Back does from the phone panel's header, and its Title Case name. */
export interface PanelBack {
  label: string;
  onBack: () => void;
}

interface PanelBackSlot {
  /** The panel is a phone sheet, whose header leads with a Back (#2843). */
  phone: boolean;
  set: Dispatch<SetStateAction<{ label: string; run: () => void } | null>>;
  /** Focus the header's Back. */
  focus: () => void;
}

/** Where a tool registers its own Back (`usePanelBack`). */
const PanelBackContext = createContext<PanelBackSlot | null>(null);

/**
 * A tool's own Back in the phone panel's header (#2855), so a page inside a tool, such as an open
 * artifact, has one back control: while `back` is set on a phone, the header's Back takes its name
 * and runs it instead of Back to Session. `carried` says the header carries it, when the tool must
 * not draw a back of its own; on a desktop panel, whose header has no Back, it is false. #2856's page
 * stack is meant to absorb this. Outside the side panel it does nothing.
 */
export function usePanelBack(back: PanelBack | null): { carried: boolean; focus: () => void } {
  const slot = useContext(PanelBackContext);
  const handlerRef = useRef(back?.onBack);
  handlerRef.current = back?.onBack;
  const label = back?.label ?? null;
  const carried = Boolean(slot?.phone && label !== null);
  useLayoutEffect(() => {
    if (!slot?.phone || label === null) return;
    const entry = { label, run: () => handlerRef.current?.() };
    slot.set(entry);
    return () => slot.set((current) => (current === entry ? null : current));
  }, [slot, label]);
  return { carried, focus: () => slot?.focus() };
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
  /**
   * Whether the panel fills the session's content area in place of the chat column (#2845). A
   * per-device preference that outlives closing the panel, switching tools and sessions; phones
   * ignore it.
   */
  expanded: boolean;
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
  setExpanded: (expanded: boolean) => void;
  setDragging: (d: boolean) => void;
  close: () => void;
  selectSubagent: (sessionId: string, eventEpoch: number, subagentId: string) => void;
  showSubagent: (sessionId: string, eventEpoch: number, subagentId: string) => void;
  consumeSubagentFocusRequest: (sessionId: string, eventEpoch: number, request: number) => void;
}

/**
 * Ctrl/⌘+P (#2852): the panel on Files, with focus in Go to File. It opens the panel and switches it
 * to Files when needed, and never closes it, so a second press only puts focus back in the field.
 */
export function openGoToFile(state: Pick<RightPanelState, "show">): void {
  state.show("files");
  requestGoToFileFocus();
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
  const [expanded, setExpanded] = useState(() => {
    try {
      return parseStoredRightPanelExpanded(loadBrowserStorageValue("wollipog.rightpanel.expanded"));
    } catch {
      return false;
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
      saveBrowserStorageValue("wollipog.rightpanel.expanded", expanded ? "1" : "0");
    } catch {
      /* localStorage unavailable — panel prefs are best-effort */
    }
  }, [open, mode, width, expanded, dragging]);

  return {
    open,
    mode,
    width,
    expanded,
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
    setExpanded,
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

/** Each tool's 16px glyph, shared by the switcher and the Session Tools list. */
export const SESSION_TOOL_ICONS: Record<SessionToolId, (props: { size?: number }) => ReactNode> = {
  launcher: GridIcon,
  review: DiffIcon,
  files: FolderIcon,
  browser: GlobeIcon,
  terminal: CommandLineIcon,
  subagents: TeamIcon,
  sidechat: QuestionIcon,
  background: JobsIcon,
  campaign: CampaignIcon,
  requests: InboxIcon,
  decisions: LockIcon,
};

function SessionToolIcon({ id, size = 16 }: { id: SessionToolId; size?: number }) {
  const Icon = SESSION_TOOL_ICONS[id];
  return <Icon size={size} />;
}

/**
 * The header's title: the current tool's icon and name and a caret, opening a menu of every tool
 * (§9.1): Session Tools first, then the Code, Work and Decisions groups, the current tool checked.
 * An unavailable tool stays focusable, with its reason as its description, so it is announced.
 * Terminal opens the bottom dock rather than becoming the panel's tool, so it is a plain item.
 */
function ToolSwitcher({
  current,
  context,
  triggerRef,
  onChoose,
}: {
  current: RightPanelMode;
  context: SessionToolContext;
  triggerRef: { current: HTMLButtonElement | null };
  /** `keyboard` when Enter or Space chose the tool, rather than a pointer. */
  onChoose: (tool: SessionToolId, keyboard: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "session-tool-switcher", "item", { reachUnavailable: true });
  const coarsePointer = useIsCoarsePointer();
  const tool = sessionTool(current);
  const setTrigger = (element: HTMLButtonElement | null) => {
    menu.triggerRef.current = element;
    triggerRef.current = element;
  };
  const item = (id: SessionToolId) => {
    const availability = sessionToolAvailability(id, context);
    if (!availability.listed) return null;
    const entry = sessionTool(id);
    const reason = availability.unavailableReason;
    return (
      <MenuItem
        key={id}
        role={id === "terminal" ? "menuitem" : "menuitemradio"}
        checked={id === "terminal" ? undefined : id === current}
        icon={<SessionToolIcon id={id} />}
        aria-disabled={reason ? "true" : undefined}
        description={reason ?? undefined}
        trail={entry.shortcut && !coarsePointer ? <kbd>{shortcutDisplay(entry.shortcut)}</kbd> : undefined}
        onClick={(event) => {
          if (reason) return;
          menu.close(true);
          // A click from Enter or Space carries no pointer press count. Files chosen again by keyboard
          // still lands in Go to File (#2852).
          const keyboard = event.detail === 0;
          if (id !== current || (id === "files" && keyboard)) onChoose(id, keyboard);
        }}
      >
        {entry.name}
      </MenuItem>
    );
  };
  return (
    <h2 className="rpanel-title">
      <button
        ref={setTrigger}
        type="button"
        className="rpanel-switcher"
        title="Switch Tool"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <span className="rpanel-switcher-icon" aria-hidden="true"><SessionToolIcon id={current} /></span>
        <span className="rpanel-switcher-name">{tool.name}</span>
        <span className="rpanel-switcher-caret" aria-hidden="true"><ChevronDownIcon size={16} /></span>
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Switch Tool"
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {item("launcher")}
          {SESSION_TOOL_GROUPS.map((group) => (
            <div key={group} role="group" aria-label={group}>
              <MenuSeparator />
              <MenuLabel>{group}</MenuLabel>
              {SESSION_TOOLS.filter((candidate) => candidate.group === group).map((candidate) => item(candidate.id))}
            </div>
          ))}
        </MenuSurface>
      )}
    </h2>
  );
}

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
  forgeFacts,
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
  /** The branch's pull request and its checks, for Review's summary (#2846). */
  forgeFacts?: Pick<VisibleForgeFacts, "pr" | "checks"> | null;
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
  // The panels show ages that read the clock as they render (requests, decisions, background work),
  // and moved on with every paced upsert while the session view rendered for them (#2872).
  useSessionChanges(session.id);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previouslyOpenRef = useRef(false);
  const filesSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionFiles");
  const terminalSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionShells");
  const filesHint = runnerCapabilityRequirement(runnerProtocolVersion, "sessionFiles", "session file browsing");
  const terminalHint = runnerCapabilityRequirement(runnerProtocolVersion, "sessionShells", "session terminal access");
  const phone = useIsMobile();
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  // The element the current tool's PanelHeaderActions portal into.
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const wasOpen = previouslyOpenRef.current;
    previouslyOpenRef.current = state.open;
    if (!wasOpen && state.open) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      // A phone's panel covers the session bar whose toggle opened it, so focus moves into the
      // panel's own bar unless the tool already took it (#2843).
      if (phone && !asideRef.current?.contains(document.activeElement)) switcherRef.current?.focus();
      return;
    }
    if (!wasOpen || state.open) return;
    const target = panelReturnFocusTarget(returnFocusRef.current, session.id, document, phone);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, state.open]);

  // Crossing the phone breakpoint with the panel open swaps Close Panel for Back to Session (and on
  // a phone the session bar is not rendered), so focus that fell with a removed control lands on the
  // switcher before the shell's own rescue looks for a page title that is not there.
  const previousPhoneRef = useRef(phone);
  useLayoutEffect(() => {
    if (previousPhoneRef.current === phone) return;
    previousPhoneRef.current = phone;
    const active = document.activeElement;
    if (state.open && (!active || active === document.body)) switcherRef.current?.focus();
  }, [phone, state.open]);

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
  // The drag ceiling as derived state (the rendered width and the separator's ARIA range both
  // re-derive from it): what the 480px rule leaves in the measured row (#2845). The stored width
  // PREFERENCE is left untouched, so a temporary window shrink never clobbers the size the user
  // chose. Same stance as the shell dock's height.
  const ceiling = rightPanelDragCeiling(columnsWidth);
  // Expanded, the panel fills the row in place of the chat column (#2845); phones have no Expand.
  const expanded = state.open && state.expanded && !phone;
  // Every mode docks or overlays by the same rule; a phone's panel is full-screen (styles.css).
  // Expanded, the panel still knows which it would be, so Restore returns there.
  const overlaysAtWidth = !phone && columnsWidth !== null &&
    rightPanelOverlays(columnsWidth, clampRightPanelWidth(state.width, ceiling));
  const overlay = state.open && !expanded && overlaysAtWidth;
  // Only a docked panel has a resize handle.
  const handleShown = !overlay && !expanded;
  // A panel that loses its handle (a window shrinking it into an overlay) ends the drag with it.
  useEffect(() => {
    if (handleShown || !dragRef.current) return;
    dragRef.current = null;
    state.setDragging(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleShown]);
  // Removing the focused handle keeps focus in the panel, on Close Panel, rather than letting it fall
  // to the page.
  useLayoutEffect(() => {
    if (!state.open) resizerFocused.current = false;
    if (handleShown || !resizerFocused.current) return;
    resizerFocused.current = false;
    // Only focus that fell with the handle moves; focus somewhere else stays where it is.
    const active = document.activeElement;
    if (!active || active === document.body) closeRef.current?.focus();
  }, [handleShown, state.open]);
  // Expanded, the panel hides the chat column it shares the row with (#2845). Focus left there (the
  // composer, when the Side Panel chord or a transcript link opened the panel) moves to the switcher
  // rather than staying on a control nobody can see.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    const active = document.activeElement;
    if (!expanded || !aside || !active || aside.contains(active)) return;
    if (aside.parentElement?.contains(active)) switcherRef.current?.focus();
  }, [expanded]);

  // Guard against a mid-drag unmount: closing the panel (shortcut/header button)
  // unmounts the resizer mid-drag and the lostpointercapture never reaches React.
  useEffect(() => {
    if (!state.open) {
      dragRef.current = null;
      state.setDragging(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open]);

  // The tool's own Escape layer, when it has one (`usePanelEscapeLayer`).
  const escapeLayerRef = useRef<(() => void) | null>(null);
  // The tool's own Back on a phone, when it has one (`usePanelBack`).
  const [toolBack, setToolBack] = useState<{ label: string; run: () => void } | null>(null);
  const phoneBackRef = useRef<HTMLButtonElement>(null);
  const backSlot = useMemo<PanelBackSlot>(
    () => ({ phone, set: setToolBack, focus: () => phoneBackRef.current?.focus() }),
    [phone],
  );
  const phoneBack = phone ? toolBack : null;
  /** Escape's step for the panel itself: Restore Panel while expanded, then Close Panel (#2845). */
  const dismiss = expanded ? () => state.setExpanded(false) : state.close;

  // Requests also takes Escape with focus outside the panel, as it always has (#2206); every tool
  // takes it from inside the panel (onPanelKeyDown below).
  useEffect(() => {
    if (!state.open || state.mode !== "requests") return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      // A modal opened from inside this panel (the enlarged evidence image) owns Escape, and an open
      // menu or popover closes first. Both listeners sit on window and this one registered first, so
      // without yielding here it would close the panel out from under the layer and mark the event
      // handled before the layer saw it.
      if (escapeTakenAbovePanel()) return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [state, dismiss]);

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
  const effectiveWidth = clampRightPanelWidth(state.width, ceiling);

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
    state.setWidth(() => resolveRightPanelDrag(d.startWidth, e.clientX - d.startX, ceiling).width);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    state.setDragging(false);
    const r = resolveRightPanelDrag(d.startWidth, e.clientX - d.startX, ceiling);
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
    if (e.key === "ArrowLeft") state.setWidth(() => clampRightPanelWidth(effectiveWidth + RIGHT_PANEL_KEY_STEP, ceiling));
    else if (e.key === "ArrowRight") state.setWidth(() => clampRightPanelWidth(effectiveWidth - RIGHT_PANEL_KEY_STEP, ceiling));
    else if (e.key === "Home") state.setWidth(() => clampRightPanelWidth(RIGHT_PANEL_MAX_WIDTH, ceiling));
    else if (e.key === "End") state.setWidth(() => RIGHT_PANEL_MIN_WIDTH);
    else return;
    e.preventDefault();
  };

  /**
   * Escape closes the panel from any tool while focus is inside it (§16.2; #1260), once nothing
   * above the panel takes it: an open menu, popover or dialog, then whatever the tool itself layers
   * on its body (a selection, a pushed page, an expanded state). Such a tool layer handles Escape
   * first and calls `preventDefault()`, which this respects, or registers itself with
   * `usePanelEscapeLayer` (Review's Select Lines, #2849). An expanded panel restores before it
   * closes (#2845). A terminal keeps Escape for its shell;
   * Ctrl+Esc leaves it first. React delivers this before the shell's window listener, so the session
   * never reads the press as "leave the session".
   */
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest(".xterm")) return;
    if (escapeTakenAbovePanel()) return;
    event.preventDefault();
    const layer = escapeLayerRef.current;
    if (layer) layer();
    else dismiss();
  };

  // The session's own requests are on its request dock (#2179); this panel lists its descendants'.
  // A request's detail has its own "‹ All Requests" inside the body (#2206).
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
            git={git}
            onOpenLocation={onOpenSourceLocation}
            onClearLocation={onClearSourceLocation}
            onAttachWorkspaceReference={onAttachWorkspaceReference}
          />
        ) : (
          // An older runner: the reason the switcher gives the tool, as a compact neutral notice (#2852).
          <Notice tone="neutral" compact role="status">{filesHint}</Notice>
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
            forgeFacts={forgeFacts}
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

  const backgroundAvailable = (session.backgroundJobs?.length ?? 0) > 0 ||
    session.backgroundJobsAvailable === true ||
    session.backgroundWorkTracking != null || session.backgroundWorkState != null;
  const toolContext: SessionToolContext = {
    filesSupported, filesHint, terminalSupported, terminalHint, backgroundAvailable, campaignAvailability,
  };
  const chooseTool = (tool: SessionToolId, keyboard = false) => {
    if (tool === "terminal") {
      onOpenTerminal();
      return;
    }
    // Requests opens the list, never a request left open from an earlier visit.
    if (tool === "requests") onSelectedRequestKeyChange(null);
    state.setMode(tool);
    // Files chosen by keyboard lands in Go to File, as Ctrl/⌘+P does (#2852).
    if (tool === "files" && keyboard && filesSupported) requestGoToFileFocus();
  };

  return (
    <>
      {/* An overlaying or expanded panel has no handle: it keeps the width chosen while docked (#2725,
          #2845). The handle is an 8px strip centred on the panel's edge that takes no room of its
          own; a line shows on hover and focus, and the width shows beside it while dragging (#2843). */}
      {handleShown && <div
        className="rpanel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Panel"
        aria-controls="right-panel"
        aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
        aria-valuemax={ceiling}
        aria-valuenow={effectiveWidth}
        aria-valuetext={`${effectiveWidth} pixels`}
        data-dragging={state.dragging ? "true" : undefined}
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
      >
        {state.dragging && <span className="rpanel-resize-tip" aria-hidden="true">{effectiveWidth}px</span>}
      </div>}
      {/* Where docking would leave the chat column under 480px, every mode opens over the transcript
          from the right, over a scrim a press on which closes the panel as Close Panel does (§15.2;
          #2206, #2725). */}
      {overlay && <div className="rpanel-scrim" aria-hidden="true" onClick={state.close} />}
      {/* Expanded from docked, a spacer holds the panel's docked footprint, so the hidden chat column
          keeps the width it had: its transcript and Pinned Summary are measured as they will be on
          Restore, and expanding or restoring reflows nothing (#2845). */}
      {expanded && !overlaysAtWidth && <div className="rpanel-spacer" aria-hidden="true" style={{ width: effectiveWidth }} />}
      <aside
        ref={asideRef}
        id="right-panel"
        className="rpanel"
        data-mode={state.mode}
        data-presentation={expanded ? "expanded" : overlay ? "overlay" : "docked"}
        style={expanded ? undefined : { width: effectiveWidth }}
        aria-label="Side Panel"
        onKeyDown={onPanelKeyDown}
      >
        {/* One 48px bar in every tool (§4.4): the tool switcher as the title, the tool's actions,
            Expand Panel, then Close Panel. A phone's panel covers the session bar, so its bar leads
            with Back to Session instead and has neither Expand nor Close (#2843, #2845). */}
        <div className="rpanel-head">
          {phone && (
            <button
              ref={phoneBackRef}
              type="button"
              className="icon-btn"
              onClick={phoneBack?.run ?? state.close}
              title={phoneBack?.label ?? "Back to Session"}
              aria-label={phoneBack?.label ?? "Back to Session"}
            >
              <ChevronLeftIcon />
            </button>
          )}
          <ToolSwitcher current={state.mode} context={toolContext} triggerRef={switcherRef} onChoose={chooseTool} />
          <div className="rpanel-actions" ref={setActionSlot} />
          {!phone && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => state.setExpanded(!expanded)}
              title={expanded ? "Restore Panel" : "Expand Panel"}
              aria-label={expanded ? "Restore Panel" : "Expand Panel"}
            >
              {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
            </button>
          )}
          {!phone && (
            <button ref={closeRef} type="button" className="icon-btn" onClick={state.close} title="Close Panel" aria-label="Close Panel">
              <CloseIcon />
            </button>
          )}
        </div>
        <PanelActionSlotContext.Provider value={actionSlot}>
          {state.mode === "launcher" ? (
            <Launcher
              onPick={chooseTool}
              onOpenTerminal={onOpenTerminal}
              filesSupported={filesSupported}
              filesHint={filesHint}
              terminalSupported={terminalSupported}
              terminalHint={terminalHint}
              backgroundAvailable={backgroundAvailable}
              campaignAvailability={campaignAvailability}
            />
          ) : (
            <PanelEscapeLayerContext.Provider value={escapeLayerRef}>
              <PanelBackContext.Provider value={backSlot}>
                <div className="rpanel-body">{modeBody(state.mode)}</div>
              </PanelBackContext.Provider>
            </PanelEscapeLayerContext.Provider>
          )}
        </PanelActionSlotContext.Provider>
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
        hint={BACKGROUND_WORK_UNAVAILABLE}
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
