/**
 * Pure sizing + mode logic for the side panel (#2843: a docked, flush column hosting every session
 * tool). The React wiring
 * (pointer capture, localStorage, shortcuts) lives in App.tsx / RightPanel.tsx;
 * everything that can be unit-tested without a DOM lives here.
 */

export const RIGHT_PANEL_DEFAULT_WIDTH = 400;
/** A stored width under this is clamped up on load (#2843). */
export const RIGHT_PANEL_MIN_WIDTH = 320;
export const RIGHT_PANEL_MAX_WIDTH = 640;
/** Dragging narrower than this snaps the panel closed instead of pinning it at the minimum. */
export const RIGHT_PANEL_SNAP_CLOSE_WIDTH = 240;

/** Keyboard resize step for the separator's arrow keys. */
export const RIGHT_PANEL_KEY_STEP = 16;

/**
 * Panel contents. "launcher" is the empty state listing the other modes. Every entry here owns a
 * body in RightPanel.tsx; the terminal lives in the bottom dock, so there is deliberately no
 * "terminal" panel mode to restore into an empty column.
 */
export const RIGHT_PANEL_MODES = ["launcher", "requests", "campaign", "review", "files", "browser", "sidechat", "subagents", "background", "decisions"] as const;
export type RightPanelMode = (typeof RIGHT_PANEL_MODES)[number];

/** The least room the chat column keeps beside a docked panel (§15.2); with less the panel overlays. */
export const RIGHT_PANEL_CHAT_MIN_WIDTH = 480;

/**
 * Whether the panel opens over the transcript rather than docking beside it (§15.2; #2725): when
 * docking it would leave the chat column under 480px. `columnsWidth` is the row the chat column and
 * the panel share, so the rail (labelled or not) and the panel's own width both count. The resize
 * handle straddles the panel's edge and takes no room of its own (#2843). Every mode answers the
 * same way at the same width; phones keep their full-screen panel.
 */
export function rightPanelOverlays(columnsWidth: number, panelWidth: number): boolean {
  return columnsWidth - panelWidth < RIGHT_PANEL_CHAT_MIN_WIDTH;
}

/**
 * The room the drag ceiling keeps beside the chat column's 480px for the resize handle (#2845).
 * Since #2843 the 8px handle straddles the panel's edge and takes no room, so this is a margin: a
 * drag stops 10px short of the width at which the panel would overlay.
 */
export const RIGHT_PANEL_HANDLE_ROOM = 10;

/**
 * The widest the panel may be dragged in a row of `columnsWidth` (#2845): what §15.2's 480px rule
 * leaves, `row − 480 − 10`, never above 640px (wider work uses Expand Panel) nor under 320px. So a
 * drag never turns the panel into an overlay; only a row too narrow for even 320px does. A row not
 * yet measured has no ceiling but the 640px maximum.
 */
export function rightPanelDragCeiling(columnsWidth: number | null): number {
  if (columnsWidth === null) return RIGHT_PANEL_MAX_WIDTH;
  const room = columnsWidth - RIGHT_PANEL_CHAT_MIN_WIDTH - RIGHT_PANEL_HANDLE_ROOM;
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, Math.floor(room)));
}

/** Clamp a panel width. `max` lets callers pass the row-aware ceiling (`rightPanelDragCeiling`) so
 * the panel can never squeeze the transcript + composer under its 480px; it is itself floored at
 * RIGHT_PANEL_MIN_WIDTH so a tiny window can't invert the bounds (same stance as the shell dock's
 * height clamp). */
export function clampRightPanelWidth(width: number, max = RIGHT_PANEL_MAX_WIDTH): number {
  const ceiling = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, max));
  return Math.min(ceiling, Math.max(RIGHT_PANEL_MIN_WIDTH, width));
}

/**
 * Parse a persisted width. Garbage (missing key, corrupt edits, NaN, Infinity) falls
 * back to the default so a bad localStorage value can never wedge the panel at an
 * unusable width with no UI to recover.
 */
export function parseStoredRightPanelWidth(raw: string | null): number {
  // Number("") is 0, not NaN — treat blank the same as missing.
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return RIGHT_PANEL_DEFAULT_WIDTH;
  return clampRightPanelWidth(n);
}

/**
 * Parse the persisted Expanded state (#2845, `wollipog.rightpanel.expanded`). Only the "1" this
 * build writes expands; anything else, a missing key included, restores the docked panel.
 */
export function parseStoredRightPanelExpanded(raw: string | null): boolean {
  return raw === "1";
}

/**
 * Parse a persisted mode. Requests are session-scoped and may disappear while the panel is
 * closed or the browser is reloading, so they are restored through the stable launcher rather
 * than poisoning the generic toggle with a transient destination. Values this build no longer
 * knows — including "terminal", which older builds could persist — fall back the same way, so a
 * stale preference can never restore a panel with nothing in it.
 */
export function parseStoredRightPanelMode(raw: string | null): RightPanelMode {
  // Decision History was "governance" before #2213; a stored preference keeps opening it.
  if (raw === "governance") return "decisions";
  return raw !== "requests" && (RIGHT_PANEL_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as RightPanelMode)
    : "launcher";
}

/**
 * Resolve a drag gesture on the panel's LEFT-edge handle: moving the pointer left
 * (negative dx) grows the panel. Callers apply the clamped width live during the
 * drag and act on `collapse` when the pointer is released.
 */
export function resolveRightPanelDrag(
  startWidth: number,
  dx: number,
  max = RIGHT_PANEL_MAX_WIDTH,
): { collapse: boolean; width: number } {
  const raw = startWidth - dx;
  return { collapse: raw < RIGHT_PANEL_SNAP_CLOSE_WIDTH, width: clampRightPanelWidth(raw, max) };
}
