import type { ProviderAccountDefinition, SubscriptionUsageSnapshot } from "@wollipog/protocol";

export const AUTOMATIC_ACCOUNT_SWITCH_COOLDOWN_MS = 5 * 60_000;

export interface UsageWindowRejection {
  resetsAt?: number;
}

/** Classify only provider-owned structured allowance state. Expired windows are immediately
 * eligible again; an exhausted window without a reset remains conservatively exhausted. */
export function usageWindowRejection(
  snapshot: SubscriptionUsageSnapshot | null | undefined,
  now: number,
): UsageWindowRejection | null {
  if (!snapshot || snapshot.state !== "available") return null;
  const exhausted = snapshot.buckets.filter((bucket) =>
    bucket.status === "exhausted" && (bucket.resetsAt === undefined || bucket.resetsAt > now));
  if (!exhausted.length) return null;
  const resets = exhausted.flatMap((bucket) => bucket.resetsAt === undefined ? [] : [bucket.resetsAt]);
  return resets.length ? { resetsAt: Math.max(...resets) } : {};
}

function candidateHeadroom(snapshot: SubscriptionUsageSnapshot | undefined, now: number): number | null {
  if (!snapshot) return null;
  if (snapshot.state !== "available") return null;
  if (usageWindowRejection(snapshot, now)) return null;
  const remaining = snapshot.buckets.flatMap((bucket) =>
    typeof bucket.remainingPercent === "number" ? [bucket.remainingPercent] : []);
  // Unknown allowance state is not proof of headroom and must never win an automatic handoff.
  return remaining.length ? Math.min(...remaining) : null;
}

export function selectAutomaticProviderAccount(input: {
  accounts: ProviderAccountDefinition[];
  snapshots: SubscriptionUsageSnapshot[];
  provider: "claude" | "codex";
  currentAccountId: string;
  cooldowns: Record<string, number>;
  now: number;
}): ProviderAccountDefinition | null {
  const snapshots = new Map(input.snapshots
    .filter((snapshot) => snapshot.providerAccountId)
    .map((snapshot) => [snapshot.providerAccountId!, snapshot]));
  return input.accounts
    .filter((account) => account.provider === input.provider &&
      account.id !== input.currentAccountId &&
      account.authStatus === "authenticated" &&
      (input.cooldowns[account.id] ?? 0) <= input.now)
    .map((account) => ({ account, headroom: candidateHeadroom(snapshots.get(account.id), input.now) }))
    .filter((candidate): candidate is { account: ProviderAccountDefinition; headroom: number } =>
      candidate.headroom !== null)
    .sort((left, right) => right.headroom - left.headroom || left.account.id.localeCompare(right.account.id))[0]?.account ?? null;
}
