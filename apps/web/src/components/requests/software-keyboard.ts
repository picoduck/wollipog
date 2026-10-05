import { useSyncExternalStore } from "react";

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

/** The request dock caps lower while the keyboard is open, so the transcript keeps its half (§13.2). */
export function useSoftwareKeyboardOpen(win: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return useSyncExternalStore(
    (listener) => win ? subscribe(win, listener) : () => {},
    () => win ? softwareKeyboardOpen(win) : false,
    () => false,
  );
}
