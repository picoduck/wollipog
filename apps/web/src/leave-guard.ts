import { useEffect, useRef } from "react";
import type { HistoryTraversal } from "./history-position.js";

/**
 * Leaving an editor with unsaved changes (docs/design-system.md §8.6, #3026).
 *
 * An editor whose draft is dirty registers a guard. Every in-app navigation (the store's `navigate`,
 * so a Settings section link, the rail, the palette and a phone's Back to Settings) asks it first:
 * the guard takes over and later calls `leave` to go ahead, or never calls it to stay. Closing or
 * reloading the window gets the browser's own leave prompt instead, because a page cannot show its
 * own dialog there.
 *
 * Browser Back and Forward are asked too (#3218), through `interceptTraversal`: by the time a page
 * hears of them the history position has moved, so the move is undone first, which puts the editor's
 * entry back without dropping any forward entry, and redone only if the person chooses to leave.
 *
 * One guard at a time: there is one editor on screen. A second registration replaces the first.
 */
export type LeaveGuard = (leave: () => void) => void;

let current: LeaveGuard | null = null;

/**
 * Whether a guard took over this navigation. When it did, the caller must not navigate now; the
 * guard calls `leave` if the person chooses to go, and the guard is released first so that call is
 * not asked again.
 */
export function interceptLeave(leave: () => void): boolean {
  const guard = current;
  if (!guard) return false;
  guard(() => {
    if (current === guard) current = null;
    leave();
  });
  return true;
}

/**
 * Whether a guard took over this Back or Forward. When it did, the move is undone, the guard is
 * asked once the editor's entry is current again, and leaving redoes the move. A guard released
 * while the move was undone (a save that finished) is not asked; the move is redone at once.
 */
export function interceptTraversal(traversal: HistoryTraversal): boolean {
  if (!current) return false;
  traversal.undo(() => {
    if (!interceptLeave(() => traversal.redo())) traversal.redo();
  });
  return true;
}

/** Makes `guard` the one that asks, until the returned function releases it. */
export function registerLeaveGuard(guard: LeaveGuard): () => void {
  current = guard;
  return () => { if (current === guard) current = null; };
}

/** Registers `guard` while `active`, with the browser's leave prompt for closing the window. */
export function useLeaveGuard(active: boolean, guard: LeaveGuard): void {
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    if (!active) return;
    const release = registerLeaveGuard((leave) => latest.current(leave));
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only for a non-empty returnValue; the text itself is ignored.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      release();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active]);
}
