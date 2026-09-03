import type { PromptImageInput, QueuedPromptDraft, QueuedPromptView } from "@wollipog/protocol";
import {
  type KeyValueStorage,
  loadInstanceStorageValue,
  removeInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

export interface QueuedPromptEditState extends QueuedPromptDraft {
  submissionId?: string;
  submissionFingerprint?: string;
  displacedDraft: { text: string; images: PromptImageInput[] };
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

const STORAGE_KEY = "wollipog.queued-edit-recoveries.v1";
/** Seven days spans ordinary app restarts without retaining abandoned prompt content indefinitely. */
export const QUEUED_EDIT_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const QUEUED_EDIT_RECOVERY_MAX_ENTRIES = 20;
/** Leave headroom under common per-origin localStorage quotas for drafts and settings. */
export const QUEUED_EDIT_RECOVERY_MAX_BYTES = 3 * 1_024 * 1_024;

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
    },
    draft: candidate.draft,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
  });
}

function parseRegistry(raw: string | null, now: number): StoredQueuedEditRegistry {
  if (!raw) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
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
    return { version: 1, entries: entries.slice(-QUEUED_EDIT_RECOVERY_MAX_ENTRIES) };
  } catch {
    return { version: 1, entries: [] };
  }
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readRegistry(instanceScope: string, storage: KeyValueStorage | undefined, now: number): StoredQueuedEditRegistry {
  return parseRegistry(loadInstanceStorageValue(STORAGE_KEY, instanceScope, storage), now);
}

function writeRegistry(
  instanceScope: string,
  registry: StoredQueuedEditRegistry,
  storage?: KeyValueStorage,
): boolean {
  if (registry.entries.length === 0) {
    removeInstanceStorageValue(STORAGE_KEY, instanceScope, storage);
    return loadInstanceStorageValue(STORAGE_KEY, instanceScope, storage) === null;
  }
  return saveInstanceStorageValue(STORAGE_KEY, JSON.stringify(registry), instanceScope, storage);
}

export function loadDurableQueuedEditRecovery(
  scope: QueuedEditRecoveryScope,
  storage?: KeyValueStorage,
  now = Date.now(),
): QueuedPromptEditRecovery | undefined {
  const registry = readRegistry(scope.instanceScope, storage, now);
  const entry = registry.entries.find((candidate) =>
    candidate.accountKey === scope.accountKey && candidate.sessionId === scope.sessionId);
  writeRegistry(scope.instanceScope, registry, storage);
  return entry ? cloneQueuedPromptEditRecovery(entry.recovery) : undefined;
}

export function saveDurableQueuedEditRecovery(
  scope: QueuedEditRecoveryScope,
  recovery: QueuedPromptEditRecovery,
  storage?: KeyValueStorage,
  now = Date.now(),
): boolean {
  const registry = readRegistry(scope.instanceScope, storage, now);
  const nextEntry: StoredQueuedEditRecovery = {
    accountKey: scope.accountKey,
    sessionId: scope.sessionId,
    recovery: cloneQueuedPromptEditRecovery(recovery),
    updatedAt: now,
    expiresAt: now + QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
  };
  const entries = registry.entries.filter((entry) =>
    entry.accountKey !== scope.accountKey || entry.sessionId !== scope.sessionId);
  entries.push(nextEntry);
  entries.sort((left, right) => left.updatedAt - right.updatedAt);
  while (entries.length > QUEUED_EDIT_RECOVERY_MAX_ENTRIES) entries.shift();
  let serialized = JSON.stringify({ version: 1, entries } satisfies StoredQueuedEditRegistry);
  while (encodedBytes(serialized) > QUEUED_EDIT_RECOVERY_MAX_BYTES) {
    const oldestOther = entries.findIndex((entry) => entry !== nextEntry);
    if (oldestOther < 0) return false;
    entries.splice(oldestOther, 1);
    serialized = JSON.stringify({ version: 1, entries } satisfies StoredQueuedEditRegistry);
  }
  return saveInstanceStorageValue(STORAGE_KEY, serialized, scope.instanceScope, storage);
}

export function clearDurableQueuedEditRecovery(
  scope: QueuedEditRecoveryScope,
  storage?: KeyValueStorage,
  now = Date.now(),
): boolean {
  const registry = readRegistry(scope.instanceScope, storage, now);
  registry.entries = registry.entries.filter((entry) =>
    entry.accountKey !== scope.accountKey || entry.sessionId !== scope.sessionId);
  return writeRegistry(scope.instanceScope, registry, storage);
}

export function clearDurableQueuedEditRecoveriesForAccount(
  instanceScope: string,
  accountKey: string,
  storage?: KeyValueStorage,
  now = Date.now(),
): boolean {
  const registry = readRegistry(instanceScope, storage, now);
  registry.entries = registry.entries.filter((entry) => entry.accountKey !== accountKey);
  return writeRegistry(instanceScope, registry, storage);
}

export function clearAllDurableQueuedEditRecoveries(
  instanceScope: string,
  storage?: KeyValueStorage,
): void {
  removeInstanceStorageValue(STORAGE_KEY, instanceScope, storage);
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
