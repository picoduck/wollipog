import { INBOX_SPLIT_RATIO_DEFAULT, INBOX_SPLIT_RATIO_MAX, INBOX_SPLIT_RATIO_MIN } from "./inbox.js";

/**
 * The stacked Sessions list and preview (docs/design-system.md §6.3, #2217). The list's height is
 * the stored ratio of the split area rounded down to whole `--row-h-2` rows plus the list's top pad,
 * never under three rows and never so tall that the preview drops under 240px, so the divider never
 * cuts a row.
 */
export const SESSIONS_LIST_MIN_ROWS = 3;
export const SESSIONS_PREVIEW_MIN_PX = 240;

export interface SessionsSplitGeometry {
  /** The split area's height: the list, the divider's hairline and the preview. */
  area: number;
  /** One list row: `--row-h-2`, which density and a coarse pointer change. */
  rowHeight: number;
  /** The list's top pad above its first row. */
  pad: number;
}

/**
 * The list's row count bounds. The stored ratio's own 25–75% range bounds them too, so every count
 * in range survives a reload: in a tall split area Home stops at the 25% floor's rows and End at the
 * 75% cap's. A window too short for both keeps the three rows.
 */
export function sessionsListRowRange({ area, rowHeight, pad }: SessionsSplitGeometry): { min: number; max: number } {
  if (!(area > 0) || !(rowHeight > 0)) return { min: SESSIONS_LIST_MIN_ROWS, max: SESSIONS_LIST_MIN_ROWS };
  // The epsilon keeps an exact fit from rounding down a row through floating-point error.
  const rowsIn = (height: number) => Math.floor((height - pad) / rowHeight + 1e-6);
  const min = Math.max(SESSIONS_LIST_MIN_ROWS, rowsIn(INBOX_SPLIT_RATIO_MIN * area));
  const max = Math.min(rowsIn(area - SESSIONS_PREVIEW_MIN_PX), rowsIn(INBOX_SPLIT_RATIO_MAX * area));
  return { min, max: Math.max(min, max) };
}

function clampRows(rows: number, geometry: SessionsSplitGeometry): number {
  const { min, max } = sessionsListRowRange(geometry);
  return Math.min(max, Math.max(min, rows));
}

/** Whole rows for a stored ratio, rounded down. */
export function sessionsListRowsForRatio(ratio: number, geometry: SessionsSplitGeometry): number {
  const { area, rowHeight, pad } = geometry;
  if (!(area > 0) || !(rowHeight > 0)) return SESSIONS_LIST_MIN_ROWS;
  // The epsilon keeps an exact fit from rounding down a row through floating-point error.
  return clampRows(Math.floor((ratio * area - pad) / rowHeight + 1e-6), geometry);
}

/** Whole rows for a dragged list height, snapped to the nearer row. */
export function sessionsListRowsForHeight(height: number, geometry: SessionsSplitGeometry): number {
  if (!(geometry.rowHeight > 0)) return SESSIONS_LIST_MIN_ROWS;
  return clampRows(Math.round((height - geometry.pad) / geometry.rowHeight), geometry);
}

export function sessionsListHeight(rows: number, { rowHeight, pad }: SessionsSplitGeometry): number {
  return pad + rows * rowHeight;
}

/**
 * The ratio to store for a row count. It names the middle of that row, so rounding it back down
 * gives the same count after a reload, and a slightly different window keeps the nearest count.
 */
export function sessionsRatioForRows(rows: number, { area, rowHeight, pad }: SessionsSplitGeometry): number {
  if (!(area > 0)) return INBOX_SPLIT_RATIO_DEFAULT;
  return (pad + (rows + 0.5) * rowHeight) / area;
}

/** The list's share of the split area in whole percent, for the divider's `aria-value*`. */
export function sessionsListPercent(height: number, { area }: SessionsSplitGeometry): number {
  return area > 0 ? Math.round((height / area) * 100) : 0;
}

/** Measure the split area and read the row and pad tokens it resolves. */
export function readSessionsSplitGeometry(element: HTMLElement): SessionsSplitGeometry {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const token = (name: string, fallback: number) => {
    const value = Number.parseFloat(style?.getPropertyValue(name) ?? "");
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { area: element.clientHeight, rowHeight: token("--row-h-2", 56), pad: token("--space-2", 8) };
}
