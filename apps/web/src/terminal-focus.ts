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
 * provided it mounts within a second, so a request never surfaces on an unrelated later visit.
 */
let terminalFocusRequest: { sessionId: string; at: number } | null = null;
const TERMINAL_FOCUS_WINDOW_MS = 1000;

export function requestTerminalFocus(sessionId: string): void {
  terminalFocusRequest = { sessionId, at: Date.now() };
}

/**
 * A lazy host's code arrived (#2869): a request made for the move that started loading it gets its
 * second from now, so a slow network never spends it before the host can mount. `loadStartedAt` is when
 * that load began; an older request belongs to an earlier move and is left to expire.
 */
export function renewTerminalFocusRequest(loadStartedAt: number): void {
  const request = terminalFocusRequest;
  if (request && request.at >= loadStartedAt - TERMINAL_FOCUS_WINDOW_MS) {
    terminalFocusRequest = { ...request, at: Date.now() };
  }
}

/**
 * The code of a host that may be a move's destination, loaded once: when it arrives it renews the
 * pending focus request (`renewTerminalFocusRequest`). For `React.lazy`.
 */
export function loadTerminalHost<T>(load: () => Promise<T>): () => Promise<T> {
  return () => {
    const startedAt = Date.now();
    return load().then((module) => {
      renewTerminalFocusRequest(startedAt);
      return module;
    });
  };
}

export function takeTerminalFocusRequest(sessionId: string): boolean {
  const request = terminalFocusRequest;
  if (request?.sessionId !== sessionId) return false;
  terminalFocusRequest = null;
  return Date.now() - request.at <= TERMINAL_FOCUS_WINDOW_MS;
}
