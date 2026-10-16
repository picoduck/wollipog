import type {
  CampaignAuthorityBoundary, CreateSessionRequest, OrchestratorCampaignPolicy, ResourceScope,
  SessionConfig, SessionLaunchSpec,
} from "./index.js";

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

export interface FullControlLaunchRequest {
  session: CreateSessionRequest;
  proposal: CampaignLaunchProposal;
  requestId?: string;
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

export interface CampaignLaunchInspectionResult {
  type: "campaign_launch_inspection_result";
  requestId: string;
  workspaceId: string;
  ok: boolean;
  repository?: string;
  issueNumbers?: number[];
  digest?: string;
  error?: string;
}

export interface CampaignLaunchPreflight {
  supported: boolean;
  digest: string;
  plan: PreparedCampaignLaunch;
  proposal: CampaignLaunchProposal;
  inspection?: Pick<CampaignLaunchInspectionResult, "repository" | "issueNumbers" | "digest">;
  capabilities: Array<{ capability: string; state: "verified" | "unsupported"; reason: string }>;
  humanRequired: string[];
}
