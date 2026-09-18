/**
 * Scratch state for the right panel's mode bodies.
 *
 * Every body unmounts when the user switches modes or closes the panel, so a half-typed pull
 * request description, the directory that was navigated into, and the view choices that were made
 * are destroyed by a glance at another mode (#1202). Component state cannot survive that; this
 * module parks those values outside the React tree, keyed by the session they describe, and hands
 * them back when the body mounts again.
 *
 * Held in memory and mirrored into one localStorage record, so a reload resumes where the panel was
 * left rather than starting over (#1282). A reload is not the deliberate "start over" it was once
 * taken for: it is also what a crash, an update, and a mistyped Cmd-R look like, and the half
 * written pull request description those destroyed was not recoverable from anywhere else.
 *
 * The record is a mirror, never a second source of truth. Memory stays authoritative while the page
 * lives, every mutation rewrites the record, and the record obeys the same eviction rule the map
 * obeys plus a hard character ceiling — so what survives a reload can never outgrow what survives a
 * mode switch. Storage that is absent, denied, full, or corrupt costs exactly the persistence: the
 * panel then behaves as it did before any of this existed.
 *
 * Reuse rather than a second mechanism. The record is written through instance-storage.ts, the same
 * layer composer-drafts.ts persists its durable fallback through, so a quota refusal or a
 * restricted webview degrades identically for both. There are no tombstones here because there is
 * nothing to reconcile: composer-drafts.ts needs them to stop one record's two stores (IndexedDB
 * and its localStorage fallback) resurrecting each other, and this has one store.
 *
 * Unsent text consequently reaches browser storage, which is a real widening — anything with access
 * to this origin's storage can read it. That is the bargain the composer beside it already makes
 * for prompt drafts, under the same scoping and the same eviction rules.
 *
 * Every tab on the origin shares the one record and writes the whole of its own map into it, so a
 * tab that never saw another's scope drops that scope when it writes. With two tabs open, a reload
 * therefore restores what the tab that wrote last knew about. That is under-delivery, never a
 * regression — none of this survived a reload at all before — and it is deliberately left alone,
 * because the cheap repairs are wrong and the sound ones are a redesign. Adopting the other tab's
 * scopes on a `storage` event, or merging the stored record in on every write, makes this tab
 * re-persist text the other tab has since sent: the resurrection problem composer-drafts.ts carries
 * a tombstone layer to solve. Doing it honestly means either that layer, or moving persistence off
 * the whole-map write entirely — an origin-wide lock (Web Locks) around a read, apply this
 * mutation's own set or delete, write back — so a later unrelated write observes deletions instead
 * of undoing them. That second route also means the record stops being this tab's map, which is
 * what currently makes its bound and its ceiling trivially true. Either way it is a change of its
 * own, and neither is needed for the per-session reload this module is here to deliver.
 *
 * The scope key is instance-qualified, because a remote control plane can reuse a local session id
 * (see instance-storage.ts) and one session's drafts must never surface under another's. That
 * qualification is also what makes one flat record safe to share between instances.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LOCAL_INSTANCE_SCOPE,
  instanceResourceKey,
  loadBrowserStorageValue,
  removeBrowserStorageValue,
  saveBrowserStorageValue,
} from "./instance-storage.js";
import { useInstanceScope } from "./instance-scope.js";

/**
 * How many sessions are remembered at once. Panel scratch is unbounded input (drafts, paths) held
 * for as long as the browser will keep it, so the oldest session's scratch is dropped rather than
 * letting a long navigation session grow the map forever. Well past the handful of sessions anyone
 * switches between while writing one pull request.
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
 *
 * `keep` is the scope the mutation just touched, and it is spared on removals for the same reason
 * as on writes: it is by definition the most recently used, which is never what least-recently-used
 * eviction takes. Collecting it here would mean sending a side chat message also discards that same
 * session's browsed directory while eight idle sessions keep theirs — a visible loss in the session
 * someone is looking at, to settle a soft bound one mutation earlier. The next mutation touching
 * any other scope collects it.
 */
