import type { ConnState } from "./store.js";

/** A next step a placeholder offers, in the order it shows them. The view renders the button. */
export type DetailPlaceholderAction =
  /** Back to the resource's list ("Back to Sessions"). */
  | "back"
  /** Open the search palette ("Search Sessions"). */
  | "search"
  /** Issue the lookup again. */
  | "retry";

export interface DetailPlaceholder {
  /** Title Case. */
  title: string;
  /** One sentence in sentence case, in the person's terms; null where the state has none (loading). */
  hint: string | null;
  /** Which §12 state this is, so the view renders the matching `State` variant. */
  variant: "empty" | "loading" | "error" | "offline";
  actions: readonly DetailPlaceholderAction[];
  /** The raw error, shown only behind Show Details. */
  details?: string;
}

export interface RoutedSessionLookup {
  sessionId: string;
  complete: boolean;
  error: string | null;
}

export function shouldHydrateRoutedSession(
  session: { archived?: boolean; projection?: "summary" } | undefined,
  snapshotRevision: number,
  conn: ConnState,
  summarySnapshot = false,
): boolean {
  if (conn !== "online") return false;
  return !session || session.projection === "summary" || ((Boolean(session.archived) || summarySnapshot) && snapshotRevision > 0);
}

const RESOURCE_NOUN = { Session: "session", Automation: "automation" } as const;

/**
 * The state a Session or Automation page shows while its entity is not loaded (docs/design-system.md
 * §12). The copy names what the person can do, never Wollipog's internals: the shell's offline
 * banner already offers Retry Now, and the pairing banner holds the pairing form (#2202).
 */
export function detailPlaceholder(
  resource: keyof typeof RESOURCE_NOUN,
  state: { authoritative: boolean; conn: ConnState; error?: string | null },
): DetailPlaceholder {
  const noun = RESOURCE_NOUN[resource];
  if (state.authoritative) {
    return {
      title: `${resource} Not Found`,
      hint: "It may have been deleted, or you may not have access.",
      variant: "empty",
      // The palette searches sessions, so only a session offers it.
      actions: resource === "Session" ? ["back", "search"] : ["back"],
    };
  }
  if (state.conn === "unauthorized") {
    return {
      title: `Pair to Load ${resource}`,
      hint: `This device needs to be paired before it can open ${noun}s.`,
      variant: "offline",
      actions: [],
    };
  }
  if (state.conn === "offline") {
    return {
      title: "Waiting to Reconnect",
      hint: `Wollipog opens this ${noun} when the connection comes back.`,
      variant: "offline",
      actions: [],
    };
  }
  if (state.error) {
    return {
      title: `Couldn't Load ${resource}`,
      hint: `Something went wrong while opening this ${noun}.`,
      variant: "error",
      actions: ["retry"],
      details: state.error,
    };
  }
  return { title: `Loading ${resource}…`, hint: null, variant: "loading", actions: [] };
}

/** Scope lookup completion to the route that produced it. This is defensive against stale async
 * completion if a future caller preserves lookup state while navigating between session routes.
 *
 * Once a snapshot has loaded, a connection that is only "connecting" is the shell retrying a lost
 * one, so the page says Waiting to Reconnect rather than flipping back to Loading on every retry
 * (the same rule as `useSnapshotState()`). */
export function routedSessionPlaceholder(
  sessionId: string,
  lookup: RoutedSessionLookup,
  conn: ConnState,
  snapshotLoaded = false,
): DetailPlaceholder {
  const appliesToRoute = lookup.sessionId === sessionId;
  const current = conn === "connecting" && snapshotLoaded ? "offline" : conn;
  return detailPlaceholder("Session", {
    authoritative: current === "online" && appliesToRoute && lookup.complete && lookup.error === null,
    conn: current,
    error: appliesToRoute ? lookup.error : null,
  });
}
