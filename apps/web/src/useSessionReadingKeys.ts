import { useEffect, useRef, type RefObject } from "react";
import { shortcutScopeForFocus } from "./focus-zones.js";
import { dispatchVirtualViewportIntent } from "./viewport-intent.js";
import {
  advanceShortcutSequence,
  matchesShortcut,
  shortcut,
  shortcutLayerActive,
  type ShortcutId,
  type ShortcutSequenceState,
} from "./shortcuts.js";

export const SESSION_READING_LINE_PX = 40;
export const SESSION_READING_PAGE_FRACTION = 0.9;

export interface SessionReadingKeyActions {
  nextSession: () => void;
  previousSession: () => void;
  approve: () => void;
  deny: () => void;
  archive: () => void;
  snooze: () => void;
  reply: () => void;
  pauseFollow: () => void;
  resumeFollow: () => void;
}

export interface SessionReadingKeyOptions {
  enabled: boolean;
  /** Resets an incomplete sequence whenever the mounted session changes. */
  sessionId: string | null;
  /** The mounted transcript viewport. Scrolling shortcuts never query the document for it. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Prevents the Reader-to-Composer Tab bridge from trapping focus on a disabled composer. */
  composerAvailable?: boolean;
  actions: SessionReadingKeyActions;
}

const ACTION_BINDINGS: ReadonlyArray<[
  ShortcutId,
  Exclude<keyof SessionReadingKeyActions, "pauseFollow" | "resumeFollow">
]> = [
  ["session-reading-next-session", "nextSession"],
  ["session-reading-previous-session", "previousSession"],
  ["session-reading-approve", "approve"],
  ["session-reading-deny", "deny"],
  ["session-reading-archive", "archive"],
  ["session-reading-snooze", "snooze"],
  ["session-reading-reply", "reply"],
];

function xtermOwnsFocus(targetDocument: Document): boolean {
  const active = targetDocument.activeElement;
  return active instanceof Element && Boolean(active.closest(".xterm"));
}

function nativeControlOwnsFocus(targetDocument: Document): boolean {
  const active = targetDocument.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  // Text inputs deliberately remain eligible for modifier bindings (Ctrl+J/K); bare bindings
  // are rejected by matchesShortcut's typing-context guard. Other controls keep all keys.
  return active.matches(
    'button, a[href], select, [role="button"], [role="link"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"]',
  );
}

function scrollBy(scroll: HTMLElement | null, top: number): void {
  if (!scroll) return;
  dispatchVirtualViewportIntent(scroll);
  scroll.scrollBy({ top });
}

function scrollTo(scroll: HTMLElement | null, top: number): void {
  if (!scroll) return;
  dispatchVirtualViewportIntent(scroll);
  scroll.scrollTo({ top });
}

/**
 * The sole Session Reading keyboard listener. Capture phase intentionally lets this contextual
 * scope shadow global Ctrl+K search before the global bubble listener observes the event.
 */
export function useSessionReadingKeys({
  enabled,
  sessionId,
  scrollRef,
  composerAvailable = true,
  actions,
}: SessionReadingKeyOptions): void {
  const sequenceRef = useRef<ShortcutSequenceState | null>(null);

  useEffect(() => {
    sequenceRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) {
      sequenceRef.current = null;
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document) || xtermOwnsFocus(document)) {
        sequenceRef.current = null;
        return;
      }
      if (event.isComposing) {
        sequenceRef.current = null;
        return;
      }
      const active = document.activeElement;
      if (shortcutScopeForFocus({
        viewName: "session",
        activeElement: active,
        sessionReading: true,
      }) !== "Session Reading" || nativeControlOwnsFocus(document)) {
        sequenceRef.current = null;
        return;
      }

      const sequence = shortcut("session-reading-start").binding.sequence ?? [];
      const isSequenceKey = event.key.toLowerCase() === sequence[0]?.toLowerCase() &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.repeat && isSequenceKey) {
        sequenceRef.current = null;
        return;
      }
      if (sequenceRef.current || isSequenceKey) {
        const result = advanceShortcutSequence(
          event,
          sequence,
          sequenceRef.current,
          performance.now(),
          document,
        );
        sequenceRef.current = result.state;
        if (result.matched) {
          event.preventDefault();
          actions.pauseFollow();
          scrollTo(scrollRef.current, 0);
          return;
        }
        // A first g is intentionally invisible. A mismatch continues through so the mismatching
        // key can still perform its own reading action (for example, g then j scrolls one line).
        if (isSequenceKey) return;
      }

      if (matchesShortcut(event, "session-reading-line-down")) {
        event.preventDefault();
        scrollBy(scrollRef.current, SESSION_READING_LINE_PX);
        return;
      }
      if (matchesShortcut(event, "session-reading-line-up")) {
        event.preventDefault();
        actions.pauseFollow();
        scrollBy(scrollRef.current, -SESSION_READING_LINE_PX);
        return;
      }
      if (matchesShortcut(event, "session-reading-page-down")) {
        event.preventDefault();
        scrollBy(scrollRef.current, (scrollRef.current?.clientHeight ?? 0) * SESSION_READING_PAGE_FRACTION);
        return;
      }
      if (matchesShortcut(event, "session-reading-page-up")) {
        event.preventDefault();
        actions.pauseFollow();
        scrollBy(scrollRef.current, -(scrollRef.current?.clientHeight ?? 0) * SESSION_READING_PAGE_FRACTION);
        return;
      }
      if (matchesShortcut(event, "session-reading-latest") ||
          matchesShortcut(event, "session-reading-latest-end")) {
        event.preventDefault();
        const scroll = scrollRef.current;
        scrollTo(scroll, scroll?.scrollHeight ?? 0);
        actions.resumeFollow();
        return;
      }
      for (const [shortcutId, action] of ACTION_BINDINGS) {
        if (!matchesShortcut(event, shortcutId)) continue;
        event.preventDefault();
        actions[action]();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [actions, composerAvailable, enabled, scrollRef]);
}
