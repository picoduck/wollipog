/**
 * Scratch state for the right panel's mode bodies.
 *
 * Every body unmounts when the user switches modes or closes the panel, so a half-typed pull
 * request description, the directory that was navigated into, and the view choices that were made
 * are destroyed by a glance at another mode (#1202). Component state cannot survive that; this
 * module parks those values outside the React tree, keyed by the session they describe, and hands
 * them back when the body mounts again.
 *
 * Held in memory and mirrored into localStorage, so a reload resumes where the panel was left
 * rather than starting over (#1282). A reload is not the deliberate "start over" it was once taken
 * for: it is also what a crash, an update, and a mistyped Cmd-R look like, and the half written
 * pull request description those destroyed was not recoverable from anywhere else.
 *
 * Storage is a mirror, never a second source of truth. Memory stays authoritative while the page
 * lives, every mutation rewrites the scope it touched (after a short pause, #2764), and what is
 * stored obeys the same eviction rule the map obeys plus a hard character ceiling — so what survives
 * a reload can never outgrow what survives a mode switch. Storage that is absent, denied, full, or
 * corrupt costs exactly the persistence: the panel then behaves as it did before any of this existed.
 *
 * Unsent text consequently reaches browser storage, which is a real widening — anything with access
 * to this origin's storage can read it. That is the bargain the composer beside it already makes
 * for prompt drafts, under the same scoping and the same eviction rules.
 *
 * Every tab on the origin shares that storage, which is what decides its shape (#1391). #1282 wrote
 * one whole-map record, so a tab that never saw another's scope dropped that scope when it wrote,
 * and a reload restored only what the tab that wrote last knew about. The shape here is instead the
 * one composer-drafts.ts already uses: a record per scope, so tabs working on different sessions
 * never write over each other, plus a deletion marker layer, because per-scope records alone are
 * not enough — a tab still holding its own live copy of a scope would write back the draft another
 * tab has since sent, which is the resurrection problem tombstones exist to solve. A marker
 * outlives the value it retires, so the send wins over the stale copy wherever that copy surfaces.
 *
 * The bounds are consequently enforced against what is actually stored rather than against one
 * tab's map: the scope count and the character ceiling are swept across every record on the origin,
 * including records this tab has never held. The tab that writes is the tab that collects.
 *
 * Ownership of a record is exact rather than inferred, which is what lets a refused write correct
 * only its own story. Each record carries the id of the page that wrote it, so a tab retracting the
 * stale record it left behind can never take back one another tab has written since — the residual
 * risk #1383 accepted while it tracked ownership by the exact bytes it last wrote, where a removal
 * that failed and later recovered could hand one tab a claim on another's record.
 *
 * Records are read and written directly rather than through instance-storage.ts, which the
 * whole-map record used. That layer leaves one permanent migration marker per storage key it
 * touches, which a per-scope layout turns into unbounded growth keyed by every session ever opened,
 * and it buys nothing here: these keys are new, so there is no earlier spelling to migrate from,
 * and the identical try/catch degradation is a few lines locally.
 *
 * The scope key is instance-qualified, because a remote control plane can reuse a local session id
 * (see instance-storage.ts) and one session's drafts must never surface under another's. That
 * qualification is also what makes records safe to share between instances under one prefix.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserRandomUUID } from "./browser-crypto.js";
import {
  LOCAL_INSTANCE_SCOPE,
  instanceResourceKey,
  type KeyValueStorage,
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
 *
 * `updatedAt` answers a different question, and has to be comparable between tabs to answer it: is
 * this value older than the deletion another page recorded for the same key? Revisions cannot say,
 * because each page counts from one.
 */
interface ScratchValue {
  value: string;
  revision: number;
  retention: PanelScratchRetention;
  updatedAt: number;
}

/** Scope key → logical key → value. Insertion order is least-recently-used first. */
const scratch = new Map<string, Map<string, ScratchValue>>();
let nextRevision = 1;

/**
 * When each live scope was last used, as a stamp the stored records also carry.
 *
 * Reads reorder the map without being mirrored (see `persistScope`), so the stored order alone
 * would drift from the real one and the storage sweep would collect a scope this tab keeps coming
 * back to. Recency is therefore read from here for a scope this page holds, and from the record for
 * one only another page does.
 */
const scopeTouchedAt = new Map<string, number>();

/**
 * A cross-tab comparable stamp: the wall clock, in milliseconds, plus a fraction this page holds.
 *
 * Every tab of the origin reads the same clock, so a stamp says when a value was typed, and that is
 * what orders two tabs' edits of one key. Writes are mirrored after a pause (#2764), so one tab
 * cannot see another's edit when it stamps its own; the moment each was typed is the only order
 * that does not depend on which tab happened to flush first.
 *
 * A stamp therefore never runs ahead of the clock by a millisecond or more. A page counter that did,
 * so as to keep several stamps inside one millisecond apart, let a burst of edits in one tab outrank
 * an edit another tab typed a moment later. Within a page, stamps instead step by a fraction of a
 * millisecond, so they stay strictly increasing, and a value typed in the same millisecond as the
 * deletion of its predecessor is still newer than it.
 *
 * The fraction is what separates two pages' stamps in one millisecond, so two different values
 * never share a stamp: a deletion marker carries the stamp of the value it retires, and a shared
 * stamp would let it retire the other value too. Fractions are multiples of 1/1024, which a double
 * holds exactly at today's millisecond counts.
 */
const STAMP_STEP = 1 / 1024;
const pageFraction = (1 + Math.floor(Math.random() * 511)) * STAMP_STEP;
let lastStamp = 0;
function stamp(): number {
  const next = Date.now() + pageFraction;
  lastStamp = next > lastStamp ? next : lastStamp + STAMP_STEP;
  return lastStamp;
}

/** The millisecond a stamp was minted in. */
function stampMillisecond(at: number): number {
  return Math.floor(at);
}

