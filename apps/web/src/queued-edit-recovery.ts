import { isWorkspaceReference, validateWorkspaceReference, type PromptImageInput, type QueuedPromptDraft, type QueuedPromptView } from "@wollipog/protocol";
import {
  type KeyValueStorage,
  instanceStorageKey,
  loadInstanceStorageValue,
  removeInstanceStorageValue,
} from "./instance-storage.js";
import { browserRandomUUID } from "./browser-crypto.js";

export interface QueuedPromptEditState extends QueuedPromptDraft {
  submissionId?: string;
  submissionFingerprint?: string;
  displacedDraft: { text: string; images: PromptImageInput[] };
  /** Large displaced attachments remain in IndexedDB instead of consuming the localStorage
   * recovery budget. SessionDetail rehydrates them before exposing recovery actions. */
  displacedDraftStoredSeparately?: true;
}

export interface QueuedPromptEditRecovery {
  edit: QueuedPromptEditState;
  draft: { text: string; images: PromptImageInput[] };
  error?: string;
}

export interface QueuedEditRecoveryScope {
  instanceScope: string;
  accountKey: string;
  sessionId: string;
}

export type QueuedEditRecoveryReconciliation =
  | { status: "retryable" }
  | { status: "checking"; reason: string }
  | { status: "stale"; reason: string };

const LEGACY_STORAGE_KEY = "wollipog.queued-edit-recoveries.v1";
const ENTRY_PREFIX = "wollipog.queued-edit-recovery.v2.entry.";
const CLEAR_PREFIX = "wollipog.queued-edit-recovery.v2.clear.";
const ACCOUNT_CLEAR_PREFIX = "wollipog.queued-edit-recovery.v2.account-clear.";
const INSTANCE_CLEAR_PREFIX = "wollipog.queued-edit-recovery.v2.instance-clear.";
/** Seven days spans ordinary app restarts without retaining abandoned prompt content indefinitely. */
export const QUEUED_EDIT_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const QUEUED_EDIT_RECOVERY_MAX_ENTRIES = 20;
/** Two MiB of UTF-16 key/value storage leaves at least three MiB of a common five-MiB origin quota
 * for drafts, settings, migration markers, and browser-specific accounting overhead. */
export const QUEUED_EDIT_RECOVERY_MAX_BYTES = 2 * 1_024 * 1_024;

interface StoredQueuedEditRecovery {
  accountKey: string;
  sessionId: string;
  recovery: QueuedPromptEditRecovery;
  updatedAt: number;
  expiresAt: number;
}

interface StoredQueuedEditRegistry {
  version: 1;
  entries: StoredQueuedEditRecovery[];
}

interface StoredQueuedEditRecoveryRecord extends StoredQueuedEditRecovery {
  version: 2;
  kind: "recovery";
  instanceScope: string;
  operationId: string;
  startedAt: number;
}

interface StoredQueuedEditRecoveryTombstone {
  version: 2;
  kind: "tombstone";
  target: "entry" | "account" | "instance";
  instanceScope: string;
  accountKey?: string;
  sessionId?: string;
  operationId: string;
  startedAt: number;
  expiresAt: number;
}

const runtimeRecoveries = new Map<string, { accountKey: string; recovery: QueuedPromptEditRecovery }>();

export function queuedEditRecoveryAccountKey(organizationId: string, userId: string): string {
  if (!organizationId || !userId) throw new TypeError("queued edit recovery identity must not be empty");
  return JSON.stringify([organizationId, userId]);
}

export function cloneQueuedPromptEditRecovery(recovery: QueuedPromptEditRecovery): QueuedPromptEditRecovery {
  return {
    ...recovery,
    edit: {
      ...recovery.edit,
      images: recovery.edit.images.map((image) => ({ ...image })),
      displacedDraft: {
        text: recovery.edit.displacedDraft.text,
        images: recovery.edit.displacedDraft.images.map((image) => ({ ...image })),
      },
    },
    draft: {
      text: recovery.draft.text,
      images: recovery.draft.images.map((image) => ({ ...image })),
    },
  };
}

export function loadRuntimeQueuedEditRecovery(
  key: string,
  accountKey: string,
): QueuedPromptEditRecovery | undefined {
  const stored = runtimeRecoveries.get(key);
  return stored?.accountKey === accountKey
    ? cloneQueuedPromptEditRecovery(stored.recovery)
    : undefined;
}

