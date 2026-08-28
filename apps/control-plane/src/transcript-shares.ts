import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import {
  LEGACY_TRANSCRIPT_SHARE_AUTH_SCHEME,
  OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION,
  WOLLIPOG_TRANSCRIPT_SHARE_AUTH_SCHEME,
  type CreateTranscriptShareRequest,
  type CreateTranscriptShareResult,
  type OperationalTranscriptProjection,
  type PublicTranscriptShare,
  type TranscriptShareView,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_UTF8_BYTES } from "./share-projection.js";
import { buildAuthorizedSessionTranscriptExport } from "./session-exports.js";

export const MIN_TRANSCRIPT_SHARE_TTL_SECONDS = 5 * 60;
export const MAX_TRANSCRIPT_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_ACTIVE_TRANSCRIPT_SHARES_PER_SESSION = 20;
export const MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_SESSION = 32 * 1024 * 1024;
export const MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_ORGANIZATION = 256 * 1024 * 1024;
export const MAX_TRANSCRIPT_SHARE_READS_PER_TOKEN_PER_MINUTE = 12;
export const MAX_TRANSCRIPT_SHARE_READS_GLOBAL_PER_MINUTE = 500;

type ShareFailure<S extends 400 | 404 | 409 | 413 | 422 = 400 | 404 | 409 | 413 | 422> = {
  ok: false;
  status: S;
  error: string;
  code: string;
};

export type CreateTranscriptShareServiceResult =
  | ShareFailure
  | { ok: true; value: CreateTranscriptShareResult };

export type ListTranscriptSharesServiceResult =
  | ShareFailure<404>
  | { ok: true; value: TranscriptShareView[] };

function validatedTtl(request: unknown): number | null {
  const ttl = (request as Partial<CreateTranscriptShareRequest> | null)?.expiresInSeconds;
  return Number.isSafeInteger(ttl) && Number(ttl) >= MIN_TRANSCRIPT_SHARE_TTL_SECONDS &&
    Number(ttl) <= MAX_TRANSCRIPT_SHARE_TTL_SECONDS
    ? Number(ttl)
    : null;
}

function newTranscriptShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The capability is deliberately a separate scheme so it can never authenticate as a device. */
export function extractTranscriptShareToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  for (const scheme of [WOLLIPOG_TRANSCRIPT_SHARE_AUTH_SCHEME, LEGACY_TRANSCRIPT_SHARE_AUTH_SCHEME]) {
    if (!authorization.startsWith(scheme)) continue;
    const match = /^\s+([A-Za-z0-9_-]{43})$/.exec(authorization.slice(scheme.length));
    if (match) return match[1]!;
  }
  return null;
}

/** In-memory abuse bound. Keys are SHA-256 digests only; raw capabilities are never retained. */
export class TranscriptShareReadLimiter {
  private windowStartedAt = 0;
  private globalCount = 0;
  private readonly perToken = new Map<string, number>();

  allowTokenHash(tokenHash: string, now = Date.now()): boolean {
    if (this.windowStartedAt === 0 || now - this.windowStartedAt >= 60_000 || now < this.windowStartedAt) {
      this.windowStartedAt = now;
      this.globalCount = 0;
      this.perToken.clear();
    }
    const count = (this.perToken.get(tokenHash) ?? 0) + 1;
    this.perToken.set(tokenHash, count);
    if (count > MAX_TRANSCRIPT_SHARE_READS_PER_TOKEN_PER_MINUTE) return false;
    this.globalCount += 1;
    return this.globalCount <= MAX_TRANSCRIPT_SHARE_READS_GLOBAL_PER_MINUTE;
  }
}

export interface PublicTranscriptShareCapability {
  tokenHash: string;
  shareId: string;
  expiresAt: number;
  schemaVersion: number;
}

/** Cheap metadata-only lookup. Unknown random tokens never consume the valid-body budget. */
export function lookupPublicTranscriptShareCapability(
  db: ControlPlaneDb,
  authorization: string | undefined | null,
  now = Date.now(),
): PublicTranscriptShareCapability | null {
  const token = extractTranscriptShareToken(authorization);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const stored = db.transcriptShareByTokenHash(tokenHash, now);
  return stored ? { tokenHash, ...stored } : null;
}

