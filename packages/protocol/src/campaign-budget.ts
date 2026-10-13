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
  /** Human explicitly authorizes this exact native profile/account within the same envelope. */
  controlledReview?: import("./campaign-review-job.js").ControlledReviewCapability;
}

export interface CampaignBudgetAllocation {
  sessionId: string;
  /** Absolute cumulative limits, including this session's already spent usage. */
  costUsd?: number;
  toolCalls?: number;
}

/** Runner-owned final history coordinate. A terminal status alone cannot release allowance. */
export interface CampaignBudgetUsageCheckpoint {
  generation: string;
  historyEpoch: number;
  throughSeq: number;
  costUsd: number;
}

export interface CampaignBudgetDispatch { rootSessionId: string; generation: string }

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
  /** Original human session ceilings, distinct from the root's campaign allocation. */
  sessionLimits?: { costBudgetUsd: number | null; maxToolCalls: number | null };
  rootAllocation?: CampaignBudgetAllocation;
  costAccounting?: "priced" | "unavailable";
  requiredNativeReview?: {supported:boolean;reason:string};
}

export function validCampaignBudgetAuthority(value: unknown): value is CampaignBudgetAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as CampaignBudgetAuthority;
  if (Object.keys(b).some((key) => !["version", "costUsd", "toolCalls", "concurrency", "acceptedFollowUps", "checkpointsUsd", "accounting", "unpriced", "controlledReview"].includes(key)) ||
      b.version !== 1 || b.accounting !== "managed_workers_only" || b.unpriced !== "stop") return false;
  if (b.costUsd !== undefined && (!Number.isFinite(b.costUsd) || b.costUsd <= 0)) return false;
  for (const key of ["toolCalls", "concurrency", "acceptedFollowUps"] as const) {
    if (b[key] !== undefined && (!Number.isSafeInteger(b[key]) || b[key]! < (key === "acceptedFollowUps" ? 0 : 1))) return false;
  }
  if ([b.costUsd, b.toolCalls, b.concurrency, b.acceptedFollowUps].every((v) => v === undefined)) return false;
  if (b.controlledReview!==undefined) {
    const p = b.controlledReview;
    if(!p || typeof p!=="object" || Array.isArray(p)) return false;
    if (b.costUsd === undefined || b.toolCalls === undefined || b.concurrency === undefined ||
        Object.keys(p).some((k) => !["profile","controllerSha256","executableSha256","cliVersion","accounting","account","agentId"].includes(k)) ||
        p.profile !== "native_opus_5_5_high_read_only" || p.cliVersion !== "2.1.296" || p.accounting !== "provider_list_estimate" ||
        p.account !== "runner_default_claude" || typeof p.agentId!=="string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.agentId) ||
        !/^[a-f0-9]{64}$/.test(p.controllerSha256) || !/^[a-f0-9]{64}$/.test(p.executableSha256)) return false;
  }
  return b.checkpointsUsd === undefined || Boolean(b.costUsd !== undefined && Array.isArray(b.checkpointsUsd) &&
    b.checkpointsUsd.length <= 100 && b.checkpointsUsd.every((v, i, all) =>
      Number.isFinite(v) && v > 0 && v <= b.costUsd! && (i === 0 || v > all[i - 1]!)));
}
