import type { ConnState } from "./store.js";

export interface DetailPlaceholder {
  title: string;
  hint: string;
}

export interface RoutedSessionLookup {
  sessionId: string;
  complete: boolean;
  error: string | null;
}

export function shouldLookupRoutedSession(hasSession: boolean, conn: ConnState): boolean {
  // A fail-closed 404 intentionally does not distinguish missing from unauthorized. Wait until
  // the authenticated UI socket proves this device is paired before treating that reply as an
  // authoritative routed-resource miss.
  return !hasSession && conn === "online";
}

export function shouldHydrateRoutedSession(
  session: { archived?: boolean } | undefined,
  snapshotRevision: number,
  conn: ConnState,
): boolean {
  if (conn !== "online") return false;
  return !session || (Boolean(session.archived) && snapshotRevision > 0);
}

export function detailPlaceholder(
  resource: "Session" | "Run" | "Pod",
  state: { authoritative: boolean; conn: ConnState; error?: string | null },
): DetailPlaceholder {
  if (state.authoritative) return { title: `${resource} Not Found`, hint: "It may have been deleted or you may not have access." };
  if (state.conn === "unauthorized") return { title: `Pair to load ${resource.toLowerCase()}`, hint: "This device needs access to the control plane." };
  if (state.conn === "offline") return { title: `${resource} Unavailable`, hint: "Reconnect to the control plane to load this link." };
  if (state.error) return { title: `${resource} Unavailable`, hint: state.error };
  return { title: `Loading ${resource.toLowerCase()}…`, hint: "Waiting for the control-plane snapshot." };
}

/** Scope lookup completion to the route that produced it. This is defensive against stale async
 * completion if a future caller preserves lookup state while navigating between session routes. */
export function routedSessionPlaceholder(
  sessionId: string,
  lookup: RoutedSessionLookup,
  conn: ConnState,
): DetailPlaceholder {
  const appliesToRoute = lookup.sessionId === sessionId;
  return detailPlaceholder("Session", {
    authoritative: conn === "online" && appliesToRoute && lookup.complete && lookup.error === null,
    conn,
    error: appliesToRoute ? lookup.error : null,
  });
}
