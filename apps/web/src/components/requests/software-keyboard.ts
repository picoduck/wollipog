import { useCallback, useSyncExternalStore } from "react";

/**
 * How far the visual viewport must be shorter than the layout viewport before it reads as a software
 * keyboard rather than a browser toolbar moving (the same scale as `mobile-viewport.ts`'s 100px).
 */
export const SOFTWARE_KEYBOARD_MIN_PX = 100;

/** Whether a software keyboard covers part of the layout viewport: the visual viewport is shorter. */
export function softwareKeyboardOpen(win: Pick<Window, "innerHeight" | "visualViewport">): boolean {
  const viewport = win.visualViewport;
  return viewport != null && win.innerHeight - viewport.height > SOFTWARE_KEYBOARD_MIN_PX;
}

function subscribe(win: Window, listener: () => void): () => void {
  const viewport = win.visualViewport;
  viewport?.addEventListener("resize", listener);
  win.addEventListener("resize", listener);
  return () => {
    viewport?.removeEventListener("resize", listener);
    win.removeEventListener("resize", listener);
  };
}

/** The request dock caps lower while the keyboard is open, so the transcript keeps its half (§13.2).
 * The session view re-renders on every streamed event, so the subscription keeps one identity per
 * window: a new one would remove and re-add both listeners on every render (#2797). */
export function useSoftwareKeyboardOpen(win: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  const subscribeToWindow = useCallback((listener: () => void) => win ? subscribe(win, listener) : () => {}, [win]);
  const getSnapshot = useCallback(() => win ? softwareKeyboardOpen(win) : false, [win]);
  return useSyncExternalStore(subscribeToWindow, getSnapshot, () => false);
}
