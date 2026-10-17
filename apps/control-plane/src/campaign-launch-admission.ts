import { createHash } from "node:crypto";
import {
  campaignAuthorityPreflight, runnerSupportsProtocol, validCampaignControl,
  CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION, CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION, campaignSessionArtifactDestinationId,
  type CampaignAuthorityOperation, type CampaignLaunchCapability, type CampaignLaunchPreflight,
  type CampaignLaunchProposal, type CampaignLaunchInspectionResult, type ChildSessionDefaults,
  type CreateSessionRequest, type FullControlLaunchOverrides, type FullControlLaunchRequest,
  type PreparedCampaignLaunch, type RunnerView,
} from "@wollipog/protocol";
import type { UiEvidenceReviewEvaluation } from "./ui-evidence-review.js";

const keys = ["repository", "issueNumbers", "objective", "operations", "delegatablePolicyIds", "issueAuthority", "budgetAuthority"];

/** The derived default: every operation Full Control can own. Overrides may only narrow it. */
export const FULL_CONTROL_LAUNCH_OPERATIONS: readonly CampaignAuthorityOperation[] = [
  "implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication",
  "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask",
];
const MAX_DERIVED_FOLLOW_UPS = 10;

export function parseCampaignLaunchProposal(value: unknown): CampaignLaunchProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as CampaignLaunchProposal;
  if (Object.keys(p).some((key) => !keys.includes(key)) ||
      !Array.isArray(p.issueNumbers) || p.issueNumbers.length > 100 ||
      p.issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(p.issueNumbers).size !== p.issueNumbers.length ||
      typeof p.repository !== "string" || p.repository !== p.repository.trim() ||
      !p.issueAuthority || p.issueAuthority.maxIssues < p.issueNumbers.length ||
      !Array.isArray(p.issueAuthority.epics) || !p.issueAuthority.epics.every((n) => p.issueNumbers.includes(n)) ||
      !p.budgetAuthority || p.budgetAuthority.costUsd === undefined || p.budgetAuthority.toolCalls === undefined ||
      p.budgetAuthority.concurrency === undefined || p.budgetAuthority.acceptedFollowUps === undefined ||
      p.budgetAuthority.concurrency > 64) return null;
  // Reuse the foundation's exact schema validation. This temporary validation value is never
  // persisted, returned as authority, or used as a principal or a consumable grant.
  if (!validCampaignControl(schemaControl(p))) return null;
  return structuredClone({ ...p, repository: p.repository.toLowerCase(), issueNumbers: [...p.issueNumbers].sort((a, b) => a - b) });
}

function schemaControl(p: CampaignLaunchProposal) {
  return { mode: "full_control" as const, boundary: {
    version: 1 as const, revision: 1, issueScopeRevision: 1, authorizedByUserId: "schema_validation", authorizedAt: 1,
    repository: p.repository, objective: p.objective, operations: p.operations,
    delegatablePolicyIds: p.delegatablePolicyIds, issueAuthority: p.issueAuthority, budgetAuthority: p.budgetAuthority,
  } };
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const only = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);

/** Strict shape check only. Values become authority solely through the derived proposal, which
 * the foundation schema validates again, and one explicit Human authorization. */
export function parseFullControlLaunchRequest(value: unknown, admit: boolean): FullControlLaunchRequest | null {
  if (!record(value) || !only(value, ["runnerId", "workspaceId", "projectId", "projectLocationId", "task", "issueNumbers", "overrides", "requestId", "preflightDigest"])) return null;
  const r = value as unknown as FullControlLaunchRequest;
  if (!text(r.runnerId, 256) || !text(r.workspaceId, 256) ||
      (r.projectId != null && !text(r.projectId, 256)) || (r.projectLocationId != null && !text(r.projectLocationId, 256)) ||
      (r.task !== undefined && !text(r.task, 4000)) ||
      (r.issueNumbers !== undefined && (!Array.isArray(r.issueNumbers) || r.issueNumbers.length > 100 ||
        r.issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(r.issueNumbers).size !== r.issueNumbers.length)) ||
      (r.task === undefined && !r.issueNumbers?.length)) return null;
  if (admit ? typeof r.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.requestId) ||
      typeof r.preflightDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.preflightDigest)
    : r.requestId !== undefined || r.preflightDigest !== undefined) return null;
  if (r.overrides !== undefined && !validOverrides(r.overrides)) return null;
  return structuredClone(r);
}

