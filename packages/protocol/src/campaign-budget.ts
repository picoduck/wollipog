/** Human-owned envelope. Session budgets remain separate, tighter ceilings. */
export interface CampaignBudgetAuthority {
  version: 1;
  costUsd?: number;
  toolCalls?: number;
  concurrency?: number;
  acceptedFollowUps?: number;
  /** Checkpoints are preauthorized notifications, never permission to exceed the envelope. */
  checkpointsUsd?: number[];
  accounting: "managed_workers_only";
  unpriced: "stop";
}

export interface CampaignBudgetAllocation {
  sessionId: string;
  /** Absolute cumulative limits, including this session's already spent usage. */
  costUsd?: number;
  toolCalls?: number;
}

export interface CampaignBudgetView {
  authority: CampaignBudgetAuthority;
  state: "active" | "exhausted" | "revoked" | "accounting_unavailable";
  reason?: string;
  actual: { costUsd: number; toolCalls: number };
  outstanding: { costUsd: number; toolCalls: number };
  remaining: { costUsd: number | null; toolCalls: number | null };
  occupied: number;
  acceptedFollowUps: number;
  reachedCheckpointsUsd: number[];
  /** Provider cancellation is asynchronous; this is an admission envelope, not a billing cap. */
  enforcement: "admission_and_best_effort_cancellation";
  externalWorkers: "unsupported";
}

export function validCampaignBudgetAuthority(value: unknown): value is CampaignBudgetAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as CampaignBudgetAuthority;
  if (Object.keys(b).some((key) => !["version", "costUsd", "toolCalls", "concurrency", "acceptedFollowUps", "checkpointsUsd", "accounting", "unpriced"].includes(key)) ||
      b.version !== 1 || b.accounting !== "managed_workers_only" || b.unpriced !== "stop") return false;
  if (b.costUsd !== undefined && (!Number.isFinite(b.costUsd) || b.costUsd <= 0)) return false;
  for (const key of ["toolCalls", "concurrency", "acceptedFollowUps"] as const) {
    if (b[key] !== undefined && (!Number.isSafeInteger(b[key]) || b[key]! < (key === "acceptedFollowUps" ? 0 : 1))) return false;
  }
  if ([b.costUsd, b.toolCalls, b.concurrency, b.acceptedFollowUps].every((v) => v === undefined)) return false;
  return b.checkpointsUsd === undefined || Boolean(b.costUsd !== undefined && Array.isArray(b.checkpointsUsd) &&
    b.checkpointsUsd.length <= 100 && b.checkpointsUsd.every((v, i, all) =>
      Number.isFinite(v) && v > 0 && v <= b.costUsd! && (i === 0 || v > all[i - 1]!)));
}
