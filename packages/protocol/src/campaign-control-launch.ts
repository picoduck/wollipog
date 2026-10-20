import type {
  CampaignAuthorityBoundary, CampaignAuthorityOperation, ControlledReviewCapability, CreateSessionRequest,
  OrchestratorCampaignPolicy, ResourceScope, SessionConfig, SessionLaunchSpec,
} from "./index.js";

/** Server-authored retention disclosure for delegated screenshot review. Changing the text
 * requires a new revision so a reviewed preflight cannot survive it. Aligned with #1716. */
export const CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE =
  "Screenshot evidence images are sent to the Orchestrator's selected provider and model for review. That provider may retain them under the provider account's terms, for example in provider-local transcripts or media logs; Wollipog does not configure zero retention. Wollipog's control-plane audit records evidence references, digests, and review receipts, not raw image bytes; provider-side retention is outside those audit guarantees.";
export const CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION = 1;
/** Private Session artifacts of one organization; never public or externally hosted storage. */
export const CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION = 1;
export function campaignSessionArtifactDestinationId(organizationId: string): string {
  return `session_artifacts:${organizationId}`;
}

/** Plain Human intent. The authenticated server constructs all authority provenance. */
export interface CampaignLaunchProposal {
  repository: string;
  issueNumbers: number[];
  objective: string;
  operations: CampaignAuthorityBoundary["operations"];
  delegatablePolicyIds: string[];
  issueAuthority: NonNullable<CampaignAuthorityBoundary["issueAuthority"]>;
  budgetAuthority: NonNullable<CampaignAuthorityBoundary["budgetAuthority"]>;
}

/** Optional Human overrides. Each replaces only the derived value it names; none can add an
 * authority field, provenance, readiness claim or evidence envelope. */
export interface FullControlLaunchOverrides {
  /** Root Orchestrator selection. Omitted fields use the account's saved defaults. */
  session?: Partial<Pick<CreateSessionRequest, "agentId" | "providerAccountId" | "title" | "useWorktree" | "config" | "orchestrator">>;
  objective?: string;
  /** May only narrow the default operation set. */
  operations?: CampaignAuthorityOperation[];
  delegatablePolicyIds?: string[];
  budget?: { costUsd?: number; toolCalls?: number; concurrency?: number; acceptedFollowUps?: number; checkpointsUsd?: number[] };
  issues?: { relatedFollowUps?: boolean; maxIssues?: number; closureReasons?: Array<"completed" | "not_planned"> };
}

/** Simple Full Control launch (#2940). The server derives the repository, objective, limits and
 * root selection; the preflight returns them for one explicit Human authorization. */
export interface FullControlLaunchRequest {
  runnerId: string;
  workspaceId: string;
  projectId?: string | null;
  projectLocationId?: string | null;
  /** Task description. At least one of `task` and `issueNumbers` is required. */
  task?: string;
  issueNumbers?: number[];
  overrides?: FullControlLaunchOverrides;
  /** Admission only: caller idempotency key and the exact digest the Human reviewed. */
  requestId?: string;
  preflightDigest?: string;
}

/** Enable Full Control on an existing root campaign (#2940). The preflight answers
 * `{ preflight, expectedRevision }`; enabling echoes both after one explicit Human authorization. */
export interface FullControlEnableRequest {
  overrides?: Pick<FullControlLaunchOverrides, "objective" | "operations" | "delegatablePolicyIds" | "budget" | "issues">;
  expectedRevision?: number;
  preflightDigest?: string;
}

/** Internal server plan, produced by the ordinary creation validator before its first write. */
export interface PreparedCampaignLaunch {
  runnerId: string;
  workspaceId: string;
  projectId?: string | null;
  projectLocationId?: string | null;
  agentId: string;
  driver: NonNullable<SessionLaunchSpec["driver"]>;
  providerAccountId?: string;
  config: SessionConfig;
  useWorktree: boolean;
  executionTarget: NonNullable<SessionLaunchSpec["executionTarget"]>;
  policy: OrchestratorCampaignPolicy;
  scope: ResourceScope;
}

