import { LEASE_WORKER_LIMITS } from "./provider-home-lease-worker-protocol.js";

const NS_PER_MS = 1_000_000n;
const MAX_U64 = (1n << 64n) - 1n;
/** Reads libuv's host monotonic coordinate, with no per-worker time-origin subtraction.
 * Never persist it or compare it across hosts/boots. */
export function leaseWorkerNow(): bigint { return process.hrtime.bigint(); }

/** A single enqueue deadline; cancellation and all acknowledgement phases keep this value. */
export function leaseWorkerDeadline(budgetMs: number): bigint {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > LEASE_WORKER_LIMITS.deadlineMs) throw new Error("invalid lease worker budget");
  const deadline = leaseWorkerNow() + BigInt(budgetMs) * NS_PER_MS;
  if (deadline < 0n || deadline > MAX_U64) throw new Error("lease worker clock range");
  return deadline;
}

/** JSON sizing cannot encode BigInt. Check length before parsing a canonical unsigned decimal
 * string; legacy wall-time numbers are never reinterpreted. */
export function parseLeaseWorkerDeadline(value: unknown): bigint | undefined {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const deadline = BigInt(value);
  return deadline <= MAX_U64 ? deadline : undefined;
}

/** Timers are wakeups, never expiry proof. Round up and clamp to the unchanged budget, then
 * recheck the original deadline after every callback, including an early callback. */
export function leaseWorkerDelay(deadline: bigint): number {
  const remaining = deadline - leaseWorkerNow();
  if (remaining <= 0n) return 0;
  const maximum = BigInt(LEASE_WORKER_LIMITS.deadlineMs);
  const rounded = (remaining + NS_PER_MS - 1n) / NS_PER_MS;
  return Number(rounded > maximum ? maximum : rounded);
}