function validOverrides(o: unknown): o is FullControlLaunchOverrides {
  if (!record(o) || !only(o, ["session", "objective", "operations", "delegatablePolicyIds", "budget", "issues"])) return false;
  const v = o as FullControlLaunchOverrides;
  if (v.session !== undefined && (!record(v.session) ||
      !only(v.session, ["agentId", "providerAccountId", "title", "useWorktree", "config", "orchestrator"]))) return false;
  if (v.objective !== undefined && !text(v.objective, 4000)) return false;
  if (v.operations !== undefined && (!Array.isArray(v.operations) || !v.operations.length ||
      new Set(v.operations).size !== v.operations.length ||
      v.operations.some((operation) => !FULL_CONTROL_LAUNCH_OPERATIONS.includes(operation)))) return false;
  if (v.delegatablePolicyIds !== undefined && (!Array.isArray(v.delegatablePolicyIds) || v.delegatablePolicyIds.length > 100 ||
      v.delegatablePolicyIds.some((id) => !text(id, 256)))) return false;
  if (v.budget !== undefined && (!record(v.budget) || !only(v.budget, ["costUsd", "toolCalls", "concurrency", "acceptedFollowUps", "checkpointsUsd"]))) return false;
  if (v.issues !== undefined && (!record(v.issues) || !only(v.issues, ["relatedFollowUps", "maxIssues", "closureReasons"]))) return false;
  return true;
}

/** Default root harness: the first available native installation that can enforce Full Control,
 * preferring the controlled native reviewer's own Claude Code installation. */
export function defaultLaunchAgentId(runner: RunnerView): string | undefined {
  const eligible = runner.agents.filter((agent) => agent.available !== false && (!agent.context || agent.context.kind === "native"));
  const reviewer = runner.runtime?.campaignReview?.agentId;
  return (eligible.find((agent) => agent.id === reviewer && agent.driver === "claude-code") ??
    eligible.find((agent) => agent.driver === "claude-code") ??
    eligible.find((agent) => agent.driver === "codex-app-server"))?.id;
}

/** The ordinary creation request the launch validates and, once authorized, admits. */
export function launchSessionRequest(request: FullControlLaunchRequest, runner: RunnerView): CreateSessionRequest | null {
  const session = request.overrides?.session;
  const agentId = session?.agentId ?? defaultLaunchAgentId(runner);
  if (!agentId) return null;
  return {
    runnerId: request.runnerId, workspaceId: request.workspaceId,
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
    ...(request.projectLocationId !== undefined ? { projectLocationId: request.projectLocationId } : {}),
    ...structuredClone(session ?? {}), agentId, role: "orchestrator",
  };
}

