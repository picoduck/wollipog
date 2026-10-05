import { useSyncExternalStore } from "react";

/**
 * How a control elsewhere (the session status control, the working line's Review, the Agents
 * panel's Open Request in Session, the campaign panel) brings a docked request into view: only the
 * expanded request has a card in the DOM, so the dock expands the one asked for and moves focus to
 * its heading. While the person has chosen a session notice in the dock's place, the notice slot
 * answers instead and brings the dock back first.
 */
type RequestRevealer = (requestId: string) => boolean;

const revealers = new Map<string, RequestRevealer[]>();

/** Registers a revealer for a session; the latest registered is asked first. Returns the unregister. */
export function registerRequestRevealer(sessionId: string, revealer: RequestRevealer): () => void {
  revealers.set(sessionId, [revealer, ...(revealers.get(sessionId) ?? [])]);
  return () => {
    const rest = (revealers.get(sessionId) ?? []).filter((candidate) => candidate !== revealer);
    if (rest.length) revealers.set(sessionId, rest);
    else revealers.delete(sessionId);
  };
}

/** True when a mounted dock (or the notice slot holding its place) has brought the request up. */
export function revealDockedRequest(sessionId: string, requestId: string): boolean {
  return (revealers.get(sessionId) ?? []).some((revealer) => revealer(requestId));
}

/**
 * Decisions sent and not yet answered, by request occurrence. The card is keyed by its request, so
 * expanding another request and coming back mounts a new one; this keeps the first decision's busy
 * state, and refuses a second, until the first is answered.
 */
const inFlight = new Map<string, string>();
const inFlightListeners = new Set<() => void>();

export function decisionKey(sessionId: string, requestId: string, occurrenceId: string | undefined): string {
  return JSON.stringify([sessionId, requestId, occurrenceId ?? null]);
}

/** Claims the occurrence for one decision; null when another decision for it is still in flight. */
export function claimDecision(key: string, optionId: string): (() => void) | null {
  if (inFlight.has(key)) return null;
  inFlight.set(key, optionId);
  for (const listener of [...inFlightListeners]) listener();
  return () => {
    if (inFlight.get(key) !== optionId) return;
    inFlight.delete(key);
    for (const listener of [...inFlightListeners]) listener();
  };
}

/** The option whose decision for this occurrence is in flight, if any. */
export function useDecisionInFlight(key: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      inFlightListeners.add(listener);
      return () => { inFlightListeners.delete(listener); };
    },
    () => inFlight.get(key) ?? null,
    () => null,
  );
}
