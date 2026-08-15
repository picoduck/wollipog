import { browserRandomUUID } from "./browser-crypto.js";
import type { PromptImageInput } from "@wollipog/protocol";
import {
  LOCAL_INSTANCE_SCOPE,
  instanceResourceKey,
  instanceStorageKey,
  legacyInstanceResourceKey,
  loadInstanceStorageValue,
  removeInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

export interface ComposerDraft {
  text: string;
  images: PromptImageInput[];
  updatedAt: number;
  revision?: string;
  commandSubmission?: ComposerCommandSubmission;
}

export interface ComposerCommandSubmission {
  submissionId: string;
  providerCommandId: string;
  catalogRevision: string;
  argumentText: string;
}

const DB_NAME = "wollipog-composer-drafts";
const LEGACY_DB_NAME = "mam-composer-drafts";
const STORE_NAME = "drafts";
const TOMBSTONE_PREFIX = "wollipog.composer-draft-tombstone.v1";
const FALLBACK_PREFIX = "wollipog.composer.draft.";
const FALLBACK_TOMBSTONE_PREFIX = "wollipog.composer.draft-tombstone.";
let dbPromise: Promise<IDBDatabase> | null = null;
let legacyDbPromise: Promise<IDBDatabase | null> | null = null;
const discardedSessionIds = new Set<string>();
const revisions = new Map<string, number>();
const pendingHandoffs = new Map<string, ComposerDraft>();
const MAX_PENDING_HANDOFFS = 20;

function draftKey(sessionId: string, instanceScope: string): string {
  return instanceResourceKey(sessionId, instanceScope);
}

function legacyDraftKey(sessionId: string, instanceScope: string): string {
  return legacyInstanceResourceKey(sessionId, instanceScope);
}

function draftTombstoneKey(key: string): string {
  return `${TOMBSTONE_PREFIX}:${key}`;
}

function fallbackTombstoneKey(sessionId: string, instanceScope: string): string {
  return instanceStorageKey(`${FALLBACK_TOMBSTONE_PREFIX}${sessionId}`, instanceScope);
}

type ExternalDeletionMarker =
  | { version: 1; kind: "unconditional"; deletedAt: number }
  | { version: 1; kind: "conditional"; deletedAt: number; fingerprint: string; expectedRevision?: string };

function loadFallbackTombstone(sessionId: string, instanceScope: string): ExternalDeletionMarker | null {
  try {
    const raw = localStorage.getItem(fallbackTombstoneKey(sessionId, instanceScope));
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<ExternalDeletionMarker>;
    if (marker.version !== 1 || !Number.isFinite(marker.deletedAt)) return null;
    if (marker.kind === "unconditional") {
      return { version: 1, kind: "unconditional", deletedAt: marker.deletedAt! };
    }
    if (marker.kind !== "conditional" || typeof marker.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(marker.fingerprint)) return null;
    return {
      version: 1,
      kind: "conditional",
      deletedAt: marker.deletedAt!,
      fingerprint: marker.fingerprint,
      ...(typeof marker.expectedRevision === "string"
        ? { expectedRevision: marker.expectedRevision }
        : {}),
    };
  } catch {
    return null;
  }
}

function saveFallbackTombstone(
  sessionId: string,
  instanceScope: string,
  marker: ExternalDeletionMarker,
): boolean {
  try {
    localStorage.setItem(fallbackTombstoneKey(sessionId, instanceScope), JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

function normalizedDraftFingerprintInput(
  text: string,
  images: readonly PromptImageInput[],
): string {
  return JSON.stringify({
    text,
    images: images.map((image) => "data" in image
      ? { mimeType: image.mimeType, data: image.data }
      : {
          mimeType: image.mimeType,
          artifactId: image.artifactId,
          sizeBytes: image.sizeBytes,
          sha256: image.sha256,
        }),
  });
}

async function draftFingerprint(text: string, images: readonly PromptImageInput[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizedDraftFingerprintInput(text, images)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function markerSuppressesDraft(
  marker: ExternalDeletionMarker | null,
  draft: ComposerDraft | null,
): Promise<boolean> {
  if (!marker || !draft) return false;
  if (marker.kind === "unconditional") return draft.updatedAt <= marker.deletedAt;
  if (marker.expectedRevision !== undefined) {
    if (draft.revision !== marker.expectedRevision) return false;
  } else if (draft.updatedAt > marker.deletedAt) {
    // Fingerprint-only intent identifies content, not a stable snapshot. Do not let it suppress an
    // identical draft saved after the conditional deletion was attempted.
    return false;
  }
  return await draftFingerprint(draft.text, draft.images) === marker.fingerprint;
}

function advanceDraftPastFallbackTombstone(
  sessionId: string,
  instanceScope: string,
  draft: ComposerDraft,
): ComposerDraft {
  const marker = loadFallbackTombstone(sessionId, instanceScope);
  if (!marker || draft.updatedAt > marker.deletedAt) return draft;
  return { ...draft, updatedAt: marker.deletedAt + 1 };
}

function clearFallbackTombstone(sessionId: string, instanceScope: string): void {
  try {
    localStorage.removeItem(fallbackTombstoneKey(sessionId, instanceScope));
  } catch {
    // A current IndexedDB record still wins if restricted storage prevents best-effort cleanup.
  }
}

function revision(key: string): number {
  return revisions.get(key) ?? 0;
}

function validImage(value: unknown): value is PromptImageInput {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) return false;
  if (typeof image.data === "string") return true;
  return typeof image.artifactId === "string" && typeof image.sizeBytes === "number" &&
    typeof image.sha256 === "string";
}

function validCommandSubmission(value: unknown): value is ComposerCommandSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const submission = value as Partial<ComposerCommandSubmission>;
  return typeof submission.submissionId === "string" && submission.submissionId.length > 0 &&
    submission.submissionId.length <= 128 && typeof submission.providerCommandId === "string" &&
    submission.providerCommandId.length > 0 && submission.providerCommandId.length <= 256 &&
    typeof submission.catalogRevision === "string" && submission.catalogRevision.length > 0 &&
    submission.catalogRevision.length <= 256 && typeof submission.argumentText === "string" &&
    submission.argumentText.length <= 256 * 1024;
}

/** Validate persisted browser data before it reaches the composer. */
export function parseComposerDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<ComposerDraft>;
  if (typeof draft.text !== "string" || !Array.isArray(draft.images) || !draft.images.every(validImage)) return null;
  return {
    text: draft.text,
    images: draft.images,
    updatedAt: typeof draft.updatedAt === "number" ? draft.updatedAt : 0,
    ...(typeof draft.revision === "string" ? { revision: draft.revision } : {}),
    ...(validCommandSubmission(draft.commandSubmission)
      ? { commandSubmission: draft.commandSubmission }
      : {}),
  };
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open draft storage"));
    request.onblocked = () => reject(new Error("draft storage upgrade blocked"));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  dbPromise = pending;
  return pending;
}

/** Open the old database only when it already exists. Opening a missing IndexedDB database creates
 * it, so browsers without `indexedDB.databases()` abort the version-zero upgrade transaction. */
function openLegacyDbIfExists(): Promise<IDBDatabase | null> {
  if (legacyDbPromise) return legacyDbPromise;
  const pending = (async () => {
    const factory = indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (typeof factory.databases === "function") {
      const databases = await factory.databases();
      if (!databases.some((database) => database.name === LEGACY_DB_NAME)) return null;
    }
    return new Promise<IDBDatabase | null>((resolve, reject) => {
      let missing = false;
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onupgradeneeded = (event) => {
        // oldVersion === 0 means the database did not exist. Abort so a fresh profile never
        // persists an empty legacy-branded database merely because a draft was read.
        missing = event.oldVersion === 0;
        if (missing) request.transaction?.abort();
      };
      request.onsuccess = () => {
        if (missing) {
          request.result.close();
          resolve(null);
        } else {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            legacyDbPromise = null;
          };
          resolve(db);
        }
      };
      request.onerror = () => {
        if (missing && request.error?.name === "AbortError") resolve(null);
        else reject(request.error ?? new Error("could not open legacy draft storage"));
      };
      request.onblocked = () => reject(new Error("legacy draft storage open blocked"));
    });
  })().catch((error) => {
    legacyDbPromise = null;
    throw error;
  });
  legacyDbPromise = pending;
  return pending;
}

function idbRead(db: IDBDatabase, key: string, rawLocalSessionId: string | null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result !== undefined || !rawLocalSessionId) {
        resolve(request.result);
        return;
      }
      const raw = store.get(rawLocalSessionId);
      raw.onsuccess = () => resolve(raw.result);
      raw.onerror = () => reject(raw.error ?? new Error("could not read legacy draft"));
    };
    request.onerror = () => reject(request.error ?? new Error("could not read draft"));
  });
}

