import { matchesShortcut } from "./shortcuts.js";
import { sessionReadingTarget } from "./focus-zones.js";

/**
 * Install the one capture-phase exception to terminal key ownership. Window capture runs before
 * xterm's textarea capture handler can cancel Ctrl+Escape; plain Escape and every other key remain
 * untouched. Returns a cleanup function for React effects and tests.
 */
export function installTerminalExitBoundary(targetWindow: Window, targetDocument: Document): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const active = targetDocument.activeElement;
    const ElementCtor = targetDocument.defaultView?.Element;
    if (!ElementCtor || !(active instanceof ElementCtor) || !active.closest(".xterm")) return;
    if (!matchesShortcut(event, "exit-terminal", targetDocument)) return;
    event.preventDefault();
    event.stopPropagation();
    const main = targetDocument.querySelector(".main-body");
    if (main) sessionReadingTarget(main)?.focus();
  };
  targetWindow.addEventListener("keydown", onKeyDown, true);
  return () => targetWindow.removeEventListener("keydown", onKeyDown, true);
}