function evictDisposableScopes(keep: string): void {
  for (const [candidate, values] of scratch) {
    if (scratch.size <= PANEL_SCRATCH_SESSION_LIMIT) return;
    if (candidate === keep || holdsUnsentText(values)) continue;
    scratch.delete(candidate);
  }
}

/**
 * The one localStorage record the whole map is mirrored into. Flat and shared between instances:
 * scope keys are already instance-qualified, so nothing inside can be read under another instance's
 * session, and a single record is what makes the stored size bounded by construction — an index of
 * per-session records could be orphaned by a crash or another tab and grow with nobody to collect
 * it. `wollipog.rightpanel.mode` beside it is stored the same way, for the same panel.
 */
const PERSIST_KEY = "wollipog.right-panel-scratch.v1";

/**
 * The hard ceiling, in characters of serialized JSON, on what is mirrored to storage.
 *
 * `PANEL_SCRATCH_SESSION_LIMIT` bounds the scope count but deliberately exempts scopes holding
 * unsent text, and a form that keeps its text after submitting holds its scope for as long as it is
 * mounted (#1375). In memory that overshoot ends with the tab; persisted, it would not, so the
 * record needs a bound that does not depend on anyone releasing anything. Scopes are mirrored
 * most-recently-used first and whatever no longer fits is simply not written — it is still in
 * memory for the life of this page, and the newest state is what a reload most wants back.
 *
 * Generous against real use (a few kilobytes per session) and small against the ~5MB localStorage
 * gets, which composer drafts and panel preferences also live in.
 */
export const PANEL_SCRATCH_PERSIST_CHAR_LIMIT = 256 * 1024;

/** `{"version":1,"scopes":[]}` — what a record costs before any scope is in it. */
const PERSIST_ENVELOPE_CHARS = 25;

/**
 * The exact record this tab last put in storage — or read out of it at hydration — so a refused
 * rewrite can tell its own stale record, which it must take back, from one another tab has written
 * since, which is not this tab's to correct.
 */
let lastWritten: string | null = null;

/**
 * Whether the persisted record has been read into the map yet. Read lazily rather than at import,
 * so a module graph that pulls this in outside a browser costs nothing, and so tests can drive a
 * reload by dropping memory alone.
 */
let hydrated = false;

/** One scope as it is stored: the values, without the revisions, which are page-local. */
interface PersistedValue {
  value: string;
  retention: PanelScratchRetention;
}

/**
 * Read back one stored scope, dropping anything malformed rather than the record around it.
 *
 * Corruption here is a hand-edited value or a record from a build that stored something else, and
 * the loss it should cause is exactly the values it touched. Returning null for the whole record on
 * one bad key would let a single stale entry wipe every other session's drafts on every reload.
 */
function parsePersistedValues(raw: unknown): Map<string, ScratchValue> {
  const values = new Map<string, ScratchValue>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return values;
  for (const [key, held] of Object.entries(raw as Record<string, unknown>)) {
    if (!held || typeof held !== "object") continue;
    const { value, retention } = held as Partial<PersistedValue>;
    if (typeof value !== "string") continue;
    if (retention !== "draft" && retention !== "disposable") continue;
    // A fresh revision, never a stored one. Revisions answer "has this been touched since I looked
    // at it", and every caller that could have looked went away with the previous page.
    values.set(key, { value, revision: nextRevision++, retention });
  }
  return values;
}

