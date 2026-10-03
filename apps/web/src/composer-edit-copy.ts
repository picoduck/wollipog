import type { PromptImageInput } from "@wollipog/protocol";
import { parseComposerDraft } from "./composer-drafts.js";
import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  removeInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

/**
 * A copy of an earlier message that Edit as a New Turn loaded into a session's composer (#2185),
 * and the draft it replaced. The copy itself is the composer draft, saved like any other; this is
 * what Discard Edit needs to put the replaced draft back. It is kept per session for as long as the
 * draft is, so leaving the session, a remount or a reload does not lose the way back.
 */
export interface ComposerEditCopy {
  /** Tells one loaded copy from the next, so finishing an earlier send cannot end a later edit. */
  id: string;
  /** The copied message's turn, as the transcript numbers it, when known. */
  turn?: number;
  /** The draft the copy replaced; null when the composer was empty. */
  previous: { text: string; images: PromptImageInput[] } | null;
}

/** This page's copies, which hold even when browser storage refuses one (quota, private mode). */
const copies = new Map<string, ComposerEditCopy>();
const MAX_COPIES = 50;

function memoryKey(sessionId: string, instanceScope: string): string {
  return `${instanceScope}\u0000${sessionId}`;
}

function storageKey(sessionId: string): string {
  return `composer-edit-copy:${sessionId}`;
}

export function parseComposerEditCopy(value: unknown): ComposerEditCopy | null {
  if (!value || typeof value !== "object") return null;
  const copy = value as Partial<ComposerEditCopy>;
  if (typeof copy.id !== "string" || !copy.id) return null;
  if (copy.turn !== undefined && !Number.isInteger(copy.turn)) return null;
  let previous: ComposerEditCopy["previous"] = null;
  if (copy.previous !== null) {
    const draft = parseComposerDraft(copy.previous);
    if (!draft) return null;
    previous = { text: draft.text, images: draft.images };
  }
  return { id: copy.id, ...(copy.turn !== undefined ? { turn: copy.turn } : {}), previous };
}

export function loadComposerEditCopy(sessionId: string, instanceScope = LOCAL_INSTANCE_SCOPE): ComposerEditCopy | null {
  const held = copies.get(memoryKey(sessionId, instanceScope));
  if (held) return held;
  const stored = loadInstanceStorageValue(storageKey(sessionId), instanceScope);
  if (stored === null) return null;
  try {
    return parseComposerEditCopy(JSON.parse(stored));
  } catch {
    return null;
  }
}

export function saveComposerEditCopy(
  sessionId: string,
  copy: ComposerEditCopy,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): void {
  const key = memoryKey(sessionId, instanceScope);
  copies.delete(key);
  copies.set(key, copy);
  while (copies.size > MAX_COPIES) {
    const oldest = copies.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    copies.delete(oldest);
  }
  // Best-effort: a draft with large images can exceed the quota, and then this page's copy holds.
  // An earlier stored copy must not come back in its place after a reload.
  if (!saveInstanceStorageValue(storageKey(sessionId), JSON.stringify(copy), instanceScope)) {
    removeInstanceStorageValue(storageKey(sessionId), instanceScope);
  }
}

export function clearComposerEditCopy(sessionId: string, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  copies.delete(memoryKey(sessionId, instanceScope));
  removeInstanceStorageValue(storageKey(sessionId), instanceScope);
}

/** Forgets this page's copies for an instance, as a reload would; stored ones stay. */
export function forgetComposerEditCopiesForInstance(instanceScope: string): void {
  const prefix = `${instanceScope}\u0000`;
  for (const key of [...copies.keys()]) if (key.startsWith(prefix)) copies.delete(key);
}
