import type { ConnState, EventHistoryState } from "./store.js";

export type TranscriptBody = "timeline" | "skeleton" | "empty" | "unavailable";

export interface TranscriptPresentation {
  body: TranscriptBody;
  busy: boolean;
  notice: "refreshing" | "stale" | "error" | null;
  error: string | null;
}

/** Decide transcript chrome without conflating an incomplete empty cache with authoritative empty.
 * Existing content always stays mounted while a reconnect recovery checks for missed activity. */
export function transcriptPresentation(input: {
  itemCount: number;
  hasOptimistic: boolean;
  working: boolean;
  history: EventHistoryState | undefined;
  conn: ConnState;
}): TranscriptPresentation {
  const visible = input.itemCount > 0 || input.hasOptimistic || input.working;
  const complete = input.history?.everComplete === true;
  const refreshing = input.history?.refreshing === true;
  const error = input.history?.error ?? null;
  const disconnected = input.conn === "offline" || input.conn === "unauthorized";
  const activelyRefreshing = refreshing && input.conn === "online";

  if (visible) {
    return {
      body: "timeline",
      busy: activelyRefreshing,
      notice: disconnected ? "stale" : error ? "error" : activelyRefreshing ? "refreshing" : null,
      error,
    };
  }
  if (complete) {
    return {
      body: "empty",
      busy: activelyRefreshing,
      notice: disconnected ? "stale" : error ? "error" : activelyRefreshing ? "refreshing" : null,
      error,
    };
  }
  if (error || disconnected) {
    return {
      body: "unavailable",
      busy: false,
      notice: disconnected ? null : error ? "error" : null,
      error: disconnected ? null : error,
    };
  }
  return { body: "skeleton", busy: true, notice: null, error: null };
}
