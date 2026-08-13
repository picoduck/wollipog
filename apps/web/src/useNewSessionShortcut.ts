import { useEffect } from "react";
import { matchesShortcut, shortcutLayerActive } from "./shortcuts.js";

function terminalOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".xterm"));
}

/** Own the global bare-C shortcut without stealing input from dialogs, editors, or terminals. */
export function useNewSessionShortcut(enabled: boolean, onNewSession: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document) || terminalOwnsKey(event.target)) return;
      if (!matchesShortcut(event, "new-session")) return;
      event.preventDefault();
      onNewSession();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onNewSession]);
}