export function createAuthorizedTranscriptShare(
  db: ControlPlaneDb,
  principal: HumanPrincipal,
  sessionId: string,
  request: unknown,
  now = Date.now(),
): CreateTranscriptShareServiceResult {
  const ttlSeconds = validatedTtl(request);
  if (ttlSeconds === null) {
    return {
      ok: false,
      status: 400,
      error: `expiresInSeconds must be an integer from ${MIN_TRANSCRIPT_SHARE_TTL_SECONDS} to ${MAX_TRANSCRIPT_SHARE_TTL_SECONDS}`,
      code: "invalid_expiry",
    };
  }
  if (!db.canAccessSession(principal, sessionId)) {
    return { ok: false, status: 404, error: "session not found", code: "not_found" };
  }

  // Build once, synchronously, from a frozen CP-cache high-water. Public reads use only the
  // canonical persisted projection and can never observe later events or session metadata.
  const exported = buildAuthorizedSessionTranscriptExport(db, principal, sessionId, "json");
  if (!exported.ok) return exported;

  const token = newTranscriptShareToken();
  const share = db.createTranscriptShare({
    shareId: `shr_${randomUUID().replace(/-/g, "")}`,
    tokenHash: hashToken(token),
    sessionId,
    organizationId: principal.organizationId,
    createdByUserId: principal.userId,
    projectionJson: exported.body.toString("utf8"),
    projectionBytes: exported.body.byteLength,
    snapshotThroughSeq: exported.throughSeq,
    schemaVersion: exported.projection.schemaVersion,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1_000,
  }, MAX_ACTIVE_TRANSCRIPT_SHARES_PER_SESSION, MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_SESSION,
  MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_ORGANIZATION);
  if (share === "count_limit") {
    return {
      ok: false,
      status: 409,
      error: `a session may have at most ${MAX_ACTIVE_TRANSCRIPT_SHARES_PER_SESSION} active transcript shares`,
      code: "share_limit",
    };
  }
  if (share === "byte_limit") {
    return {
      ok: false,
      status: 409,
      error: "active transcript shares exceed the retained snapshot byte quota",
      code: "share_storage_limit",
    };
  }
  return { ok: true, value: { share, token } };
}

export function listAuthorizedTranscriptShares(
  db: ControlPlaneDb,
  principal: HumanPrincipal,
  sessionId: string,
  now = Date.now(),
): ListTranscriptSharesServiceResult {
  if (!db.canAccessSession(principal, sessionId)) {
    return { ok: false, status: 404, error: "session not found", code: "not_found" };
  }
  return { ok: true, value: db.listTranscriptShares(sessionId, now) };
}

export function revokeAuthorizedTranscriptShare(
  db: ControlPlaneDb,
  principal: HumanPrincipal,
  sessionId: string,
  shareId: string,
  now = Date.now(),
): { ok: true; value: TranscriptShareView } | ShareFailure<404> {
  if (!db.canAccessSession(principal, sessionId)) {
    return { ok: false, status: 404, error: "share not found", code: "not_found" };
  }
  const share = db.revokeTranscriptShare(sessionId, shareId, now);
  return share
    ? { ok: true, value: share }
    : { ok: false, status: 404, error: "share not found", code: "not_found" };
}

function parsePersistedProjection(raw: string, schemaVersion: number): OperationalTranscriptProjection | null {
  if (schemaVersion !== OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION ||
      Buffer.byteLength(raw, "utf8") > DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_UTF8_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const projection = value as Partial<OperationalTranscriptProjection>;
  if (projection.schemaVersion !== OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION ||
      projection.source !== "control-plane-cache" || projection.completeness !== "possibly-partial" ||
      !Array.isArray(projection.messages)) return null;
  const messages: OperationalTranscriptProjection["messages"] = [];
  for (const message of projection.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const candidate = message as { role?: unknown; text?: unknown };
    if (Object.keys(candidate).some((key) => key !== "role" && key !== "text")) return null;
    if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.text !== "string") return null;
    messages.push({ role: candidate.role, text: candidate.text });
  }
  return {
    schemaVersion: OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION,
    source: "control-plane-cache",
    completeness: "possibly-partial",
    messages,
  };
}

/** Invalid, unknown, expired, revoked, and corrupt capabilities intentionally collapse to null. */
export function resolvePublicTranscriptShare(
  db: ControlPlaneDb,
  authorization: string | undefined | null,
  now = Date.now(),
): PublicTranscriptShare | null {
  const capability = lookupPublicTranscriptShareCapability(db, authorization, now);
  return capability ? loadPublicTranscriptShare(db, capability, now) : null;
}

export function loadPublicTranscriptShare(
  db: ControlPlaneDb,
  capability: PublicTranscriptShareCapability,
  now = Date.now(),
): PublicTranscriptShare | null {
  const raw = db.transcriptShareContentById(capability.shareId, now);
  if (raw === null) return null;
  const transcript = parsePersistedProjection(raw, capability.schemaVersion);
  return transcript ? { expiresAt: capability.expiresAt, transcript } : null;
}
