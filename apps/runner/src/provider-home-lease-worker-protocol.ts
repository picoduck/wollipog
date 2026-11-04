import { validProviderHomeBlockingProcess, type ProviderHomeBlockingProcess } from "@wollipog/protocol";
/** Control frames contain no canonical snapshots or private acquisition/completion tokens. */
export const LEASE_WORKER_LIMITS = { pending: 64, requestBytes: 64 * 1024, responseBytes: 4096, deadlineMs: 300_000, heartbeatDelayMs: 500 } as const;
/** Mixed wall-time/monotonic workers fail before any operation is dispatched. */
export const LEASE_WORKER_CLOCK = "hrtime-ns-v1";
export const LEASE_WORKER_ASSET = "wollipog/provider-home-lease-worker-hrtime-ns-v1";
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
  /** #3239: grant retirement for a removed account's HOME, under its lease. Drops every
   * grant of this control plane from the marker; `value` is true only when the lease was released
   * (no other reference here) and no other control plane is granted. This is not deletion authority;
   * a successor or unproved consumer may still depend on the HOME after release (#3157).
   * `profileId`, sent for a managed profile HOME, is the identity its account recorded: a marker
   * holding any other identity, or none, keeps the HOME and is not changed. */
  | { method: "profile_retire"; home: string; provider: "claude" | "codex"; profileId?: string }
  /** #3719: copy the Codex API-key sign-in of the existing source HOME `home` into a new managed
   * profile HOME `<destinationRoot>/<profileId>` whose first marker records `grantId`, in one
   * operation. `layout` says where the credential sits under `home`. The source is never created,
   * is refused while this runner holds or acquires it, and is leased exclusively with its own
   * dispatch-time profile context; the destination is created only after the source is admitted.
   * With `layout: "user_home"` the credential directory `home/.codex` is leased too, exclusively,
   * with its own context `credentialProfile`, since an account may name that directory itself. */
  | { method: "profile_import"; home: string; provider: "codex"; layout: "codex_home" | "user_home"; destinationRoot: string; profileId: string; grantId: string;
    profile?: LeaseWorkerProfileAccess; credentialProfile?: LeaseWorkerProfileAccess }
  /** #3241 part 2: read the HOME's lease journal without creating anything; the reply carries
   * `inspection`. */
  | { method: "lease_inspect"; home: string; profile?: LeaseWorkerProfileAccess }
  /** #3241 part 2: on an Owner/Admin authorization, succeed exactly the stale record hashed
   * `staleTipHash` and release the HOME again before replying. */
  | { method: "lease_recover"; home: string; provider: string; staleTipHash: string; authorizationId: string; profile?: LeaseWorkerProfileAccess };
export function isLeaseWorkerAcquisition(method: LeaseWorkerOperation["method"]): method is "acquire" | "acquire_reference" {
  return method === "acquire" || method === "acquire_reference";
}
/** Operations that carry the dispatch-time provider-profile context. */
export function leaseWorkerOperationTakesProfile(method: LeaseWorkerOperation["method"]): method is "acquire" | "acquire_reference" | "lease_inspect" | "lease_recover" | "profile_import" {
  return isLeaseWorkerAcquisition(method) || method === "lease_inspect" || method === "lease_recover" || method === "profile_import";
}
export type LeaseWorkerError = "busy" | "unavailable" | "foreign_owner" | "foreign_host" | "refusal" | "cancelled" | "cancel_release_failed" | "expired" |
  "holder_alive" | "boundary_survivor" | "process_survivor" | "boundary_unverifiable" | "process_uninspectable" | "process_uninspectable_not_delegated" | "invalid_journal" |
  "profile_unsupported_control_plane" | "profile_unverifiable" | "profile_not_granted" | "profile_changed" | "profile_grant_limit" |
  "stale_tip_changed" | "no_reboot_proof" | "recovery_unconfirmed" |
  "import_source_missing" | "import_source_held" | "import_source_unsafe" | "import_source_foreign" | "import_source_unsupported" | "import_source_changed";
