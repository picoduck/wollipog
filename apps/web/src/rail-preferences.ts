import { experimentForViewName, type ExperimentFlags } from "./experiments.js";
import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";
import { GLOBAL_VIEW_ITEMS, type GlobalViewName } from "./navigation.js";

/**
 * User-configured navigation-rail visibility and order (#385).
 *
 * The visible order is the SOLE source of the bare-digit shortcuts: the first nine visible
 * destinations get `1`–`9`, a tenth gets `0`, later ones get none, and digits are never
 * assignable directly — reordering or hiding is the only way to move one. Hidden and
 * experiment-disabled destinations consume no slot. Settings is deliberately not part of this
 * vocabulary at all: on a phone it is the only Settings entry point (pinned trailing row of the
 * More sheet), so a preference must never be able to strand it (#458).
 *
 * Preferences key on the INTERNAL destination names, never display labels, so label renames
 * (Inbox → Sessions) can never orphan a saved order. A saved name that no longer exists is
 * dropped silently; a known name missing from a save (a destination added by a newer client)
 * is inserted after its nearest canonical predecessor that survives in the saved order, which
 * is deterministic and keeps the newcomer beside its default neighbors.
 */

export const RAIL_PREFERENCES_STORAGE_KEY = "wollipog.navigation.rail";
const RAIL_PREFERENCES_SCHEMA_VERSION = 1;

const CANONICAL_ORDER: readonly GlobalViewName[] = GLOBAL_VIEW_ITEMS.map((item) => item.name);
const KNOWN = new Set<string>(CANONICAL_ORDER);

/** Sessions must stay recoverable from the rail itself, so it can never be hidden. */
export const REQUIRED_RAIL_VIEWS: ReadonlySet<GlobalViewName> = new Set(["inbox"]);

export interface RailPreferences {
  /** Every known destination exactly once, in the user's configured order. */
  order: readonly GlobalViewName[];
  /** The hidden subset of `order`; required destinations never appear here. */
  hidden: ReadonlySet<GlobalViewName>;
}

export function defaultRailPreferences(): RailPreferences {
  return { order: [...CANONICAL_ORDER], hidden: new Set() };
}

export function railPreferencesAreDefault(preferences: RailPreferences): boolean {
  return preferences.hidden.size === 0 &&
    preferences.order.length === CANONICAL_ORDER.length &&
    preferences.order.every((name, index) => name === CANONICAL_ORDER[index]);
}

/**
 * Reconcile a saved order against the current destination vocabulary: drop removed names,
 * dedupe, and slot never-saved names after their nearest surviving canonical predecessor.
 */
export function reconcileRailOrder(saved: readonly string[]): GlobalViewName[] {
  const order: GlobalViewName[] = [];
  for (const name of saved) {
    if (KNOWN.has(name) && !order.includes(name as GlobalViewName)) order.push(name as GlobalViewName);
  }
  for (const [canonicalIndex, name] of CANONICAL_ORDER.entries()) {
    if (order.includes(name)) continue;
    // The nearest canonical predecessor that survives in the saved order, wherever the user
    // put it — not the last-positioned earlier item, which in a reordered list is arbitrary.
    let predecessorAt = -1;
    let predecessorCanonical = -1;
    for (const [index, present] of order.entries()) {
      const presentCanonical = CANONICAL_ORDER.indexOf(present);
      if (presentCanonical < canonicalIndex && presentCanonical > predecessorCanonical) {
        predecessorCanonical = presentCanonical;
        predecessorAt = index;
      }
    }
    order.splice(predecessorAt + 1, 0, name);
  }
  return order;
}

export function parseRailPreferences(raw: string | null): RailPreferences {
  if (!raw) return defaultRailPreferences();
  try {
    const value = JSON.parse(raw) as { v?: unknown; order?: unknown; hidden?: unknown };
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultRailPreferences();
    const savedOrder = Array.isArray(value.order) ? value.order.filter((name): name is string => typeof name === "string") : [];
    const savedHidden = Array.isArray(value.hidden) ? value.hidden.filter((name): name is string => typeof name === "string") : [];
    const order = reconcileRailOrder(savedOrder);
    const hidden = new Set<GlobalViewName>();
    for (const name of savedHidden) {
      if (KNOWN.has(name) && !REQUIRED_RAIL_VIEWS.has(name as GlobalViewName)) hidden.add(name as GlobalViewName);
    }
    return { order, hidden };
  } catch {
    return defaultRailPreferences();
  }
}

