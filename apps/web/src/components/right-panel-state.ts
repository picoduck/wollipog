import { useEffect, useRef, useState } from "react";
import { RIGHT_PANEL_DEFAULT_WIDTH, parseStoredRightPanelExpanded, parseStoredRightPanelMode, parseStoredRightPanelWidth, type RightPanelMode } from "../right-panel.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";
import { requestGoToFileFocus } from "./go-to-file-focus.js";
import { requestSideChatFocus } from "./side-chat-focus.js";

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

/**
 * Ctrl/⌘+; (#2862): the panel on Side Chat, with focus in its message field (or Start Side Chat when
 * there is none). Like Go to File it never closes the panel, so a second press only puts focus back.
 */
export function openSideChat(state: Pick<RightPanelState, "show">): void {
  state.show("sidechat");
  requestSideChatFocus();
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
