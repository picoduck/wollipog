/**
 * Browser persistence primitives with instance isolation and one-release rename compatibility.
 *
 * A remote control plane can reuse runner, project, and session ids from the local control
 * plane. Persisting those ids directly would therefore leak preferences and drafts between
 * instances. These helpers encode the instance and logical key as a length-prefixed tuple so
 * no choice of delimiters inside either value can create a collision.
 */

export const LOCAL_INSTANCE_SCOPE = "local";

const STORAGE_PREFIX = "wollipog.instance.v1";
const LEGACY_STORAGE_PREFIX = "mam.instance.v1";
const RESOURCE_PREFIX = "wollipog.resource.v1";
const LEGACY_RESOURCE_PREFIX = "mam.resource.v1";
const MIGRATION_PREFIX = "wollipog.instance-migration.v1";
const LEGACY_MIGRATION_PREFIX = "mam.instance-migration.v1";
const CURRENT_LOGICAL_PREFIX = "wollipog.";
const LEGACY_LOGICAL_PREFIX = "mam.";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function nonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

/** Encode an ordered tuple without relying on a delimiter that could occur in user data. */
function tuple(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/** Map a current browser key back to the spelling used by the compatibility release. */
export function legacyBrowserStorageKey(currentKey: string): string {
  nonEmpty(currentKey, "storage key");
  return currentKey.startsWith(CURRENT_LOGICAL_PREFIX)
    ? `${LEGACY_LOGICAL_PREFIX}${currentKey.slice(CURRENT_LOGICAL_PREFIX.length)}`
    : currentKey;
}

/** The localStorage key for a logical key on one control-plane instance. */
export function instanceStorageKey(
  logicalKey: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): string {
  return `${STORAGE_PREFIX}:${tuple(
    nonEmpty(instanceScope, "instance scope"),
    nonEmpty(logicalKey, "logical key"),
  )}`;
}

/** The exact instance-scoped key emitted by the compatibility release. */
export function legacyInstanceStorageKey(
  logicalKey: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): string {
  return `${LEGACY_STORAGE_PREFIX}:${tuple(
    nonEmpty(instanceScope, "instance scope"),
    legacyBrowserStorageKey(nonEmpty(logicalKey, "logical key")),
  )}`;
}

/**
 * A collision-proof composite identity for IndexedDB object-store keys and in-memory maps.
 * The resource id deliberately remains opaque: callers can use session, runner, or project ids.
 */
export function instanceResourceKey(
  resourceId: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): string {
  return `${RESOURCE_PREFIX}:${tuple(
    nonEmpty(instanceScope, "instance scope"),
    nonEmpty(resourceId, "resource id"),
  )}`;
}

/** The exact IndexedDB/in-memory resource key emitted by the compatibility release. */
export function legacyInstanceResourceKey(
  resourceId: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): string {
  return `${LEGACY_RESOURCE_PREFIX}:${tuple(
    nonEmpty(instanceScope, "instance scope"),
    nonEmpty(resourceId, "resource id"),
  )}`;
}

function instanceMigrationMarkerKey(logicalKey: string, instanceScope: string): string {
  return `${MIGRATION_PREFIX}:${tuple("instance", instanceScope, nonEmpty(logicalKey, "logical key"))}`;
}

function browserMigrationMarkerKey(currentKey: string): string {
  return `${MIGRATION_PREFIX}:${tuple("browser", nonEmpty(currentKey, "storage key"))}`;
}

function legacyInstanceMigrationMarkerKey(logicalKey: string): string {
  return `${LEGACY_MIGRATION_PREFIX}:${tuple(legacyBrowserStorageKey(nonEmpty(logicalKey, "logical key")))}`;
}

function targetStorage(storage?: KeyValueStorage): KeyValueStorage {
  return storage ?? localStorage;
}

function removeStorageKey(target: KeyValueStorage, key: string): boolean {
  try {
    target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a global Wollipog key new-first and copy the old MAM value forward once. Legacy values are
 * retained for the compatibility window, while clean installs and later writes use only the new
 * identity.
 */
export function loadBrowserStorageValue(
  currentKey: string,
  storage?: KeyValueStorage,
): string | null {
  try {
    const target = targetStorage(storage);
    const currentValue = target.getItem(currentKey);
    if (currentValue !== null) return currentValue;
    if (target.getItem(browserMigrationMarkerKey(currentKey)) !== null) return null;

    const legacyValue = target.getItem(legacyBrowserStorageKey(currentKey));
    if (legacyValue === null) return null;
    try {
      target.setItem(currentKey, legacyValue);
      target.setItem(browserMigrationMarkerKey(currentKey), "1");
    } catch {
      // Keep serving the legacy value and retry the copy on the next read.
    }
    return legacyValue;
  } catch {
    return null;
  }
}

/** Write only the current key; the legacy spelling is read-only compatibility input. */
export function saveBrowserStorageValue(
  currentKey: string,
  value: string,
  storage?: KeyValueStorage,
): boolean {
  try {
    const target = targetStorage(storage);
    target.setItem(currentKey, value);
    try { target.setItem(browserMigrationMarkerKey(currentKey), "1"); } catch { /* best-effort */ }
    return true;
  } catch {
    // Browser persistence is best-effort (private mode, restricted webviews, and quota errors).
    return false;
  }
}

/** Delete both generations after preventing a stale legacy value from reappearing when possible. */
export function removeBrowserStorageValue(
  currentKey: string,
  storage?: KeyValueStorage,
): void {
  let target: KeyValueStorage;
  try { target = targetStorage(storage); } catch { return; }
  let marked = false;
  try {
    target.setItem(browserMigrationMarkerKey(currentKey), "1");
    marked = true;
  } catch { /* best-effort */ }
  // If quota rejects a new marker, remove the resurrection source first and retain the current
  // value when that fails. A successful marker makes every generation independently disposable.
  const legacyRemoved = removeStorageKey(target, legacyBrowserStorageKey(currentKey));
  if (marked || legacyRemoved) removeStorageKey(target, currentKey);
}

/**
 * Read one instance's value new-first, copying forward an old scoped value when present. Local is
 * also allowed to import the pre-instance unscoped value exactly once; remote instances never see
 * it. Old keys remain read-only compatibility inputs throughout the migration window.
 */
export function loadInstanceStorageValue(
  logicalKey: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
  storage?: KeyValueStorage,
): string | null {
  try {
    const target = targetStorage(storage);
    const currentKey = instanceStorageKey(logicalKey, instanceScope);
    const currentValue = target.getItem(currentKey);
    if (currentValue !== null) return currentValue;
    if (target.getItem(instanceMigrationMarkerKey(logicalKey, instanceScope)) !== null) return null;

    let value = target.getItem(legacyInstanceStorageKey(logicalKey, instanceScope));
    if (value === null && instanceScope === LOCAL_INSTANCE_SCOPE &&
        target.getItem(legacyInstanceMigrationMarkerKey(logicalKey)) === null) {
      value = target.getItem(legacyBrowserStorageKey(logicalKey));
    }
    if (value === null) return null;

    try {
      target.setItem(currentKey, value);
      target.setItem(instanceMigrationMarkerKey(logicalKey, instanceScope), "1");
    } catch {
      // Preserve legacy read behavior and retry migration later if the current write was denied.
    }
    return value;
  } catch {
    return null;
  }
}

/** Write only the current generation; legacy names are accepted only as migration input. */
export function saveInstanceStorageValue(
  logicalKey: string,
  value: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
  storage?: KeyValueStorage,
): boolean {
  try {
    const target = targetStorage(storage);
    target.setItem(instanceStorageKey(logicalKey, instanceScope), value);
    try { target.setItem(instanceMigrationMarkerKey(logicalKey, instanceScope), "1"); } catch { /* best-effort */ }
    return true;
  } catch {
    // Browser persistence is best-effort (private mode, restricted webviews, and quota errors).
    return false;
  }
}

/** Delete both generations without allowing an older unscoped Local value to reappear when possible. */
export function removeInstanceStorageValue(
  logicalKey: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
  storage?: KeyValueStorage,
): void {
  let target: KeyValueStorage;
  try { target = targetStorage(storage); } catch { return; }
  let marked = false;
  try {
    target.setItem(instanceMigrationMarkerKey(logicalKey, instanceScope), "1");
    marked = true;
  } catch { /* best-effort */ }
  // Without a marker, delete every legacy resurrection source before the current value. If any
  // legacy removal is denied, retaining the current generation preserves new-first behavior.
  const scopedLegacyRemoved = removeStorageKey(target, legacyInstanceStorageKey(logicalKey, instanceScope));
  const unscopedLegacyRemoved = instanceScope !== LOCAL_INSTANCE_SCOPE ||
    removeStorageKey(target, legacyBrowserStorageKey(logicalKey));
  if (marked || (scopedLegacyRemoved && unscopedLegacyRemoved)) {
    removeStorageKey(target, instanceStorageKey(logicalKey, instanceScope));
  }
}
