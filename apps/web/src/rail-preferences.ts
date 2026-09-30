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

const CANONICAL_ORDER: readonly GlobalViewName[] = GLOBAL_VIEW_ITEMS.map((item) => item.id);
const KNOWN = new Set<string>(CANONICAL_ORDER);

/** Sessions must stay recoverable from the rail itself, so it can never be hidden. */
export const REQUIRED_RAIL_VIEWS: ReadonlySet<GlobalViewName> = new Set(["inbox"]);

/** The phone tab bar holds four destinations, then More (docs/design-system.md §15.1). */
export const PHONE_BAR_SLOTS = 4;

/**
 * The phone bar when the user has not chosen one: the places a phone is most often opened for, and
 * whether this machine is online. Deliberately not the first four of the rail order, which let the
 * desktop's ordering, and experiments, decide the phone's most valuable slots.
 */
export const DEFAULT_PHONE_BAR: readonly GlobalViewName[] = ["inbox", "projects", "runners", "automations"];

export interface RailPreferences {
  /** Every known destination exactly once, in the user's configured order. */
  order: readonly GlobalViewName[];
  /** The hidden subset of `order`; required destinations never appear here. */
  hidden: ReadonlySet<GlobalViewName>;
  /**
   * The phone tab bar's destinations, in bar order, when the user chose them (#1959). Absent means
   * `DEFAULT_PHONE_BAR`. Older clients ignore the field.
   */
  phoneBar?: readonly GlobalViewName[];
  /**
   * Whether the desktop rail shows each destination's name beside its icon, 208px wide (#1968).
   * Off by default and on a phone whatever is saved; a save without the field loads as off.
   */
  labels: boolean;
}

export function defaultRailPreferences(): RailPreferences {
  return { order: [...CANONICAL_ORDER], hidden: new Set(), labels: false };
}

/**
 * Whether the destination list is as shipped, which is what Reset to Default restores. The labelled
 * rail is a separate switch beside the list, so it neither enables that reset nor is undone by it.
 */
export function railPreferencesAreDefault(preferences: RailPreferences): boolean {
  return preferences.hidden.size === 0 &&
    preferences.phoneBar === undefined &&
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
    const value = JSON.parse(raw) as {
      v?: unknown;
      order?: unknown;
      hidden?: unknown;
      phoneBar?: unknown;
      labels?: unknown;
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultRailPreferences();
    const savedOrder = Array.isArray(value.order) ? value.order.filter((name): name is string => typeof name === "string") : [];
    const savedHidden = Array.isArray(value.hidden) ? value.hidden.filter((name): name is string => typeof name === "string") : [];
    const order = reconcileRailOrder(savedOrder);
    const hidden = new Set<GlobalViewName>();
    for (const name of savedHidden) {
      if (KNOWN.has(name) && !REQUIRED_RAIL_VIEWS.has(name as GlobalViewName)) hidden.add(name as GlobalViewName);
    }
    // Only a literal `true` turns labels on, so a save from before #1968 loads with them off.
    const labels = value.labels === true;
    if (!Array.isArray(value.phoneBar)) return { order, hidden, labels };
    const phoneBar: GlobalViewName[] = [];
    for (const name of value.phoneBar) {
      if (typeof name === "string" && KNOWN.has(name) && !phoneBar.includes(name as GlobalViewName)) {
        phoneBar.push(name as GlobalViewName);
      }
    }
    // An empty choice is no choice: the bar would otherwise be whatever the top-up happened to pick.
    if (phoneBar.length === 0) return { order, hidden, labels };
    return { order, hidden, phoneBar: phoneBar.slice(0, PHONE_BAR_SLOTS), labels };
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

/**
 * The phone tab bar's destinations, in bar order: the one source for the bar, and for the Settings
 * editor that marks them (#1959).
 *
 * A chosen or default slot whose destination is hidden or turned off is filled, in place, by the
 * next visible destination in rail order that is not already on the bar. An experimental
 * destination never fills a slot: it reaches the bar only when the user put it there. Everything
 * visible and not returned here belongs to More, in rail order.
 */
export function phoneBarViews(preferences: RailPreferences, flags: ExperimentFlags): GlobalViewName[] {
  const visible = visibleRailViews(preferences, flags);
  const chosen = (preferences.phoneBar ?? DEFAULT_PHONE_BAR).slice(0, PHONE_BAR_SLOTS);
  const slots = chosen.map((name) => visible.includes(name) ? name : null);
  const fillers = visible.filter((name) => experimentForViewName(name) === null && !slots.includes(name));
  // A chosen list shorter than the bar tops up the same way as a skipped slot.
  while (slots.length < PHONE_BAR_SLOTS) slots.push(null);
  const bar: GlobalViewName[] = [];
  for (const slot of slots) {
    const name = slot ?? fillers.shift();
    if (name) bar.push(name);
  }
  return bar;
}

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
    JSON.stringify({
      v: RAIL_PREFERENCES_SCHEMA_VERSION,
      order: preferences.order,
      hidden: [...preferences.hidden],
      ...(preferences.phoneBar ? { phoneBar: preferences.phoneBar } : {}),
      ...(preferences.labels ? { labels: true } : {}),
    }),
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
  commit({ ...current, hidden: nextHidden }, instanceScope);
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
  commit({ ...current, order }, instanceScope);
}

/** The Settings switch, the rail's foot button and the palette action all write this (#1968). */
export function setRailLabels(labels: boolean, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  const current = getRailPreferences(instanceScope);
  if (current.labels === labels) return;
  commit({ ...current, labels }, instanceScope);
}

export function resetRailPreferences(instanceScope = LOCAL_INSTANCE_SCOPE): void {
  commit({ ...defaultRailPreferences(), labels: getRailPreferences(instanceScope).labels }, instanceScope);
}

export function subscribeRailPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget cached preferences so a fresh get() re-reads storage. */
export function resetRailPreferencesForTest(): void {
  preferencesByScope.clear();
}