/** The effective rail: configured order, minus hidden, minus experiment-disabled surfaces. */
export function visibleRailViews(preferences: RailPreferences, flags: ExperimentFlags): GlobalViewName[] {
  return preferences.order.filter((name) => {
    if (preferences.hidden.has(name)) return false;
    const experiment = experimentForViewName(name);
    return experiment === null || flags[experiment];
  });
}

/** `1`–`9` for the first nine visible destinations, `0` for the tenth, none past that. */
export function railDigitForIndex(index: number): string | null {
  if (index >= 0 && index < 9) return String(index + 1);
  if (index === 9) return "0";
  return null;
}

export function railDigits(visible: readonly GlobalViewName[]): Map<GlobalViewName, string> {
  const digits = new Map<GlobalViewName, string>();
  for (const [index, name] of visible.entries()) {
    const digit = railDigitForIndex(index);
    if (digit !== null) digits.set(name, digit);
  }
  return digits;
}

/** The destination a bare digit opens under the current visible order, if any. */
export function railViewForDigit(visible: readonly GlobalViewName[], digit: string): GlobalViewName | null {
  if (!/^[0-9]$/.test(digit)) return null;
  const index = digit === "0" ? 9 : Number(digit) - 1;
  return visible[index] ?? null;
}

/** The phone bar keeps the first four visible destinations; the rest overflow into More. */
export const MOBILE_PRIMARY_COUNT = 4;

/* ----------------------- Module store, one per instance ----------------------- */

const preferencesByScope = new Map<string, RailPreferences>();
const listeners = new Set<() => void>();

export function getRailPreferences(instanceScope = LOCAL_INSTANCE_SCOPE): RailPreferences {
  const cached = preferencesByScope.get(instanceScope);
  if (cached) return cached;
  const loaded = parseRailPreferences(loadInstanceStorageValue(RAIL_PREFERENCES_STORAGE_KEY, instanceScope));
  preferencesByScope.set(instanceScope, loaded);
  return loaded;
}

function commit(preferences: RailPreferences, instanceScope: string): void {
  preferencesByScope.set(instanceScope, preferences);
  // Persistence is best-effort like every other preference; the in-memory value still wins
  // for this page's lifetime even when private mode rejects the write.
  saveInstanceStorageValue(
    RAIL_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ v: RAIL_PREFERENCES_SCHEMA_VERSION, order: preferences.order, hidden: [...preferences.hidden] }),
    instanceScope,
  );
  for (const listener of listeners) listener();
}

export function setRailViewHidden(
  name: GlobalViewName,
  hidden: boolean,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): void {
  if (REQUIRED_RAIL_VIEWS.has(name) && hidden) return;
  const current = getRailPreferences(instanceScope);
  if (current.hidden.has(name) === hidden) return;
  const nextHidden = new Set(current.hidden);
  if (hidden) nextHidden.add(name);
  else nextHidden.delete(name);
  // A hidden destination keeps its position in `order`, so restoring returns it to its place.
  commit({ order: current.order, hidden: nextHidden }, instanceScope);
}

export function moveRailView(
  name: GlobalViewName,
  direction: "up" | "down",
  instanceScope = LOCAL_INSTANCE_SCOPE,
): void {
  const current = getRailPreferences(instanceScope);
  const index = current.order.indexOf(name);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= current.order.length) return;
  const order = [...current.order];
  [order[index], order[target]] = [order[target]!, order[index]!];
  commit({ order, hidden: current.hidden }, instanceScope);
}

export function resetRailPreferences(instanceScope = LOCAL_INSTANCE_SCOPE): void {
  commit(defaultRailPreferences(), instanceScope);
}

export function subscribeRailPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget cached preferences so a fresh get() re-reads storage. */
export function resetRailPreferencesForTest(): void {
  preferencesByScope.clear();
}
