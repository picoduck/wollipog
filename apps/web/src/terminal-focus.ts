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
 * mounts abandons it (the app cancels it), the person typing or clicking anywhere first takes focus
 * back from it, and leaving the session drops it. So focus never jumps into a terminal the person has
 * stopped waiting for, and their keys never reach a shell they did not choose.
 */
let terminalFocusRequest: { sessionId: string; place: TerminalPlacement } | null = null;
let stopWatchingInput: (() => void) | null = null;

function endTerminalFocusRequest(): void {
  terminalFocusRequest = null;
  stopWatchingInput?.();
  stopWatchingInput = null;
}

export function requestTerminalFocus(sessionId: string, place: TerminalPlacement): void {
  endTerminalFocusRequest();
  const request = { sessionId, place };
  terminalFocusRequest = request;
  if (typeof window === "undefined") return;
  // Watched from the next task, so the click or key that chose the move does not count.
  const target = window;
  const onInput = () => {
    if (terminalFocusRequest === request) endTerminalFocusRequest();
  };
  const timer = target.setTimeout(() => {
    target.addEventListener("keydown", onInput, true);
    target.addEventListener("pointerdown", onInput, true);
  }, 0);
  stopWatchingInput = () => {
    target.clearTimeout(timer);
    target.removeEventListener("keydown", onInput, true);
    target.removeEventListener("pointerdown", onInput, true);
  };
}

/** The move is abandoned: its destination (`place`, or any) closed, or the session was left. */
export function cancelTerminalFocusRequest(sessionId: string, place?: TerminalPlacement): void {
  const request = terminalFocusRequest;
  if (request?.sessionId === sessionId && (place === undefined || request.place === place)) endTerminalFocusRequest();
}

/**
 * A host of `place` mounted for the session. For the move's destination it returns the claim to call
 * right before moving focus, which ends the move and says whether it still wants focus: the request
 * stays open to cancellation (typing, clicking, the destination closing) until then. The other place's
 * host ends the move and gets null.
 */
export function takeTerminalFocusRequest(sessionId: string, place: TerminalPlacement): (() => boolean) | null {
  const request = terminalFocusRequest;
  if (request?.sessionId !== sessionId) return null;
  if (request.place !== place) {
    endTerminalFocusRequest();
    return null;
  }
  return () => {
    const wanted = terminalFocusRequest === request;
    if (wanted) endTerminalFocusRequest();
    return wanted;
  };
}
