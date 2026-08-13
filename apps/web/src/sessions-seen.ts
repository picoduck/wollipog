/**
 * Unread tracking for inbox cards: a session is "unread" when it has produced
 * events since the user last had it open. Persisted as one JSON map (id → last-seen ts)
 * under wollipog.sessions.seen, capped so it can't grow unbounded. Pure — the localStorage
 * wiring lives with the components.
 */

import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

export const SEEN_KEY = "wollipog.sessions.seen";
export const SEEN_CAP = 200;

export type SeenMap = Record<string, number>;

export function loadSeen(instanceScope = LOCAL_INSTANCE_SCOPE): SeenMap {
  return parseSeen(loadInstanceStorageValue(SEEN_KEY, instanceScope));
}

export function saveSeen(map: SeenMap, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  saveInstanceStorageValue(SEEN_KEY, JSON.stringify(map), instanceScope);
}

/** Parse the persisted map; garbage falls back to empty (dots simply stay off). */
export function parseSeen(raw: string | null): SeenMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: SeenMap = {};
    for (const [k, ts] of Object.entries(v)) {
      if (typeof ts === "number" && Number.isFinite(ts)) out[k] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record that `id` was viewed at `ts`, pruning the oldest entries beyond the cap. */
export function markSeen(map: SeenMap, id: string, ts: number): SeenMap {
  const next: SeenMap = { ...map, [id]: Math.max(ts, map[id] ?? 0) };
  const ids = Object.keys(next);
  if (ids.length > SEEN_CAP) {
    ids
      .sort((a, b) => next[a]! - next[b]!)
      .slice(0, ids.length - SEEN_CAP)
      .forEach((old) => delete next[old]);
  }
  return next;
}

/** Force a session with activity back to unread without changing any other seen marker. */
export function markUnread(map: SeenMap, id: string, lastEventAt: number | null | undefined): SeenMap {
  if (lastEventAt == null || !Number.isFinite(lastEventAt)) return map;
  return { ...map, [id]: lastEventAt - 1 };
}

/**
 * Unread = new activity since the user LAST had the session open. Never-opened sessions are
 * not unread — flooding every historic session with a dot on first run would make the signal
 * meaningless.
 */
export function isUnread(map: SeenMap, id: string, lastEventAt: number | null | undefined): boolean {
  const seen = map[id];
  return seen != null && lastEventAt != null && lastEventAt > seen;
}
