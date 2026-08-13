import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useFeedback } from "./FeedbackProvider.js";

/** The event the shell emits when it holds a close back. */
export const CLOSE_WOULD_STOP_WORK = "wollipog://close-would-stop-work";

export interface CloseGuardShell {
  isTauri(): boolean;
  /** Subscribe to a shell event; resolves to its unsubscribe. */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** The real shell. Injected as a prop so the component is testable without a Tauri webview. */
const shell: CloseGuardShell = {
  isTauri,
  listen: (event, handler) => listen(event, (received) => handler(received.payload)),
};

/**
 * "3 sessions still have work running." — and a count of zero means the shell could not get one.
 *
 * The shell holds the close when the control plane is up but unanswerable, because a needless
 * warning costs a keypress and a missed one costs an agent turn. It has no number to report then,
 * and inventing one would be worse than saying so.
 */
export function closeWarning(count: number): string {
  if (count <= 0) return "Agent work may still be running. Closing again will stop it.";
  return count === 1
    ? "1 session still has work running. Closing again will stop it."
    : `${count} sessions still have work running. Closing again will stop them.`;
}

/**
 * §23.1 — closing the desktop window kills in-flight agent work, so warn once before it does.
 *
 * The shell decides: at close time it asks the local control plane what is in flight, because that
 * is what exit destroys. This turns the shell's warning into something the user can read.
 *
 * Renders nothing, and does nothing at all in a browser.
 */
export function DesktopCloseGuard({ desktop = shell }: { desktop?: CloseGuardShell } = {}) {
  const { showToast } = useFeedback();

  useEffect(() => {
    if (!desktop.isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void desktop.listen(CLOSE_WOULD_STOP_WORK, (payload) => {
      showToast(closeWarning(typeof payload === "number" ? payload : 0), { tone: "error", durationMs: 0 });
    }).then((unlisten) => {
      // `listen` can resolve after an unmount; drop the subscription rather than leak it.
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => {
      // An older shell emits nothing, so there is nothing to listen for and nothing to repair.
    });
    return () => { disposed = true; stop?.(); };
  }, [desktop, showToast]);

  return null;
}