function idbReadCurrent(db: IDBDatabase, key: string): Promise<{ value: unknown; tombstoned: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const record = store.get(key);
    const tombstone = store.get(draftTombstoneKey(key));
    tx.oncomplete = () => resolve({
      value: record.result,
      tombstoned: tombstone.result !== undefined,
    });
    tx.onerror = () => reject(tx.error ?? new Error("could not read draft state"));
    tx.onabort = () => reject(tx.error ?? new Error("draft state read aborted"));
  });
}

function idbPut(db: IDBDatabase, key: string, draft: ComposerDraft): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(draft, key);
    store.delete(draftTombstoneKey(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("could not save draft"));
    tx.onabort = () => reject(tx.error ?? new Error("draft save aborted"));
  });
}

/** Copy an old record without overwriting a new record or crossing a durable deletion tombstone. */
function idbPutIfAbsent(
  db: IDBDatabase,
  key: string,
  draft: unknown,
): Promise<{ value: unknown; tombstoned: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const record = store.get(key);
    const tombstone = store.get(draftTombstoneKey(key));
    let result: unknown;
    let tombstoned = false;
    tx.oncomplete = () => resolve({ value: result, tombstoned });
    tx.onerror = () => reject(tx.error ?? new Error("could not migrate draft"));
    tx.onabort = () => reject(tx.error ?? new Error("draft migration aborted"));
    tombstone.onsuccess = () => {
      tombstoned = tombstone.result !== undefined;
      result = record.result;
      if (result === undefined && !tombstoned) {
        result = draft;
        store.put(draft, key);
      }
    };
  });
}

