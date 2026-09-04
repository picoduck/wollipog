/**
 * Pure sizing + mode logic for the right side panel ( a toggleable
 * column hosting Review / Terminal / Browser / Files / Side chat). The React wiring
 * (pointer capture, localStorage, shortcuts) lives in App.tsx / RightPanel.tsx;
 * everything that can be unit-tested without a DOM lives here.
 */

export const RIGHT_PANEL_DEFAULT_WIDTH = 380;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 640;
/** Dragging narrower than this snaps the panel closed instead of pinning it at the minimum. */
export const RIGHT_PANEL_SNAP_CLOSE_WIDTH = 240;

/** Keyboard resize step for the separator's arrow keys. */
export const RIGHT_PANEL_KEY_STEP = 16;

/** Panel contents. "launcher" is the empty state listing the other modes. */
export const RIGHT_PANEL_MODES = ["launcher", "review", "files", "terminal", "browser", "sidechat", "subagents", "background"] as const;
export type RightPanelMode = (typeof RIGHT_PANEL_MODES)[number];

/** Clamp a panel width. `max` lets callers pass a viewport-aware ceiling (e.g. 40% of the
 * window width) so the panel can never squeeze the transcript + composer into a sliver on a
 * narrow window; it is itself floored at RIGHT_PANEL_MIN_WIDTH so a tiny window can't invert
 * the bounds (same stance as the shell dock's height clamp). */
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

/** Parse a persisted mode; anything unknown falls back to the launcher. */
export function parseStoredRightPanelMode(raw: string | null): RightPanelMode {
  return (RIGHT_PANEL_MODES as readonly string[]).includes(raw ?? "") ? (raw as RightPanelMode) : "launcher";
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
