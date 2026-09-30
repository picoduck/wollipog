import { LOCAL_INSTANCE_SCOPE, loadInstanceStorageValue, saveInstanceStorageValue } from "./instance-storage.js";

/**
 * The sessions most recently opened on this device, for the palette's Recent section (#1978).
 *
 * Ids only, newest first, per instance: a remote control plane can reuse the local one's session
 * ids, so an unscoped list would offer one instance's sessions on another. A session that has since
 * been deleted stays in the list until it is pushed out; the palette skips ids it cannot name.
 */

export const RECENT_SESSIONS_KEY = "wollipog.palette.recentSessions";

/** Recent holds the last five sessions opened (docs/design-system.md §4.1 Search). */
export const RECENT_SESSIONS_LIMIT = 5;

/** `id` moved to the front, without a duplicate, capped at the limit. */
export function withRecentSession(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_SESSIONS_LIMIT);
}

/** A stored list, or none when the value is missing or not a list of ids. */
export function parseRecentSessions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return [...new Set(ids)].slice(0, RECENT_SESSIONS_LIMIT);
  } catch {
    return [];
  }
}

export function loadRecentSessions(instanceScope = LOCAL_INSTANCE_SCOPE): string[] {
  return parseRecentSessions(loadInstanceStorageValue(RECENT_SESSIONS_KEY, instanceScope));
}

/** Record that a session was opened. Best-effort, like every other preference. */
export function recordRecentSession(id: string, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  const current = loadRecentSessions(instanceScope);
  if (current[0] === id) return;
  saveInstanceStorageValue(RECENT_SESSIONS_KEY, JSON.stringify(withRecentSession(current, id)), instanceScope);
}
