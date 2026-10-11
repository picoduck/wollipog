import { matchesShortcut } from "./shortcuts.js";
import { sessionReadingTarget } from "./focus-zones.js";
import { MOBILE_BREAKPOINT_PX } from "./components/useIsMobile.js";
import type { TerminalPlacement } from "./terminal-placement.js";

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
 * focus in it there. The request names its destination, and that place's host takes it as it mounts,
 * however long its code or the session view around it takes to load (#2869 review). It ends with the
 * move: the other place's host mounting instead supersedes it, the destination closing before its host
 * mounts abandons it (the app cancels it), and leaving the session drops it. So a request never
 * surfaces later in a terminal that opened for another reason.
 */
let terminalFocusRequest: { sessionId: string; place: TerminalPlacement } | null = null;

export function requestTerminalFocus(sessionId: string, place: TerminalPlacement): void {
  terminalFocusRequest = { sessionId, place };
}

/** The move is abandoned: its destination (`place`, or any) closed, or the session was left. */
export function cancelTerminalFocusRequest(sessionId: string, place?: TerminalPlacement): void {
  const request = terminalFocusRequest;
  if (request?.sessionId === sessionId && (place === undefined || request.place === place)) terminalFocusRequest = null;
}

/** A host of `place` mounted for the session: true when it is the move's destination. Either way the move ends. */
export function takeTerminalFocusRequest(sessionId: string, place: TerminalPlacement): boolean {
  const request = terminalFocusRequest;
  if (request?.sessionId !== sessionId) return false;
  terminalFocusRequest = null;
  return request.place === place;
}
