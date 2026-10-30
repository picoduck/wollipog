import { createHash } from "node:crypto";
import {
  campaignAuthorityPreflight, campaignRepositoryLocation, runnerSupportsProtocol, validCampaignControl,
  FULL_CONTROL_EVIDENCE_EXCEPTIONS, FULL_CONTROL_HUMAN_REQUIRED_LABELS, FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON,
  FULL_CONTROL_DECLINED_NOTE, fullControlStandingHumanRequired,
  CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION, CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION, campaignSessionArtifactDestinationId, FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE,
  type CampaignAuthorityBoundary, type CampaignAuthorityOperation, type FullControlDerivedLimits, type OrchestratorCampaignPolicy, type CampaignLaunchCapability, type CampaignLaunchPreflight,
  type CampaignLaunchProposal, type CampaignLaunchInspectionResult, type ChildSessionDefaults,
  type OrchestratorCampaignBudgetDefault,
  type CreateSessionRequest, type FullControlEnableRequest, type FullControlLaunchOverrides, type FullControlLaunchRequest,
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
      !p.budgetAuthority || p.budgetAuthority.concurrency === undefined || p.budgetAuthority.acceptedFollowUps === undefined ||
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
        r.issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(r.issueNumbers).size !== r.issueNumbers.length))) return null;
  if (admit ? typeof r.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.requestId) ||
      typeof r.preflightDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.preflightDigest)
    : r.requestId !== undefined || r.preflightDigest !== undefined) return null;
  if (r.overrides !== undefined && !validOverrides(r.overrides)) return null;
  return structuredClone(r);
}

/** Strict shape of an enable request; values flow through the same derivation and schema. */
export function parseFullControlEnableRequest(value: unknown, enable: boolean): FullControlEnableRequest | null {
  if (!record(value) || !only(value, ["overrides", "expectedRevision", "preflightDigest"])) return null;
  const r = value as FullControlEnableRequest;
  if (r.overrides !== undefined && (!validOverrides(r.overrides) || (r.overrides as FullControlLaunchOverrides).session !== undefined)) return null;
  if (enable ? !Number.isSafeInteger(r.expectedRevision) || (r.expectedRevision as number) < 0 ||
      typeof r.preflightDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.preflightDigest)
    : r.expectedRevision !== undefined || r.preflightDigest !== undefined) return null;
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

/** A Full Control campaign that waits for its owner's first message, or is delivering it (#2940).
 * Nothing else may start a provider turn for it: no prompt, command, steer, continuation or queued
 * work. Revoking to Custom ends the wait. */
export function awaitsFirstMessage(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope" | "control"> | undefined): boolean {
  const state = policy?.firstMessageScope?.state;
  return (state === "pending" || state === "delivering") && policy!.control?.mode === "full_control";
}

/** A launch that names no task, issues or objective: the owner's first message supplies them (#2940). */
export function firstMessageLaunch(request: Pick<FullControlLaunchRequest, "task" | "issueNumbers" | "overrides">): boolean {
  return request.task === undefined && !request.issueNumbers?.length && request.overrides?.objective === undefined;
}

const MAX_MESSAGE_ISSUES = 100;

/** Issue references in the owner's first message that name the campaign's own repository: `#123`,
 * `owner/repo#123` and `https://github.com/owner/repo/issues/123`, or for a GitLab project (#3539)
 * `http(s)://<host>/<project>/-/issues/123`. References to another repository and pull or merge
 * request URLs are ignored. These are candidates only; the runner still verifies each one
 * is an issue of the repository before it enters the scope. */
