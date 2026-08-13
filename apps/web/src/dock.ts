/**
 * Pure sizing logic for the bottom shell dock. The
 * React wiring (pointer capture, localStorage) lives in ShellDock.tsx; everything that can be
 * unit-tested without a DOM lives here.
 */

export const DOCK_DEFAULT_HEIGHT = 280;
export const DOCK_MIN_HEIGHT = 120;
export const DOCK_MAX_HEIGHT = 640;
/** Dragging shorter than this snaps the dock closed instead of pinning it at the minimum. */
export const DOCK_SNAP_CLOSE_HEIGHT = 80;

/** Clamp a dock height. `max` lets callers pass a viewport-aware ceiling (e.g. 60% of the
 * window height) so no height path — stored, dragged, or keyboard — can crush the transcript
 * and composer on a short window; it is itself floored at DOCK_MIN_HEIGHT so a tiny window
 * can't invert the bounds. */
export function clampDockHeight(height: number, max = DOCK_MAX_HEIGHT): number {
  const ceiling = Math.max(DOCK_MIN_HEIGHT, Math.min(DOCK_MAX_HEIGHT, max));
  return Math.min(ceiling, Math.max(DOCK_MIN_HEIGHT, height));
}

/** Parse a persisted height; garbage falls back to the default so corrupt localStorage cannot
 * wedge the dock at an unusable size. */
export function parseStoredHeight(raw: string | null, max = DOCK_MAX_HEIGHT): number {
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw); // Number("") is 0, not NaN
  if (!Number.isFinite(n)) return clampDockHeight(DOCK_DEFAULT_HEIGHT, max);
  return clampDockHeight(n, max);
}

/**
 * Parse the dock's visibility pref. The dock is toggled from the topbar (Ctrl+`) and starts
 * HIDDEN by default (Codex layout — no always-visible bar). Migration: users who had the
 * legacy always-mounted dock explicitly EXPANDED (`wollipog.shelldock.collapsed` === "0") keep it
 * visible on first run; default-collapsed, missing, or garbage values start hidden.
 */
export function parseStoredDockVisible(raw: string | null, legacyCollapsed: string | null): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return legacyCollapsed === "0";
}

/** Resolve a drag gesture on the dock's TOP edge: dy is pointer movement (down = positive =
 * shrink). Callers apply the clamped height live and act on `collapse` at release. */
export function resolveDockDrag(
  startHeight: number,
  dy: number,
  max = DOCK_MAX_HEIGHT,
): { collapse: boolean; height: number } {
  const raw = startHeight - dy; // dragging up grows the dock
  return { collapse: raw < DOCK_SNAP_CLOSE_HEIGHT, height: clampDockHeight(raw, max) };
}