async function idbGet(
  key: string,
  legacyKey: string,
  rawLocalSessionId: string | null,
  fallbackTombstone: ExternalDeletionMarker | null,
): Promise<unknown> {
  const currentDb = await openDb();
  const current = await idbReadCurrent(currentDb, key);
  if (current.value !== undefined) {
    return await markerSuppressesDraft(fallbackTombstone, parseComposerDraft(current.value))
      ? undefined
      : current.value;
  }
  if (current.tombstoned) return undefined;

  const legacyDb = await openLegacyDbIfExists();
  if (!legacyDb) return undefined;
  const legacy = await idbRead(legacyDb, legacyKey, rawLocalSessionId);
  if (legacy === undefined) return undefined;
  if (await markerSuppressesDraft(fallbackTombstone, parseComposerDraft(legacy))) return undefined;
  const copied = await idbPutIfAbsent(currentDb, key, legacy);
  return copied.tombstoned ? undefined : copied.value;
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    store.put({ deletedAt: Date.now() }, draftTombstoneKey(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("could not delete draft"));
    tx.onabort = () => reject(tx.error ?? new Error("draft delete aborted"));
  });
}

function sameImages(left: readonly PromptImageInput[], right: readonly PromptImageInput[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((image, index) => {
    const candidate = right[index];
    if (!candidate || image.mimeType !== candidate.mimeType) return false;
    if ("data" in image || "data" in candidate) {
      return "data" in image && "data" in candidate && image.data === candidate.data;
    }
    return image.artifactId === candidate.artifactId &&
      image.sizeBytes === candidate.sizeBytes && image.sha256 === candidate.sha256;
  });
}

export function composerDraftMatches(
  draft: Pick<ComposerDraft, "text" | "images"> | null | undefined,
  text: string,
  images: readonly PromptImageInput[],
): boolean {
  return Boolean(draft && draft.text === text && sameImages(draft.images, images));
}

type ConditionalDeleteResult = "deleted" | "mismatch" | "missing" | "tombstoned";

function idbDeleteCurrentIfMatches(
  db: IDBDatabase,
  key: string,
  text: string,
  images: readonly PromptImageInput[],
  expectedRevision?: string,
  tombstoneWhenMissing = false,
): Promise<ConditionalDeleteResult> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const record = store.get(key);
    const tombstone = store.get(draftTombstoneKey(key));
    let result: ConditionalDeleteResult = "missing";
    tombstone.onsuccess = () => {
      const current = parseComposerDraft(record.result);
      if (record.result !== undefined) {
        if (!composerDraftMatches(current, text, images) ||
            (expectedRevision !== undefined && current?.revision !== expectedRevision)) {
          result = "mismatch";
          return;
        }
        store.delete(key);
        store.put({ deletedAt: Date.now() }, draftTombstoneKey(key));
        result = "deleted";
        return;
      }
      if (tombstone.result !== undefined) {
        result = "tombstoned";
      } else if (tombstoneWhenMissing) {
        store.put({ deletedAt: Date.now() }, draftTombstoneKey(key));
        result = "deleted";
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("could not conditionally delete draft"));
    tx.onabort = () => reject(tx.error ?? new Error("draft conditional delete aborted"));
  });
}

