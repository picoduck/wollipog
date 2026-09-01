import { useEffect } from "react";
import { focusZoneForElement } from "./focus-zones.js";
import { inTypingContext, matchesShortcut, shortcutLayerActive, type ShortcutId } from "./shortcuts.js";

export interface InboxKeyActions {
  next: () => void;
  previous: () => void;
  expand: () => void;
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
  // These explicitly own both Inbox list and detail zones: End resumes the preview transcript
  // rather than scrolling the session grid, matching the visible follow shortcut.
  ["inbox-follow-latest", "resumeFollow"],
  ["inbox-follow-latest-end", "resumeFollow"],
];

/** The sole Inbox keyboard listener. Rows, tabs, and the preview expose mouse paths only. */
export function useInboxKeys(enabled: boolean, actions: InboxKeyActions): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document) || inTypingContext(document)) return;
      const active = document.activeElement;
      const zone = active instanceof Element ? focusZoneForElement(active) : null;
      if (zone !== null && zone !== "list" && zone !== "detail") return;
      if (active instanceof HTMLElement &&
          active.matches('button, a[href], input, textarea, select, [role="button"], [role="radio"], [role="checkbox"]') &&
          !active.matches(".inbox-list")) return;
      for (const [shortcutId, action] of BINDINGS) {
        if (!matchesShortcut(event, shortcutId)) continue;
        if (action === "fork" && zone !== "list" && zone !== "detail") return;
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