/** The collision-proof identity of one session's scratch within one control-plane instance. */
export function panelScratchScopeKey(sessionId: string, instanceScope = LOCAL_INSTANCE_SCOPE): string {
  return instanceResourceKey(sessionId, instanceScope);
}

/** Move a scope to the most-recently-used end so eviction takes the genuinely idle one. */
function touch(scope: string, values: Map<string, ScratchValue>): void {
  scratch.delete(scope);
  scratch.set(scope, values);
  scopeTouchedAt.set(scope, stamp());
}

/** Drop a scope from memory, recency included, so nothing keeps pointing at what is gone. */
function forgetScope(scope: string): void {
  scratch.delete(scope);
  scopeTouchedAt.delete(scope);
}

/**
 * How long a typed value waits for the next keystroke before it is mirrored, and the longest a run
 * of keystrokes can hold it back (#2764).
 *
 * Mirroring a scope reads, merges and rewrites its record, and every keystroke in a panel draft used
 * to pay that. Memory is authoritative while the page lives, so a value that has not reached storage
 * yet is still shown, restored on remount and consumed exactly as before; what waits is only the copy
 * a reload would read. That copy is flushed when the page is hidden or unloaded, when a body that
 * holds the value unmounts or moves to another session, and whenever a value is removed, so the gap
 * is a crash during a pause of at most `PANEL_SCRATCH_PERSIST_MAX_DELAY_MS`.
 */
export const PANEL_SCRATCH_PERSIST_DELAY_MS = 300;
export const PANEL_SCRATCH_PERSIST_MAX_DELAY_MS = 1_000;

/** Scope → keys set since the scope was last mirrored, in the order they were set. */
const pendingWrites = new Map<string, Set<string>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;

function schedulePersist(scope: string, key: string): void {
  const keys = pendingWrites.get(scope) ?? new Set<string>();
  keys.delete(key);
  keys.add(key);
  pendingWrites.set(scope, keys);
  listenToPage();
  const now = Date.now();
  if (flushTimer === null) firstPendingAt = now;
  else clearTimeout(flushTimer);
  const delay = Math.max(0, Math.min(PANEL_SCRATCH_PERSIST_DELAY_MS,
    firstPendingAt + PANEL_SCRATCH_PERSIST_MAX_DELAY_MS - now));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPanelScratch();
  }, delay);
}

/** The writes one scope still owes storage, taken so that whoever persists the scope carries them. */
function takePendingWrites(scope: string): Mutation[] {
  const keys = pendingWrites.get(scope);
  if (keys === undefined) return [];
  pendingWrites.delete(scope);
  if (pendingWrites.size === 0) cancelFlushTimer();
  return [...keys].map((key) => ({ key, removed: false }));
}

function cancelFlushTimer(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}

/**
 * Mirror every value still waiting for storage, or only one scope's.
 *
 * Bodies call this as they let go of a scope, and the page calls it as it is hidden or unloaded, so
 * nothing typed waits on a timer that will never fire.
 */
export function flushPanelScratch(scope?: string): void {
  const scopes = scope === undefined ? [...pendingWrites.keys()] : pendingWrites.has(scope) ? [scope] : [];
  for (const pending of scopes) persistScope(pending, takePendingWrites(pending));
}

/**
 * A sweep after another tab's change, which this page learns of only afterwards. Waiting for this
 * page's next write would leave the origin over a bound for as long as nobody here types, so the
 * change itself schedules the sweep, coalesced like the writes are.
 */
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    enforceRecordBounds(null);
  }, PANEL_SCRATCH_PERSIST_DELAY_MS);
}

/** The window this page's listeners are registered on, so a swapped test window gets its own. */
let listeningTo: Window | null = null;

function listenToPage(): void {
  if (typeof window === "undefined" || listeningTo === window) return;
  listeningTo = window;
  const flushAll = () => flushPanelScratch();
  window.addEventListener("pagehide", flushAll);
  // Mobile browsers can discard a backgrounded page without a pagehide, so being hidden flushes too.
  window.document?.addEventListener?.("visibilitychange", () => {
    if (window.document.visibilityState === "hidden") flushAll();
  });
  // Another tab changed scratch storage, so what this page measured no longer describes it: the
  // next write sweeps rather than trusting a total that leaves the other tab's growth out.
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith(RECORD_PREFIX)) return;
    storedCharsEstimate = null;
    scheduleSweep();
  });
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
    // Whatever it still owes storage goes first: storage is collected by its own sweep, not here.
    flushPanelScratch(candidate);
    forgetScope(candidate);
  }
}

/**
 * Where one scope's record lives. Shared between instances under one prefix: scope keys are already
 * instance-qualified, so nothing inside can be read under another instance's session.
 *
 * Nothing indexes these. An index could be orphaned by a crash or another tab and then grow with
 * nobody to collect it, so the prefix is the index: every sweep enumerates the origin's keys, which
 * is also what lets a record another tab left behind be collected at all.
 */
const RECORD_PREFIX = "wollipog.right-panel-scratch.v2:";

/** The single whole-map record #1282 wrote, imported once and then retired (#1391). */
const WHOLE_MAP_KEY = "wollipog.right-panel-scratch.v1";

/**
 * The hard ceiling, in characters of serialized JSON, on what is mirrored to storage.
 *
 * `PANEL_SCRATCH_SESSION_LIMIT` bounds the scope count but deliberately exempts scopes holding
 * unsent text, and a draft the user neither sends nor empties holds its scope for as long as it
 * exists. In memory that overshoot ends with the tab; persisted, it would not, so the record needs a
 * bound that does not depend on anyone releasing anything (#1375). Scopes are mirrored
 * most-recently-used first and whatever no longer fits is simply not written — it is still in
 * memory for the life of this page, and the newest state is what a reload most wants back.
 *
 * Generous against real use (a few kilobytes per session) and small against the ~5MB localStorage
 * gets, which composer drafts and panel preferences also live in.
 */