export function storeRuntimeQueuedEditRecovery(
  key: string,
  accountKey: string,
  recovery: QueuedPromptEditRecovery,
): void {
  runtimeRecoveries.delete(key);
  runtimeRecoveries.set(key, { accountKey, recovery: cloneQueuedPromptEditRecovery(recovery) });
  while (runtimeRecoveries.size > QUEUED_EDIT_RECOVERY_MAX_ENTRIES) {
    const oldest = runtimeRecoveries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    runtimeRecoveries.delete(oldest);
  }
}

export function clearRuntimeQueuedEditRecovery(key: string): void {
  runtimeRecoveries.delete(key);
}

export function clearRuntimeQueuedEditRecoveriesForInstance(instanceScope: string): void {
  const prefix = `${instanceScope}\u0000`;
  for (const key of runtimeRecoveries.keys()) {
    if (key.startsWith(prefix)) runtimeRecoveries.delete(key);
  }
}

function validImage(value: unknown): value is PromptImageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (isWorkspaceReference(value)) return validateWorkspaceReference(value).ok;
  const image = value as Record<string, unknown>;
  if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) return false;
  if (typeof image.data === "string") return true;
  return typeof image.artifactId === "string" && typeof image.sizeBytes === "number" &&
    Number.isSafeInteger(image.sizeBytes) && image.sizeBytes >= 0 && typeof image.sha256 === "string";
}

function validDraft(value: unknown): value is { text: string; images: PromptImageInput[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as { text?: unknown; images?: unknown };
  return typeof draft.text === "string" && Array.isArray(draft.images) && draft.images.every(validImage);
}

/** Persisted browser data is untrusted input; malformed entries never reach the composer. */
export function parseQueuedPromptEditRecovery(value: unknown): QueuedPromptEditRecovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { edit?: unknown; draft?: unknown; error?: unknown };
  if (!candidate.edit || typeof candidate.edit !== "object" || Array.isArray(candidate.edit) ||
      !validDraft(candidate.draft)) return null;
  const edit = candidate.edit as Record<string, unknown>;
  if (typeof edit.promptId !== "string" || !edit.promptId || typeof edit.text !== "string" ||
      typeof edit.editRevision !== "string" || !edit.editRevision || !Array.isArray(edit.images) ||
      !edit.images.every(validImage) || !validDraft(edit.displacedDraft)) return null;
  if (edit.submissionId !== undefined && (typeof edit.submissionId !== "string" || !edit.submissionId)) return null;
  if (edit.submissionFingerprint !== undefined && typeof edit.submissionFingerprint !== "string") return null;
  if (edit.displacedDraftStoredSeparately !== undefined && edit.displacedDraftStoredSeparately !== true) return null;
  if (candidate.error !== undefined && typeof candidate.error !== "string") return null;
  return cloneQueuedPromptEditRecovery({
    edit: {
      promptId: edit.promptId,
      text: edit.text,
      images: edit.images,
      editRevision: edit.editRevision,
      displacedDraft: edit.displacedDraft,
      ...(typeof edit.submissionId === "string" ? { submissionId: edit.submissionId } : {}),
      ...(typeof edit.submissionFingerprint === "string"
        ? { submissionFingerprint: edit.submissionFingerprint }
        : {}),
      ...(edit.displacedDraftStoredSeparately === true ? { displacedDraftStoredSeparately: true } : {}),
    },
    draft: candidate.draft,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
  });
}

function parseLegacyRegistry(
  raw: string | null,
  now: number,
): { registry: StoredQueuedEditRegistry; cleaned: boolean } {
  if (!raw) return { registry: { version: 1, entries: [] }, cleaned: false };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { registry: { version: 1, entries: [] }, cleaned: true };
    }
    const entries = parsed.entries.flatMap((value): StoredQueuedEditRecovery[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const entry = value as Partial<StoredQueuedEditRecovery>;
      const recovery = parseQueuedPromptEditRecovery(entry.recovery);
      if (typeof entry.accountKey !== "string" || !entry.accountKey || typeof entry.sessionId !== "string" ||
          !entry.sessionId || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt) ||
          typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now ||
          !recovery) return [];
      return [{
        accountKey: entry.accountKey,
        sessionId: entry.sessionId,
        recovery,
        updatedAt: entry.updatedAt,
        expiresAt: entry.expiresAt,
      }];
    });
    entries.sort((left, right) => left.updatedAt - right.updatedAt);
    return {
      registry: { version: 1, entries: entries.slice(-QUEUED_EDIT_RECOVERY_MAX_ENTRIES) },
      cleaned: entries.length !== parsed.entries.length || entries.length > QUEUED_EDIT_RECOVERY_MAX_ENTRIES,
    };
  } catch {
    return { registry: { version: 1, entries: [] }, cleaned: true };
  }
}

