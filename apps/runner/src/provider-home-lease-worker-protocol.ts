/** Control frames contain no canonical snapshots or private acquisition/completion tokens. */
export const LEASE_WORKER_LIMITS = { pending: 64, requestBytes: 64 * 1024, responseBytes: 4096, deadlineMs: 300_000, heartbeatDelayMs: 500 } as const;
export const LEASE_WORKER_ASSET = "wollipog/provider-home-lease-worker";
/** Bound on outstanding `acquire_reference` handles the worker keeps. Every handle is settled by
 * `release_reference` or `retain_reference`, so only in-flight transactions occupy the pool. */
export const LEASE_WORKER_REFERENCE_LIMIT = 1024;
/** `acquire_reference` is `acquire` that also keeps a worker-side handle for its exact registry
 * entry; `release_reference` drops that one reference through the handle (named by the completed
 * acquisition's id), so retargeting the HOME path afterwards cannot redirect the release.
 * `retain_reference` discards only the handle: the reference stays held until shutdown. */
/** Bound on the active profile ids one acquisition carries. */
export const LEASE_WORKER_PROFILE_LIMIT = 64;
/** Per-acquisition provider-profile context (#3239). Absent means an older caller. */
export interface LeaseWorkerProfileAccess {
  expectedId?: string;
  controlPlaneSupportsProfiles: boolean;
  activeProfileIds: string[];
}
export type LeaseWorkerOperation =
  | { method: "acquire" | "acquire_reference"; home: string; provider: string; profile?: LeaseWorkerProfileAccess }
  | { method: "release"; home: string }
  | { method: "release_reference" | "retain_reference"; home: string; referenceId: string }
  | { method: "cancel"; home: string; completedId: string }
  | { method: "close" }
  /** #3239: record or drop this control plane's grant in the HOME's profile marker while holding
   * the HOME's lease. These take the lease without the grant check (they are how grants change)
   * and drop the reference they took before replying. */
  | { method: "profile_adopt"; home: string; provider: "claude" | "codex"; grantId: string }
  | { method: "profile_revoke"; home: string; provider: "claude" | "codex"; profileId: string; grantId: string }
  /** #3239: give a new, marker-less managed HOME (Add Account) the identity `profileId` with this
   * control plane's grant. Refused as `profile_changed` when the HOME already holds a marker. */
  | { method: "profile_create"; home: string; provider: "claude" | "codex"; profileId: string; grantId: string }
  /** #3239: the retain-or-delete decision for a removed account's HOME, under its lease. Drops every
   * grant of this control plane from the marker; `value` is true only when the lease was released
   * (no other reference here) and no other control plane is granted, so the caller may delete it.
   * `profileId`, sent for a managed profile HOME, is the identity its account recorded: a marker
   * holding any other identity, or none, keeps the HOME and is not changed. */
  | { method: "profile_retire"; home: string; provider: "claude" | "codex"; profileId?: string };
export function isLeaseWorkerAcquisition(method: LeaseWorkerOperation["method"]): method is "acquire" | "acquire_reference" {
  return method === "acquire" || method === "acquire_reference";
}
export type LeaseWorkerError = "busy" | "unavailable" | "foreign_owner" | "foreign_host" | "refusal" | "cancelled" | "cancel_release_failed" | "expired" |
  "profile_unsupported_control_plane" | "profile_unverifiable" | "profile_not_granted" | "profile_changed" | "profile_grant_limit";