/** Fill the map from storage exactly once. Anything unreadable leaves it empty. */
function hydrate(): void {
  if (hydrated) return;
  // Set before reading: a parse that throws must not re-run on every subsequent read.
  hydrated = true;
  const raw = loadBrowserStorageValue(PERSIST_KEY);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable as a whole, so there is nothing to salvage and no reason to keep paying for it.
    removeBrowserStorageValue(PERSIST_KEY);
    return;
  }
  const record = parsed as { version?: unknown; scopes?: unknown };
  if (record?.version !== 1 || !Array.isArray(record.scopes)) {
    removeBrowserStorageValue(PERSIST_KEY);
    return;
  }
  // This page is now working from that record, so it is the one a refused rewrite would be leaving
  // behind, and the one this tab is entitled to take back.
  lastWritten = raw;
  for (const entry of record.scopes) {
    if (!entry || typeof entry !== "object") continue;
    const { scope, values } = entry as { scope?: unknown; values?: unknown };
    if (typeof scope !== "string" || scope === "") continue;
    const held = parsePersistedValues(values);
    if (held.size > 0) scratch.set(scope, held);
  }
  // Stored order is least-recently-used first, so the map is already in eviction order. A record
  // written under a larger bound still has to obey this build's: nothing here is spared as "just
  // touched", because nothing here has been.
  evictDisposableScopes("");
}

/**
 * Mirror the map into storage. Called by every mutation, including the removals and evictions that
 * shrink it, so the record never holds a value the map has let go of.
 *
 * Reads are not mirrored even though they reorder the map: a mount reading its scratch back would
 * otherwise write to storage, and the only thing at stake is which scope a later eviction takes
 * first — settled by the next mutation, which is the thing that can evict anyway.
 */
function persist(): void {
  const stored: string[] = [];
  let size = PERSIST_ENVELOPE_CHARS;
  // Most-recently-used first so the ceiling spends itself on the freshest state, and skipping
  // rather than stopping so one outsized draft costs only itself.
  for (const [scope, values] of [...scratch].reverse()) {
    const entry = JSON.stringify({
      scope,
      values: Object.fromEntries([...values].map(([key, held]): [string, PersistedValue] =>
        [key, { value: held.value, retention: held.retention }])),
    });
    if (size + entry.length + 1 > PANEL_SCRATCH_PERSIST_CHAR_LIMIT) continue;
    stored.push(entry);
    size += entry.length + 1;
  }
  if (stored.length === 0) {
    // Removing is this tab writing its empty map, which is what any successful mutation does to the
    // shared record. The refusal path below is the one that must not presume to speak for it.
    removeBrowserStorageValue(PERSIST_KEY);
    lastWritten = readBackAfterRemoval();
    return;
  }
  // Assembled from the pieces that were measured, so the ceiling holds for the string actually
  // written. Restored in stored order, which is why it goes back least-recently-used first.
  stored.reverse();
  const record = `{"version":1,"scopes":[${stored.join(",")}]}`;
  if (saveBrowserStorageValue(PERSIST_KEY, record)) {
    lastWritten = record;
    return;
  }
  // A refusal (private mode, a full quota, a restricted webview) is not an error here — but a record
  // this tab left behind is now a lie. It describes a map this one has moved past, so a reload would
  // restore older text, including a draft this very mutation cleared after sending it. Degrading to
  // no restore is the honest failure; the next mutation that is allowed to write puts the whole map
  // back, so the exposure is one mutation wide.
  //
  // Only this tab's own record, though. Another tab may have written since, and that record is its
  // latest state rather than this one's stale state — taking it back would cost that tab the reload
  // this whole module exists for, to correct a lie it never told.
  const abandoned = loadBrowserStorageValue(PERSIST_KEY);
  if (abandoned !== null && abandoned === lastWritten) {
    removeBrowserStorageValue(PERSIST_KEY);
    lastWritten = readBackAfterRemoval();
  }
}

/**
 * What this tab still owns after a best-effort removal: nothing when the record is gone, and the
 * record itself when the removal did not take.
 *
 * `removeBrowserStorageValue` reports no outcome, and a storage that is refusing writes can refuse
 * a removal too. Assuming it worked would hand back ownership of a record that is still sitting
 * there, and the next refused write would no longer recognise it as this tab's to take back —
 * leaving exactly the obsolete record the retraction exists to prevent.
 */
function readBackAfterRemoval(): string | null {
  return loadBrowserStorageValue(PERSIST_KEY);
}

/** Read one remembered value, or undefined when the session never stored it. */
export function readPanelScratch(scope: string, key: string): string | undefined {
  hydrate();
  const values = scratch.get(scope);
  if (!values) return undefined;
  touch(scope, values);
  return values.get(key)?.value;
}