function logicalCoordinate(...parts: string[]): string {
  return encodeURIComponent(JSON.stringify(parts));
}

function entryLogicalKey(record: Pick<StoredQueuedEditRecoveryRecord,
  "accountKey" | "sessionId" | "operationId">): string {
  return `${ENTRY_PREFIX}${logicalCoordinate(record.accountKey, record.sessionId, record.operationId)}`;
}

function tombstoneLogicalKey(marker: StoredQueuedEditRecoveryTombstone): string {
  const coordinate = marker.target === "entry"
    ? logicalCoordinate(marker.accountKey!, marker.sessionId!, marker.operationId)
    : marker.target === "account"
      ? logicalCoordinate(marker.accountKey!, marker.operationId)
      : logicalCoordinate(marker.operationId);
  return `${marker.target === "entry" ? CLEAR_PREFIX : marker.target === "account"
    ? ACCOUNT_CLEAR_PREFIX : INSTANCE_CLEAR_PREFIX}${coordinate}`;
}

function targetStorage(storage?: KeyValueStorage): KeyValueStorage | undefined {
  try { return storage ?? localStorage; } catch { return undefined; }
}

function currentStorageBytes(logicalKey: string, value: string, instanceScope: string): number {
  // Web Storage stores JavaScript strings. Count both the physical key and value as UTF-16 code
  // units, which is conservative for browser implementations that account two bytes per unit.
  return 2 * (instanceStorageKey(logicalKey, instanceScope).length + value.length);
}

function writeStoredValue(
  logicalKey: string,
  value: string,
  instanceScope: string,
  storage?: KeyValueStorage,
): boolean {
  const target = targetStorage(storage);
  if (!target) return false;
  const physicalKey = instanceStorageKey(logicalKey, instanceScope);
  try {
    target.setItem(physicalKey, value);
    return target.getItem(physicalKey) === value;
  } catch {
    return false;
  }
}

function parseRecord(value: unknown): StoredQueuedEditRecoveryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StoredQueuedEditRecoveryRecord>;
  const recovery = parseQueuedPromptEditRecovery(record.recovery);
  if (record.version !== 2 || record.kind !== "recovery" || typeof record.instanceScope !== "string" ||
      !record.instanceScope || typeof record.accountKey !== "string" || !record.accountKey ||
      typeof record.sessionId !== "string" || !record.sessionId || typeof record.operationId !== "string" ||
      !record.operationId || typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt) ||
      typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt) ||
      typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt) || !recovery) return null;
  return { ...record as StoredQueuedEditRecoveryRecord, recovery };
}

function parseTombstone(value: unknown): StoredQueuedEditRecoveryTombstone | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Partial<StoredQueuedEditRecoveryTombstone>;
  if (marker.version !== 2 || marker.kind !== "tombstone" ||
      (marker.target !== "entry" && marker.target !== "account" && marker.target !== "instance") ||
      typeof marker.instanceScope !== "string" || !marker.instanceScope ||
      typeof marker.operationId !== "string" || !marker.operationId ||
      typeof marker.startedAt !== "number" || !Number.isFinite(marker.startedAt) ||
      typeof marker.expiresAt !== "number" || !Number.isFinite(marker.expiresAt) ||
      (marker.target !== "instance" && (typeof marker.accountKey !== "string" || !marker.accountKey)) ||
      (marker.target === "entry" && (typeof marker.sessionId !== "string" || !marker.sessionId))) return null;
  return marker as StoredQueuedEditRecoveryTombstone;
}