export interface CampaignLaunchInspectionMessage {
  type: "campaign_launch_inspect";
  requestId: string;
  workspaceId: string;
  issueNumbers: number[];
}

/** Version 2 runners stop an inspection whose caller expired or went away (#3360). The runner
 * aborts only the inspection registered under this exact request id. */
export interface CampaignLaunchInspectionCancelMessage {
  type: "campaign_launch_inspect_cancel";
  requestId: string;
}

export interface CampaignLaunchInspectionResult {
  type: "campaign_launch_inspection_result";
  requestId: string;
  workspaceId: string;
  ok: boolean;
  repository?: string;
  issueNumbers?: number[];
  digest?: string;
  error?: string;
  /** Set when the inspection stopped because its request was cancelled. Never admits a launch. */
  cancelled?: true;
}

export type CampaignLaunchCapabilityId =
  | "repository_scope" | "authority_contract" | "accounting_budget" | "native_review"
  | "execution_isolation" | "image_evidence" | "video_evidence" | "external_evidence";

/** `unsupported` blocks launch, and only a mandatory capability can be unsupported. `human_required`
 * is an allowed, disclosed exception that routes that class of decision to the Human for this
 * campaign. `informational` states an infrastructure gap the campaign works around with the best
 * available path, such as the regular cross-model review workflow; it never blocks launch. */
export interface CampaignLaunchCapability {
  id: CampaignLaunchCapabilityId;
  capability: string;
  state: "verified" | "unsupported" | "human_required" | "informational";
  reason: string;
  mandatory: boolean;
}

export interface CampaignLaunchSummary {
  repository: string | null;
  issueNumbers: number[];
  objective: string;
  root: { agentId: string; driver: string; model: string | null; effort: string | null;
    isolation: { mode: string; network: string } | null; strictProjectIsolation: boolean; integrationIsolation: boolean;
    completion: OrchestratorCampaignPolicy["behavior"]["completion"] };
  /** A null amount has no ceiling. `unset`: neither amount has one, so the campaign runs with no
   * limit while usage is still metered, priced and shown. */
  budget: { costUsd: number | null; toolCalls: number | null; concurrency: number; acceptedFollowUps: number;
    source: "override" | "saved_defaults" | "unset"; reviewIncluded: boolean };
  /** Which cross-model review the campaign uses: the controlled reviewer charged to the campaign,
   * or, when that is unavailable, the regular cross-model review workflow. */
  review: { controlled: boolean; statement: string };
  followUps: { policy: OrchestratorCampaignPolicy["behavior"]["followUps"]; relatedFollowUps: boolean;
    maxIssues: number; closureReasons: Array<"completed" | "not_planned"> };
  evidence: {
    /** Plain statement of who reviews which evidence for this campaign. */
    statement: string;
    destination: { kind: "private_session_artifacts"; configurationId: string; disclosureRevision: number };
    /** The provider that receives screenshot bytes, with its verbatim retention disclosure. */
    provider: { providerId: string; disclosureRevision: number; retentionDisclosure: string;
      reviewer: { driver: string; model: string | null } } | null;
    /** True only when the launch also mints the paced-media evidence envelope (every peer
     * declares the private media contract). Screenshot review never depends on it. */
    envelope: boolean;
  };
  humanRequired: Array<{ exception: string; reason: string }>;
  blockers: Array<{ capability: string; reason: string }>;
}

export interface CampaignLaunchPreflight {
  /** Every mandatory capability (repository scope, the authority contract and any explicit budget
   * ceiling) is verified. Only then does the admission route launch. */
  ready: boolean;
  digest: string;
  summary: CampaignLaunchSummary;
  capabilities: CampaignLaunchCapability[];
  /** Whether this runner stops an expired inspection; older runners stay bounded by command timeouts. */
  inspectionCancellation: "supported" | "unsupported";
  advanced: {
    proposal: CampaignLaunchProposal | null;
    plan: PreparedCampaignLaunch;
    inspection?: Pick<CampaignLaunchInspectionResult, "repository" | "issueNumbers" | "digest">;
    controlledReview?: ControlledReviewCapability;
    humanRequiredRequests: string[];
  };
}
