import type { SessionEvent, SessionView } from "@wollipog/protocol";
import type { EventHistoryState } from "./store.js";

export interface ComparisonStoreSlices {
  sessions: ReadonlyMap<string, SessionView>;
  events: ReadonlyMap<string, SessionEvent[]>;
}

export interface ComparisonHistorySlices {
  sessions: ReadonlyMap<string, SessionView>;
  eventHistory: ReadonlyMap<string, EventHistoryState>;
}

/** Entry selectors intentionally return the stored value, not a containing fleet Map. An
 * unrelated session upsert/event replacement therefore preserves Object.is equality at each
 * comparison-column subscription boundary. */
export function selectComparisonSession(state: ComparisonStoreSlices, sessionId: string): SessionView | undefined {
  return state.sessions.get(sessionId);
}

export function selectComparisonEvents(state: ComparisonStoreSlices, sessionId: string): SessionEvent[] | undefined {
  return state.events.get(sessionId);
}

export function selectComparisonHistory(
  state: ComparisonHistorySlices,
  sessionId: string,
): EventHistoryState | undefined {
  const history = state.eventHistory.get(sessionId);
  const eventEpoch = state.sessions.get(sessionId)?.eventEpoch ?? 0;
  return history?.eventEpoch === eventEpoch ? history : undefined;
}
