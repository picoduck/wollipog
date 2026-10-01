/** Control frames contain no canonical snapshots or private acquisition/completion tokens. */
export const LEASE_WORKER_LIMITS = { pending: 64, requestBytes: 64 * 1024, responseBytes: 4096, deadlineMs: 300_000, heartbeatDelayMs: 500 } as const;
export const LEASE_WORKER_ASSET = "wollipog/provider-home-lease-worker";
export type LeaseWorkerOperation =
  | { method: "acquire"; home: string; provider: string }
  | { method: "release"; home: string }
  | { method: "cancel"; home: string; completedId: string }
  | { method: "close" };
export type LeaseWorkerError = "busy" | "unavailable" | "refusal" | "cancelled" | "cancel_release_failed" | "expired";
export const LEASE_WORKER_ERRORS: Record<LeaseWorkerError, string> = {
  busy: "Provider HOME is already in use; retry after the current owner or publication finishes.",
  unavailable: "Provider-HOME lease helper unavailable; preserve all evidence and restore the fixed helper and executable staging directory before retrying.",
  refusal: "Provider-HOME lease could not be proved; preserve all evidence and retry only with the exact private registry; quarantine the entire lease directory only after proving this HOME unused, and do not remove individual records.",
  cancelled: "Provider-HOME lease acquisition was cancelled.",
  cancel_release_failed: "Cancelled provider-HOME acquisition could not be exactly released; preserve all evidence and restart only after proving the HOME unused.",
  expired: "Provider-HOME lease operation exceeded its finite deadline; preserve all evidence.",
};
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
  return v.method === "acquire" && typeof v.provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(v.provider) && Object.keys(v).length === 3;
}
export function boundedLeaseWorkerFrame(value: unknown, maximum: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= maximum; } catch { return false; }
}

export function leaseWorkerFrameKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
