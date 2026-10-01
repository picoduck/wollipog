import { sessionDisplayTitle } from "./session-title.js";

/**
 * The bodies of a session's lifecycle confirmations (docs/design-system.md §7.4, §17): one or two
 * sentences that name the session and say what happens to it and whether it can be undone, never
 * the mechanism behind it. Each is shared by every surface that asks the same question, so the
 * session header and the Sessions list cannot drift.
 */

/** The session's one-line title in quotes, or null when it has none. */
export function quotedSessionTitle(title: string | null | undefined): string | null {
  const line = title ? sessionDisplayTitle(title) : "";
  return line ? `“${line}”` : null;
}

/** What Stop Session does to the session. The queued-message clause is left out when nothing is queued. */
function stopsNowSentence(title: string | null | undefined, queuedCount: number): string {
  const name = quotedSessionTitle(title) ?? "This session";
  const queued = queuedCount > 0
    ? ` and its ${queuedCount} queued ${queuedCount === 1 ? "message is" : "messages are"} discarded`
    : "";
  return `${name} stops now${queued}.`;
}

/** Stop Session. The queued-message clause is left out when nothing is queued. */
export function stopSessionMessage(title: string | null | undefined, queuedCount: number): string {
  return `${stopsNowSentence(title, queuedCount)} To interrupt only the current turn, use Stop Turn in the composer.`;
}

/**
 * Stop Session in Archived Sessions: the same first sentence, then where the session stays. An
 * archived session shows no composer, so Stop Turn is not offered.
 */
export function stopArchivedSessionMessage(title: string | null | undefined, queuedCount: number): string {
  return `${stopsNowSentence(title, queuedCount)} It stays in Archived Sessions with its transcript.`;
}

/** Delete Session. */
export function deleteSessionMessage(title: string | null | undefined): string {
  return `${quotedSessionTitle(title) ?? "This session"} and its history are removed from Wollipog. This can't be undone.`;
}

/** Sign Out of Agent: which agent, and on which machine. */
export function signOutOfAgentMessage(agent: string, machine: string | null | undefined): string {
  return `${agent} signs out on ${machine || "this machine"}, and new sessions with it will ask you to sign in again. ` +
    "Saved credentials stay on that machine.";
}
