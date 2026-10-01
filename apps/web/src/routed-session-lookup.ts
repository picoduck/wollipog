import { useSyncExternalStore } from "react";
import type { RoutedSessionLookup } from "./detail-placeholder.js";

/**
 * The lookup of a routed session that is not in the live snapshot, shared by the Session page that
 * runs it and the phone top bar, which shows the page's placeholder title (#2202). Module state, so
 * both read one answer rather than the bar guessing; the page removes its entry when it unmounts, so
 * a later visit starts from Loading again.
 */
const lookups = new Map<string, RoutedSessionLookup>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The lookup's state before it has run: incomplete, with no error. Cached per id, so a
 * `useSyncExternalStore` snapshot stays the same object between renders. */
const pending = new Map<string, RoutedSessionLookup>();
function pendingLookup(sessionId: string): RoutedSessionLookup {
  let value = pending.get(sessionId);
  if (!value) {
    value = { sessionId, complete: false, error: null };
    pending.set(sessionId, value);
  }
  return value;
}

export function setRoutedSessionLookup(lookup: RoutedSessionLookup): void {
  lookups.set(lookup.sessionId, lookup);
  notify();
}

export function clearRoutedSessionLookup(sessionId: string): void {
  pending.delete(sessionId);
  if (!lookups.delete(sessionId)) return;
  notify();
}

export function useRoutedSessionLookup(sessionId: string): RoutedSessionLookup {
  const read = () => lookups.get(sessionId) ?? pendingLookup(sessionId);
  return useSyncExternalStore(subscribe, read, read);
}
