import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

/** The docked summary's width: `--summary-w` in the stylesheet (docs/design-system.md §4.3, §19.4). */
export const PINNED_SUMMARY_WIDTH_PX = 280;
/** The narrowest reader the docked summary may leave beside it. */
export const PINNED_SUMMARY_READER_MIN_PX = 560;
/** The session body docks the summary from this width. The stylesheet's `session-body` container
 * query uses the same number; styles.test.ts holds them equal. */
export const PINNED_SUMMARY_DOCK_MIN_PX = PINNED_SUMMARY_READER_MIN_PX + PINNED_SUMMARY_WIDTH_PX;

const PREFERENCE_KEY = "wollipog.pinned.open";

/**
 * Where the summary is shown (#2147): a column beside the reader while the reader keeps 560px after
 * it, otherwise a drawer over the reader, and on a phone a bottom sheet.
 */
export type PinnedSummaryPresentation = "docked" | "drawer" | "sheet";

/** A body that has not been measured yet (no layout, or not mounted) docks, as before it existed. */
export function pinnedSummaryPresentation(phone: boolean, dockable: boolean | null): PinnedSummaryPresentation {
  if (phone) return "sheet";
  return dockable === false ? "drawer" : "docked";
}

export function pinnedSummaryDockable(bodyWidth: number): boolean {
  return bodyWidth >= PINNED_SUMMARY_DOCK_MIN_PX;
}

/**
 * The summary's app-level state. It lives in App.tsx beside the toggle in the session bar, like the
 * right panel's. Only the docked column reads and writes the stored preference; the drawer and the
 * sheet always start closed, are never persisted, and close whenever the presentation changes, so
 * loading or resizing at any width is deterministic.
 */
export interface PinnedSummaryState {
  presentation: PinnedSummaryPresentation;
  /** Shown in the current presentation: the preference while docked, else the transient overlay. */
  open: boolean;
  toggle: () => void;
  /** Close the drawer or the sheet. The docked preference is unchanged. */
  closeOverlay: () => void;
  /** The session body reports its width, so docking follows the column, not the viewport. */
  reportBodyWidth: (width: number) => void;
  /** The session bar's toggle; focus returns to it when the drawer closes. */
  toggleRef: RefObject<HTMLButtonElement | null>;
}

export function usePinnedSummaryState(
  phone: boolean,
  { onOverlayOpen }: { onOverlayOpen?: () => void } = {},
): PinnedSummaryState {
  const [preference, setPreference] = useState(() => {
    try {
      return loadBrowserStorageValue(PREFERENCE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      saveBrowserStorageValue(PREFERENCE_KEY, preference ? "1" : "0");
    } catch {
      /* best-effort */
    }
  }, [preference]);
  const [dockable, setDockable] = useState<boolean | null>(null);
  // The presentation the overlay was opened in. Comparing it with the current one closes the
  // overlay in the same render that changes presentation; the effect below then forgets it, so
  // drawer → sheet → drawer does not reopen it.
  const [overlayFor, setOverlayFor] = useState<PinnedSummaryPresentation | null>(null);
  const presentation = pinnedSummaryPresentation(phone, dockable);
  useEffect(() => setOverlayFor(null), [presentation]);
  const open = presentation === "docked" ? preference : overlayFor === presentation;
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const onOverlayOpenRef = useRef(onOverlayOpen);
  onOverlayOpenRef.current = onOverlayOpen;

  const closeOverlay = useCallback(() => setOverlayFor(null), []);
  const reportBodyWidth = useCallback((width: number) => setDockable(pinnedSummaryDockable(width)), []);

  return useMemo(() => ({
    presentation,
    open,
    toggle: () => {
      if (presentation === "docked") {
        setPreference((value) => !value);
        return;
      }
      setOverlayFor(open ? null : presentation);
      if (!open) onOverlayOpenRef.current?.();
    },
    closeOverlay,
    reportBodyWidth,
    toggleRef,
  }), [presentation, open, closeOverlay, reportBodyWidth]);
}

/**
 * A summary held docked and open or closed, with no toggle and no measuring: for hosts that mount
 * SessionDetail without the app shell (tests and browser fixtures).
 */
export function staticPinnedSummary(open: boolean): PinnedSummaryState {
  return {
    presentation: "docked",
    open,
    toggle: () => undefined,
    closeOverlay: () => undefined,
    reportBodyWidth: () => undefined,
    toggleRef: { current: null },
  };
}
