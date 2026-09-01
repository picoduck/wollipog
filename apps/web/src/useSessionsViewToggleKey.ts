import { useEffect, useRef } from "react";
import type { View } from "./navigation.js";
import { matchesShortcut, shortcutLayerActive } from "./shortcuts.js";

function xtermOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".xterm"));
}

/**
 * The bare `b` binding that flips Sessions between its list and board modes.
 *
 * Extracted from the app shell's keyboard layer so the browser harness can mount the SAME
 * handler the app runs (#527): a copy in the fixture would keep the e2e green while the real
 * binding regressed. Only fires while Sessions is the current view — `b` is unadvertised
 * elsewhere, and a bare letter firing from, say, Usage would navigate without any visible
 * control naming it. Typing contexts are already excluded by the bare-key matcher.
 */
export function useSessionsViewToggleKey(
  enabled: boolean,
  view: View,
  navigate: (view: View) => void,
): void {
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document) || xtermOwnsKey(event.target)) return;
      if (!matchesShortcut(event, "toggle-sessions-view")) return;
      const current = viewRef.current.name;
      if (current !== "inbox" && current !== "board") return;
      event.preventDefault();
      navigate({ name: current === "board" ? "inbox" : "board" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, navigate]);
}