/** #3241 part 2: a HOME's lease state, as an Owner or Admin sees it before authorizing a recovery. */
export interface LeaseWorkerInspection {
  state: "none" | "released" | "held" | "stale" | "unverifiable";
  tipHash?: string;
  createdAt?: string;
  sameHost?: boolean;
  hasEvidence?: boolean;
  /** Why an authorized recovery would be refused now, or null when it would proceed. */
  refusal?: LeaseWorkerError | null;
  blockingProcess?: ProviderHomeBlockingProcess;
}
/** Fixed, path-free texts: only the code crosses the worker boundary, never the registry's message. */
export const LEASE_WORKER_ERRORS: Record<LeaseWorkerError, string> = {
  holder_alive: "Another Wollipog runner is using this account. Wait for its work to finish, then try again, or choose another account.",
  boundary_survivor: "A program from an earlier session is still using this account. Wait for that work to finish, then try again, or choose another account.",
  process_survivor: "A program started by an earlier Wollipog runner is still using this account. Wait for that work to finish, then try again, or choose another account.",
  boundary_unverifiable: "Wollipog can't confirm that an earlier session has finished using this account. Choose another account for now, or ask the person who manages this machine to check it.",
  process_uninspectable: "Wollipog can't check whether another program is still using this account. Choose another account for now, or save your work and restart the machine before trying again.",
  process_uninspectable_not_delegated: "Wollipog can't safely unlock this account because it can't check a running program. Choose another account for now, or save your work and restart the machine before trying again.",
  invalid_journal: "Wollipog can't read or verify this account's recovery records. Choose another account and ask the person who manages this machine to check the recovery details.",
  busy: "Provider HOME is already in use; retry after the current owner or publication finishes.",
  unavailable: "Provider-HOME lease helper unavailable; preserve all evidence and restore the fixed helper and executable staging directory before retrying.",
  foreign_owner: "Provider HOME has a stale lease from another runner or control plane whose recorded process has exited; Wollipog does not take over another owner's lease automatically. Use a separate provider account HOME for this runner, or quarantine the entire provider-home-leases-v1 directory only after proving no provider process or runner uses this HOME, and do not remove individual records.",
  foreign_host: "Provider HOME is leased by a runner on another host; use a separate provider account HOME or an isolated OS account for this runner, and preserve all lease evidence.",
  refusal: "Provider-HOME lease could not be proved; preserve all evidence and retry only with the exact private registry; quarantine the entire lease directory only after proving this HOME unused, and do not remove individual records.",
  cancelled: "Provider-HOME lease acquisition was cancelled.",
  cancel_release_failed: "Cancelled provider-HOME acquisition could not be exactly released; preserve all evidence and restart only after proving the HOME unused.",
  expired: "Provider-HOME lease operation exceeded its finite deadline; preserve all evidence.",
  profile_unsupported_control_plane: "This version of Wollipog can't approve access to this account. Update the Wollipog server, then try again.",
  profile_unverifiable: "This provider profile's identity marker is unreadable or uses a newer format, so it was not used. Update the runner, or ask an Owner or Admin to check the profile.",
  profile_not_granted: "This provider profile is not granted to this control plane. An Owner or Admin must grant access on this Machine before it can be used.",
  profile_changed: "This provider HOME no longer holds the profile that this account or session recorded, so it was not used. Restore the original directory or adopt the replacement explicitly.",
  profile_grant_limit: "Too many Wollipog servers already have access to this account. An Owner or Admin needs to remove an unused server's access before adding this one.",
  stale_tip_changed: "This provider HOME's lease is no longer the stale lease that was authorized for recovery. Inspect it again before authorizing a recovery.",
  no_reboot_proof: "Wollipog can't safely unlock this account until this machine has restarted. Save your work, restart the machine, then recover the account in Connections.",
  recovery_unconfirmed: "The provider HOME lease recovery may have been recorded but could not be confirmed. Inspect the lease again before retrying.",
  import_source_missing: "There's no Codex sign-in to copy there. Sign in to create the profile instead.",
  import_source_held: "This sign-in is in use by a session, sign-in or Agent TUI on this Machine. Try again once it's free, or sign in instead.",
  import_source_unsafe: "Wollipog can't verify this sign-in's files: they must be private regular files and directories owned by the runner's user, without links. Sign in instead.",
  import_source_foreign: "This HOME belongs to another provider's profile, so its sign-in can't be copied. Sign in instead.",
  import_source_unsupported: "Only a Codex sign-in that uses an API key stored in auth.json can be copied. A ChatGPT sign-in, or one kept in the keyring, can't be shared safely; sign in instead.",
  import_source_changed: "This sign-in changed while it was being copied, so nothing was used. Try again.",
};
/** A worker refusal with its typed code, so callers can choose a recovery action without parsing text. */
export class ProviderHomeLeaseError extends Error {
  constructor(readonly code: LeaseWorkerError) { super(LEASE_WORKER_ERRORS[code]); }
}
export interface LeaseWorkerExecute {
  kind: "execute"; epoch: string; id: string; deadline: string; operation: LeaseWorkerOperation;
}
export interface LeaseWorkerAccept { kind: "accept"; epoch: string; id: string; cancel: boolean }
export type LeaseWorkerReply =
  | { kind: "ready"; epoch: string; pid: number; clock: typeof LEASE_WORKER_CLOCK }
  | { kind: "receipt" | "done"; epoch: string; id: string; ok: boolean; value: boolean; error?: LeaseWorkerError; profileId?: string; inspection?: LeaseWorkerInspection }
  | { kind: "diagnostic"; epoch: string; event: "provider_home_checkpoint_unavailable" | "provider_home_release_unpublished" | "provider_home_boundary_recovered"; leaseId: string; message: string };

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** A `profileId` crosses back only on a successful `profile_adopt` reply. */
export function validLeaseWorkerReplyProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID.test(value);
}
const DIGEST = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
/** An `inspection` crosses back only on a successful `lease_inspect` reply, in exactly this shape. */
export function validLeaseWorkerInspection(value: unknown): value is LeaseWorkerInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.state === "none" || v.state === "released" || v.state === "held" || v.state === "unverifiable") return Object.keys(v).length === 1;
  if (v.state !== "stale" || !leaseWorkerFrameKeys(v, ["state", "tipHash", "createdAt", "sameHost", "hasEvidence", "refusal", "blockingProcess"])) return false;
  const dated = Object.hasOwn(v, "createdAt");
  return Object.keys(v).length === (dated ? 6 : 5) + (Object.hasOwn(v, "blockingProcess") ? 1 : 0) &&
    (!Object.hasOwn(v, "blockingProcess") || v.refusal !== null && validProviderHomeBlockingProcess(v.blockingProcess)) && typeof v.tipHash === "string" && DIGEST.test(v.tipHash) &&
    (!dated || typeof v.createdAt === "string" && TIMESTAMP.test(v.createdAt)) &&
    typeof v.sameHost === "boolean" && typeof v.hasEvidence === "boolean" &&
    (v.refusal === null || typeof v.refusal === "string" && Object.hasOwn(LEASE_WORKER_ERRORS, v.refusal));
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
  if (profiled && !validLeaseWorkerProfileAccess(v.profile)) return false;
  if (v.method === "profile_import") {
    const credentialProfiled = Object.hasOwn(v, "credentialProfile");
    if (credentialProfiled && (v.layout !== "user_home" || !validLeaseWorkerProfileAccess(v.credentialProfile))) return false;
    return v.provider === "codex" && (v.layout === "codex_home" || v.layout === "user_home") &&
      typeof v.destinationRoot === "string" && v.destinationRoot.startsWith("/") && !v.destinationRoot.includes("\0") &&
      Buffer.byteLength(v.destinationRoot) <= 32768 && typeof v.profileId === "string" && PROFILE_ID.test(v.profileId) &&
      typeof v.grantId === "string" && GRANT_ID.test(v.grantId) &&
      Object.keys(v).length === 7 + (profiled ? 1 : 0) + (credentialProfiled ? 1 : 0);
  }
  if (v.method === "lease_inspect") return Object.keys(v).length === (profiled ? 3 : 2);
  const provider = typeof v.provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(v.provider);
  if (v.method === "lease_recover") {
    return provider && typeof v.staleTipHash === "string" && DIGEST.test(v.staleTipHash) &&
      typeof v.authorizationId === "string" && GRANT_ID.test(v.authorizationId) && Object.keys(v).length === (profiled ? 6 : 5);
  }
  return (v.method === "acquire" || v.method === "acquire_reference") && provider && Object.keys(v).length === (profiled ? 4 : 3);
}
export function boundedLeaseWorkerFrame(value: unknown, maximum: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= maximum; } catch { return false; }
}

export function leaseWorkerFrameKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
