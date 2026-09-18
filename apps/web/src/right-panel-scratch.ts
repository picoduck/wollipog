/**
 * Scratch state for the right panel's mode bodies.
 *
 * Every body unmounts when the user switches modes or closes the panel, so a half-typed pull
 * request description, the directory that was navigated into, and the view choices that were made
 * are destroyed by a glance at another mode (#1202). Component state cannot survive that; this
 * module parks those values outside the React tree, keyed by the session they describe, and hands
 * them back when the body mounts again.
 *
 * In memory only, deliberately. These are scratch values rather than preferences: reloading the
 * app is a far stronger "start over" signal than switching modes, and keeping them out of browser
 * storage means nothing here can outlive the tab or accumulate in localStorage with nobody to
 * clean it up. The scope key is still instance-qualified, because a remote control plane can reuse
 * a local session id (see instance-storage.ts) and one session's drafts must never surface under
 * another's.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { LOCAL_INSTANCE_SCOPE, instanceResourceKey } from "./instance-storage.js";
import { useInstanceScope } from "./instance-scope.js";

/**
 * How many sessions are remembered at once. Panel scratch is unbounded input (drafts, paths) held
 * for as long as the tab lives, so the oldest session's scratch is dropped rather than letting a
 * long navigation session grow the map forever. Well past the handful of sessions anyone switches
 * between while writing one pull request.
 */
export const PANEL_SCRATCH_SESSION_LIMIT = 8;

/** Scope key → logical key → value. Insertion order is least-recently-used first. */
const scratch = new Map<string, Map<string, string>>();

/** The collision-proof identity of one session's scratch within one control-plane instance. */
export function panelScratchScopeKey(sessionId: string, instanceScope = LOCAL_INSTANCE_SCOPE): string {
  return instanceResourceKey(sessionId, instanceScope);
}

/** Move a scope to the most-recently-used end so eviction takes the genuinely idle one. */
function touch(scope: string, values: Map<string, string>): void {
  scratch.delete(scope);
  scratch.set(scope, values);
}

/** Read one remembered value, or undefined when the session never stored it. */
export function readPanelScratch(scope: string, key: string): string | undefined {
  const values = scratch.get(scope);
  if (!values) return undefined;
  touch(scope, values);
  return values.get(key);
}

/**
 * Remember a value, or forget it when `value` is null. Callers pass null for a body holding its
 * own default: there is nothing to restore, and not storing it keeps a default that is derived
 * from the session (the commit message, say) free to follow the session when it changes.
 */
export function writePanelScratch(scope: string, key: string, value: string | null): void {
  const values = scratch.get(scope);
  if (value === null) {
    if (!values) return;
    values.delete(key);
    if (values.size === 0) scratch.delete(scope);
    else touch(scope, values);
    return;
  }
  const next = values ?? new Map<string, string>();
  next.set(key, value);
  touch(scope, next);
  while (scratch.size > PANEL_SCRATCH_SESSION_LIMIT) {
    const oldest = scratch.keys().next();
    if (oldest.done || oldest.value === scope) break;
    scratch.delete(oldest.value);
  }
}

/** Restore a value, falling back whenever the stored one is missing or the caller rejects it. */
export function restorePanelScratch<T extends string>(
  scope: string,
  key: string,
  fallback: T,
  accept?: (raw: string) => boolean,
): T {
  const stored = readPanelScratch(scope, key);
  if (stored === undefined) return fallback;
  return accept === undefined || accept(stored) ? (stored as T) : fallback;
}

/**
 * Forget one value only if it is still the exact one the caller is done with.
 *
 * The compare is the point: a body that finishes consuming a draft (a side chat message that was
 * sent) may already be unmounted, and a blind delete would then discard a replacement the user
 * typed after remounting.
 */
export function clearPanelScratchIf(scope: string, key: string, expected: string): void {
  if (readPanelScratch(scope, key) === expected) writePanelScratch(scope, key, null);
}

