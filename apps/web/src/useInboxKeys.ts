import { useEffect } from "react";
import { focusZoneForElement } from "./focus-zones.js";
import { inTypingContext, matchesShortcut, shortcutLayerActive, type ShortcutId } from "./shortcuts.js";

export interface InboxKeyActions {
  next: () => void;
  previous: () => void;
  first: () => void;
  last: () => void;
  expand: () => void;
  /** F2: open the selected session with its top-priority request focused (#896). */
  openTopRequest: () => void;
  toggleThread: () => void;
  toggleAllThreads: () => void;
  goToParent: () => void;
  expandThread: () => void;
  collapseThread: () => void;
  fork: () => void;
  nextSplit: () => void;
  previousSplit: () => void;
  approve: () => void;
  deny: () => void;
  archive: () => void;
  snooze: () => void;
  pin: () => void;
  unread: () => void;
  reply: () => void;
  pageDown: () => void;
  pageUp: () => void;
  /** Returns false when no preview surface is registered and the browser should retain the key. */
  resumeFollow: () => boolean;
}

const BINDINGS: ReadonlyArray<[ShortcutId, keyof InboxKeyActions]> = [
  ["inbox-next", "next"],
  ["inbox-previous", "previous"],
  ["inbox-expand", "expand"],
  ["inbox-open-top-request", "openTopRequest"],
  ["inbox-toggle-thread", "toggleThread"],
  ["inbox-toggle-all-threads", "toggleAllThreads"],
  ["inbox-go-to-parent", "goToParent"],
  ["inbox-expand-thread", "expandThread"],
  ["inbox-collapse-thread", "collapseThread"],
  ["inbox-fork", "fork"],
  ["inbox-next-split", "nextSplit"],
  ["inbox-previous-split", "previousSplit"],
  ["inbox-approve", "approve"],
  ["inbox-deny", "deny"],
  ["inbox-archive", "archive"],
  ["inbox-snooze", "snooze"],
  ["inbox-pin", "pin"],
  ["inbox-unread", "unread"],
  ["inbox-reply", "reply"],
  ["inbox-page-down", "pageDown"],
  ["inbox-page-up", "pageUp"],
  // Preview End remains available from the reading pane. The focused Sessions grid handles End
  // earlier as conventional last-row navigation, alongside ArrowUp/ArrowDown and Home.
  ["inbox-follow-latest", "resumeFollow"],
  ["inbox-follow-latest-end", "resumeFollow"],
];

/** The sole Inbox keyboard listener. Rows, tabs, and the preview expose mouse paths only. */
export function useInboxKeys(enabled: boolean, actions: InboxKeyActions): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document, false, event) || inTypingContext(document)) return;
      const active = document.activeElement;
      const zone = active instanceof Element ? focusZoneForElement(active) : null;
      if (zone !== null && zone !== "list" && zone !== "main") return;
      if (active instanceof HTMLElement &&
          active.matches('button, summary, a[href], input, textarea, select, [role="button"], [role="radio"], [role="checkbox"]') &&
          !active.matches(".inbox-list")) return;
      if (active instanceof HTMLElement && active.matches(".inbox-list")) {
        const action = matchesShortcut(event, "inbox-grid-next") ? actions.next
          : matchesShortcut(event, "inbox-grid-previous") ? actions.previous
          : matchesShortcut(event, "inbox-grid-first") ? actions.first
          : matchesShortcut(event, "inbox-follow-latest-end") ? actions.last
          : null;
        if (action) {
          event.preventDefault();
          action();
          return;
        }
      }
      for (const [shortcutId, action] of BINDINGS) {
        if (!matchesShortcut(event, shortcutId)) continue;
        // Fork acts on the Sessions list or reading pane, not on the page header around them.
        if (action === "fork" && !(active instanceof Element && active.closest(".inbox-view"))) return;
        // Tab and Shift+Tab switch groups from the list only (#2180); in the preview they move focus,
        // so Shift+Tab walks back through it to the list's divider (#2217).
        if ((action === "nextSplit" || action === "previousSplit") && zone === "main") return;
        if (action === "resumeFollow") {
          if (!actions.resumeFollow()) return;
          event.preventDefault();
          return;
        }
        event.preventDefault();
        actions[action]();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, enabled]);
}
