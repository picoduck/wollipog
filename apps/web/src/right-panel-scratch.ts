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
 *
 * It bounds recreatable scratch only. A scope still holding unsent text the user wrote is exempt,
 * because evicting it destroys that text with nothing to recover it from (#1283) — so the map's
 * size is this limit plus however many sessions the user has an unsent draft open in, and it falls
 * back to the limit as those drafts are sent or emptied. Predictable at the bound is the point: the
 * only thing that can push a scope out is scratch the app can rebuild by asking the runner again.
 */
export const PANEL_SCRATCH_SESSION_LIMIT = 8;

/**
 * What is at stake in one remembered value, and therefore whether the scope holding it may be
 * evicted to stay under the limit.
 *
 * `draft` is text the user typed and has not sent: a pull request description, a side chat message.
 * Nothing else knows it, so losing it loses it for good. `disposable` is everything the app can
 * reconstruct — the directory Files was browsing, the diff layout, an address bar's contents — for
 * which eviction costs a re-listing and a re-choice, not the user's words.
 *
 * Recorded at the write, never inferred from the key, for the reason `dirty` is recorded below: the
 * call site is the only place that knows which of its values the user authored.
 */
export type PanelScratchRetention = "draft" | "disposable";

/**
 * One remembered value. The revision is a global monotonic stamp, so a caller that captured it
 * before an await can tell "nobody has touched this draft since" from "it was changed and then
 * changed back to the same bytes" — which a value compare alone cannot.
 */
interface ScratchValue {
  value: string;
  revision: number;
  retention: PanelScratchRetention;
}

/** Scope key → logical key → value. Insertion order is least-recently-used first. */
const scratch = new Map<string, Map<string, ScratchValue>>();
let nextRevision = 1;

/** The collision-proof identity of one session's scratch within one control-plane instance. */
export function panelScratchScopeKey(sessionId: string, instanceScope = LOCAL_INSTANCE_SCOPE): string {
  return instanceResourceKey(sessionId, instanceScope);
}

/** Move a scope to the most-recently-used end so eviction takes the genuinely idle one. */
function touch(scope: string, values: Map<string, ScratchValue>): void {
  scratch.delete(scope);
  scratch.set(scope, values);
}

/**
 * Whether a scope is holding text the user wrote and has not sent.
 *
 * Blank is not held text: a composer whose message was sent keeps writing back the empty string it
 * was reset to, and an emptied field is text the user deleted. Treating either as a draft would pin
 * a scope forever on nothing, which is how an exemption quietly becomes a leak.
 */
function holdsUnsentText(values: Map<string, ScratchValue>): boolean {
  for (const held of values.values()) {
    if (held.retention === "draft" && held.value.trim() !== "") return true;
  }
  return false;
}

/**
 * Bring the map back under the limit by dropping the least recently used scopes that hold nothing
 * the user wrote, oldest first. Scopes with unsent text are skipped rather than counted out, so a
 * tour of eight other sessions costs the drafts nothing; when every scope is holding a draft there
 * is simply nothing to evict and the map stays over the limit until one of them is sent.
 *
 * Every mutation runs this, removals included: a draft that is sent releases its scope, and if that
 * scope is still holding a directory the map would otherwise stay over the limit until the next
 * unrelated write happened to collect it.
 */
function evictDisposableScopes(keep: string): void {
  for (const [candidate, values] of scratch) {
    if (scratch.size <= PANEL_SCRATCH_SESSION_LIMIT) return;
    if (candidate === keep || holdsUnsentText(values)) continue;
    scratch.delete(candidate);
  }
}

/** Read one remembered value, or undefined when the session never stored it. */
export function readPanelScratch(scope: string, key: string): string | undefined {
  const values = scratch.get(scope);
  if (!values) return undefined;
  touch(scope, values);
  return values.get(key)?.value;
}

/** The stamp of the value currently held, or 0 when nothing is. */
export function panelScratchRevision(scope: string, key: string): number {
  return scratch.get(scope)?.get(key)?.revision ?? 0;
}

/**
 * Remember a value, or forget it when `value` is null. Callers pass null for a body that is holding
 * a value it never took ownership of — see the `dirty` provenance the hook tracks below.
 */
export function writePanelScratch(
  scope: string,
  key: string,
  value: string | null,
  retention: PanelScratchRetention = "disposable",
): void {
  const values = scratch.get(scope);
  if (value === null) {
    if (!values) return;
    values.delete(key);
    if (values.size === 0) scratch.delete(scope);
    else touch(scope, values);
    evictDisposableScopes(scope);
    return;
  }
  const next = values ?? new Map<string, ScratchValue>();
  next.set(key, { value, revision: nextRevision++, retention });
  touch(scope, next);
  evictDisposableScopes(scope);
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
 * Forget one value only if it is still untouched since `revision` and still reads as `expected`.
 *
 * A body that finishes consuming a draft — a side chat message that was sent — may already be
 * unmounted by the time it can say so, and a blind delete would discard whatever replaced it. The
 * value compare alone is not enough: a user who retypes the same message after coming back would
 * have it deleted under them, and the mounted body would not even learn its scratch was gone. The
 * revision is what distinguishes an untouched draft from one that came back to the same bytes.
 */
export function clearPanelScratchIf(
  scope: string,
  key: string,
  expected: string,
  revision: number,
): void {
  if (panelScratchRevision(scope, key) !== revision) return;
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
  /** The default in force for this entry; a moved default is adopted only while `dirty` is false. */
  fallback: T;
  value: T;
  /**
   * Whether the body has taken ownership of this value — the user typed, chose, or navigated.
   *
   * Recorded, never inferred from `value !== fallback`. Equality cannot tell an untouched default
   * from text the user wrote that happens to read the same, so inferring it lets a rename to that
   * same text mark the value untouched and a later rename silently overwrite what was typed.
   */
  dirty: boolean;
}

/**
 * A freshly restored entry. A value the scratch still holds was put there by a body that owned it,
 * so restoring it restores that ownership too — but a refused value is not restored at all, and the
 * body is left holding its default with no claim on it.
 */
function restored<T extends string>(
  scope: string,
  key: string,
  fallback: T,
  accept?: (raw: string) => boolean,
): ScratchEntry<T> {
  const stored = readPanelScratch(scope, key);
  const usable = stored !== undefined && (accept === undefined || accept(stored));
  return { scope, key, fallback, value: usable ? (stored as T) : fallback, dirty: usable };
}

/**
 * `useState` for free text the app could rebuild — a path, an address, an id — that must survive
 * the body being unmounted. Text is restored verbatim; pass `accept` for the rare value the body
 * will go on to parse (a URL it hands to `new URL`), so one it could not honour degrades to the
 * fallback.
 *
 * Use `usePanelScratchDraft` instead for anything the user is composing: this one's value is spent
 * to keep the scope budget, and a message nobody else has a copy of must not be.
 */
export function usePanelScratchText(
  scope: string,
  key: string,
  fallback = "",
  accept?: (raw: string) => boolean,
): [string, (next: string | ((prior: string) => string)) => void] {
  return usePanelScratchValue<string>(scope, key, fallback, "disposable", accept);
}

/**
 * `useState` for unsent text the user is writing — a pull request description, a commit message, a
 * side chat message. Identical to `usePanelScratchText` except that the session holding it is
 * exempt from scope eviction for as long as the text is non-blank, so visiting other sessions
 * cannot destroy it (#1283).
 *
 * No `accept`: prose has no closed set to refuse it against, and a draft degraded to its default
 * would be the very loss this exemption exists to prevent.
 *
 * The exemption follows the text, not the form's fate. A body that consumes its draft says so —
 * Side Chat clears the message it sent, which releases the scope — while Review leaves the four
 * fields of a submitted commit or pull request exactly as the user left them, so that session keeps
 * its scope for as long as the text is still in the box. That is the same bargain as any other
 * unsent text: the map grows only where someone typed, and only while what they typed is on screen.
 */
export function usePanelScratchDraft(
  scope: string,
  key: string,
  fallback = "",
): [string, (next: string | ((prior: string) => string)) => void] {
  return usePanelScratchValue<string>(scope, key, fallback, "draft");
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
  return usePanelScratchValue<T>(scope, key, fallback, "disposable", accept);
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
  retention: PanelScratchRetention,
  accept?: (raw: string) => boolean,
): [T, (next: T | ((prior: T) => T)) => void] {
  const [entry, setEntry] = useState<ScratchEntry<T>>(() => restored(scope, key, fallback, accept));
  let current = entry;
  if (entry.scope !== scope || entry.key !== key) {
    current = restored(scope, key, fallback, accept);
    setEntry(current);
  } else if (entry.fallback !== fallback && !entry.dirty) {
    // The default moved under a mounted body — Review's commit message defaults to the session
    // title, and the session can be renamed while the panel is open. A value nobody has taken
    // ownership of follows it; anything the user made theirs stays exactly as they left it.
    current = { ...entry, fallback, value: fallback };
    setEntry(current);
  } else if (entry.fallback !== fallback) {
    current = { ...entry, fallback };
    setEntry(current);
  }

  const { scope: liveScope, key: liveKey, value, dirty } = current;
  useEffect(() => {
    writePanelScratch(liveScope, liveKey, dirty ? value : null, retention);
  }, [dirty, liveKey, liveScope, retention, value]);

  const setValue = useCallback((next: T | ((prior: T) => T)) => {
    setEntry((prior) => {
      const resolved = typeof next === "function" ? next(prior.value) : next;
      // Only a value that actually moves takes ownership. Bodies re-report what they are already
      // holding — the Files loader announces the root directory it just listed on every mount —
      // and treating that as ownership would store a meaningless entry for every session merely
      // opened, spending the scope budget and evicting a session whose drafts someone still wants.
      if (resolved === prior.value) return prior;
      return { ...prior, value: resolved, dirty: true };
    });
  }, []);

  return [value, setValue];
}