async function idbDeleteIfMatches(
  key: string,
  legacyKey: string,
  rawLocalSessionId: string | null,
  text: string,
  images: readonly PromptImageInput[],
  expectedRevision?: string,
): Promise<boolean> {
  const currentDb = await openDb();
  const current = await idbDeleteCurrentIfMatches(
    currentDb,
    key,
    text,
    images,
    expectedRevision,
  );
  if (current === "deleted") return true;
  if (current !== "missing") return false;

  const legacyDb = await openLegacyDbIfExists();
  if (!legacyDb) return false;
  const legacy = await idbRead(legacyDb, legacyKey, rawLocalSessionId);
  const legacyDraft = parseComposerDraft(legacy);
  if (!composerDraftMatches(legacyDraft, text, images) ||
      (expectedRevision !== undefined && legacyDraft?.revision !== expectedRevision)) {
    return false;
  }
  return (await idbDeleteCurrentIfMatches(
    currentDb,
    key,
    text,
    images,
    expectedRevision,
    true,
  )) === "deleted";
}

function fallbackLogicalKey(sessionId: string): string {
  return `${FALLBACK_PREFIX}${sessionId}`;
}

function fallbackLoadRaw(sessionId: string, instanceScope: string): ComposerDraft | null {
  try {
    return parseComposerDraft(JSON.parse(
      loadInstanceStorageValue(fallbackLogicalKey(sessionId), instanceScope) ?? "null",
    ));
  } catch {
    return null;
  }
}

async function fallbackLoad(sessionId: string, instanceScope: string): Promise<ComposerDraft | null> {
  const draft = fallbackLoadRaw(sessionId, instanceScope);
  return await markerSuppressesDraft(loadFallbackTombstone(sessionId, instanceScope), draft)
    ? null
    : draft;
}

export async function loadComposerDraft(
  sessionId: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): Promise<ComposerDraft | null> {
  const key = draftKey(sessionId, instanceScope);
  if (discardedSessionIds.has(key)) return null;
  const handoff = pendingHandoffs.get(key);
  if (handoff) return handoff;
  if (typeof indexedDB !== "undefined") {
    try {
      const draft = parseComposerDraft(await idbGet(
        key,
        legacyDraftKey(sessionId, instanceScope),
        instanceScope === LOCAL_INSTANCE_SCOPE ? sessionId : null,
        loadFallbackTombstone(sessionId, instanceScope),
      ));
      if (draft) return draft;
    } catch {
      /* fall through to localStorage (private mode / unavailable IndexedDB) */
    }
  }
  return fallbackLoad(sessionId, instanceScope);
}

/** Keep a one-shot same-page copy while a newly created session mounts. Browser persistence can
 * be denied or quota-limited, so edit-in-fork must not rely on IndexedDB/localStorage alone. */
export function stageComposerDraftHandoff(
  sessionId: string,
  text: string,
  images: PromptImageInput[],
  instanceScope = LOCAL_INSTANCE_SCOPE,
): void {
  const key = draftKey(sessionId, instanceScope);
  if (discardedSessionIds.has(key)) return;
  pendingHandoffs.delete(key);
  pendingHandoffs.set(key, { text, images, updatedAt: Date.now() });
  while (pendingHandoffs.size > MAX_PENDING_HANDOFFS) {
    const oldest = pendingHandoffs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingHandoffs.delete(oldest);
  }
}

