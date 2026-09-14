import {
  loadInstanceStorageValue,
  removeInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

function draftKey(sessionId: string, requestId: string, resourceDigest: string): string {
  return `wollipog.evidence-review.${JSON.stringify([sessionId, requestId, resourceDigest])}`;
}

/** Persist only opaque evidence ids. URLs and request context never enter browser storage. */
export function loadEvidenceReviewDraft(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  allowedIds: readonly string[],
): string[] {
  const raw = loadInstanceStorageValue(draftKey(sessionId, requestId, resourceDigest), instanceScope);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set(allowedIds);
    return [...new Set(parsed.filter((value): value is string =>
      typeof value === "string" && allowed.has(value)))];
  } catch {
    return [];
  }
}

export function saveEvidenceReviewDraft(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  reviewedIds: readonly string[],
): void {
  saveInstanceStorageValue(
    draftKey(sessionId, requestId, resourceDigest),
    JSON.stringify([...new Set(reviewedIds)]),
    instanceScope,
  );
}

export function clearEvidenceReviewDraft(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
): void {
  removeInstanceStorageValue(draftKey(sessionId, requestId, resourceDigest), instanceScope);
}