function parseStoredJson(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function storageKeys(storage?: KeyValueStorage): string[] {
  const target = targetStorage(storage);
  if (!target || typeof target.length !== "number" || typeof target.key !== "function") return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key !== null) keys.push(key);
    }
  } catch { return []; }
  return keys;
}

type StoredItem<T> = { logicalKey: string; physicalKey: string; raw: string; value: T };

function listStored<T>(
  instanceScope: string,
  storage: KeyValueStorage | undefined,
  parse: (value: unknown) => T | null,
  logicalKey: (value: T) => string,
): Array<StoredItem<T>> {
  const target = targetStorage(storage);
  if (!target) return [];
  const result: Array<StoredItem<T>> = [];
  for (const physicalKey of storageKeys(target)) {
    let raw: string | null;
    try { raw = target.getItem(physicalKey); } catch { continue; }
    const value = parse(parseStoredJson(raw));
    if (!raw || !value || (value as { instanceScope?: string }).instanceScope !== instanceScope) continue;
    const expectedLogicalKey = logicalKey(value);
    if (physicalKey !== instanceStorageKey(expectedLogicalKey, instanceScope)) continue;
    result.push({ logicalKey: expectedLogicalKey, physicalKey, raw, value });
  }
  return result;
}

function listRecords(instanceScope: string, storage?: KeyValueStorage) {
  return listStored(instanceScope, storage, parseRecord, entryLogicalKey);
}

function listTombstones(instanceScope: string, storage?: KeyValueStorage) {
  return listStored(instanceScope, storage, parseTombstone, tombstoneLogicalKey);
}

function removeStored(item: Pick<StoredItem<unknown>, "physicalKey">, storage?: KeyValueStorage): boolean {
  const target = targetStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(item.physicalKey);
    return target.getItem(item.physicalKey) === null;
  } catch { return false; }
}

function activeTombstones(instanceScope: string, storage: KeyValueStorage | undefined, now: number) {
  const active: StoredQueuedEditRecoveryTombstone[] = [];
  for (const item of listTombstones(instanceScope, storage)) {
    if (item.value.expiresAt <= now) removeStored(item, storage);
    else active.push(item.value);
  }
  return active;
}

function markerMatches(record: StoredQueuedEditRecoveryRecord, marker: StoredQueuedEditRecoveryTombstone): boolean {
  return marker.instanceScope === record.instanceScope && (
    marker.target === "instance" ||
    (marker.accountKey === record.accountKey && (marker.target === "account" || marker.sessionId === record.sessionId))
  );
}

function recordIsSuppressed(
  record: StoredQueuedEditRecoveryRecord,
  tombstones: readonly StoredQueuedEditRecoveryTombstone[],
): boolean {
  return tombstones.some((marker) => markerMatches(record, marker) && marker.startedAt >= record.startedAt);
}

function makeTombstone(
  target: StoredQueuedEditRecoveryTombstone["target"],
  scope: Partial<QueuedEditRecoveryScope> & Pick<QueuedEditRecoveryScope, "instanceScope">,
  startedAt: number,
  expiresAt = startedAt + QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
): StoredQueuedEditRecoveryTombstone {
  return {
    version: 2,
    kind: "tombstone",
    target,
    instanceScope: scope.instanceScope,
    ...(scope.accountKey ? { accountKey: scope.accountKey } : {}),
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    operationId: browserRandomUUID(),
    startedAt,
    expiresAt,
  };
}

function persistTombstone(
  marker: StoredQueuedEditRecoveryTombstone,
  storage?: KeyValueStorage,
): boolean {
  const logicalKey = tombstoneLogicalKey(marker);
  const serialized = JSON.stringify(marker);
  return writeStoredValue(logicalKey, serialized, marker.instanceScope, storage);
}

const pendingTombstones = new Map<string, StoredQueuedEditRecoveryTombstone>();

function pendingTombstoneKey(marker: Pick<StoredQueuedEditRecoveryTombstone,
  "target" | "instanceScope" | "accountKey" | "sessionId">): string {
  return JSON.stringify([marker.target, marker.instanceScope, marker.accountKey, marker.sessionId]);
}

function removeRecordsSuppressedBy(
  marker: StoredQueuedEditRecoveryTombstone,
  storage: KeyValueStorage | undefined,
): void {
  for (const item of listRecords(marker.instanceScope, storage)) {
    if (markerMatches(item.value, marker) && marker.startedAt >= item.value.startedAt) removeStored(item, storage);
  }
}

