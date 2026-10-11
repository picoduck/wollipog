import { useEffect } from "react";
import { matchesShortcut, shortcutLayerActive } from "./shortcuts.js";

function xtermOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".xterm"));
}

/**
 * Ctrl+K / Cmd+K toggles the palette. Deliberately ALSO from inputs/textareas (the Slack/Linear
 * convention — jumping mid-typing is the point) but NOT from a terminal: Ctrl+K is a real control
 * sequence inside xterm. Other layers (dialogs, menus) keep the key; the palette itself does not.
 */
export function useSearchShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || shortcutLayerActive(document, true, e)) return;
      if (matchesShortcut(e, "search")) {
        if (xtermOwnsKey(e.target)) return;
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