/** Consume only the exact handoff a live hydration applied. A StrictMode throwaway mount may peek
 * first and be cancelled before its Promise callback, so load itself must remain non-destructive. */
export function consumeComposerDraftHandoff(
  sessionId: string,
  draft: ComposerDraft,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): void {
  const key = draftKey(sessionId, instanceScope);
  if (pendingHandoffs.get(key) === draft) pendingHandoffs.delete(key);
}

export async function saveComposerDraft(
  sessionId: string,
  text: string,
  images: PromptImageInput[],
  instanceScope = LOCAL_INSTANCE_SCOPE,
): Promise<void> {
  const key = draftKey(sessionId, instanceScope);
  if (discardedSessionIds.has(key)) return;
  if (!text && images.length === 0) return deleteComposerDraft(sessionId, instanceScope);
  const startedAtRevision = revision(key);
  const draft: ComposerDraft = { text, images, updatedAt: Date.now(), revision: browserRandomUUID() };
  if (typeof indexedDB !== "undefined") {
    try {
      const db = await openDb();
      await idbPut(db, key, draft);
      if (discardedSessionIds.has(key) || revision(key) !== startedAtRevision) {
        // A newer save may already have queued its write while this put was in flight. Cleanup
        // therefore has to prove that this exact revision still owns the key inside the same
        // transaction that deletes it; an unconditional delete could otherwise erase the newer
        // draft after IndexedDB serializes that write ahead of this continuation.
        await idbDeleteCurrentIfMatches(db, key, draft.text, draft.images, draft.revision);
        return;
      }
      clearFallbackTombstone(sessionId, instanceScope);
      removeInstanceStorageValue(fallbackLogicalKey(sessionId), instanceScope);
      return;
    } catch {
      /* use the smaller/quota-limited fallback when IndexedDB is unavailable */
    }
  }
  if (discardedSessionIds.has(key) || revision(key) !== startedAtRevision) return;
  // A fallback write does not prove the current IndexedDB record was replaced. Keep any external
  // deletion intent so reads can suppress an older still-readable IDB record before choosing this
  // newer fallback. A later successful IDB save clears the marker.
  const fallbackDraft = advanceDraftPastFallbackTombstone(sessionId, instanceScope, draft);
  saveInstanceStorageValue(
    fallbackLogicalKey(sessionId),
    JSON.stringify(fallbackDraft),
    instanceScope,
  );
}

export async function deleteComposerDraft(
  sessionId: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): Promise<void> {
  const key = draftKey(sessionId, instanceScope);
  const deletionMarker: ExternalDeletionMarker = {
    version: 1,
    kind: "unconditional",
    deletedAt: Date.now(),
  };
  pendingHandoffs.delete(key);
  revisions.set(key, revision(key) + 1);
  if (typeof indexedDB !== "undefined") {
    try {
      await idbDelete(await openDb(), key);
    } catch {
      // The current database cannot carry its atomic tombstone. Record the confirmed deletion in
      // current-only instance storage before clearing fallback data or consulting legacy again.
      saveFallbackTombstone(sessionId, instanceScope, deletionMarker);
    }
  } else {
    saveFallbackTombstone(sessionId, instanceScope, deletionMarker);
  }
  removeInstanceStorageValue(fallbackLogicalKey(sessionId), instanceScope);
}

/** Delete only the exact submitted snapshot. A newer edit must survive a delayed prompt or
 * steering response, including when the user navigates away while the request is in flight. */