function retryPendingTombstones(instanceScope: string, storage: KeyValueStorage | undefined, now: number): void {
  for (const [key, marker] of pendingTombstones) {
    if (marker.instanceScope !== instanceScope) continue;
    if (marker.expiresAt <= now) {
      pendingTombstones.delete(key);
      continue;
    }
    if (persistTombstone(marker, storage)) {
      removeRecordsSuppressedBy(marker, storage);
      pendingTombstones.delete(key);
    }
  }
}

function effectiveTombstones(instanceScope: string, storage: KeyValueStorage | undefined, now: number) {
  retryPendingTombstones(instanceScope, storage, now);
  const tombstones = activeTombstones(instanceScope, storage, now);
  for (const marker of pendingTombstones.values()) {
    if (marker.instanceScope === instanceScope && marker.expiresAt > now) tombstones.push(marker);
  }
  return tombstones;
}

function activeRecords(instanceScope: string, storage: KeyValueStorage | undefined, now: number) {
  const tombstones = effectiveTombstones(instanceScope, storage, now);
  const active: Array<StoredItem<StoredQueuedEditRecoveryRecord>> = [];
  for (const item of listRecords(instanceScope, storage)) {
    if (item.value.expiresAt <= now || recordIsSuppressed(item.value, tombstones)) removeStored(item, storage);
    else active.push(item);
  }
  return active;
}

function markerMatchesScope(
  scope: QueuedEditRecoveryScope,
  marker: StoredQueuedEditRecoveryTombstone,
): boolean {
  return marker.instanceScope === scope.instanceScope && (
    marker.target === "instance" ||
    (marker.accountKey === scope.accountKey && (marker.target === "account" || marker.sessionId === scope.sessionId))
  );
}

function nextSaveStartedAt(
  scope: QueuedEditRecoveryScope,
  storage: KeyValueStorage | undefined,
  now: number,
): number {
  let startedAt = now;
  for (const marker of effectiveTombstones(scope.instanceScope, storage, now)) {
    if (markerMatchesScope(scope, marker)) startedAt = Math.max(startedAt, marker.startedAt + 1);
  }
  for (const item of activeRecords(scope.instanceScope, storage, now)) {
    if (item.value.accountKey === scope.accountKey && item.value.sessionId === scope.sessionId) {
      startedAt = Math.max(startedAt, item.value.startedAt + 1);
    }
  }
  return startedAt;
}

function clearStartedAt(
  target: StoredQueuedEditRecoveryTombstone["target"],
  scope: Partial<QueuedEditRecoveryScope> & Pick<QueuedEditRecoveryScope, "instanceScope">,
  storage: KeyValueStorage | undefined,
  now: number,
): number {
  let startedAt = now;
  for (const item of activeRecords(scope.instanceScope, storage, now)) {
    if (target === "instance" || (item.value.accountKey === scope.accountKey &&
        (target === "account" || item.value.sessionId === scope.sessionId))) {
      startedAt = Math.max(startedAt, item.value.startedAt);
    }
  }
  return startedAt;
}

function enforceStoredBounds(
  instanceScope: string,
  protectedOperationId: string,
  storage: KeyValueStorage | undefined,
  now: number,
): boolean {
  const active = activeRecords(instanceScope, storage, now).sort((left, right) =>
    left.value.updatedAt - right.value.updatedAt || left.value.operationId.localeCompare(right.value.operationId));
  let totalBytes = active.reduce(
    (sum, item) => sum + 2 * (item.physicalKey.length + item.raw.length), 0);
  while (active.length > QUEUED_EDIT_RECOVERY_MAX_ENTRIES || totalBytes > QUEUED_EDIT_RECOVERY_MAX_BYTES) {
    const evictionIndex = active.findIndex((item) => item.value.operationId !== protectedOperationId);
    if (evictionIndex < 0) return false;
    const [oldest] = active.splice(evictionIndex, 1);
    if (!oldest) return false;
    // Each save owns an immutable operation-specific key. Evict that exact record instead of
    // publishing a Session-wide clear marker, which could suppress a concurrent newer save for
    // the same Session.
    if (!removeStored(oldest, storage)) return false;
    totalBytes -= 2 * (oldest.physicalKey.length + oldest.raw.length);
  }
  return true;
}

