import { REVIEW_JOBS_RETIRED_REASON } from "./review-retirement.js";
/** Exact installed review controller. This is a review-only job, never an interactive harness. */
export const CONTROLLED_REVIEW_PROFILE = "native_opus_5_5_high_read_only" as const;
const REVIEW_FAILURE_REASONS=new Set([
  REVIEW_JOBS_RETIRED_REASON,
  "controlled native review accounting supports audited Linux hosts only","installed review controller differs from the audited version",
  "native reviewer usage provenance is unsupported for this CLI version","native reviewer repository identity is outside its authorized target",
  "review epoch differs from the current canonical forge target","native reviewer init identity/tool policy mismatch",
  "native reviewer tool provenance mismatch","native reviewer final usage identity missing","native reviewer model pricing is unavailable",
  "native reviewer cost is unpriced or inconsistent","native reviewer cost regressed","human-authorized native profile changed",
  "native reviewer host/provider admission is currently unavailable","review requires the owned native managed worktree",
  "controlled review requires the exact clean assigned head","review admission was revoked before provider dispatch",
  "controlled reviewer preflight refused","Native reviewer ended without durable priced final usage; reservation retained.",
]);
export function sanitizedCampaignReviewReason(value:unknown):string {
  return typeof value==="string" && REVIEW_FAILURE_REASONS.has(value)?value:
    "Native reviewer inspection or accounting is unavailable; reconcile the existing attempt before new dispatch.";
}
export interface ControlledReviewCapability {
  profile: typeof CONTROLLED_REVIEW_PROFILE;
  controllerSha256: string;
  executableSha256: string;
  cliVersion: "2.1.296";
  accounting: "provider_list_estimate";
  account: "runner_default_claude";
  agentId: string;
}
export function controlledReviewCapabilityKey(p:ControlledReviewCapability):string {
  return JSON.stringify([p.profile,p.controllerSha256,p.executableSha256,p.cliVersion,p.accounting,p.account,p.agentId]);
}
export interface CampaignReviewJobRequest {
  requestId: string;
  workItemId: string;
  pullRequest: { repository: string; number: number };
  baseSha: string;
  headSha: string;
  costUsd: number;
  toolCalls: number;
  /** Untrusted reviewer brief; the unchanged controller appends its authoritative contract. */
  brief: string;
}
export interface CampaignReviewJobCommand {
  type: "campaign_review_job";
  jobId: string;
  nonce: string;
  rootSessionId: string;
  authorityRevision: number;
  lineage?: {workItemAttemptId:string;issue:{repository:string;number:number}};
  worktreeSessionId: string;
  profile: ControlledReviewCapability;
  request: CampaignReviewJobRequest;
}
export interface CampaignReviewJobUpdate {
  type: "campaign_review_job_update";
  jobId: string;
  nonce: string;
  state: "running" | "completed" | "accounting_unavailable" | "not_launched";
  /** Runner-owned monotonic cumulative values, including unsuccessful paid attempts. */
  costUsd?: number;
  toolCalls: number;
  attemptValid?: boolean;
  attemptConsumed?: boolean;
  vote?: "UPVOTE" | "DOWNVOTE" | "INVALID";
  receiptSha256?: string;
  reason?: string;
  report?: string;
}
export interface CampaignReviewJobView {
  jobId: string;
  rootSessionId: string;
  authorityRevision: number;
  workItemAttemptId: string | null;
  issue: {repository:string;number:number} | null;
  worktreeSessionId: string;
  profile: ControlledReviewCapability;
  reviewEpoch: string;
  state: CampaignReviewJobUpdate["state"] | "reserved";
  round: number;
  attempt: number;
  attemptValid: boolean | null;
  attemptConsumed: boolean | null;
  usageSettlement: "pending" | "settled" | "unavailable";
  terminalOutcome: "valid_review" | "invalid_review" | "not_launched" | "unknown" | null;
  request: Omit<CampaignReviewJobRequest, "brief">;
  costUsd: number | null;
  toolCalls: number;
  receiptSha256?: string;
  vote?: "UPVOTE" | "DOWNVOTE" | "INVALID";
  reason?: string;
}
export interface CampaignReviewJobsPage { jobs: CampaignReviewJobView[]; nextAfterJobId: string | null }