/** Fixed, path-free texts: only the code crosses the worker boundary, never the registry's message. */
export const LEASE_WORKER_ERRORS: Record<LeaseWorkerError, string> = {
  busy: "Provider HOME is already in use; retry after the current owner or publication finishes.",
  unavailable: "Provider-HOME lease helper unavailable; preserve all evidence and restore the fixed helper and executable staging directory before retrying.",
  foreign_owner: "Provider HOME has a stale lease from another runner or control plane whose recorded process has exited; Wollipog does not take over another owner's lease automatically. Use a separate provider account HOME for this runner, or quarantine the entire provider-home-leases-v1 directory only after proving no provider process or runner uses this HOME, and do not remove individual records.",
  foreign_host: "Provider HOME is leased by a runner on another host; use a separate provider account HOME or an isolated OS account for this runner, and preserve all lease evidence.",
  refusal: "Provider-HOME lease could not be proved; preserve all evidence and retry only with the exact private registry; quarantine the entire lease directory only after proving this HOME unused, and do not remove individual records.",
  cancelled: "Provider-HOME lease acquisition was cancelled.",
  cancel_release_failed: "Cancelled provider-HOME acquisition could not be exactly released; preserve all evidence and restart only after proving the HOME unused.",
  expired: "Provider-HOME lease operation exceeded its finite deadline; preserve all evidence.",
  profile_unsupported_control_plane: "This provider profile needs a newer control plane. Update the control plane, then retry.",
  profile_unverifiable: "This provider profile's identity marker is unreadable or uses a newer format, so it was not used. Update the runner, or ask an Owner or Admin to check the profile.",
  profile_not_granted: "This provider profile is not granted to this control plane. An Owner or Admin must grant access on this Machine before it can be used.",
  profile_changed: "This provider HOME no longer holds the profile that this account or session recorded, so it was not used. Restore the original directory or adopt the replacement explicitly.",
  profile_grant_limit: "This provider profile already records the maximum number of control-plane grants. Revoke an unused grant before granting another control plane.",
};
/** A worker refusal with its typed code, so callers can choose a recovery action without parsing text. */
export class ProviderHomeLeaseError extends Error {
  constructor(readonly code: LeaseWorkerError) { super(LEASE_WORKER_ERRORS[code]); }
}
export interface LeaseWorkerExecute {
  kind: "execute"; epoch: string; id: string; deadline: number; operation: LeaseWorkerOperation;
}
export interface LeaseWorkerAccept { kind: "accept"; epoch: string; id: string; cancel: boolean }
export type LeaseWorkerReply =
  | { kind: "ready"; epoch: string; pid: number }
  | { kind: "receipt" | "done"; epoch: string; id: string; ok: boolean; value: boolean; error?: LeaseWorkerError; profileId?: string }
  | { kind: "diagnostic"; epoch: string; event: "provider_home_checkpoint_unavailable" | "provider_home_release_unpublished"; leaseId: string; message: string };

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** A `profileId` crosses back only on a successful `profile_adopt` reply. */
export function validLeaseWorkerReplyProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID.test(value);
}
export function validLeaseWorkerProfileAccess(value: unknown): value is LeaseWorkerProfileAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (!leaseWorkerFrameKeys(v, ["expectedId", "controlPlaneSupportsProfiles", "activeProfileIds"]) ||
      keys.length !== (Object.hasOwn(v, "expectedId") ? 3 : 2)) return false;
  if (Object.hasOwn(v, "expectedId") && (typeof v.expectedId !== "string" || !PROFILE_ID.test(v.expectedId))) return false;
  if (typeof v.controlPlaneSupportsProfiles !== "boolean" || !Array.isArray(v.activeProfileIds) ||
      v.activeProfileIds.length > LEASE_WORKER_PROFILE_LIMIT) return false;
  const ids = v.activeProfileIds as unknown[];
  return ids.every(id => typeof id === "string" && PROFILE_ID.test(id)) && new Set(ids).size === ids.length;
}

export function validLeaseWorkerOperation(value: unknown): value is LeaseWorkerOperation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.method === "close") return Object.keys(v).length === 1;
  if (typeof v.home !== "string" || !v.home || v.home.includes("\0") || Buffer.byteLength(v.home) > 32768) return false;
  if (v.method === "release") return Object.keys(v).length === 2;
  if (v.method === "cancel") return typeof v.completedId === "string" && /^[a-f0-9-]{36}$/u.test(v.completedId) && Object.keys(v).length === 3;
  if (v.method === "release_reference" || v.method === "retain_reference") return typeof v.referenceId === "string" && /^[a-f0-9-]{36}$/u.test(v.referenceId) && Object.keys(v).length === 3;
  if (v.method === "profile_retire") {
    const expected = Object.hasOwn(v, "profileId");
    if (expected && (typeof v.profileId !== "string" || !PROFILE_ID.test(v.profileId))) return false;
    return (v.provider === "claude" || v.provider === "codex") && Object.keys(v).length === (expected ? 4 : 3);
  }
  if (v.method === "profile_adopt" || v.method === "profile_revoke" || v.method === "profile_create") {
    if (v.provider !== "claude" && v.provider !== "codex") return false;
    if (typeof v.grantId !== "string" || !GRANT_ID.test(v.grantId)) return false;
    if (v.method === "profile_adopt") return Object.keys(v).length === 4;
    return typeof v.profileId === "string" && PROFILE_ID.test(v.profileId) && Object.keys(v).length === 5;
  }
  const profiled = Object.hasOwn(v, "profile");
  return (v.method === "acquire" || v.method === "acquire_reference") && typeof v.provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(v.provider) &&
    (!profiled || validLeaseWorkerProfileAccess(v.profile)) && Object.keys(v).length === (profiled ? 4 : 3);
}
export function boundedLeaseWorkerFrame(value: unknown, maximum: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= maximum; } catch { return false; }
}

export function leaseWorkerFrameKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
