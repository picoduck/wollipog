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

/**
 * A and D on the dock's expanded request, wherever the keys are read: the session's reading keys,
 * or the Sessions list while its preview shows the dock. One handler per mounted dock.
 */
type RequestIntent = (intent: "approve" | "deny") => boolean;
const intents = new Map<string, RequestIntent[]>();

export function registerRequestIntent(sessionId: string, handler: RequestIntent): () => void {
  intents.set(sessionId, [handler, ...(intents.get(sessionId) ?? [])]);
  return () => {
    const rest = (intents.get(sessionId) ?? []).filter((candidate) => candidate !== handler);
    if (rest.length) intents.set(sessionId, rest);
    else intents.delete(sessionId);
  };
}

/** True when a mounted dock took the key for its expanded request. */
export function decideDockedRequest(sessionId: string, intent: "approve" | "deny"): boolean {
  // The most recently mounted dock answers.
  return (intents.get(sessionId) ?? []).slice(0, 1).some((handler) => handler(intent));
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
/** The last failed decision's message per occurrence, so a card that remounted still offers the retry. */
const failures = new Map<string, string>();
const inFlightListeners = new Set<() => void>();
const notify = () => { for (const listener of [...inFlightListeners]) listener(); };

export function decisionKey(sessionId: string, requestId: string, occurrenceId: string | undefined): string {
  return JSON.stringify([sessionId, requestId, occurrenceId ?? null]);
}

/** Claims the occurrence for one decision; null when another decision for it is still in flight. */
export function claimDecision(key: string, optionId: string): ((failure?: string) => void) | null {
  if (inFlight.has(key)) return null;
  inFlight.set(key, optionId);
  failures.delete(key);
  notify();
  return (failure) => {
    if (inFlight.get(key) !== optionId) return;
    inFlight.delete(key);
    if (failure !== undefined) failures.set(key, failure);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  inFlightListeners.add(listener);
  return () => { inFlightListeners.delete(listener); };
}

/** Why the last decision for this occurrence was not sent, until the next one is. */
export function useDecisionFailure(key: string): string | null {
  return useSyncExternalStore(subscribe, () => failures.get(key) ?? null, () => null);
}

/** The option whose decision for this occurrence is in flight, if any. */
export function useDecisionInFlight(key: string): string | null {
  return useSyncExternalStore(subscribe, () => inFlight.get(key) ?? null, () => null);
}
