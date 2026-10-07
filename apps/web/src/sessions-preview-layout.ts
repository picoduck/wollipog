import { LOCAL_INSTANCE_SCOPE, loadInstanceStorageValue, saveInstanceStorageValue } from "./instance-storage.js";

/**
 * Where the Sessions preview sits (docs/design-system.md §6.3, #2219): below the list, the default,
 * or beside it as **Preview Right**. A per-device, per-instance preference that is never synced to
 * the account. Preview Right applies only in windows 1100px and wider; narrower windows stack
 * whatever is stored, and the stored value applies again when the window widens.
 */
export type SessionsPreviewLayout = "below" | "right";

export const SESSIONS_PREVIEW_LAYOUT_KEY = "wollipog.sessions.previewLayout";

/** Preview Right's list column (§6): 400px by default, resized within 280–440px in 16px key steps. */
export const SESSIONS_LIST_WIDTH_KEY = "wollipog.sessions.listWidth";
export const SESSIONS_LIST_WIDTH_DEFAULT = 400;
export const SESSIONS_LIST_WIDTH_MIN = 280;
export const SESSIONS_LIST_WIDTH_MAX = 440;
export const SESSIONS_LIST_WIDTH_STEP = 16;

export function loadSessionsPreviewLayout(instanceScope = LOCAL_INSTANCE_SCOPE): SessionsPreviewLayout {
  return loadInstanceStorageValue(SESSIONS_PREVIEW_LAYOUT_KEY, instanceScope) === "right" ? "right" : "below";
}

/** Whole pixels within the column's range; anything unreadable is the default. */
export function clampSessionsListWidth(width: number): number {
  if (!Number.isFinite(width)) return SESSIONS_LIST_WIDTH_DEFAULT;
  return Math.min(SESSIONS_LIST_WIDTH_MAX, Math.max(SESSIONS_LIST_WIDTH_MIN, Math.round(width)));
}

export function loadSessionsListWidth(instanceScope = LOCAL_INSTANCE_SCOPE): number {
  const stored = loadInstanceStorageValue(SESSIONS_LIST_WIDTH_KEY, instanceScope);
  return stored === null ? SESSIONS_LIST_WIDTH_DEFAULT : clampSessionsListWidth(Number(stored));
}

export function saveSessionsListWidth(width: number, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  saveInstanceStorageValue(SESSIONS_LIST_WIDTH_KEY, String(clampSessionsListWidth(width)), instanceScope);
}

/* -------- Module store: the header control and the Settings row update each other live -------- */

const layoutByScope = new Map<string, SessionsPreviewLayout>();
const listeners = new Set<() => void>();

export function getSessionsPreviewLayout(instanceScope = LOCAL_INSTANCE_SCOPE): SessionsPreviewLayout {
  const cached = layoutByScope.get(instanceScope);
  if (cached) return cached;
  const loaded = loadSessionsPreviewLayout(instanceScope);
  layoutByScope.set(instanceScope, loaded);
  return loaded;
}

export function setSessionsPreviewLayout(layout: SessionsPreviewLayout, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  if (getSessionsPreviewLayout(instanceScope) === layout) return;
  layoutByScope.set(instanceScope, layout);
  // Best-effort like every other preference: the in-memory value still wins for this page's
  // lifetime when private mode rejects the write.
  saveInstanceStorageValue(SESSIONS_PREVIEW_LAYOUT_KEY, layout, instanceScope);
  for (const listener of listeners) listener();
}

export function subscribeSessionsPreviewLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget cached layouts so a fresh get() re-reads storage. */
export function resetSessionsPreviewLayoutForTest(): void {
  layoutByScope.clear();
}
