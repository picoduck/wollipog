import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { SessionNoticeSlot, type SessionNoticeEntry } from "./SessionNoticeSlot.js";

/**
 * Where the side panel's notice slot goes: directly under the panel header, above the tool's body
 * and above a pushed page alike. Only RightPanel provides it (and tests). `focusHead` takes focus
 * when the slot is gone while it held focus.
 */
export const PanelNoticeRegionContext = createContext<{ element: HTMLElement; focusHead: () => void } | null>(null);

/**
 * The side panel's one notice slot (docs/design-system.md §4.9, §13.2; #2856): a panel instance of
 * `SessionNoticeSlot`, so a tool shows one notice and the rest behind "+N More" exactly as the
 * session slot does, rather than stacking status sentences between its filter and its list. A tool
 * renders it anywhere in its body (outside the part it hides while a page is pushed) with the
 * entries that apply to what it shows; they take ranks from `PANEL_NOTICE_RANK`. Outside the side
 * panel it renders in place.
 */
export function PanelNoticeSlot({ sessionId, entries }: {
  /** Whose info dismissals these are; kept apart from the session slot's. */
  sessionId: string;
  entries: readonly SessionNoticeEntry[];
}) {
  const region = useContext(PanelNoticeRegionContext);
  const slot = (
    <SessionNoticeSlot
      sessionId={`panel:${sessionId}`}
      entries={entries}
      label="Panel Notices"
      className="panel-notice-slot"
      onFocusLost={region?.focusHead}
    />
  );
  return region ? createPortal(slot, region.element) : slot;
}