/** The stamp of the value currently held, or 0 when nothing is. */
export function panelScratchRevision(scope: string, key: string): number {
  hydrate();
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
  hydrate();
  const values = scratch.get(scope);
  if (value === null) {
    if (!values) return;
    values.delete(key);
    if (values.size === 0) scratch.delete(scope);
    else touch(scope, values);
    evictDisposableScopes(scope);
    persist();
    return;
  }
  const next = values ?? new Map<string, ScratchValue>();
  next.set(key, { value, revision: nextRevision++, retention });
  touch(scope, next);
  evictDisposableScopes(scope);
  persist();
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
  if (readPanelScratch(scope, key) !== expected) return;
  writePanelScratch(scope, key, null);
  // A body mounted since the draft was consumed restored it into its own state, and would show it
  // — and write it straight back — until told (#1284). Removing the stored copy is only half of
  // consuming it.
  for (const listener of [...(consumedListeners.get(consumedListenerKey(scope, key)) ?? [])]) {
    listener(expected);
  }
}

/** Bodies currently showing one scope's value, told when that value is consumed out from under them. */
const consumedListeners = new Map<string, Set<(consumed: string) => void>>();

function consumedListenerKey(scope: string, key: string): string {
  return JSON.stringify([scope, key]);
}

function onPanelScratchConsumed(scope: string, key: string, listener: (consumed: string) => void): () => void {
  const id = consumedListenerKey(scope, key);
  const listeners = consumedListeners.get(id) ?? new Set();
  listeners.add(listener);
  consumedListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && consumedListeners.get(id) === listeners) consumedListeners.delete(id);
  };
}

/**
 * Write a mounted body's value unless it is exactly what is already held.
 *
 * A body mounting reports the value it just restored, and treating that as a new write would
 * re-stamp the revision — so a draft sent from the previous mount, with its send still in flight,
 * would look replaced and `clearPanelScratchIf` would leave the sent text behind (#1284). Anything
 * the user actually types moves the value, so a retyped draft still earns a fresh revision.
 */
function syncPanelScratch(
  scope: string,
  key: string,
  value: string | null,
  retention: PanelScratchRetention,
): void {
  hydrate();
  const held = scratch.get(scope)?.get(key);
  if (value !== null && held?.value === value && held.retention === retention) return;
  writePanelScratch(scope, key, value, retention);
}

/** Forget everything, persisted included. Test-only: state would otherwise leak between cases. */
export function clearPanelScratch(): void {
  scratch.clear();
  hydrated = false;
  lastWritten = null;
  removeBrowserStorageValue(PERSIST_KEY);
}

/**
 * Forget what is in memory while leaving the stored record alone — the half of a page reload a test
 * process cannot perform on itself. The next read hydrates from storage, exactly as a fresh page
 * would. Test-only.
 */
export function dropPanelScratchMemory(): void {
  scratch.clear();
  hydrated = false;
  // A reload is a fresh module: it has written nothing yet, and learns what is in storage by
  // hydrating from it.
  lastWritten = null;
}

/** How many sessions currently hold scratch. Test-only. */
export function panelScratchScopeCount(): number {
  hydrate();
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
 *
 * Persistence does not widen that bargain, but it does remove the closing of the tab as the thing
 * that eventually ends it (#1375), which is why the stored record has a ceiling of its own rather
 * than trusting the exemption to be released.
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
    syncPanelScratch(liveScope, liveKey, dirty ? value : null, retention);
  }, [dirty, liveKey, liveScope, retention, value]);

  // A value consumed elsewhere — a send that landed after this body remounted — must leave the box
  // as well as the store. Only while the box still holds exactly what was consumed: anything the
  // user has typed since is theirs.
  useEffect(() => onPanelScratchConsumed(liveScope, liveKey, (consumed) => {
    setEntry((prior) => prior.scope === liveScope && prior.key === liveKey && prior.value === consumed
      ? { ...prior, value: prior.fallback, dirty: false }
      : prior);
  }), [liveKey, liveScope]);

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