export const PANEL_SCRATCH_PERSIST_CHAR_LIMIT = 256 * 1024;

/**
 * How many scopes may keep a deletion marker once their last value is gone. The only bound on the
 * marker layer, and deliberately the only one.
 *
 * A marker has to outlive every page still holding the copy it retires, and a browser tab lives as
 * long as someone leaves it open — weeks, in this app's own usage. So there is no age at which a
 * marker is provably spent, and an expiry by wall clock would simply hand the oldest markers back
 * to whichever stale tab was still holding the sent draft: its next mutation would write that text
 * into the record again, and a reload would restore a message the user sent a fortnight ago.
 *
 * A count is a bound that does not make that claim. Four times the scope bound is generous against
 * the handful of sessions two tabs have open, it is a hard stop rather than one more thing that
 * grows with every session ever opened, and at a few hundred characters each the whole layer is
 * kilobytes. It is not free of the same hazard — the thirty-third send retires the oldest marker —
 * but it spends markers in the order they stop mattering rather than on a timer.
 */
export const PANEL_SCRATCH_CLEARED_SCOPE_LIMIT = 32;

/**
 * This page's identity as a writer of records, so a refused write can recognise exactly the record
 * it left behind. Random per page: two tabs of the same origin must never answer the same.
 */
function newWriterId(): string {
  try {
    return browserRandomUUID();
  } catch {
    // No crypto at all (an exotic webview, a non-browser module graph). A weaker id still separates
    // this page from another, and the only thing at stake is which stale record may be retracted.
    return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
let writerId = newWriterId();

/**
 * The exact bytes each scope's record held when this page hydrated from it.
 *
 * Ownership is normally the writer id in the record, but a page that has only read has not written
 * one yet — and its first mutation is exactly when a refusal can leave the pre-mutation record
 * behind. Matching the hydrated bytes says "nobody has written since" without ever claiming another
 * page's record: any write by another tab carries that tab's writer id, so the bytes differ.
 * Dropped as soon as this page writes the scope, when the writer id takes over.
 */
const hydratedRaw = new Map<string, string>();

/**
 * Whether the persisted records have been read into the map yet. Read lazily rather than at import,
 * so a module graph that pulls this in outside a browser costs nothing, and so tests can drive a
 * reload by dropping memory alone.
 */
let hydrated = false;

/** One value as it is stored: no revision, which is page-local, and a stamp tabs can compare. */
interface PersistedValue {
  value: string;
  retention: PanelScratchRetention;
  updatedAt: number;
}

/** One scope as it is stored, once validated. */
interface PersistedRecord {
  writer: string;
  touchedAt: number;
  values: Map<string, PersistedValue>;
  /** Logical key → when it was cleared. What stops a stale live copy writing the value back. */
  cleared: Map<string, number>;
}

function recordKey(scope: string): string {
  return `${RECORD_PREFIX}${scope}`;
}

/** localStorage, or nothing at all — a restricted webview throws on the property itself. */
function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readRaw(storageKey: string): string | null {
  try {
    return browserStorage()?.getItem(storageKey) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(storageKey: string, value: string): boolean {
  try {
    const target = browserStorage();
    if (target === null) return false;
    target.setItem(storageKey, value);
    return true;
  } catch {
    // Browser persistence is best-effort: private mode, a restricted webview, an exhausted quota.
    return false;
  }
}

function deleteRaw(storageKey: string): void {
  try {
    browserStorage()?.removeItem(storageKey);
  } catch {
    // Best-effort, and deliberately not reported: the callers that care read the key back instead,
    // because a storage refusing writes can refuse a removal too.
  }
}

/**
 * Every scope record on the origin, this page's and every other page's.
 *
 * Enumeration is what makes the prefix an index nobody has to maintain. A storage that cannot be
 * enumerated — no `key`, no `length` — simply has no records to find, which degrades to the no
 * restore this module already degrades to everywhere else.
 */
function listRecordKeys(): string[] {
  const keys: string[] = [];
  try {
    const target = browserStorage();
    if (target === null || typeof target.key !== "function" || typeof target.length !== "number") {
      return keys;
    }
    for (let index = 0; index < target.length; index += 1) {
      const storageKey = target.key(index);
      if (storageKey !== null && storageKey.startsWith(RECORD_PREFIX)) keys.push(storageKey);
    }
  } catch {
    return keys;
  }
  return keys;
}

/**
 * Read back one stored record, dropping anything malformed rather than the record around it.
 *
 * Corruption here is a hand-edited value or a record from a build that stored something else, and
 * the loss it should cause is exactly the values it touched. Refusing the whole record on one bad
 * key would let a single stale entry wipe a session's drafts on every reload.
 *
 * Deletion markers are applied here, once, so nothing downstream has to consult both halves: a
 * value a marker still covers is dropped, and a marker a newer value has overtaken is retired.
 * Returns null when nothing usable is left, which is the caller's cue to collect the key.
 */
function parseRecord(raw: string): PersistedRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as {
    version?: unknown;
    writer?: unknown;
    touchedAt?: unknown;
    values?: unknown;
    cleared?: unknown;
  };
  if (record.version !== 2 || !Number.isFinite(record.touchedAt)) return null;

  const values = new Map<string, PersistedValue>();
  if (record.values && typeof record.values === "object" && !Array.isArray(record.values)) {
    for (const [key, held] of Object.entries(record.values as Record<string, unknown>)) {
      if (key === "" || !held || typeof held !== "object") continue;
      const { value, retention, updatedAt } = held as Partial<PersistedValue>;
      if (typeof value !== "string") continue;
      if (retention !== "draft" && retention !== "disposable") continue;
      if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) continue;
      values.set(key, { value, retention, updatedAt });
    }
  }

  const cleared = new Map<string, number>();
  if (record.cleared && typeof record.cleared === "object" && !Array.isArray(record.cleared)) {
    for (const [key, at] of Object.entries(record.cleared as Record<string, unknown>)) {
      if (key === "" || typeof at !== "number" || !Number.isFinite(at)) continue;
      cleared.set(key, at);
    }
  }
  applyClearedMarkers(values, cleared);
  if (values.size === 0 && cleared.size === 0) return null;
  return {
    // A record with no writer belongs to nobody, which is the safe answer: it can be collected by
    // the bounds like any other, and retracted by no one.
    writer: typeof record.writer === "string" ? record.writer : "",
    touchedAt: record.touchedAt as number,
    values,
    cleared,
  };
}

/**
 * Settle values against markers, in place.
 *
 * A value written no later than the deletion is the copy the deletion is for, and goes. A value
 * written after it is the user typing again, which retires the marker: keeping it would suppress
 * every future value under that key for as long as the marker lived.
 */
function applyClearedMarkers(
  values: Map<string, PersistedValue>,
  cleared: Map<string, number>,
): void {
  for (const [key, at] of cleared) {
    const held = values.get(key);
    if (held === undefined) continue;
    if (held.updatedAt <= at) values.delete(key);
    else cleared.delete(key);
  }
}

function readRecord(scope: string): PersistedRecord | null {
  const raw = readRaw(recordKey(scope));
  return raw === null ? null : parseRecord(raw);
}

/** Fill the map from storage exactly once. Anything unreadable leaves it empty. */
function hydrate(): void {
  if (hydrated) return;
  // Set before reading: a parse that throws must not re-run on every subsequent read.
  hydrated = true;
  listenToPage();
  const imported = importWholeMapRecord();
  // The markers each record carried when this page read it, which is later than the moment the
  // import captured what it captured. Another tab can send a draft in between, and the fold below
  // has to answer to the newer of the two views.
  const markersWhenLoaded = new Map<string, Map<string, number>>();
  const loaded: Array<{ scope: string; record: PersistedRecord; raw: string }> = [];
  for (const storageKey of listRecordKeys()) {
    const scope = storageKey.slice(RECORD_PREFIX.length);
    const raw = readRaw(storageKey);
    const record = raw === null ? null : parseRecord(raw);
    if (raw === null || record === null || scope === "") {
      deleteRaw(storageKey);
      continue;
    }
    loaded.push({ scope, record, raw });
    markersWhenLoaded.set(scope, record.cleared);
  }
  // Least-recently-used first, so the map arrives in eviction order.
  loaded.sort((left, right) => left.record.touchedAt - right.record.touchedAt);
  for (const { scope, record, raw } of loaded) {
    hydratedRaw.set(scope, raw);
    scopeTouchedAt.set(scope, record.touchedAt);
    if (record.values.size === 0) continue;
    const values = new Map<string, ScratchValue>();
    for (const [key, held] of record.values) {
      // A fresh revision, never a stored one. Revisions answer "has this been touched since I
      // looked at it", and every caller that could have looked went away with the previous page.
      values.set(key, { ...held, revision: nextRevision++ });
    }
    scratch.set(scope, values);
  }
  // Anything the whole-map import could not get into storage still belongs to this page. Storage
  // that refused those writes costs the reload after this one, not the drafts in front of the user
  // now — memory is authoritative, and it has no reason to wait for storage to agree.
  //
  // Against the markers this page has just read, not the ones the import saw. A key missing from a
  // record is not the same as a key nobody has spoken for: another tab sending that draft between
  // the import and this read leaves a marker and no value, and folding the imported copy in on the
  // strength of its absence would put a sent message back in front of the reader.
  for (const { scope, values } of imported) {
    const markers = markersWhenLoaded.get(scope);
    const held = scratch.get(scope) ?? new Map<string, ScratchValue>();
    for (const [key, value] of values) {
      if (held.has(key)) continue;
      const clearedAt = markers?.get(key);
      if (clearedAt !== undefined && value.updatedAt <= clearedAt) continue;
      held.set(key, { ...value, revision: nextRevision++ });
    }
    if (held.size > 0 && !scratch.has(scope)) scratch.set(scope, held);
  }
  // Records written under a larger bound still have to obey this build's: nothing here is spared as
  // "just touched", because nothing here has been.
  evictDisposableScopes("");
  enforceRecordBounds(null);
}

/**
 * The stamp imported whole-map values are given.
 *
 * Older than anything this build can mint, deliberately. The import may run more than once — its
 * source is only removed when every scope has been written, and that removal can itself be refused
 * — so an imported value must never outrank a v2 value the user has edited since. It must still
 * lose to any deletion marker, which is exactly what a stamp below every marker's gives.
 */
const IMPORTED_VALUE_STAMP = 1;

/**
 * Take over whatever the single whole-map record still holds and retire it, in that order.
 *
 * The drafts in it are the same unsent text this module exists to keep, so a deploy that simply
 * ignored it would destroy exactly what #1282 was for — and so would removing it before its
 * contents were safely somewhere else. Storage that refuses the writes keeps the old record for
 * the next load; storage that refuses the removal replays an import that can no longer overwrite
 * anything, because imported values are stamped below everything.
 *
 * Returns what was imported, so a page whose writes were all refused still hands the drafts to
 * the reader. Memory is authoritative, and it has no reason to wait for storage to agree.
 */
function importWholeMapRecord(): Array<{ scope: string; values: Map<string, PersistedValue> }> {
  const raw = readRaw(WHOLE_MAP_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable as a whole, so there is nothing to salvage and no reason to keep paying for it.
    deleteRaw(WHOLE_MAP_KEY);
    return [];
  }
  const record = parsed as { version?: unknown; scopes?: unknown };
  if (record?.version !== 1 || !Array.isArray(record.scopes)) {
    deleteRaw(WHOLE_MAP_KEY);
    return [];
  }
  const imported: Array<{ scope: string; values: Map<string, PersistedValue> }> = [];
  let allStored = true;
  // Stored least-recently-used first, and a stamp per scope in that order keeps the ordering.
  for (const entry of record.scopes) {
    if (!entry || typeof entry !== "object") continue;
    const { scope, values } = entry as { scope?: unknown; values?: unknown };
    if (typeof scope !== "string" || scope === "") continue;
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    const held = new Map<string, PersistedValue>();
    for (const [key, stored] of Object.entries(values as Record<string, unknown>)) {
      if (key === "" || !stored || typeof stored !== "object") continue;
      const { value, retention } = stored as Partial<PersistedValue>;
      if (typeof value !== "string") continue;
      if (retention !== "draft" && retention !== "disposable") continue;
      held.set(key, { value, retention, updatedAt: IMPORTED_VALUE_STAMP });
    }
    if (held.size === 0) continue;
    // Merged into whatever is already there rather than written over it, on the same terms every
    // other write uses: a v2 value or a marker from a previous run of this import wins.
    const existing = readRecord(scope);
    const merged = new Map<string, PersistedValue>(existing?.values);
    const markers = new Map<string, number>(existing?.cleared);
    for (const [key, value] of held) if (!merged.has(key)) merged.set(key, value);
    applyClearedMarkers(merged, markers);
    // What survived the markers, captured before `writeRecord` may shed values for its own ceiling.
    // Reporting the raw import instead would hand the reader a draft the markers just retired — a
    // message already sent, back in the box, which is the whole thing those markers are for.
    imported.push({ scope, values: new Map(merged) });
    allStored = writeRecord(scope, stamp(), merged, markers) !== null && allStored;
  }
  // Only once every scope is somewhere else. A removal that is itself refused simply replays a
  // now-harmless import on the next load.
  if (allStored) deleteRaw(WHOLE_MAP_KEY);
  return imported;
}

/**
 * Mirror one scope into storage, applying this mutation's own deletions to whatever is there.
 *
 * Read, apply, write rather than overwrite: the record may hold keys another tab set and this one
 * has never seen, and dropping those is the whole-map failure this replaced. `mutated` is the key
 * this mutation actually moved — removed, and it becomes the marker that keeps another tab's live
 * copy from writing the value back; set, and it is stamped against what is stored so the page that
 * just wrote is the page that wins.
 *
 * Every other key this page holds keeps the stamp it was written under and can lose to a newer
 * stored copy, which is the point: this page's map is no longer entitled to speak for the scope.
 *
 * Reads are not mirrored even though they reorder the map: a mount reading its scratch back would
 * otherwise write to storage. What is at stake is only which scope a later sweep collects first,
 * and `scopeTouchedAt` already carries that without spending a write.
 */
function persistScope(scope: string, mutations: readonly Mutation[]): void {
  const now = Date.now();
  const storedRaw = readRaw(recordKey(scope));
  const stored = storedRaw === null ? null : parseRecord(storedRaw);
  const values = new Map<string, PersistedValue>(stored?.values);
  const cleared = new Map<string, number>(stored?.cleared);
  for (const mutated of mutations) {
    if (mutated.removed) {
      // Stamped with the value that was actually removed, never with "now". A marker's job is to
      // retire one copy of one value, and a marker stamped now would also retire a replacement
      // another tab typed while this page's send was in flight — text nobody else has, destroyed by
      // a deletion that was never about it. Another tab's stale copy carries the same stamp as the
      // value removed here, so it is still suppressed, which is all the marker was ever for.
      const previous = cleared.get(mutated.key) ?? 0;
      cleared.set(mutated.key, Math.max(previous, mutated.removedAt));
      continue;
    }
    // A set keeps the stamp of the moment it was typed, and the merge below orders it against
    // whatever another page stored under the key since: the newer edit wins, and a deletion
    // marker retires an edit typed before the value it removed, as it would have had this edit been
    // mirrored at once. Two kinds of stored stamp say nothing about which edit came first, and the
    // edit being mirrored is moved past them:
    //
    // - One in the future: a clock that has since been corrected, an older build's counter, a
    //   hand-edited record. The edit replaces the copy it was typed over; without this it would lose
    //   to it until the clock caught up, and a send of it would leave a marker below that copy.
    // - One in the same millisecond: another page typing, or sending, while both edits waited. The
    //   later flush wins, which is the order storage gave them when every edit was mirrored at once,
    //   and the two values never share a stamp a marker could retire both by.
    //
    // A move past a future stamp is not where this page's later stamps continue from, so one stray
    // record cannot pin every later stamp to its future.
    const held = scratch.get(scope)?.get(mutated.key);
    if (held === undefined) continue;
    const rivals = [values.get(mutated.key)?.updatedAt, cleared.get(mutated.key)]
      .filter((at): at is number => at !== undefined)
      .sort((left, right) => left - right);
    for (const rival of rivals) {
      if (rival < held.updatedAt) continue;
      if (rival >= now + 1) {
        held.updatedAt = stampMillisecond(rival) + 1 + pageFraction;
      } else if (stampMillisecond(rival) === stampMillisecond(held.updatedAt)) {
        held.updatedAt = rival + STAMP_STEP;
        if (held.updatedAt > lastStamp) lastStamp = held.updatedAt;
      }
    }
  }
  for (const [key, held] of scratch.get(scope) ?? []) {
    const rival = values.get(key);
    // This page's copy wins a tie: a stored value of the same age is at worst the same bytes.
    if (rival === undefined || held.updatedAt >= rival.updatedAt) {
      values.set(key, { value: held.value, retention: held.retention, updatedAt: held.updatedAt });
    }
  }
  applyClearedMarkers(values, cleared);
  const written = writeRecord(scope, scopeTouchedAt.get(scope) ?? stamp(), values, cleared);
  // An existing record rewritten within the measured bounds cannot have broken either of them, so
  // the sweep, which reads every record on the origin, is skipped and this write touched one key.
  // A removal always sweeps: a scope that stops holding unsent text can become the one to collect.
  const before = storedRaw === null ? 0 : recordKey(scope).length + storedRaw.length;
  if (written !== null && storedRaw !== null && storedCharsEstimate !== null &&
      now - storedCharsMeasuredAt < PANEL_SCRATCH_SWEEP_MAX_AGE_MS) {
    storedCharsEstimate += written - before;
    if (written === 0) storedRecordsEstimate -= 1;
    if (mutations.every((mutated) => !mutated.removed) &&
        storedCharsEstimate <= PANEL_SCRATCH_PERSIST_CHAR_LIMIT &&
        storedRecordsEstimate <= PANEL_SCRATCH_SESSION_LIMIT) return;
  }
  enforceRecordBounds(scope);
}

/**
 * What the last sweep measured stored, plus this page's own writes since; null until a sweep has
 * run, and again whenever another tab changes a scratch record (its `storage` event). Another tab's
 * writes are not in it, and two tabs could each stay under the ceiling by their own count while
 * their records together do not, so the event discards it, and so does age, for a page that missed
 * the event.
 */
let storedCharsEstimate: number | null = null;
let storedRecordsEstimate = 0;
let storedCharsMeasuredAt = 0;
const PANEL_SCRATCH_SWEEP_MAX_AGE_MS = 30_000;

/**
 * What one mutation did to one key.
 *
 * A removal carries the stamp of the value it removed rather than the moment it happened, because
 * that is what the marker it becomes has to be measured against.
 */
type Mutation = { key: string; removed: false } | { key: string; removed: true; removedAt: number };

function serializeRecord(
  touchedAt: number,
  values: Map<string, PersistedValue>,
  cleared: Map<string, number>,
): string {
  return JSON.stringify({
    version: 2,
    writer: writerId,
    touchedAt,
    values: Object.fromEntries(values),
    cleared: Object.fromEntries(cleared),
  });
}

/**
 * Store one scope's record, or take back this page's own if storage will not have it.
 *
 * The record carries its own ceiling: a scope whose values will not fit sheds them largest first,
 * and never its markers. The markers are the only part another tab depends on, and they are what
 * keeps a send from coming back — scratch is recoverable by asking again, a sent message is not.
 *
 * Returns the characters the scope now holds in storage, key included (0 once it is removed), or null
 * when storage refused the write.
 */
function writeRecord(
  scope: string,
  touchedAt: number,
  values: Map<string, PersistedValue>,
  cleared: Map<string, number>,
): number | null {
  const storageKey = recordKey(scope);
  const budget = PANEL_SCRATCH_PERSIST_CHAR_LIMIT - storageKey.length;
  let serialized = serializeRecord(touchedAt, values, cleared);
  if (serialized.length > budget) {
    const largestFirst = [...values].sort((left, right) => right[1].value.length - left[1].value.length);
    for (const [key] of largestFirst) {
      values.delete(key);
      serialized = serializeRecord(touchedAt, values, cleared);
      if (serialized.length <= budget) break;
    }
  }
  if (values.size === 0 && cleared.size === 0) {
    // Nothing left to say, by this page or any other: the record was already empty when it was read
    // and this mutation added nothing to it.
    deleteRaw(storageKey);
    hydratedRaw.delete(scope);
    return 0;
  }
  if (writeRaw(storageKey, serialized)) {
    hydratedRaw.delete(scope);
    return storageKey.length + serialized.length;
  }
  // A refusal (private mode, a full quota, a restricted webview) is not an error here — but a record
  // this page left behind is now a lie. It describes a scope this page has moved past, so a reload
  // would restore older text, including a draft this very mutation cleared after sending it.
  // Degrading to no restore is the honest failure; the next mutation that is allowed through puts
  // the scope back, so the exposure is one mutation wide.
  retractOwnRecord(scope);
  return null;
}

/**
 * Remove the record this page is responsible for, and only that one.
 *
 * Another tab may have written since, and that record is its latest state rather than this page's
 * stale state — taking it back would cost that tab exactly the reload this module exists for, to
 * correct a story it never told. The writer id makes the question exact, where matching the bytes a
 * page last wrote could not: a removal that failed and later recovered used to hand this page a
 * claim on whatever record it happened to read back (#1383).
 *
 * Ownership is deliberately not surrendered when the removal is refused too. Storage that is
 * refusing writes can refuse removals, and the record left sitting there is still this page's to
 * take back on the first mutation that gets the chance.
 */
function retractOwnRecord(scope: string): void {
  const storageKey = recordKey(scope);
  const raw = readRaw(storageKey);
  if (raw === null) return;
  if (raw !== hydratedRaw.get(scope) && recordWriter(raw) !== writerId) return;
  deleteRaw(storageKey);
}

/** Who wrote a stored record, without paying for the rest of it. */
function recordWriter(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { writer?: unknown } | null;
    return parsed && typeof parsed === "object" && typeof parsed.writer === "string"
      ? parsed.writer
      : null;
  } catch {
    return null;
  }
}

/**
 * Hold the origin's records under the scope bound and the character ceiling.
 *
 * The bounds belong here rather than to any one map, because the records are the union of every
 * tab's: one tab's map cannot be what keeps them finite. `keep` is the scope the mutation just
 * touched, spared for the same reason the in-memory eviction spares it — it is by definition the
 * most recently used, which is never what least-recently-used collection takes.
 *
 * Under both bounds this costs an enumeration and no parsing. A keystroke no longer pays even that:
 * writes are mirrored after a pause, and a write to an existing record skips the sweep while the
 * last measurement says no bound can bind (see `persistScope`).
 */
function enforceRecordBounds(keep: string | null): void {
  const raws: Array<{ scope: string; storageKey: string; raw: string; bytes: number }> = [];
  let total = 0;
  for (const storageKey of listRecordKeys()) {
    const raw = readRaw(storageKey);
    if (raw === null) continue;
    const bytes = storageKey.length + raw.length;
    total += bytes;
    raws.push({ scope: storageKey.slice(RECORD_PREFIX.length), storageKey, raw, bytes });
  }
  storedCharsEstimate = total;
  storedRecordsEstimate = raws.length;
  storedCharsMeasuredAt = Date.now();
  // The marker bounds cannot bind while the scope bound holds, since a marker-only record is still
  // a record and the marker bound is the larger of the two.
  if (raws.length <= PANEL_SCRATCH_SESSION_LIMIT && total <= PANEL_SCRATCH_PERSIST_CHAR_LIMIT) return;

  const now = Date.now();
  interface Candidate {
    scope: string;
    storageKey: string;
    bytes: number;
    recency: number;
    holdsUnsentText: boolean;
    markerOnly: boolean;
  }
  const candidates: Candidate[] = [];
  for (const { scope, storageKey, raw, bytes } of raws) {
    const record = parseRecord(raw);
    if (record === null || scope === "") {
      deleteRaw(storageKey);
      storedCharsEstimate = (storedCharsEstimate ?? 0) - bytes;
      storedRecordsEstimate -= 1;
      continue;
    }
    let unsent = false;
    for (const held of record.values.values()) {
      if (held.retention === "draft" && held.value.trim() !== "") {
        unsent = true;
        break;
      }
    }
    candidates.push({
      scope,
      storageKey,
      bytes,
      // A scope this page is still using outranks its stored stamp, which reads never refresh.
      recency: scopeTouchedAt.get(scope) ?? record.touchedAt,
      holdsUnsentText: unsent,
      markerOnly: record.values.size === 0,
    });
  }
  candidates.sort((left, right) => left.recency - right.recency);
  const kept = new Set(candidates);
  const collect = (candidate: Candidate): void => {
    deleteRaw(candidate.storageKey);
    kept.delete(candidate);
    storedCharsEstimate = (storedCharsEstimate ?? 0) - candidate.bytes;
    storedRecordsEstimate -= 1;
  };

  // The scope bound, over records that still hold something, on the same terms the map uses: text
  // the user has not sent is never what a bound spends.
  let scopes = candidates.filter((candidate) => !candidate.markerOnly).length;
  for (const candidate of candidates) {
    if (scopes <= PANEL_SCRATCH_SESSION_LIMIT) break;
    if (candidate.markerOnly || candidate.scope === keep || candidate.holdsUnsentText) continue;
    collect(candidate);
    scopes -= 1;
  }

  // Records left holding only markers are counted apart, so a tombstone layer cannot spend the
  // scope budget that live scratch needs — and cannot grow without one of its own either.
  let markerOnly = candidates.filter((candidate) => candidate.markerOnly && kept.has(candidate)).length;
  for (const candidate of candidates) {
    if (markerOnly <= PANEL_SCRATCH_CLEARED_SCOPE_LIMIT) break;
    if (!candidate.markerOnly || !kept.has(candidate)) continue;
    collect(candidate);
    markerOnly -= 1;
  }

  // The ceiling. Markers are charged against it first, and are never what it sheds: they are what
  // keeps a sent draft from coming back, they are already held to their own count above, and the
  // whole layer is a few kilobytes against a 256KB budget. Shedding one to make room for a newer
  // draft would let the tab still holding the sent text write it back — which is the defect this
  // change exists to close, reintroduced by its own bound. `writeRecord` takes the same side.
  let size = 0;
  for (const candidate of candidates) {
    if (kept.has(candidate) && candidate.markerOnly) size += candidate.bytes;
  }
  // Values, most-recently-used first so the ceiling goes on the freshest state, and skipping rather
  // than stopping so one outsized scope costs only itself.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (!kept.has(candidate) || candidate.markerOnly) continue;
    if (size + candidate.bytes > PANEL_SCRATCH_PERSIST_CHAR_LIMIT) collect(candidate);
    else size += candidate.bytes;
  }
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
    // A value still waiting for storage is mirrored first: its stamp is final only once it has been
    // weighed against the stored copy it replaces (one stamped in the future, say), and the marker
    // this removal leaves is stamped with it. Removed unsettled, that copy would outlive the marker,
    // and the reload after a send would bring back the draft the send replaced.
    if (pendingWrites.get(scope)?.has(key)) flushPanelScratch(scope);
    // Only a value that was actually there is a deletion. A body mounting reports that it owns
    // nothing under keys it never wrote, and recording a marker for each of those would retire
    // values other tabs are still holding — and spend the marker budget on nothing.
    const removed = values.get(key);
    if (removed === undefined) {
      evictDisposableScopes(scope);
      return;
    }
    values.delete(key);
    if (values.size === 0) forgetScope(scope);
    else touch(scope, values);
    evictDisposableScopes(scope);
    // A removal is mirrored at once, carrying whatever the scope still owed storage: its marker is
    // what keeps another tab's copy of a sent draft from being written back, so it does not wait.
    persistScope(scope, [...takePendingWrites(scope), { key, removed: true, removedAt: removed.updatedAt }]);
    return;
  }
  const next = values ?? new Map<string, ScratchValue>();
  next.set(key, { value, revision: nextRevision++, retention, updatedAt: stamp() });
  touch(scope, next);
  evictDisposableScopes(scope);
  schedulePersist(scope, key);
}