export function issueReferencesInMessage(text: string, repository: string): number[] {
  const own = repository.toLowerCase();
  const found = new Set<number>();
  const add = (value: string) => {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0) found.add(n);
  };
  for (const match of text.matchAll(/(?<![\w./#-])#([1-9][0-9]{0,15})(?![\w-])/gu)) add(match[1]!);
  for (const match of text.matchAll(/(?<![\w./-])([\w.-]+\/[\w.-]+)#([1-9][0-9]{0,15})(?![\w-])/gu)) {
    if (match[1]!.toLowerCase() === own) add(match[2]!);
  }
  for (const match of text.matchAll(/\bhttps?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]{0,15})(?![\w-])/giu)) {
    if (match[1]!.toLowerCase() === own) add(match[2]!);
  }
  if (campaignRepositoryLocation(repository)?.forge === "gitlab") {
    for (const match of text.matchAll(/\bhttps?:\/\/([^\s/?#@]+\/[^\s?#]+?)\/-\/issues\/([1-9][0-9]{0,15})(?![\w-])/giu)) {
      if (match[1]!.toLowerCase() === own) add(match[2]!);
    }
  }
  const numbers = [...found].sort((a, b) => a - b);
  return numbers.length <= MAX_MESSAGE_ISSUES ? numbers : numbers.slice(0, MAX_MESSAGE_ISSUES);
}

/** The boundary objective a first message states: its text on one line (the boundary refuses
 * control characters), bounded to the schema's 4000 characters. The digest binds the exact text. */
export function firstMessageObjective(text: string): string {
  const line = text.replace(/[\x00-\x1f\x7f\s]+/gu, " ").trim();
  return line.length <= 4000 ? line : `${line.slice(0, 3999)}…`;
}

export function firstMessageDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Which of a launch's limits the server derived rather than the Human set (#2940). */
export function derivedLaunchLimits(overrides: FullControlLaunchOverrides | undefined): FullControlDerivedLimits {
  return { acceptedFollowUps: overrides?.budget?.acceptedFollowUps === undefined, maxIssues: overrides?.issues?.maxIssues === undefined };
}

/** The issues a first message can scope: all verified ones, unless the Human set Maximum Issues,
 * which an explicit ceiling bounds. */
export function firstMessageIssues(boundary: CampaignAuthorityBoundary, issueNumbers: number[], derived: FullControlDerivedLimits | undefined): number[] {
  const max = boundary.issueAuthority?.maxIssues;
  return derived?.maxIssues || max === undefined ? [...issueNumbers] : issueNumbers.slice(0, max);
}

/** The boundary the owner's first message establishes from the launch's task-only one: the same
 * operations, policy asks, evidence and ceilings, with the message as objective and its verified
 * issues as scope. Only a limit the launch derived (no Human override) grows to what a launch
 * naming those issues derives, never below what was authorized; an explicit ceiling never
 * changes, and a missing record counts as explicit. */
export function firstMessageBoundary(boundary: CampaignAuthorityBoundary, followUps: "recommend_only" | "execute_approved",
  issueNumbers: number[], objective: string, revision: number, issueScopeRevision: number, now: number,
  derived: FullControlDerivedLimits = { acceptedFollowUps: false, maxIssues: false }): CampaignAuthorityBoundary {
  const derivedFollowUps = followUps === "execute_approved" ? Math.min(MAX_DERIVED_FOLLOW_UPS, Math.max(1, issueNumbers.length)) : 0;
  const budget = boundary.budgetAuthority;
  const acceptedFollowUps = derived.acceptedFollowUps ? Math.max(budget?.acceptedFollowUps ?? 0, derivedFollowUps) : budget?.acceptedFollowUps ?? 0;
  const issues = boundary.issueAuthority;
  const maxIssues = issues && (derived.maxIssues ? Math.min(100, Math.max(issues.maxIssues, issueNumbers.length + acceptedFollowUps)) : issues.maxIssues);
  return structuredClone({ ...boundary, objective, revision, issueScopeRevision, authorizedAt: now,
    ...(budget ? { budgetAuthority: { ...budget, acceptedFollowUps } } : {}),
    ...(issues ? { issueAuthority: { ...issues, epics: [...issueNumbers], maxIssues: maxIssues! } } : {}) });
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

/** The certified video reviewer a launch on one runner could use, read from current server records. */
export interface VideoLaunchCertification {
  reviewer: { driver: string; model: string; effort: string };
  proofExpiresAt: number;
  /** The control plane's video review adapters are attached to Sessions and the runner hub. */
  adaptersReady: boolean;
}

export interface CampaignLaunchFacts {
  request: FullControlLaunchRequest;
  plan: PreparedCampaignLaunch;
  runner: RunnerView;
  inspection?: CampaignLaunchInspectionResult;
  organizationId: string;
  projectDefaults: ChildSessionDefaults | null;
  /** `campaignBudgetAccountingError` for the root's driver and model; `costProtected` when the
   * launch has a cost ceiling, which needs priced usage. */
  accountingError: (costProtected: boolean) => string | null;
  /** The owner's organization enforces a per-user daily limit native review cannot honor. */
  dailyLimit: boolean;
  /** Named policy asks that are unknown, disabled, built in or Human Required. */
  invalidPolicyIds: string[];
  imageReview: UiEvidenceReviewEvaluation;
  /** An enabled ask rule is marked Human Required. Only then does that class stay with the Human;
   * omitted, the summary still discloses it rather than claim nothing reaches the Human. */
  humanRequiredRules?: boolean;
  /** Every launch peer declares the exact private media contract (#1321). */
  pacedVideoPeer: boolean;
  /** Hosting disclosure port is wired. */
  disclosuresAvailable: boolean;
  /** A current Human-recorded live proof certifies an attested media-only reviewer installation on
   * the root's runner (#1321). Absent or null keeps video evidence with the Human exactly as before. */
  videoCertification?: VideoLaunchCertification | null;
  /** The authorizing Human's saved Full Control campaign envelope, if any. */
  savedBudget?: OrchestratorCampaignBudgetDefault | null;
  /** Enabling Full Control on an existing campaign: its Human-established issue scope stands in for
   * the workspace inspection. `authorizedByCaller` is false when another person established it. */
  campaignScope?: { repository: string; issueNumbers: number[]; authorizedByCaller: boolean } | null;
  /** Enabling on an existing campaign: a live participant already holds its own cost or tool limit. */
  participantCeiling?: boolean;
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

/** Readiness comes from current server and runner facts. Only genuine impossibilities are mandatory:
 * no verifiable repository scope, a provider path that cannot enforce the authority contract, and an
 * explicit budget ceiling that cannot be enforced. `unsupported` blocks the launch with an actionable
 * reason; `human_required` is a disclosed exception that routes that decision class to the Human;
 * `informational` states an infrastructure gap the campaign works around with the best available
 * path. No caller field, preset, protocol number alone or fixture can mark a capability verified. */
const blockersBeforeVideo = (capabilities: CampaignLaunchCapability[]) =>
  capabilities.some((item) => item.mandatory && item.state !== "verified");

/** Delegable only when a current proof certifies a reviewer on the root's runner and the launch
 * mints an evidence envelope that names that exact reviewer: the paced contract is advertised only
 * by an attested Claude Code agent, so the root itself must be one, at the certified model. Without
 * a proof the row is exactly what it was before certification existed. Full Control never hands
 * video to the Human (#2940): unless the authorization leaves UI Evidence Approval out, an
 * Orchestrator that can't watch it asks for screenshots or denies the claim as unproven. */
function videoEvidenceCapability(facts: CampaignLaunchFacts, imageDelegated: boolean, evidenceOwned: boolean, blocked: boolean,
  proposal: boolean): { state: CampaignLaunchCapability["state"]; reason: string } {
  const certification = facts.videoCertification;
  const human = (reason: string) => evidenceOwned
    ? { state: "orchestrator_decides" as const, reason: `The Orchestrator can't watch video because ${reason} It asks for screenshots or denies the claim as unproven.` }
    : { state: "human_required" as const, reason: "Video evidence needs your review because UI evidence approval is not part of this campaign's authorization." };
  if (!certification) return evidenceOwned ? { state: "orchestrator_decides",
    reason: FULL_CONTROL_EVIDENCE_EXCEPTIONS.find((item) => item.id === "video_evidence")!.reason } : human("");
  const { reviewer } = certification;
  if (!imageDelegated) return human("it can't inspect evidence images either.");
  if (!facts.pacedVideoPeer) return human(`this Orchestrator's agent does not declare the paced video review contract; only an attested ${reviewer.driver} media-only agent does.`);
  if (facts.plan.driver !== reviewer.driver || facts.plan.config.model !== reviewer.model) {
    return human(`the evidence envelope would name ${facts.plan.driver} ${facts.plan.config.model ?? "with no fixed model"}, not the certified ${reviewer.driver} ${reviewer.model} reviewer.`);
  }
  if (!facts.disclosuresAvailable) return human("Wollipog has no provider disclosures to mint the evidence envelope.");
  if (!certification.adaptersReady) return human("Wollipog's video review service is not attached yet.");
  if (blocked || !proposal) return human("the launch is blocked, so no evidence envelope is minted.");
  return { state: "verified", reason: `MP4 and WebM recordings attached as private Session artifacts are reviewed by the certified ${reviewer.driver} ${reviewer.model} (${reviewer.effort} effort) media-only reviewer, and the Orchestrator decides from its verdict. Children must also run on an attested agent. The live proof expires ${new Date(certification.proofExpiresAt).toISOString()}.` };
}

export function campaignLaunchPreflight(facts: CampaignLaunchFacts): { preflight: CampaignLaunchPreflight; proposal: CampaignLaunchProposal | null } {
  const { request, plan, runner, inspection, campaignScope } = facts;
  const overrides = request.overrides ?? {};
  const issueNumbers = [...(campaignScope ? campaignScope.issueNumbers : request.issueNumbers ?? [])].sort((a, b) => a - b);
  const behavior = plan.policy.behavior;
  const inspectionVersion = runner.runtime?.campaignLaunchInspection?.version ?? 0;
  const verified = campaignScope ? campaignScope.authorizedByCaller && campaignRepositoryLocation(campaignScope.repository) !== null
    : inspection?.ok === true && inspection.workspaceId === plan.workspaceId &&
      typeof inspection.repository === "string" && /^[a-f0-9]{64}$/.test(inspection.digest ?? "") &&
      canonical(inspection.issueNumbers) === canonical(issueNumbers);
  const repository = verified ? (campaignScope?.repository ?? inspection!.repository!).toLowerCase() : null;

  const acceptedFollowUps = overrides.budget?.acceptedFollowUps ??
    (behavior.followUps === "execute_approved" ? Math.min(MAX_DERIVED_FOLLOW_UPS, Math.max(1, issueNumbers.length)) : 0);
  const concurrency = overrides.budget?.concurrency ?? behavior.maximumConcurrentChildren;
  // The envelope is a Human amount: this request's override or the Human's saved Full Control
  // default. Saved per-session limits (root ceilings, Project child-session defaults) are tighter
  // ceilings, never the envelope, and controlled review refuses to run under them.
  // No ceiling is a first-class state, never a fake large amount: each amount is either the Human's
  // ceiling or absent, and an absent amount is metered without a limit.
  const overridden = overrides.budget?.costUsd !== undefined || overrides.budget?.toolCalls !== undefined;
  const costUsd = overrides.budget?.costUsd ?? facts.savedBudget?.costUsd;
  const toolCalls = overrides.budget?.toolCalls ?? facts.savedBudget?.toolCalls;
  const ceiling = costUsd !== undefined || toolCalls !== undefined;
  const budgetSource = !ceiling ? "unset" as const : overridden ? "override" as const : "saved_defaults" as const;
  const relatedFollowUps = overrides.issues?.relatedFollowUps ?? behavior.followUps === "execute_approved";
  const maxIssues = overrides.issues?.maxIssues ?? Math.min(100, Math.max(1, issueNumbers.length + acceptedFollowUps));
  const closureReasons = overrides.issues?.closureReasons ?? ["completed" as const];
  const objective = overrides.objective ?? request.task?.trim() ?? (issueNumbers.length
    ? `Deliver ${repository ?? "the selected repository"} ${issueNumbers.map((n) => `#${n}`).join(", ")}.`
    : FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE);
  const advertisedReview = runner.runtime?.campaignReview;
  const reviewOwnerScope = plan.scope.owner.kind === "user";
  // Review admission refuses any root or worker holding an original per-session ceiling; workers
  // inherit the Project's child-session defaults as such ceilings.
  const rootCeiling = (plan.config.costBudgetUsd ?? 0) > 0 || (plan.config.maxToolCalls ?? 0) > 0;
  const workerCeiling = facts.projectDefaults !== null;
  const participantCeiling = facts.participantCeiling === true;
  const reviewPeer = runnerSupportsProtocol(runner.protocolVersion, "campaignBudgetAdmission");
  // The controlled reviewer enters the boundary only when it can actually run. Otherwise the campaign
  // uses the regular cross-model review workflow and admits children with their own limits as before.
  const controlledReview = advertisedReview && reviewPeer && reviewOwnerScope && !facts.dailyLimit &&
    !rootCeiling && !workerCeiling && !participantCeiling ? advertisedReview : undefined;
  const operations = overrides.operations ?? [...FULL_CONTROL_LAUNCH_OPERATIONS];
  const delegatablePolicyIds = overrides.delegatablePolicyIds ?? [];

  const proposal = repository ? parseCampaignLaunchProposal({
    repository, issueNumbers, objective, operations, delegatablePolicyIds,
    issueAuthority: { epics: issueNumbers, relatedFollowUps, maxIssues, closureReasons },
    budgetAuthority: { version: 1, ...(costUsd !== undefined ? { costUsd } : {}), ...(toolCalls !== undefined ? { toolCalls } : {}),
      concurrency, acceptedFollowUps,
      ...(overrides.budget?.checkpointsUsd?.length ? { checkpointsUsd: overrides.budget.checkpointsUsd } : {}),
      accounting: "managed_workers_only", unpriced: "stop", ...(controlledReview ? { controlledReview } : {}) },
  }) : null;

  const capabilities: CampaignLaunchCapability[] = [];
  const add = (id: CampaignLaunchCapability["id"], capability: string, state: CampaignLaunchCapability["state"], reason: string, mandatory = true) =>
    capabilities.push({ id, capability, state, reason, mandatory });

  add("repository_scope", "Repository and Issue Scope", verified ? "verified" : "unsupported", campaignScope ? verified
    ? `This campaign's Human-established scope is ${repository}${issueNumbers.length ? ` with issues ${issueNumbers.map((n) => `#${n}`).join(", ")}` : " with no issues yet"}.`
    : !campaignScope.authorizedByCaller ? "Only the person who established this campaign's issue scope can enable Full Control for it."
    : !campaignScope.repository ? "The runner could not verify this campaign's repository; check that the runner is online and the origin is github.com."
    : "This campaign's issue scope is not repository-qualified; establish its scope first."
    : verified
    ? `The registered workspace's origin is ${repository}${issueNumbers.length ? ` and issues ${issueNumbers.map((n) => `#${n}`).join(", ")} were read from it` : "; no issues were selected, so the campaign starts with an empty issue scope"}.`
    : inspection?.cancelled ? "The workspace inspection was cancelled before it finished; refresh the preflight."
    : !inspectionVersion ? "This runner cannot inspect the workspace origin and issues; update the runner."
    : !issueNumbers.length && inspectionVersion < 2 ? "This runner can inspect only selected issues; select issue numbers or update the runner."
    : inspection && !issueNumbers.length ? "The registered workspace's origin could not be verified; check that it is a github.com repository."
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
      : `The ${plan.driver} root's runner enforces the Full Control authority contract.`);

  // Only limits the Human set must be enforceable, so only then is this row mandatory: an explicit
  // ceiling, or derived limits the schema refuses, such as a paused campaign's zero concurrency. With
  // no ceiling the campaign runs unbounded and this row only says how its usage is metered.
  const accountingError = facts.accountingError(costUsd !== undefined);
  // Without a cost ceiling an unpriced model can still launch: tool calls are counted, cost is not.
  const priced = costUsd !== undefined || !facts.accountingError(true);
  const limitsInvalid = Boolean(repository) && !proposal;
  const limitText = [costUsd !== undefined ? `$${costUsd}` : null, toolCalls !== undefined ? `${toolCalls} tool calls` : null]
    .filter(Boolean).join(" and ");
  const metering = priced ? "Managed workers are metered and priced"
    : "Managed workers' tool calls are counted, but this model's cost is not priced";
  // Checkpoints are amounts within a cost ceiling, so without one they are refused, never dropped.
  const checkpointsWithoutCost = Boolean(overrides.budget?.checkpointsUsd?.length) && costUsd === undefined;
  const accounting: [CampaignLaunchCapability["state"], string] =
    limitsInvalid && checkpointsWithoutCost ? ["unsupported", "Cost checkpoints need a cost limit; enter one or remove the checkpoints."]
    : limitsInvalid && concurrency < 1 ? ["unsupported", "This campaign pauses new children; raise Live Child Limit in Guardrails to enable Full Control."]
    : limitsInvalid ? ["unsupported", "The derived campaign limits are invalid; adjust the budget, concurrency or issue limits."]
    : accountingError ? ceiling ? ["unsupported", accountingError] : ["informational", `No limit. ${accountingError}`]
    : ceiling ? ["verified", `${metering}; the campaign is limited to ${limitText}.`]
    : [priced ? "verified" : "informational", `No limit. ${metering}, and Campaign Status shows the campaign's usage.`];
  add("accounting_budget", "Campaign Accounting and Budget", ...accounting, ceiling || limitsInvalid);

  const isolation = runner.runtime?.executionIsolation;
  const regular = "; the campaign uses the regular cross-model review workflow.";
  add("native_review", "Controlled Cross-Model Review", controlledReview ? "verified" : "informational",
    controlledReview ? `Reviews run as ${controlledReview.profile} through agent ${controlledReview.agentId}, charged to this campaign.`
      : !advertisedReview ? `This runner does not offer the controlled reviewer, which needs provider isolation (current: ${isolation?.mode ?? "unreported"}), Claude Code CLI 2.1.296 and python3 on Linux${regular}`
      : !reviewPeer ? `Controlled review needs a newer runner${regular}`
      : !reviewOwnerScope ? `Controlled review accounting needs a user-owned campaign${regular}`
      : facts.dailyLimit ? `Controlled review cannot honor this organization's per-user daily limit${regular}`
      : rootCeiling ? `Controlled review cannot run under the root session's own cost or tool-call limit${regular}`
      : workerCeiling ? `Controlled review cannot run under the Project's child-session defaults, which every worker inherits${regular}`
      : `Controlled review cannot run under the limits some of this campaign's sessions already hold${regular}`, false);

  add("execution_isolation", "Execution Isolation", isolation ? "verified" : "informational", isolation
    ? `The runner enforces ${isolation.mode} isolation with network ${isolation.network}${plan.policy.execution.strictProjectIsolation ? "; Strict Project Isolation is on" : ""}.`
    : "The runner does not report the execution isolation it enforces.", false);

  const imageReviewer = { driver: plan.driver, model: plan.config.model ?? null };
  // Full Control never routes evidence to the Human (#2940). Only an authorization that leaves UI
  // Evidence Approval out keeps it with them; an Orchestrator that can't inspect an item asks for
  // screenshots or denies the claim as unproven.
  const evidenceOwned = operations.includes("ui_evidence_approval");
  const imageDelegated = evidenceOwned && facts.imageReview.effectiveOwner === "orchestrator";
  const notAuthorized = "UI evidence approval is not part of this campaign's authorization.";
  add("image_evidence", "Screenshot Evidence Review", imageDelegated ? "verified" : evidenceOwned ? "orchestrator_decides" : "human_required", imageDelegated
    ? "Screenshots attached as private Session artifacts are reviewed by the Orchestrator."
    : evidenceOwned ? `The Orchestrator can't view screenshots: ${facts.imageReview.effectiveOwner === "human" && facts.imageReview.fallback
      ? facts.imageReview.fallback.reason : "its client can't inspect evidence images."} It asks for inspectable evidence or denies the claim as unproven.`
    : `Screenshots need your review because ${notAuthorized}`, false);
  // Video is the one exception a current live proof can lift (#1321); without one the Orchestrator
  // asks for screenshots or denies.
  const video = videoEvidenceCapability(facts, imageDelegated, evidenceOwned, blockersBeforeVideo(capabilities), proposal !== null);
  for (const item of FULL_CONTROL_EVIDENCE_EXCEPTIONS) {
    if (item.id === "video_evidence") add(item.id, item.exception, video.state, video.reason, false);
    else add(item.id, item.exception, evidenceOwned ? "orchestrator_decides" : "human_required",
      evidenceOwned ? item.reason : `External evidence needs your review because ${notAuthorized}`, false);
  }

  const blockers = capabilities.filter((item) => item.mandatory && item.state !== "verified");
  const ready = blockers.length === 0 && proposal !== null;
  const envelope = Boolean(ready && facts.pacedVideoPeer && facts.disclosuresAvailable && imageDelegated && plan.config.model);
  const humanRequiredRequests = authority.supported ? fullControlStandingHumanRequired(facts.humanRequiredRules ?? true) : [];
  const summary: CampaignLaunchPreflight["summary"] = {
    repository, issueNumbers, objective,
    root: { agentId: plan.agentId, driver: plan.driver, model: plan.config.model ?? null, effort: plan.config.effort ?? null,
      isolation: isolation ? { mode: isolation.mode, network: isolation.network } : null,
      strictProjectIsolation: plan.policy.execution.strictProjectIsolation, integrationIsolation: plan.policy.execution.integrationIsolation,
      completion: behavior.completion },
    budget: { costUsd: costUsd ?? null, toolCalls: toolCalls ?? null, concurrency, acceptedFollowUps, source: budgetSource,
      reviewIncluded: Boolean(controlledReview) },
    review: { controlled: Boolean(controlledReview), statement: controlledReview
      ? "Controlled cross-model review, charged to this campaign."
      : "The regular cross-model review workflow, because controlled review is unavailable." },
    followUps: { policy: behavior.followUps, relatedFollowUps, maxIssues, closureReasons },
    evidence: {
      statement: !evidenceOwned
        ? "Screenshots, video and external evidence need your review."
        : video.state === "verified"
        ? "The Orchestrator reviews screenshots, and video through the certified media-only reviewer. For external evidence it asks for screenshots or denies the claim as unproven."
        : imageDelegated
        ? "The Orchestrator reviews screenshots. For video and external evidence it asks for screenshots or denies the claim as unproven."
        : "The Orchestrator decides UI evidence but can't view images, so it asks for inspectable evidence or denies the claim as unproven.",
      destination: { kind: "private_session_artifacts", configurationId: campaignSessionArtifactDestinationId(facts.organizationId),
        disclosureRevision: CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION },
      provider: imageDelegated ? { providerId: plan.driver, disclosureRevision: CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION,
        retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, reviewer: imageReviewer } : null,
      envelope,
    },
    humanRequired: [
      ...capabilities.filter((item) => item.state === "human_required").map((item) => ({ exception: item.capability, reason: item.reason })),
      ...humanRequiredRequests.map((id) => ({ exception: FULL_CONTROL_HUMAN_REQUIRED_LABELS[id] ?? id, reason: FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON })),
    ],
    declinedNote: FULL_CONTROL_DECLINED_NOTE,
    blockers: blockers.map((item) => ({ capability: item.capability, reason: item.reason })),
  };
  const advanced: CampaignLaunchPreflight["advanced"] = {
    proposal, plan,
    ...(verified && inspection ? { inspection: { repository: inspection.repository, issueNumbers: inspection!.issueNumbers, digest: inspection!.digest } } : {}),
    ...(controlledReview ? { controlledReview } : {}),
    humanRequiredRequests,
  };
  const inspectionCancellation = inspectionVersion >= 2 ? "supported" as const : "unsupported" as const;
  const view = { ready, summary, capabilities, inspectionCancellation, advanced };
  return { proposal: ready ? proposal : null, preflight: { ...view, digest: campaignLaunchDigest({ ...view,
    runnerGeneration: runner.connectedAt, runtime: runner.runtime, protocolVersion: runner.protocolVersion }) } };
}
