import { useSyncExternalStore } from "react";

/**
 * Where THIS device shows the terminal (docs/design-system.md §4.6, #2867): the bottom dock under
 * the composer, or the right panel's Terminal tool. Hosts render the same session terminals either
 * way (`useSessionTerminals`), so moving never restarts a running shell.
 *
 * Stored per device (localStorage). An unset or unreadable value means the bottom dock, which is
 * also the default: nothing is written until someone chooses. The side panel's Terminal tool (#2868)
 * reads this; Move to Right Panel, Move to Bottom Dock and the Settings row (#2869) write it.
 */
export type TerminalPlacement = "dock" | "panel";

export const TERMINAL_PLACEMENT_STORAGE_KEY = "wollipog.terminal.placement";

/** Same-tab writes never fire the browser's `storage` event, so the setter announces its own. */
const TERMINAL_PLACEMENT_CHANGE_EVENT = "wollipog:terminal-placement-change";

/**
 * The page-lifetime home of a choice storage refused to keep (private mode, quota, sandboxing).
 * Cleared by the next successful write, so it can never shadow a value another tab stored.
 */
const unstorableChoice = new WeakMap<Window, TerminalPlacement>();

export function terminalPlacement(win: Window = window): TerminalPlacement {
  const remembered = unstorableChoice.get(win);
  if (remembered) return remembered;
  try {
    return win.localStorage.getItem(TERMINAL_PLACEMENT_STORAGE_KEY) === "panel" ? "panel" : "dock";
  } catch {
    return "dock";
  }
}

export function setTerminalPlacement(value: TerminalPlacement, win: Window = window): void {
  try {
    win.localStorage.setItem(TERMINAL_PLACEMENT_STORAGE_KEY, value);
    unstorableChoice.delete(win);
  } catch {
    // The choice still governs this page for its lifetime; only persistence is lost.
    unstorableChoice.set(win, value);
  }
  win.dispatchEvent(new Event(TERMINAL_PLACEMENT_CHANGE_EVENT));
}

function subscribeToPlacement(onChange: () => void): () => void {
  window.addEventListener(TERMINAL_PLACEMENT_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(TERMINAL_PLACEMENT_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The live placement: follows the setter in this tab and other tabs' writes through `storage`. */
export function useTerminalPlacement(): TerminalPlacement {
  return useSyncExternalStore(subscribeToPlacement, () => terminalPlacement());
}
