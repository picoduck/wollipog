/**
 * What a composer action the server refused says in the session notice slot (#2511): a Title Case
 * name for the failure, one sentence that says what happened and what to do, and the server's own
 * words behind Show Details (docs/design-system.md §17.2). #2156 did this for sends and steers; these
 * are the other actions whose failures land in the same slot.
 */

import { ApiError } from "./api.js";

export interface ComposerActionError {
  /** Title Case: the notice's title and its "+N More" menu item. */
  title: string;
  /** Sentence case, none of the server's words: what failed and what to do. */
  message: string;
  /** The server's own words, behind Show Details. */
  detail?: string;
}

export type ComposerAction =
  | "cancelMessage"
  | "dismissMessage"
  | "retryMessage"
  | "cancelQueuedMessage"
  | "stopTurn"
  | "rewind"
  | "fork"
  | "editInFork"
  | "recoverConversation"
  | "restart"
  | "retrySetup"
  | "restartAfterSetup"
  | "addReference"
  | "steerQueuedMessage"
  | "queueAgain"
  | "dismissSteering";

interface ActionCopy {
  title: string;
  /** What failed, as the sentence's opening: "Couldn't restart this session." */
  failed: string;
  /** What to do when the cause is unknown. */
  next?: string;
}

/** Each action's title, what failed, and what to do; an unrecognized failure reads as both together. */
const ACTION_COPY: Record<ComposerAction, ActionCopy> = {
  cancelMessage: { title: "Message Not Canceled", failed: "Couldn't cancel this message." },
  dismissMessage: { title: "Message Not Dismissed", failed: "Couldn't dismiss this message." },
  retryMessage: { title: "Message Not Retried", failed: "Couldn't retry this message." },
  cancelQueuedMessage: { title: "Message Not Canceled", failed: "Couldn't cancel this queued message." },
  stopTurn: { title: "Turn Not Stopped", failed: "Couldn't stop the turn.", next: "Try again or use Stop Session." },
  rewind: { title: "Rewind Failed", failed: "Couldn't rewind the files to before this turn." },
  fork: { title: "Fork Not Created", failed: "Couldn't fork this conversation." },
  editInFork: { title: "Fork Not Created", failed: "Couldn't create the fork." },
  recoverConversation: {
    title: "Session Not Recovered",
    failed: "Couldn't start a new conversation from the last checkpoint.",
  },
  restart: { title: "Session Not Restarted", failed: "Couldn't restart this session." },
  retrySetup: { title: "Setup Not Retried", failed: "Couldn't retry worktree setup." },
  restartAfterSetup: {
    title: "Session Not Restarted",
    failed: "Worktree setup finished, but the session couldn't restart.",
    next: "Try restarting it.",
  },
  addReference: { title: "Reference Not Added", failed: "Couldn't add this reference." },
  steerQueuedMessage: {
    title: "Message Not Steered",
    failed: "Couldn't steer the turn with this queued message.",
    next: "It's still queued.",
  },
  queueAgain: { title: "Message Not Queued", failed: "Couldn't queue this message again." },
  dismissSteering: { title: "Message Not Dismissed", failed: "Couldn't dismiss this message." },
};

/** The server's words for Show Details, if it gave any. */
function serverWords(cause: unknown): string | undefined {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return text.trim() || undefined;
}

/**
 * A failed composer action as a notice slot entry. A known cause has its own sentence, which says
 * all there is to say. Anything else reads as the action's own sentence, with the server's words
 * behind Show Details, never in the sentence. `machineName` names the session's machine when the
 * cause is that machine.
 */
export function composerActionError(
  action: ComposerAction,
  cause: unknown,
  machineName?: string,
): ComposerActionError {
  const copy = ACTION_COPY[action];
  const known = knownCause(action, copy, cause, machineName?.trim() || undefined);
  if (known !== null) return { title: copy.title, message: known };
  const detail = serverWords(cause);
  return { title: copy.title, message: `${copy.failed} ${copy.next ?? "Try again."}`, ...(detail ? { detail } : {}) };
}

/**
 * A sentence for a failure whose cause the person can act on, or null for the generic one. The
 * server sends sentences, not codes, so only its fixed wording for stable causes is matched; a
 * change to that wording falls back to the generic sentence rather than to a wrong one.
 */
function knownCause(action: ComposerAction, copy: ActionCopy, cause: unknown, machineName: string | undefined): string | null {
  const machine = machineName ?? "The machine";
  // The request never got an answer from Wollipog itself: each browser's words for a failed fetch.
  if (!(cause instanceof ApiError)) {
    return cause instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(cause.message)
      ? `${copy.failed} Wollipog didn't respond. Check your connection and try again.`
      : null;
  }
  const text = cause.message.trim();
  if (cause.status === 409 && /^runner is offline$/i.test(text)) {
    return `${copy.failed} ${machine} is offline. Try again once it reconnects.`;
  }
  if (/^runner did not respond in time$/i.test(text)) {
    return `${copy.failed} ${machine} didn't respond in time. Try again.`;
  }
  if (cause.status !== 409) return null;
  switch (action) {
    case "stopTurn":
      // The turn ended before the stop reached it: the same sentence as stopping with no turn (#2156).
      return /no active turn to stop/i.test(text) ? "There's no turn to stop right now." : null;
    case "rewind":
      if (/^no checkpoint exists for turn \d+$/i.test(text)) {
        return `${copy.failed} This turn has no checkpoint to rewind to.`;
      }
      if (/^a turn is running\b/i.test(text)) {
        return `${copy.failed} A turn is running. Stop it or wait for it to finish, then try again.`;
      }
      if (/^a rewind is already in progress$/i.test(text)) {
        return "Another rewind is still in progress. Wait for it to finish, then try again.";
      }
      return null;
    case "fork":
    case "editInFork":
      return /^the source session is busy\b/i.test(text)
        ? `${copy.failed} This session is busy. Wait for it to settle, then try again.`
        : null;
    default:
      return null;
  }
}
