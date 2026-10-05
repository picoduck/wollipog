/**
 * How a control elsewhere (the session status control, the working line's Review, the Agents
 * panel's Open Request in Session) brings a docked request into view: only the expanded request has
 * a card in the DOM, so the dock expands the one asked for and moves focus to its heading.
 */
type RequestRevealer = (requestId: string) => boolean;

const revealers = new Map<string, RequestRevealer>();

/** Registers the mounted dock of a session; returns the unregister. */
export function registerRequestRevealer(sessionId: string, revealer: RequestRevealer): () => void {
  revealers.set(sessionId, revealer);
  return () => {
    if (revealers.get(sessionId) === revealer) revealers.delete(sessionId);
  };
}

/** True when a mounted dock holds the request and has brought it up. */
export function revealDockedRequest(sessionId: string, requestId: string): boolean {
  return revealers.get(sessionId)?.(requestId) ?? false;
}
