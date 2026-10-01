import { unarchiveAndRestartFailureMessage } from "./archive-actions.js";
import type { ToastOptions } from "./components/FeedbackProvider.js";

export interface UnarchiveSessionOptions {
  sessionId: string;
  /** One preflighted Unarchive and Restart (`sessionUnarchiveRestarts()`), or a plain Unarchive. */
  restarts: boolean;
  api: {
    unarchiveAndRestart: (id: string) => Promise<unknown>;
    setArchived: (id: string, archived: boolean) => Promise<unknown>;
  };
  showToast: (message: string, options?: ToastOptions) => unknown;
  showUndo: (message: string, undo: () => void | Promise<void>) => unknown;
  /** Re-read the session after an outcome the client could not confirm. */
  reloadSession?: () => Promise<void>;
}

/**
 * Restore an archived session, as the session's More Actions and its Session Archived notice both
 * do (#2202). Unarchive and Restart has no Undo: re-archiving a relaunched session without a Stop
 * would hide live work. A plain Unarchive offers one. Every outcome is a toast; this never throws.
 */
export async function unarchiveSession({
  sessionId,
  restarts,
  api,
  showToast,
  showUndo,
  reloadSession,
}: UnarchiveSessionOptions): Promise<void> {
  if (!restarts) {
    try {
      await api.setArchived(sessionId, false);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { tone: "error" });
      return;
    }
    showUndo("Session restored.", async () => {
      await api.setArchived(sessionId, true);
    });
    return;
  }
  try {
    await api.unarchiveAndRestart(sessionId);
    showToast("Session restored and restarting.");
  } catch (cause) {
    const failure = unarchiveAndRestartFailureMessage(cause);
    showToast(failure.message, { tone: "error" });
    // The server may have restored and relaunched this session before the response was lost; the
    // page would otherwise keep showing it archived. The reload can fail for the very reason the
    // outcome was unconfirmed — the toast already says so, and an escaping rejection would be
    // unhandled.
    if (failure.ambiguous) {
      try {
        await reloadSession?.();
      } catch {
        /* the session state stays as it was; the toast already reports the uncertainty */
      }
    }
  }
}
