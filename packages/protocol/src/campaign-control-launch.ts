import type {
  CampaignAuthorityBoundary, CampaignAuthorityOperation, CampaignIssueRef, ControlledReviewCapability, CreateSessionRequest,
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

/** The boundary objective while a Full Control campaign waits for its owner's first message (#2940).
 * That message replaces it before the Orchestrator's first turn. */
export const FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE = "The task its owner sends as this campaign's first message.";

/** Plain Human intent. The authenticated server constructs all authority provenance. */
export interface CampaignLaunchProposal {
  repository: string;
  /** Verified Project repositories (#4117); the first entry's repository is `repository`. */
  repositories?: CampaignAuthorityBoundary["repositories"];
  issueNumbers: number[];
  /** Issues in the boundary's other repositories (#4118), each read through a Location of its own. */
  otherIssues?: CampaignIssueRef[];
  objective: string;
  operations: CampaignAuthorityBoundary["operations"];
  delegatablePolicyIds: string[];
  issueAuthority: NonNullable<CampaignAuthorityBoundary["issueAuthority"]>;
  budgetAuthority: NonNullable<CampaignAuthorityBoundary["budgetAuthority"]>;
}

/** Optional Human overrides. Each replaces only the derived value it names; none can add an
 * authority field, provenance, readiness claim or evidence envelope. */
export interface FullControlLaunchOverrides {
  /** Root Orchestrator selection. Omitted fields use the account's saved defaults. New Session's
   * Run On (`executionTargetId`) and Harness (`launchSurface`) are forwarded so the ordinary
   * creation validator honors or refuses them; neither is ever replaced by a default. ACP session
   * context is excluded: it applies only to ACP agents, which cannot hold Full Control (#2940). */
  session?: Partial<Pick<CreateSessionRequest, "agentId" | "providerAccountId" | "title" | "useWorktree" | "executionTargetId" |
    "launchSurface" | "config" | "orchestrator">>;
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
  /** Task description. With neither `task` nor `issueNumbers`, the campaign starts idle with a
   * task-only boundary, and its owner's first message sets the objective and issue scope. */
  task?: string;
  issueNumbers?: number[];
  /** Issues in the Project's other repositories (#4118). Like `issueNumbers`, they become the scope
   * and its epics, so a person's launch is what authorizes an epic in another repository. */
  otherIssues?: CampaignIssueRef[];
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
  /** Resolved by authorized session preparation, never browser or agent input. */
  workspacePath?: string;
  issueNumbers: number[];
  /** Version 4 (#4119): a follow-up's exact sanitized payload, checked in the Location's repository
   * as the root checks its own. With no issue numbers: content screening and the duplicate search
   * by subject, before publishing. With one issue number: that issue must be published with
   * exactly this payload, before it joins the scope. Never sent with `facts`: a runner refuses both. */
  publication?: { sanitizedTitle: string; sanitizedBody: string; labels: string[] };
  /** Also report each of `issueNumbers` as `issueFacts` (#4118): sent only to a runner with
   * `locationIssueFacts`, and an older one refuses it as invalid. */
  facts?: true;
  /** Resolve this epic's members as `candidates` (#4118), with no `issueNumbers`: sent only to a
   * v322 runner, and an older one refuses it as invalid. */
  epic?: number;
}

export const CAMPAIGN_LAUNCH_INSPECTION_ERRORS = {
  invalid_request: "The workspace inspection request is invalid.",
  unknown_location: "The project location is unknown; select an available location.",
  missing_path: "The project location path is missing or unavailable on the runner.",
  not_repository: "The project location is not a git repository with a valid HEAD.",
  unsupported_origin: "The project repository origin is unsupported; Full Control requires a github.com or GitLab repository.",
  issue_read_failed: "The selected issues could not be read and verified in the project repository.",
  publication_refused: "The follow-up could not be inspected in the project repository, or an issue there already has its title.",
} as const;
export type CampaignLaunchInspectionFailure = keyof typeof CAMPAIGN_LAUNCH_INSPECTION_ERRORS;

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
  /** Each requested number's bounded facts, with a pull request reported rather than refused. */
  issueFacts?: import("./index.js").CampaignIssueFacts[];
  /** The asked-for epic and its members. */
  candidates?: NonNullable<import("./index.js").CampaignIssueScopeView["candidates"]>;
  error?: string;
  failure?: CampaignLaunchInspectionFailure;
  /** Set when the inspection stopped because its request was cancelled. Never admits a launch. */
  cancelled?: true;
  /** Version 4, for a `publication` request: the digest of the inspected payload, and how the
   * duplicate search compared titles, as the root's publication inspection reports them. */
  publicationDigest?: string;
  duplicateSearch?: "subject";
}

export type CampaignLaunchCapabilityId =
  | "repository_scope" | "authority_contract" | "accounting_budget" | "native_review"
  | "execution_isolation" | "image_evidence" | "video_evidence" | "external_evidence";

/** `unsupported` blocks launch, and only a mandatory capability can be unsupported. `human_required`
 * is an allowed, disclosed exception that routes that class of decision to the Human for this
 * campaign. `informational` states an infrastructure gap the campaign works around with the best
 * available path, such as the regular cross-model review workflow; it never blocks launch.
 * `orchestrator_decides` discloses a class the Orchestrator owns without being able to inspect it:
 * it asks for inspectable evidence or denies, and never hands it to the Human (#2940). */
export interface CampaignLaunchCapability {
  id: CampaignLaunchCapabilityId;
  capability: string;
  state: "verified" | "unsupported" | "human_required" | "informational" | "orchestrator_decides";
  reason: string;
  mandatory: boolean;
}