export async function deleteComposerDraftIfMatches(
  sessionId: string,
  text: string,
  images: readonly PromptImageInput[],
  instanceScope = LOCAL_INSTANCE_SCOPE,
  expectedRevision?: string,
): Promise<boolean> {
  const key = draftKey(sessionId, instanceScope);
  const deletedAt = Date.now();
  const handoff = pendingHandoffs.get(key);
  const handoffDeleted = composerDraftMatches(handoff, text, images) &&
    (expectedRevision === undefined || handoff?.revision === expectedRevision);
  if (handoffDeleted) pendingHandoffs.delete(key);

  let deleted = handoffDeleted;
  let idbDeleted = false;
  let currentIdbReliable = typeof indexedDB !== "undefined";
  if (typeof indexedDB !== "undefined") {
    try {
      idbDeleted = await idbDeleteIfMatches(
        key,
        legacyDraftKey(sessionId, instanceScope),
        instanceScope === LOCAL_INSTANCE_SCOPE ? sessionId : null,
        text,
        images,
        expectedRevision,
      );
      deleted = idbDeleted || deleted;
    } catch {
      currentIdbReliable = false;
    }
  }
  // Read the physical fallback record without applying its deletion marker. Provider acceptance
  // records that marker before cleanup begins, so applying it here would hide the exact record
  // this best-effort cleanup is meant to remove.
  const fallback = fallbackLoadRaw(sessionId, instanceScope);
  if (composerDraftMatches(fallback, text, images) &&
      (expectedRevision === undefined || fallback?.revision === expectedRevision)) {
    removeInstanceStorageValue(fallbackLogicalKey(sessionId), instanceScope);
    deleted = true;
  }
  if (!currentIdbReliable || (deleted && !idbDeleted)) {
    const deletionMarker: ExternalDeletionMarker = {
      version: 1,
      kind: "conditional",
      deletedAt,
      fingerprint: await draftFingerprint(text, images),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    };
    // A failed operation is uncertain even when no currently readable snapshot matched, while a
    // matched handoff/fallback can outlive a reliable-but-nonmatching IDB view. In both cases the
    // typed marker suppresses only the submitted snapshot and preserves a newer record.
    saveFallbackTombstone(sessionId, instanceScope, deletionMarker);
  }
  return deleted;
}

/** Record provider acceptance before best-effort local cleanup. The revision-scoped marker makes
 * the submitted recovery snapshot unreadable across navigation and reload even if conditional
 * deletion reports a mismatch or throws, while a later/newer draft remains visible. */
export async function markComposerDraftAccepted(
  sessionId: string,
  text: string,
  images: readonly PromptImageInput[],
  instanceScope = LOCAL_INSTANCE_SCOPE,
  expectedRevision?: string,
): Promise<boolean> {
  const marker: ExternalDeletionMarker = {
    version: 1,
    kind: "conditional",
    deletedAt: Date.now(),
    fingerprint: await draftFingerprint(text, images),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
  return saveFallbackTombstone(sessionId, instanceScope, marker);
}

/** Persist the exact snapshot being submitted and return its immutable identity. Cleanup can then
 * delete only this revision, never a newer draft that happens to have identical content. */
export async function reserveComposerDraftSnapshot(
  sessionId: string,
  text: string,
  images: PromptImageInput[],
  instanceScope = LOCAL_INSTANCE_SCOPE,
  commandSubmission?: ComposerCommandSubmission,
): Promise<ComposerDraft> {
  const key = draftKey(sessionId, instanceScope);
  const draft: ComposerDraft = {
    text,
    images,
    updatedAt: Date.now(),
    revision: browserRandomUUID(),
    ...(commandSubmission ? { commandSubmission } : {}),
  };
  if (discardedSessionIds.has(key)) return draft;
  pendingHandoffs.delete(key);
  if (typeof indexedDB !== "undefined") {
    try {
      await idbPut(await openDb(), key, draft);
      clearFallbackTombstone(sessionId, instanceScope);
      if (discardedSessionIds.has(key)) {
        await idbDelete(await openDb(), key);
        return draft;
      }
      removeInstanceStorageValue(fallbackLogicalKey(sessionId), instanceScope);
      return draft;
    } catch {
      /* preserve the reservation in fallback storage when IndexedDB is unavailable */
    }
  }
  if (discardedSessionIds.has(key)) return draft;
  // As in saveComposerDraft, fallback persistence cannot retire an external marker while an older
  // IndexedDB record may still be readable.
  const fallbackDraft = advanceDraftPastFallbackTombstone(sessionId, instanceScope, draft);
  saveInstanceStorageValue(
    fallbackLogicalKey(sessionId),
    JSON.stringify(fallbackDraft),
    instanceScope,
  );
  return fallbackDraft;
}

/** Permanently discard a deleted session's draft and reject late debounce/unmount writes. Session
 * ids are never reused; the in-memory tombstone only needs to live until this page unloads. */
export async function discardComposerDraft(
  sessionId: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): Promise<void> {
  discardedSessionIds.add(draftKey(sessionId, instanceScope));
  await deleteComposerDraft(sessionId, instanceScope);
}