/**
 * Forget one value only if it is still untouched since `revision` and still reads as `expected`.
 *
 * A body that finishes consuming a draft — a side chat message that was sent — may already be
 * unmounted by the time it can say so, and a blind delete would discard whatever replaced it. The
 * value compare alone is not enough: a user who retypes the same message after coming back would
 * have it deleted under them, and the mounted body would not even learn its scratch was gone. The
 * revision is what distinguishes an untouched draft from one that came back to the same bytes.
 *
 * `leaveShown` releases the stored copy without emptying a box that is showing it. Review's commit
 * message is submitted by a commit yet stays on screen for the next one (#1375): once git holds it,
 * it is no longer text only this panel knows, so it stops pinning the scope and a reload no longer
 * brings it back, but the reviewer looking at it keeps it until they move on.
 */
export function clearPanelScratchIf(
  scope: string,
  key: string,
  expected: string,
  revision: number,
  { leaveShown = false }: { leaveShown?: boolean } = {},
): void {
  if (panelScratchRevision(scope, key) !== revision) return;
  if (readPanelScratch(scope, key) !== expected) return;
  writePanelScratch(scope, key, null);
  consumedRevisions.set(consumedListenerKey(scope, key), { revision, leaveShown });
  if (leaveShown) return;
  // A body mounted since the draft was consumed restored it into its own state, and would show it
  // — and write it straight back — until told (#1284). Removing the stored copy is only half of
  // consuming it.
  for (const listener of [...(consumedListeners.get(consumedListenerKey(scope, key)) ?? [])]) {
    listener(expected);
  }
}

