import {
  loadInstanceStorageValue,
  removeInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

/** `reviewed` holds the items marked Reviewed; `opened`, the link-only items whose link this
 * browser opened, which only then may be marked (#2197). */
type DraftPart = "reviewed" | "opened";

function draftKey(part: DraftPart, sessionId: string, requestId: string, resourceDigest: string): string {
  // The reviewed marks keep the key they had before opened links were recorded beside them.
  const prefix = part === "reviewed" ? "wollipog.evidence-review" : "wollipog.evidence-opened";
  return `${prefix}.${JSON.stringify([sessionId, requestId, resourceDigest])}`;
}

function loadIds(
  part: DraftPart,
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  allowedIds: readonly string[],
): string[] {
  const raw = loadInstanceStorageValue(draftKey(part, sessionId, requestId, resourceDigest), instanceScope);
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

function saveIds(
  part: DraftPart,
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  ids: readonly string[],
): void {
  saveInstanceStorageValue(
    draftKey(part, sessionId, requestId, resourceDigest),
    JSON.stringify([...new Set(ids)]),
    instanceScope,
  );
}

/** Persist only opaque evidence ids. URLs and request context never enter browser storage. */
export function loadEvidenceReviewDraft(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  allowedIds: readonly string[],
): string[] {
  return loadIds("reviewed", instanceScope, sessionId, requestId, resourceDigest, allowedIds);
}

export function saveEvidenceReviewDraft(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  reviewedIds: readonly string[],
): void {
  saveIds("reviewed", instanceScope, sessionId, requestId, resourceDigest, reviewedIds);
}

/** The link-only items of this occurrence whose link was opened in this browser. */
export function loadOpenedEvidenceLinks(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  allowedIds: readonly string[],
): string[] {
  return loadIds("opened", instanceScope, sessionId, requestId, resourceDigest, allowedIds);
}

export function saveOpenedEvidenceLinks(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
  openedIds: readonly string[],
): void {
  saveIds("opened", instanceScope, sessionId, requestId, resourceDigest, openedIds);
}

/** Forgets both the reviewed marks and the opened links of one occurrence. */
export function clearEvidenceReviewDraft(
  instanceScope: string,
  sessionId: string,
  requestId: string,
  resourceDigest: string,
): void {
  removeInstanceStorageValue(draftKey("reviewed", sessionId, requestId, resourceDigest), instanceScope);
  removeInstanceStorageValue(draftKey("opened", sessionId, requestId, resourceDigest), instanceScope);
}
