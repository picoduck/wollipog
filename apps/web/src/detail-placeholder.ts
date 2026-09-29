import { destination } from "./navigation.js";
import type { ConnState } from "./store.js";

export interface DetailPlaceholder {
  title: string;
  hint: string;
  /** Which §12 state this is, so the view renders the matching `State` variant. */
  variant: "empty" | "loading" | "error" | "offline";
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
  if (state.authoritative) return { title: `${resource} Not Found`, hint: "It may have been deleted or you may not have access.", variant: "empty" };
  if (state.conn === "unauthorized") return { title: `Pair to Load ${resource}`, hint: "This device needs access to the control plane.", variant: "offline" };
  if (state.conn === "offline") return { title: `${resource} Unavailable`, hint: "Reconnect to the control plane to load this link.", variant: "offline" };
  if (state.error) return { title: `${resource} Unavailable`, hint: state.error, variant: "error" };
  return { title: `Loading ${resource}…`, hint: "Waiting for the control-plane snapshot.", variant: "loading" };
}

/** A resource list before the first snapshot, or while disconnected. An empty map proves nothing
 * then, so the list must not claim "No … Yet" or offer to create what may already exist. */
export function listPlaceholder(list: "runs" | "pods", conn: ConnState): DetailPlaceholder {
  const resource = destination(list).name;
  if (conn === "unauthorized") return { title: `Pair to Load ${resource}`, hint: "This device needs access to the control plane.", variant: "offline" };
  if (conn === "offline") return { title: `${resource} Unavailable`, hint: "Reconnect to the control plane to load this list.", variant: "offline" };
  return { title: `Loading ${resource}…`, hint: "Waiting for the control-plane snapshot.", variant: "loading" };
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