/** Forget everything. Test-only: module state would otherwise leak between cases. */
export function clearPanelScratch(): void {
  scratch.clear();
}

/** How many sessions currently hold scratch. Test-only. */
export function panelScratchScopeCount(): number {
  return scratch.size;
}

/** The scratch scope for one session under the mounted control-plane instance. */
export function usePanelScratchScope(sessionId: string): string {
  const instanceScope = useInstanceScope();
  return useMemo(() => panelScratchScopeKey(sessionId, instanceScope), [instanceScope, sessionId]);
}

interface ScratchEntry<T extends string> {
  scope: string;
  key: string;
  /** The default in force when this value was last settled — see the adoption rule below. */
  fallback: T;
  value: T;
}

/**
 * `useState` for free text — a draft, a path, an address — that must survive the body being
 * unmounted. Prose is restored verbatim; pass `accept` for the rare text the body will go on to
 * parse (a URL it hands to `new URL`), so a value it could not honour degrades to the fallback.
 */
export function usePanelScratchText(
  scope: string,
  key: string,
  fallback = "",
  accept?: (raw: string) => boolean,
): [string, (next: string | ((prior: string) => string)) => void] {
  return usePanelScratchValue<string>(scope, key, fallback, accept);
}

/**
 * `useState` for a remembered choice from a closed set — a diff scope, a layout, a tab.
 *
 * `accept` is how the body refuses a value it can no longer honour: a scope that only exists for
 * worktree sessions, a layout this build dropped. Stale scratch then degrades to the default
 * instead of wedging the panel on a choice it cannot render — the stance
 * `parseStoredRightPanelMode` takes for the persisted mode.
 */
export function usePanelScratchChoice<T extends string>(
  scope: string,
  key: string,
  fallback: T,
  accept: (raw: string) => boolean,
): [T, (next: T | ((prior: T) => T)) => void] {
  return usePanelScratchValue<T>(scope, key, fallback, accept);
}

/**
 * The shared implementation. The scope is tracked alongside the value rather than assumed: a body
 * that stays mounted while the session under it changes must re-read for the incoming session, or
 * the outgoing session's draft would be shown — and then written back — under the new one. The
 * re-read is derived during render and committed with `setState`, so no frame is ever painted with
 * the wrong session's text.
 */
function usePanelScratchValue<T extends string>(
  scope: string,
  key: string,
  fallback: T,
  accept?: (raw: string) => boolean,
): [T, (next: T | ((prior: T) => T)) => void] {
  const [entry, setEntry] = useState<ScratchEntry<T>>(() => ({
    scope,
    key,
    fallback,
    value: restorePanelScratch(scope, key, fallback, accept),
  }));
  let current = entry;
  if (entry.scope !== scope || entry.key !== key) {
    current = { scope, key, fallback, value: restorePanelScratch(scope, key, fallback, accept) };
    setEntry(current);
  } else if (entry.fallback !== fallback) {
    // The default moved under a mounted body — Review's commit message defaults to the session
    // title, and the session can be renamed while the panel is open. An untouched value follows it;
    // one the user has edited is theirs and stays. Without this, the old default is written out as
    // if it were a draft and pins the previous title for the rest of the tab's life.
    current = { ...entry, fallback, value: entry.value === entry.fallback ? fallback : entry.value };
    setEntry(current);
  }

  const { scope: liveScope, key: liveKey, fallback: liveFallback, value } = current;
  useEffect(() => {
    writePanelScratch(liveScope, liveKey, value === liveFallback ? null : value);
  }, [liveFallback, liveKey, liveScope, value]);

  const setValue = useCallback((next: T | ((prior: T) => T)) => {
    setEntry((prior) => {
      const resolved = typeof next === "function" ? next(prior.value) : next;
      return resolved === prior.value ? prior : { ...prior, value: resolved };
    });
  }, []);

  return [value, setValue];
}