export interface CampaignLaunchSummary {
  repository: string | null;
  /** Every verified repository of the campaign's Project with its Locations, the launch
   * Location's first (#4117). Omitted when only the launch Location is inspected. */
  repositories?: Array<{ repository: string; locations: Array<{ locationId: string; name: string }> }>;
  /** Project Locations left out of the boundary, each with its fixed reason. They never block launch. */
  excludedLocations?: import("./project-location-inspection.js").CampaignExcludedLocation[];
  /** Enabling on a campaign whose first message limited it: Project Locations of other repositories,
   * which stay available and don't join (#4117). */
  availableLocations?: import("./project-location-inspection.js").CampaignAvailableLocation[];
  /** Enabling on an existing campaign: Project Locations its owner didn't add, which keep waiting for
   * Include in Campaign (#4117). */
  pendingLocations?: import("./project-location-inspection.js").CampaignPendingLocation[];
  issueNumbers: number[];
  otherIssues?: CampaignIssueRef[];
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
  /** What happens to the requests the campaign can never supply, instead of asking the Human. */
  declinedNote?: string;
  blockers: Array<{ capability: string; reason: string }>;
}

/** What a Full Control launch or enable told its Human about capabilities and evidence (#2940),
 * kept on the campaign so Campaign Status can show it after launch: Full Control launches with no
 * preflight panel, so this is where those facts are disclosed. Server-owned and informational: it
 * grants nothing, and it is a snapshot of that moment, not a live capability check. It holds no
 * account, organization or destination identifier. */
export interface CampaignLaunchDisclosure {
  version: 1;
  /** The authorization that recorded it. */
  source: "launch" | "enable";
  recordedAt: number;
  capabilities: Array<Pick<CampaignLaunchCapability, "id" | "capability" | "state" | "reason" | "mandatory">>;
  evidence: {
    statement: string;
    destination: "private_session_artifacts";
    /** The provider that receives screenshot bytes, with its verbatim retention disclosure; null
     * when the Orchestrator reviews no images. */
    provider: { providerId: string; disclosureRevision: number; retentionDisclosure: string;
      reviewer: { driver: string; model: string | null } } | null;
  };
}

const LAUNCH_DISCLOSURE_TEXT_MAX = 4_000;
const LAUNCH_CAPABILITY_IDS: ReadonlySet<string> = new Set<CampaignLaunchCapabilityId>([
  "repository_scope", "authority_contract", "accounting_budget", "native_review",
  "execution_isolation", "image_evidence", "video_evidence", "external_evidence",
]);
const LAUNCH_CAPABILITY_STATES: ReadonlySet<string> = new Set<CampaignLaunchCapability["state"]>([
  "verified", "unsupported", "human_required", "informational", "orchestrator_decides",
]);

/** The disclosure an admitted launch or enable records, derived only from its reviewed preflight. */
export function campaignLaunchDisclosure(preflight: Pick<CampaignLaunchPreflight, "capabilities" | "summary">,
  source: CampaignLaunchDisclosure["source"], recordedAt: number): CampaignLaunchDisclosure {
  const { evidence } = preflight.summary;
  return {
    version: 1, source, recordedAt,
    capabilities: preflight.capabilities.map(({ id, capability, state, reason, mandatory }) => ({ id, capability, state, reason, mandatory })),
    evidence: {
      statement: evidence.statement,
      destination: evidence.destination.kind,
      provider: evidence.provider ? { providerId: evidence.provider.providerId, disclosureRevision: evidence.provider.disclosureRevision,
        retentionDisclosure: evidence.provider.retentionDisclosure,
        reviewer: { driver: evidence.provider.reviewer.driver, model: evidence.provider.reviewer.model } } : null,
    },
  };
}

/** Whether a stored disclosure has exactly the recorded shape. Callers drop one that doesn't, since
 * it is informational: Campaign Status then reads it as not recorded. */
export function validCampaignLaunchDisclosure(value: unknown): value is CampaignLaunchDisclosure {
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= LAUNCH_DISCLOSURE_TEXT_MAX;
  const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v)) &&
    Object.keys(v as object).length === keys.length && keys.every((key) => Object.hasOwn(v as object, key));
  if (!exact(value, ["version", "source", "recordedAt", "capabilities", "evidence"]) || value.version !== 1 ||
      (value.source !== "launch" && value.source !== "enable") || !Number.isSafeInteger(value.recordedAt) || (value.recordedAt as number) < 1) return false;
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > LAUNCH_CAPABILITY_IDS.size ||
      new Set(capabilities.map((item) => (item as { id?: unknown })?.id)).size !== capabilities.length ||
      !capabilities.every((item) => exact(item, ["id", "capability", "state", "reason", "mandatory"]) &&
        LAUNCH_CAPABILITY_IDS.has(item.id as string) && LAUNCH_CAPABILITY_STATES.has(item.state as string) &&
        text(item.capability) && text(item.reason) && typeof item.mandatory === "boolean")) return false;
  const evidence = value.evidence;
  if (!exact(evidence, ["statement", "destination", "provider"]) || !text(evidence.statement) ||
      evidence.destination !== "private_session_artifacts") return false;
  const provider = evidence.provider;
  if (provider === null) return true;
  return exact(provider, ["providerId", "disclosureRevision", "retentionDisclosure", "reviewer"]) && text(provider.providerId) &&
    Number.isSafeInteger(provider.disclosureRevision) && (provider.disclosureRevision as number) >= 1 && text(provider.retentionDisclosure) &&
    exact(provider.reviewer, ["driver", "model"]) && text(provider.reviewer.driver) &&
    (provider.reviewer.model === null || text(provider.reviewer.model));
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
