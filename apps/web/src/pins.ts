/**
 * localStorage-backed id-set persistence shared by inbox project/session pins and the session
 * detail (pin cleanup on delete). All helpers are
 * guarded: localStorage may be unavailable (private mode, quota) and the stored JSON may be
 * corrupt — both degrade to an empty set / no-op rather than throwing.
 */
import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

export const SESSION_PIN_KEY = "wollipog.sessions.pinned";

export function loadKeySet(key: string, instanceScope = LOCAL_INSTANCE_SCOPE): Set<string> {
  try {
    const raw = loadInstanceStorageValue(key, instanceScope);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveKeySet(key: string, set: ReadonlySet<string>, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  try {
    saveInstanceStorageValue(key, JSON.stringify([...set]), instanceScope);
  } catch {
    /* localStorage unavailable — best-effort */
  }
}

/** Drop ids from a persisted set (no-op when none are present). Sessions are pinned by id, so a
 * DELETED session's pin must be cleaned here — archive intentionally keeps the pin, so a later
 * unarchive restores the session to the top of its group. */
export function removeFromKeySet(key: string, ...ids: string[]): void {
  removeFromInstanceKeySet(key, LOCAL_INSTANCE_SCOPE, ...ids);
}

export function removeFromInstanceKeySet(key: string, instanceScope: string, ...ids: string[]): void {
  const set = loadKeySet(key, instanceScope);
  let changed = false;
  for (const id of ids) if (set.delete(id)) changed = true;
  if (changed) saveKeySet(key, set, instanceScope);
}