/**
 * The revision each key last had consumed, and whether the consumer asked for it to stay on screen.
 * A body can restore a value and then have it consumed before its effects have run — too early to
 * have been listening, and early enough that its write-back would put the sent text straight back.
 * Revisions are global stamps, so a body that restored exactly this one is holding exactly what was
 * consumed. One entry per key ever consumed.
 */
const consumedRevisions = new Map<string, { revision: number; leaveShown: boolean }>();

/** How the value a body restored was consumed since, or null when it was not. */
function consumedAs(scope: string, key: string, revision: number): "cleared" | "shown" | null {
  const consumed = consumedRevisions.get(consumedListenerKey(scope, key));
  if (consumed?.revision !== revision) return null;
  return consumed.leaveShown ? "shown" : "cleared";
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
  pendingWrites.clear();
  cancelFlushTimer();
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  dropPanelScratchMemory();
  for (const storageKey of listRecordKeys()) deleteRaw(storageKey);
  deleteRaw(WHOLE_MAP_KEY);
}

/**
 * Forget what is in memory while leaving the stored record alone — the half of a page reload a test
 * process cannot perform on itself. The next read hydrates from storage, exactly as a fresh page
 * would. Test-only.
 */
export function dropPanelScratchMemory(): void {
  // A real reload hides the page first, and hiding it flushes what was still waiting for storage.
  flushPanelScratch();
  storedCharsEstimate = null;
  scratch.clear();
  consumedRevisions.clear();
  scopeTouchedAt.clear();
  hydratedRaw.clear();
  hydrated = false;
  // A reload is a fresh page: it has written nothing yet, it is not the page that wrote whatever is
  // in storage, and it learns what is there by hydrating from it.
  writerId = newWriterId();
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
  /**
   * The stored revision `value` was restored from, for as long as `value` is still exactly that;
   * null once it moves or when nothing was restored. How the body recognises a restored value that
   * was consumed before it could subscribe.
   */
  restoredRevision: number | null;
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
  return {
    scope,
    key,
    fallback,
    value: usable ? (stored as T) : fallback,
    dirty: usable,
    restoredRevision: usable ? panelScratchRevision(scope, key) : null,
  };
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
 * The exemption follows the text, so a body that submits its draft must say so, or a scope pinned
 * by text the forge already holds stays pinned for good — and, persisted, past the tab (#1375).
 * Side Chat clears the message it sent; Review resets a pull request's fields once it is opened and
 * releases the commit message once git has it. Both go through `clearPanelScratchIf`.
 *
 * The stored record still keeps a ceiling of its own rather than trusting every body to do that:
 * a draft nobody submits is exempt for as long as it exists, which persistence makes open-ended.
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
    current = { ...entry, fallback, value: fallback, restoredRevision: null };
    setEntry(current);
  } else if (entry.fallback !== fallback) {
    current = { ...entry, fallback };
    setEntry(current);
  }

  const { scope: liveScope, key: liveKey, value, dirty, restoredRevision } = current;
  useEffect(() => {
    const consumed = restoredRevision === null ? null : consumedAs(liveScope, liveKey, restoredRevision);
    if (consumed !== null) {
      // Consumed between this body restoring it and this effect running: writing it back would
      // resurrect sent text in the store and, through it, after a reload. A value its consumer left
      // on screen stays there, unstored, exactly as it does in a body that was already listening.
      if (consumed === "cleared") {
        setEntry((prior) => prior.restoredRevision === restoredRevision
          ? { ...prior, value: prior.fallback, dirty: false, restoredRevision: null }
          : prior);
      }
      return;
    }
    syncPanelScratch(liveScope, liveKey, dirty ? value : null, retention);
  }, [dirty, liveKey, liveScope, restoredRevision, retention, value]);

  // Letting go of a scope (unmounting, or moving to another session) mirrors what it typed there
  // now, rather than leaving it to a timer. Declared after the write above, so its cleanup runs
  // after that effect has recorded the last value.
  useEffect(() => () => flushPanelScratch(liveScope), [liveScope]);

  // A value consumed elsewhere — a send that landed after this body remounted — must leave the box
  // as well as the store. Only while the box still holds exactly what was consumed: anything the
  // user has typed since is theirs.
  useEffect(() => onPanelScratchConsumed(liveScope, liveKey, (consumed) => {
    setEntry((prior) => prior.scope === liveScope && prior.key === liveKey && prior.value === consumed
      ? { ...prior, value: prior.fallback, dirty: false, restoredRevision: null }
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
      return { ...prior, value: resolved, dirty: true, restoredRevision: null };
    });
  }, []);

  return [value, setValue];
}