function removeSupersededSessionRecords(
  current: StoredQueuedEditRecoveryRecord,
  storage: KeyValueStorage | undefined,
): boolean {
  for (const item of listRecords(current.instanceScope, storage)) {
    if (item.value.operationId === current.operationId ||
        item.value.accountKey !== current.accountKey || item.value.sessionId !== current.sessionId ||
        item.value.startedAt >= current.startedAt) continue;
    // Immutable operation keys make this exact deletion race-safe: a concurrent newer save has a
    // different key and can never be erased here.
    if (!removeStored(item, storage)) return false;
  }
  return true;
}

function legacyRecovery(scope: QueuedEditRecoveryScope, storage: KeyValueStorage | undefined,
  now: number): QueuedPromptEditRecovery | undefined {
  const { registry } = parseLegacyRegistry(
    loadInstanceStorageValue(LEGACY_STORAGE_KEY, scope.instanceScope, storage),
    now,
  );
  const entry = registry.entries.find((candidate) =>
    candidate.accountKey === scope.accountKey && candidate.sessionId === scope.sessionId);
  return entry ? cloneQueuedPromptEditRecovery(entry.recovery) : undefined;
}

export function loadDurableQueuedEditRecovery(
  scope: QueuedEditRecoveryScope,
  storage?: KeyValueStorage,
  now = Date.now(),
): QueuedPromptEditRecovery | undefined {
  const candidates = activeRecords(scope.instanceScope, storage, now)
    .filter((item) => item.value.accountKey === scope.accountKey && item.value.sessionId === scope.sessionId)
    .sort((left, right) => left.value.startedAt - right.value.startedAt ||
      left.value.operationId.localeCompare(right.value.operationId));
  const current = candidates.at(-1)?.value;
  if (current) return cloneQueuedPromptEditRecovery(current.recovery);
  const recovered = legacyRecovery(scope, storage, now);
  if (!recovered) return undefined;
  const synthetic: StoredQueuedEditRecoveryRecord = {
    version: 2, kind: "recovery", instanceScope: scope.instanceScope, accountKey: scope.accountKey,
    sessionId: scope.sessionId, operationId: "legacy", startedAt: 0, updatedAt: 0,
    expiresAt: now + 1, recovery: recovered,
  };
  return recordIsSuppressed(synthetic, effectiveTombstones(scope.instanceScope, storage, now)) ? undefined : recovered;
}

export function saveDurableQueuedEditRecovery(
  scope: QueuedEditRecoveryScope,
  recovery: QueuedPromptEditRecovery,
  storage?: KeyValueStorage,
  now = Date.now(),
): boolean {
  const startedAt = nextSaveStartedAt(scope, storage, now);
  let nextEntry: StoredQueuedEditRecoveryRecord = {
    version: 2, kind: "recovery", instanceScope: scope.instanceScope,
    accountKey: scope.accountKey, sessionId: scope.sessionId,
    recovery: cloneQueuedPromptEditRecovery(recovery), operationId: browserRandomUUID(),
    startedAt, updatedAt: now, expiresAt: now + QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
  };
  if (recordIsSuppressed(nextEntry, effectiveTombstones(scope.instanceScope, storage, now))) return false;
  const logicalKey = entryLogicalKey(nextEntry);
  let serialized = JSON.stringify(nextEntry);
  if (currentStorageBytes(logicalKey, serialized, scope.instanceScope) > QUEUED_EDIT_RECOVERY_MAX_BYTES &&
      nextEntry.recovery.edit.displacedDraft.images.length > 0) {
    // The ordinary draft is already durable in IndexedDB before queued editing begins. Keep only
    // its text in localStorage when raw base64 attachments would otherwise block the unrelated
    // queued edit; SessionDetail rehydrates the full displaced draft before restoration.
    nextEntry = {
      ...nextEntry,
      recovery: {
        ...nextEntry.recovery,
        edit: {
          ...nextEntry.recovery.edit,
          displacedDraft: { ...nextEntry.recovery.edit.displacedDraft, images: [] },
          displacedDraftStoredSeparately: true,
        },
      },
    };
    serialized = JSON.stringify(nextEntry);
  }
  if (currentStorageBytes(logicalKey, serialized, scope.instanceScope) > QUEUED_EDIT_RECOVERY_MAX_BYTES) return false;
  if (!writeStoredValue(logicalKey, serialized, scope.instanceScope, storage)) return false;
  if (!removeSupersededSessionRecords(nextEntry, storage)) {
    removeStored({ physicalKey: instanceStorageKey(logicalKey, scope.instanceScope) }, storage);
    return false;
  }
  if (!enforceStoredBounds(scope.instanceScope, nextEntry.operationId, storage, now)) {
    removeStored({ physicalKey: instanceStorageKey(logicalKey, scope.instanceScope) }, storage);
    return false;
  }
  return loadInstanceStorageValue(logicalKey, scope.instanceScope, storage) === serialized &&
    !recordIsSuppressed(nextEntry, effectiveTombstones(scope.instanceScope, storage, now));
}

