import { matchesShortcut } from "./shortcuts.js";
import { sessionReadingTarget } from "./focus-zones.js";
import { MOBILE_BREAKPOINT_PX } from "./components/useIsMobile.js";

const PHONE_MEDIA = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

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
    // A phone's side panel is a sheet over the transcript: leaving its Terminal tool lands on the
    // sheet's tool switcher rather than behind it (#2868).
    const panel = active.closest("#right-panel");
    if (panel && targetDocument.defaultView?.matchMedia(PHONE_MEDIA).matches) {
      panel.querySelector<HTMLElement>(".rpanel-switcher")?.focus();
      return;
    }
    const main = targetDocument.querySelector(".main-body");
    if (main) sessionReadingTarget(main)?.focus();
  };
  targetWindow.addEventListener("keydown", onKeyDown, true);
  return () => targetWindow.removeEventListener("keydown", onKeyDown, true);
}

/**
 * Moving the terminal to another place (Move to Bottom Dock, #2868; Move to Right Panel, #2869) puts
 * focus in it there. The host that shows the session's terminals next takes the request as it mounts,
 * however long its code or the session view around it takes to load (#2869 review): a move leaves no
 * other host showing them, so the next one is the move's destination. Leaving the session cancels the
 * request (`cancelTerminalFocusRequest`), so it never surfaces on an unrelated later visit.
 */
let terminalFocusRequest: { sessionId: string } | null = null;

export function requestTerminalFocus(sessionId: string): void {
  terminalFocusRequest = { sessionId };
}

/** The session's terminals are disposed (leaving the session): a move still pending is dropped. */
export function cancelTerminalFocusRequest(sessionId: string): void {
  if (terminalFocusRequest?.sessionId === sessionId) terminalFocusRequest = null;
}

export function takeTerminalFocusRequest(sessionId: string): boolean {
  if (terminalFocusRequest?.sessionId !== sessionId) return false;
  terminalFocusRequest = null;
  return true;
}
