/** Control frames contain no canonical snapshots or private acquisition/completion tokens. */
export const LEASE_WORKER_LIMITS = { pending: 64, requestBytes: 64 * 1024, responseBytes: 4096, deadlineMs: 300_000, heartbeatDelayMs: 500 } as const;
export const LEASE_WORKER_ASSET = "wollipog/provider-home-lease-worker";
/** Bound on outstanding `acquire_reference` handles the worker keeps. */
export const LEASE_WORKER_REFERENCE_LIMIT = 1024;
/** `acquire_reference` is `acquire` that also keeps a worker-side handle for its exact registry
 * entry; `release_reference` drops that one reference through the handle (named by the completed
 * acquisition's id), so retargeting the HOME path afterwards cannot redirect the release. */
export type LeaseWorkerOperation =
  | { method: "acquire" | "acquire_reference"; home: string; provider: string }
  | { method: "release"; home: string }
  | { method: "release_reference"; home: string; referenceId: string }
  | { method: "cancel"; home: string; completedId: string }
  | { method: "close" };
export function isLeaseWorkerAcquisition(method: LeaseWorkerOperation["method"]): method is "acquire" | "acquire_reference" {
  return method === "acquire" || method === "acquire_reference";
}
export type LeaseWorkerError = "busy" | "unavailable" | "foreign_owner" | "foreign_host" | "refusal" | "cancelled" | "cancel_release_failed" | "expired";
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
  | { kind: "receipt" | "done"; epoch: string; id: string; ok: boolean; value: boolean; error?: LeaseWorkerError }
  | { kind: "diagnostic"; epoch: string; event: "provider_home_checkpoint_unavailable" | "provider_home_release_unpublished"; leaseId: string; message: string };

export function validLeaseWorkerOperation(value: unknown): value is LeaseWorkerOperation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.method === "close") return Object.keys(v).length === 1;
  if (typeof v.home !== "string" || !v.home || v.home.includes("\0") || Buffer.byteLength(v.home) > 32768) return false;
  if (v.method === "release") return Object.keys(v).length === 2;
  if (v.method === "cancel") return typeof v.completedId === "string" && /^[a-f0-9-]{36}$/u.test(v.completedId) && Object.keys(v).length === 3;
  if (v.method === "release_reference") return typeof v.referenceId === "string" && /^[a-f0-9-]{36}$/u.test(v.referenceId) && Object.keys(v).length === 3;
  return (v.method === "acquire" || v.method === "acquire_reference") && typeof v.provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(v.provider) && Object.keys(v).length === 3;
}
export function boundedLeaseWorkerFrame(value: unknown, maximum: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= maximum; } catch { return false; }
}

export function leaseWorkerFrameKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