export function clearDurableQueuedEditRecovery(
  scope: QueuedEditRecoveryScope,
  storage?: KeyValueStorage,
  now = Date.now(),
): boolean {
  const marker = makeTombstone(
    "entry", scope, clearStartedAt("entry", scope, storage, now), now + QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
  );
  const pendingKey = pendingTombstoneKey(marker);
  if (!persistTombstone(marker, storage)) {
    pendingTombstones.set(pendingKey, marker);
    return false;
  }
  pendingTombstones.delete(pendingKey);
  removeRecordsSuppressedBy(marker, storage);
  return true;
}

export function clearDurableQueuedEditRecoveriesForAccount(
  instanceScope: string,
  accountKey: string,
  storage?: KeyValueStorage,
  now = Date.now(),
): boolean {
  const markerScope = { instanceScope, accountKey };
  const marker = makeTombstone(
    "account", markerScope, clearStartedAt("account", markerScope, storage, now),
    now + QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
  );
  const pendingKey = pendingTombstoneKey(marker);
  if (!persistTombstone(marker, storage)) {
    pendingTombstones.set(pendingKey, marker);
    return false;
  }
  pendingTombstones.delete(pendingKey);
  removeRecordsSuppressedBy(marker, storage);
  return true;
}

export function clearAllDurableQueuedEditRecoveries(
  instanceScope: string,
  storage?: KeyValueStorage,
): void {
  const now = Date.now();
  const markerScope = { instanceScope };
  const marker = makeTombstone(
    "instance", markerScope, clearStartedAt("instance", markerScope, storage, now),
    now + QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
  );
  const pendingKey = pendingTombstoneKey(marker);
  if (!persistTombstone(marker, storage)) {
    pendingTombstones.set(pendingKey, marker);
    return;
  }
  pendingTombstones.delete(pendingKey);
  removeRecordsSuppressedBy(marker, storage);
  removeInstanceStorageValue(LEGACY_STORAGE_KEY, instanceScope, storage);
}

/** Recovered edits are retryable only against the same live queue identity and revision. */
export function reconcileQueuedEditRecovery(
  promptId: string,
  editRevision: string,
  queued: readonly QueuedPromptView[] | undefined,
  authoritative: boolean,
): QueuedEditRecoveryReconciliation {
  if (!authoritative) {
    return {
      status: "checking",
      reason: "Waiting for the authoritative queue before this recovered edit can be retried.",
    };
  }

  const target = queued?.find((prompt) => prompt.id === promptId);
  if (!target) {
    return {
      status: "stale",
      reason: "This queued message is no longer waiting, so the recovered edit cannot be saved in place.",
    };
  }
  if (target.steeringState) {
    return {
      status: "stale",
      reason: "Resolve steering before editing this queued message.",
    };
  }
  if (
    target.liveQueueObserved !== true ||
    target.editable !== true ||
    Boolean(target.editDisabledReason) ||
    !target.editRevision
  ) {
    return {
      status: "stale",
      reason: target.editDisabledReason ??
        "This queued message is no longer editable. The recovered content is still available.",
    };
  }
  if (target.editRevision !== editRevision) {
    return {
      status: "stale",
      reason: "This queued message changed elsewhere. The recovered edit cannot overwrite its newer revision.",
    };
  }
  return { status: "retryable" };
}