export interface CampaignLaunchFacts {
  request: FullControlLaunchRequest;
  plan: PreparedCampaignLaunch;
  runner: RunnerView;
  inspection?: CampaignLaunchInspectionResult;
  organizationId: string;
  projectDefaults: ChildSessionDefaults | null;
  /** `campaignBudgetAccountingError` for the root's driver and model. */
  accountingError: string | null;
  /** The owner's organization enforces a per-user daily limit native review cannot honor. */
  dailyLimit: boolean;
  /** Named policy asks that are unknown, disabled, built in or Human Required. */
  invalidPolicyIds: string[];
  imageReview: UiEvidenceReviewEvaluation;
  /** Every launch peer declares the exact private media contract (#1321). */
  pacedVideoPeer: boolean;
  /** Hosting disclosure port is wired. */
  disclosuresAvailable: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function campaignLaunchDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const HUMAN_REQUIRED_LABELS: Record<string, string> = {
  secrets_and_sign_in: "Secrets and sign-in",
  persistent_permissions: "Persistent permission grants",
  provider_access_expansion: "Provider access expansion",
  external_elicitation: "External provider forms",
  root_forms_without_suggested_answers: "Root questions without a suggested answer",
  unverified_tool_effects: "Tool effects that cannot be verified",
  git_execution_without_bounded_effect_proof: "Git commands without bounded effect proof",
  script_execution_without_bounded_effect_proof: "Scripts without bounded effect proof",
  human_required_rules: "Human Required governance rules",
  relative_shell_commands_without_verified_cwd: "Relative shell commands without a verified directory",
};

/** Readiness comes from current server and runner facts. `unsupported` blocks the launch with an
 * actionable reason; `human_required` is a disclosed exception that routes that decision class to
 * the Human. No caller field, preset, protocol number alone or fixture can mark a capability verified. */
export function campaignLaunchPreflight(facts: CampaignLaunchFacts): { preflight: CampaignLaunchPreflight; proposal: CampaignLaunchProposal | null } {
  const { request, plan, runner, inspection } = facts;
  const overrides = request.overrides ?? {};
  const issueNumbers = [...(request.issueNumbers ?? [])].sort((a, b) => a - b);
  const behavior = plan.policy.behavior;
  const inspectionVersion = runner.runtime?.campaignLaunchInspection?.version ?? 0;
  const verified = inspection?.ok === true && inspection.workspaceId === plan.workspaceId &&
    typeof inspection.repository === "string" && /^[a-f0-9]{64}$/.test(inspection.digest ?? "") &&
    canonical(inspection.issueNumbers) === canonical(issueNumbers);
  const repository = verified ? inspection!.repository!.toLowerCase() : null;

  const acceptedFollowUps = overrides.budget?.acceptedFollowUps ??
    (behavior.followUps === "execute_approved" ? Math.min(MAX_DERIVED_FOLLOW_UPS, Math.max(1, issueNumbers.length)) : 0);
  const concurrency = overrides.budget?.concurrency ?? behavior.maximumConcurrentChildren;
  // The campaign envelope is always an explicit Human amount. Saved per-session limits (root
  // ceilings, Project child-session defaults) are tighter ceilings, not a campaign envelope, and
  // controlled review refuses to run under them.
  const costUsd = overrides.budget?.costUsd;
  const toolCalls = overrides.budget?.toolCalls;
  const budgetSource = costUsd !== undefined && toolCalls !== undefined ? "override" as const : "unset" as const;
  const relatedFollowUps = overrides.issues?.relatedFollowUps ?? behavior.followUps === "execute_approved";
  const maxIssues = overrides.issues?.maxIssues ?? Math.min(100, Math.max(1, issueNumbers.length + acceptedFollowUps));
  const closureReasons = overrides.issues?.closureReasons ?? ["completed" as const];
  const objective = overrides.objective ?? request.task?.trim() ??
    `Deliver ${repository ?? "the selected repository"} ${issueNumbers.map((n) => `#${n}`).join(", ")}.`;
  const controlledReview = runner.runtime?.campaignReview;
  const operations = overrides.operations ?? [...FULL_CONTROL_LAUNCH_OPERATIONS];
  const delegatablePolicyIds = overrides.delegatablePolicyIds ?? [];

  const proposal = repository && costUsd !== undefined && toolCalls !== undefined ? parseCampaignLaunchProposal({
    repository, issueNumbers, objective, operations, delegatablePolicyIds,
    issueAuthority: { epics: issueNumbers, relatedFollowUps, maxIssues, closureReasons },
    budgetAuthority: { version: 1, costUsd, toolCalls, concurrency, acceptedFollowUps,
      ...(overrides.budget?.checkpointsUsd ? { checkpointsUsd: overrides.budget.checkpointsUsd } : {}),
      accounting: "managed_workers_only", unpriced: "stop", ...(controlledReview ? { controlledReview } : {}) },
  }) : null;

  const capabilities: CampaignLaunchCapability[] = [];
  const add = (id: CampaignLaunchCapability["id"], capability: string, state: CampaignLaunchCapability["state"], reason: string, mandatory = true) =>
    capabilities.push({ id, capability, state, reason, mandatory });

  add("repository_scope", "Repository and Issue Scope", verified ? "verified" : "unsupported", verified
    ? `The registered workspace's origin is ${repository}${issueNumbers.length ? ` and issues ${issueNumbers.map((n) => `#${n}`).join(", ")} were read from it` : "; no issues were selected, so the campaign starts with an empty issue scope"}.`
    : inspection?.cancelled ? "The workspace inspection was cancelled before it finished; refresh the preflight."
    : !inspectionVersion ? "This runner cannot inspect the workspace origin and issues; update the runner."
    : !issueNumbers.length && inspectionVersion < 2 ? "This runner can inspect only selected issues; select issue numbers or update the runner."
    : inspection ? "The workspace origin or the selected issues could not be verified; check that the origin is github.com and each issue exists."
    : "The runner did not answer the workspace inspection in time; refresh the preflight.");

  const authority = campaignAuthorityPreflight(proposal ? schemaControl(proposal) : schemaControl({
    repository: "schema/validation", issueNumbers: [], objective: "schema validation", operations, delegatablePolicyIds: [],
    issueAuthority: { epics: [], relatedFollowUps: false, maxIssues: 1, closureReasons: ["completed"] },
    budgetAuthority: { version: 1, costUsd: 1, toolCalls: 1, concurrency: 1, acceptedFollowUps: 0, accounting: "managed_workers_only", unpriced: "stop" },
  }), plan.driver, runner.protocolVersion);
  add("authority_contract", "Full Control Authority", authority.supported && !facts.invalidPolicyIds.length ? "verified" : "unsupported",
    !authority.supported ? authority.reason ?? "This provider path cannot enforce Full Control."
      : facts.invalidPolicyIds.length ? `Named policy asks are unknown, disabled, built in or Human Required: ${facts.invalidPolicyIds.join(", ")}.`
      : `The ${plan.driver} root on runner protocol v${runner.protocolVersion} enforces the Full Control authority contract.`);

  const budgetValid = budgetSource !== "unset" && Boolean(proposal || !repository);
  add("accounting_budget", "Campaign Accounting and Budget", !facts.accountingError && budgetValid ? "verified" : "unsupported",
    facts.accountingError ? facts.accountingError
      : budgetSource === "unset" ? "No campaign cost and tool-call budget: enter both limits for this campaign."
      : !budgetValid ? "The derived campaign limits are invalid; adjust the budget, concurrency or issue limits."
      : `Managed workers are metered and priced; the campaign is limited to $${costUsd} and ${toolCalls} tool calls.`);

  const reviewOwnerScope = plan.scope.owner.kind === "user";
  // Review admission refuses any root or worker holding an original per-session ceiling; workers
  // inherit the Project's child-session defaults as such ceilings.
  const rootCeiling = (plan.config.costBudgetUsd ?? 0) > 0 || (plan.config.maxToolCalls ?? 0) > 0;
  const workerCeiling = facts.projectDefaults !== null;
  add("native_review", "Controlled Cross-Model Review",
    controlledReview && runnerSupportsProtocol(runner.protocolVersion, "campaignBudgetAdmission") && reviewOwnerScope && !facts.dailyLimit &&
      !rootCeiling && !workerCeiling ? "verified" : "unsupported",
    !controlledReview ? `This runner does not advertise the controlled native reviewer. It needs executionIsolation.mode "provider" (current: ${runner.runtime?.executionIsolation?.mode ?? "unreported"}), a native claude-code agent whose command is "claude", Claude Code CLI 2.1.296 and python3 on a Linux host; restart the runner after configuring it.`
      : !runnerSupportsProtocol(runner.protocolVersion, "campaignBudgetAdmission") ? "Controlled review admission needs a protocol-v218 runner; update the runner."
      : !reviewOwnerScope ? "Controlled review accounting needs a user-owned campaign."
      : facts.dailyLimit ? "Controlled review cannot honor this organization's per-user daily limit; remove the limit or launch in Custom."
      : rootCeiling ? "Controlled review cannot run under the root session's own cost or tool-call limit; clear the root limits and rely on the campaign budget."
      : workerCeiling ? "Controlled review cannot run under the Project's child-session defaults, which every worker inherits as a tighter limit; clear them for this Project and rely on the campaign budget."
      : `Reviews run as ${controlledReview.profile} through agent ${controlledReview.agentId}, charged to this campaign's budget.`);

  const isolation = runner.runtime?.executionIsolation;
  add("execution_isolation", "Execution Isolation", isolation ? "verified" : "unsupported", isolation
    ? `The runner enforces ${isolation.mode} isolation with network ${isolation.network}${plan.policy.execution.strictProjectIsolation ? "; Strict Project Isolation is on" : ""}.`
    : "The runner does not report the execution isolation it enforces; update the runner.");

  const imageReviewer = { driver: plan.driver, model: plan.config.model ?? null };
  const imageDelegated = operations.includes("ui_evidence_approval") && facts.imageReview.effectiveOwner === "orchestrator";
  add("image_evidence", "Screenshot Evidence Review", imageDelegated ? "verified" : "human_required", imageDelegated
    ? "Screenshots attached as private Session artifacts are reviewed by the Orchestrator."
    : facts.imageReview.effectiveOwner === "human" && facts.imageReview.fallback ? `Screenshots go to the Human: ${facts.imageReview.fallback.reason}`
    : "Screenshots go to the Human because UI evidence approval is not delegated.", false);
  add("video_evidence", "Video Evidence Review", "human_required",
    "Video evidence goes to the Human until production video review (#1321) lands.", false);
  add("external_evidence", "External Evidence Review", "human_required",
    "Evidence stored outside private Session artifacts (links only) goes to the Human.", false);

  const blockers = capabilities.filter((item) => item.mandatory && item.state !== "verified");
  const ready = blockers.length === 0 && proposal !== null;
  const envelope = Boolean(ready && facts.pacedVideoPeer && facts.disclosuresAvailable && imageDelegated && plan.config.model);
  const humanRequiredRequests = authority.humanRequiredRequests ?? [];
  const summary: CampaignLaunchPreflight["summary"] = {
    repository, issueNumbers, objective,
    root: { agentId: plan.agentId, driver: plan.driver, model: plan.config.model ?? null, effort: plan.config.effort ?? null,
      isolation: isolation ? { mode: isolation.mode, network: isolation.network } : null,
      strictProjectIsolation: plan.policy.execution.strictProjectIsolation, integrationIsolation: plan.policy.execution.integrationIsolation,
      completion: behavior.completion },
    budget: { costUsd: costUsd ?? null, toolCalls: toolCalls ?? null, concurrency, acceptedFollowUps, source: budgetSource,
      reviewIncluded: Boolean(controlledReview) },
    followUps: { policy: behavior.followUps, relatedFollowUps, maxIssues, closureReasons },
    evidence: {
      statement: imageDelegated
        ? "Screenshots are reviewed by the Orchestrator; video and external evidence need a Human (Human Required) until production video review (#1321) lands."
        : "Screenshots, video and external evidence need a Human (Human Required) for this campaign.",
      destination: { kind: "private_session_artifacts", configurationId: campaignSessionArtifactDestinationId(facts.organizationId),
        disclosureRevision: CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION },
      provider: imageDelegated ? { providerId: plan.driver, disclosureRevision: CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION,
        retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, reviewer: imageReviewer } : null,
      envelope,
    },
    humanRequired: [
      ...capabilities.filter((item) => item.state === "human_required").map((item) => ({ exception: item.capability, reason: item.reason })),
      ...humanRequiredRequests.map((id) => ({ exception: HUMAN_REQUIRED_LABELS[id] ?? id, reason: "Always decided by the Human under Full Control." })),
    ],
    blockers: blockers.map((item) => ({ capability: item.capability, reason: item.reason })),
  };
  const advanced: CampaignLaunchPreflight["advanced"] = {
    proposal, plan,
    ...(verified ? { inspection: { repository: inspection!.repository, issueNumbers: inspection!.issueNumbers, digest: inspection!.digest } } : {}),
    ...(controlledReview ? { controlledReview } : {}),
    humanRequiredRequests,
  };
  const inspectionCancellation = inspectionVersion >= 2 ? "supported" as const : "unsupported" as const;
  const view = { ready, summary, capabilities, inspectionCancellation, advanced };
  return { proposal: ready ? proposal : null, preflight: { ...view, digest: campaignLaunchDigest({ ...view,
    runnerGeneration: runner.connectedAt, runtime: runner.runtime, protocolVersion: runner.protocolVersion }) } };
}
