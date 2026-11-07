/** Human-owned envelope. Session budgets remain separate, tighter ceilings. An omitted `costUsd` or
 * `toolCalls` has no ceiling: usage is still metered and shown, and each set amount is enforced. */
export interface CampaignBudgetAuthority {
  version: 1;
  costUsd?: number;
  toolCalls?: number;
  concurrency?: number;
  /** How many follow-ups the Orchestrator accepts without approval (#2940); each one past it is a
   * Human decision. Omitted: no limit. */
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
  /** `includesEstimate`: `costUsd` adds running Claude turns' open live estimates to the members'
   * recorded spend (#3196). */
  actual: { costUsd: number; toolCalls: number; includesEstimate?: boolean };
  outstanding: { costUsd: number; toolCalls: number };
  remaining: { costUsd: number | null; toolCalls: number | null };
  occupied: number;
  acceptedFollowUps: number;
  /** Follow-ups past `authority.acceptedFollowUps` (#2940): Human decisions still pending, and how
   * many the Human approved. Absent where the allowance does not govern the campaign. */
  followUpApprovals?: { pending: Array<{ occurrenceId: string; title: string }>; approved: number };
  reachedCheckpointsUsd: number[];
  /** Provider cancellation is asynchronous; this is an admission envelope, not a billing cap. */
  enforcement: "admission_and_best_effort_cancellation";
  externalWorkers: "unsupported";
  /** Original human session ceilings, distinct from the root's campaign allocation. */
  sessionLimits?: { costBudgetUsd: number | null; maxToolCalls: number | null };
  rootAllocation?: CampaignBudgetAllocation;
  costAccounting?: "priced" | "unavailable";
  requiredNativeReview?: {supported:boolean;reason:string};
  /** v331 (#4331): ended workers whose slot no automatic proof can ever free. Only the campaign's
   * owner can release one, with `POST /api/sessions/:root/orchestrator-campaign/slots/release`.
   * Absent when there are none. */
  heldSlots?: CampaignHeldSlot[];
  /** v331 (#4331): slots people released, newest first, at most CAMPAIGN_SLOT_RELEASES_LIMIT. */
  slotReleases?: CampaignSlotRelease[];
}

/** Why a held slot can only be released by a person (#4331): its generation was served by a runner
 * too old to prove retirement (#3788), or its runner's retirement fence carries no process evidence,
 * either because that runner build couldn't record it or because the provider ran in a location the
 * host can't observe (WSL, a container or a cloud machine). */
export type CampaignHeldSlotReason = "older_runner" | "fence_without_evidence" | "unsupported_location";

/** A runner's report that a worker's retirement fence can never be lifted by a later runner process. */
export interface CampaignRetirementHold {
  generation: string;
  reason: Exclude<CampaignHeldSlotReason, "older_runner">;
}

export interface CampaignHeldSlot {
  sessionId: string;
  title: string | null;
  /** The worker generation whose slot is held; a release names it, so it can't free a relaunch. */
  generation: string;
  reason: CampaignHeldSlotReason;
  status: "completed" | "failed" | "stopped";
}

export interface CampaignSlotRelease {
  sessionId: string;
  title: string | null;
  generation: string;
  releasedByUserId: string;
  releasedByName: string | null;
  releasedAt: number;
  /** The person's own words, for example "Rebooted the host". */
  reason: string;
  heldReason: CampaignHeldSlotReason;
  /** What the reservation settled at: the runner's final checkpoint where one arrived, otherwise
   * the usage the control plane recorded, never below a recorded charge. */
  settlement: { costUsd: number; toolCalls: number; source: "checkpoint" | "recorded_usage" };
}

export const CAMPAIGN_SLOT_RELEASES_LIMIT = 20;
/** The longest reason a person can give for a release. */
export const CAMPAIGN_SLOT_RELEASE_REASON_MAX = 500;

export interface ReleaseCampaignSlotRequest {
  sessionId: string;
  generation: string;
  reason: string;
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
    // Each review job reserves its own bounded cost and tool calls, so a campaign with no ceiling
    // still meters and charges controlled review.
    if (b.concurrency === undefined ||
        Object.keys(p).some((k) => !["profile","controllerSha256","executableSha256","cliVersion","accounting","account","agentId"].includes(k)) ||
        p.profile !== "native_opus_5_5_high_read_only" || p.cliVersion !== "2.1.296" || p.accounting !== "provider_list_estimate" ||
        p.account !== "runner_default_claude" || typeof p.agentId!=="string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.agentId) ||
        !/^[a-f0-9]{64}$/.test(p.controllerSha256) || !/^[a-f0-9]{64}$/.test(p.executableSha256)) return false;
  }
  return b.checkpointsUsd === undefined || Boolean(b.costUsd !== undefined && Array.isArray(b.checkpointsUsd) &&
    b.checkpointsUsd.length <= 100 && b.checkpointsUsd.every((v, i, all) =>
      Number.isFinite(v) && v > 0 && v <= b.costUsd! && (i === 0 || v > all[i - 1]!)));
}
