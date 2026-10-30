import { supportsPacedVideoReviewPeer } from "./paced-video-review.js";
import { campaignEvidenceAuthorityBound, type CampaignEvidenceAuthority } from "./campaign-evidence-authority.js";
import { parentControlRequestEligible, runnerCapabilityRequirementError, runnerSupportsProtocol, type RunnerCapabilityRequirementDetails } from "./index.js";
import { validCampaignBudgetAuthority, type CampaignBudgetAuthority } from "./campaign-budget.js";
import { campaignRepositoryLocation } from "./campaign-work-ledger.js";
import type { CampaignPublicationAdmissionFailure } from "./campaign-issue-publication.js";
import type { ApprovalContext, GovernancePolicy, ParentControlDecisionPolicy, ParentControlMode, PendingApproval, WorkflowDecisionCategory, WorkflowDecisionResourceSnapshot } from "./index.js";

export type CampaignControlMode = "custom" | "full_control";
export type CampaignAuthorityOperation = WorkflowDecisionCategory | "question" | "tool_approval" | "policy_ask";

/** Only an authenticated human admission may mint this contract. Defaults, prompts, ledger
 * records and child metadata are never authorization. Additional scope/limit contracts compose
 * with this boundary; listing an operation does not bypass their own enforcement. */
export interface CampaignAuthorityBoundary {
  version: 1;
  revision: number;
  issueScopeRevision: number;
  repository: string;
  objective: string;
  authorizedByUserId: string;
  authorizedAt: number;
  operations: CampaignAuthorityOperation[];
  /** Exact human-selected policy asks eligible for one-time delegation. Built-in rules and
   * escalations requiring a human cannot be named here to override their enforcement. */
  delegatablePolicyIds: string[];
  /** Human-established issue-write boundary. Omission preserves human-only scope/closure. */
  issueAuthority?: {
    epics: number[];
    relatedFollowUps: boolean;
    maxIssues: number;
    closureReasons: Array<"completed" | "not_planned">;
  };
  budgetAuthority?: CampaignBudgetAuthority;
  /** Narrowed destination/provider disclosure. UI Evidence Approval remains the sole authority. */
  evidenceAuthority?: CampaignEvidenceAuthority;
}

export type CampaignControl = { mode: "custom" } | { mode: "full_control"; boundary: CampaignAuthorityBoundary };
export type CampaignRequestSource = "provider_question" | "provider_tool" | "provider_elicitation";
/** Request classes Full Control once routed to the Human. Each now has a fixed owner: the
 * Orchestrator decides it, the server declines it, or (rules only) the Human keeps it. */
export type FullControlRequestClass = "secrets_and_sign_in" | "persistent_permissions" | "provider_access_expansion" |
  "external_elicitation" | "root_questions" | "unverified_tool_effects" |
  "git_execution_without_bounded_effect_proof" | "script_execution_without_bounded_effect_proof" |
  "human_required_rules" | "undelegated_policy_asks" | "relative_shell_commands_without_verified_cwd";

/** Classes the Orchestrator cannot supply. Under Full Control the server declines each occurrence
 * once and records content-safe blocked work; nobody is asked and nothing is approved. */
export const FULL_CONTROL_DECLINED_CLASSES: ReadonlySet<FullControlRequestClass> =
  new Set(["secrets_and_sign_in", "persistent_permissions", "provider_access_expansion"]);

export interface CampaignAuthorityEvaluation {
  owner: "human" | "orchestrator";
  basis: "human_required" | "custom_policy" | "campaign_delegation" | "standing_authorization" | "standing_decline";
  reason: "custom_owner" | "authorized_operation" | "outside_boundary" | "protected_request" |
    "unverified_intent" | "unsupported_provider" | "human_required_rule" | "evidence_review_unavailable" | "provider_delivery_unavailable" |
    "declined_request" | "unresolved_effects";
  operation: CampaignAuthorityOperation;
  boundaryRevision?: number;
  /** Full Control only: which formerly human class this occurrence belongs to. Content-safe. */
  requestClass?: FullControlRequestClass;
  /** The server answers this occurrence itself with its one-time reject or dismissal. A
   * declined occurrence can never be approved or answered by anyone acting for the campaign. */
  disposition?: "decline";
  /** A publication that named a recommendation the server could not admit (#2940). */
  admissionFailure?: CampaignPublicationAdmissionFailure;
}

const operations: CampaignAuthorityOperation[] = ["implementation_question", "pr_merge", "merged_branch_deletion",
  "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"];

/** Category-level projection only. A concrete request still needs provenance, resource and
 * sensitive-effect evaluation; this value is never a consumable grant. */
export function campaignWorkflowOwner(control: CampaignControl | undefined, decisions: ParentControlDecisionPolicy,
  category: WorkflowDecisionCategory, supported: boolean): "human" | "orchestrator" {
  // A follow-up past the campaign's approval limit is the Human's in every mode (#2940).
  if (!supported || category === "automation_creation" || category === "campaign_follow_up_admission") return "human";
  if (category === "issue_closure" || category === "campaign_issue_scope") return control?.mode === "full_control" &&
    validCampaignControl(control) && control.boundary.issueAuthority && control.boundary.operations.includes(category) ? "orchestrator" : "human";
  if (!control || control.mode === "custom") return decisions[category];
  // More review rounds than the policy allows are never part of Full Control's own authority: only
  // an explicit Parent Control grant delegates them (#3369).
  if (category === "review_round_extension") return decisions[category];
  return validCampaignControl(control) && control.boundary.operations.includes(category) ? "orchestrator" : "human";
}

export function validCampaignControl(value: unknown): value is CampaignControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const control = value as CampaignControl;
  if (control.mode === "custom") return Object.keys(control).every((key) => key === "mode");
  if (control.mode !== "full_control" || Object.keys(control).some((key) => !["mode", "boundary"].includes(key))) return false;
  const b = control.boundary;
  const bounded = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/u.test(v);
  return Boolean(b && !Array.isArray(b) && b.version === 1 &&
    Object.keys(b).every((key) => ["version", "revision", "issueScopeRevision", "repository", "objective", "authorizedByUserId", "authorizedAt", "operations", "delegatablePolicyIds", "issueAuthority", "budgetAuthority", "evidenceAuthority"].includes(key)) &&
    (b.issueAuthority === undefined || validIssueAuthority(b.issueAuthority)) &&
    (b.budgetAuthority === undefined || validCampaignBudgetAuthority(b.budgetAuthority)) &&
    Number.isSafeInteger(b.revision) && b.revision > 0 && bounded(b.repository, 256) && campaignRepositoryLocation(b.repository) !== null &&
    Number.isSafeInteger(b.issueScopeRevision) && b.issueScopeRevision > 0 &&
    bounded(b.objective, 4000) && bounded(b.authorizedByUserId, 256) && Number.isSafeInteger(b.authorizedAt) && b.authorizedAt > 0 &&
    Array.isArray(b.operations) && b.operations.length <= operations.length && new Set(b.operations).size === b.operations.length &&
    b.operations.every((operation) => operations.includes(operation)) &&
    Array.isArray(b.delegatablePolicyIds) && b.delegatablePolicyIds.length <= 100 &&
    new Set(b.delegatablePolicyIds).size === b.delegatablePolicyIds.length && b.delegatablePolicyIds.every((id) => bounded(id, 256)) &&
    (b.evidenceAuthority === undefined || campaignEvidenceAuthorityBound(b.evidenceAuthority, b)));
}

function validIssueAuthority(value: NonNullable<CampaignAuthorityBoundary["issueAuthority"]>): boolean {
  return Boolean(value && Object.keys(value).every((key) => ["epics", "relatedFollowUps", "maxIssues", "closureReasons"].includes(key)) &&
    Array.isArray(value.epics) && value.epics.length <= 100 && new Set(value.epics).size === value.epics.length &&
    value.epics.every((n) => Number.isSafeInteger(n) && n > 0) && typeof value.relatedFollowUps === "boolean" &&
    Number.isSafeInteger(value.maxIssues) && value.maxIssues > 0 && value.maxIssues <= 100 &&
    Array.isArray(value.closureReasons) && new Set(value.closureReasons).size === value.closureReasons.length &&
    value.closureReasons.every((reason) => ["completed", "not_planned"].includes(reason)));
}

// Screen actual requests to disclose credentials, authenticate, administer identity or change
// access. Mentioning an authentication implementation is deliberately insufficient on its own.
const protectedAction = /(?:\b(?:paste|enter|provide|supply|reveal|show|print|read|retrieve|extract|send|upload|copy|use|share|give|fetch|load|export)\b.{0,80}\b(?:password|passphrases?|secrets?|credentials?|api[ _-]?key|access[ _-]?token|private[ _-]?key|cookie|bearer)\b|\b(?:sign[ -]?in|log[ -]?in|authenticate|authorize)\b.{0,60}\b(?:me|your|my|account|device|browser|now)\b|\b(?:grant|enlarge|increase|broaden|disable|bypass|remove)\b.{0,60}\b(?:access|permission|guardrail|sandbox|policy|limit|protection)\b|\b(?:passwords?|secrets?|credentials?|tokens?|api[ _-]?key)\b.{0,40}\b(?:value|here|please)\b|\b(?:gh|railway|vercel|npm|aws)\s+(?:auth\s+)?login\b|\b(?:chmod|chown|sudo)\b|(?:\.ssh|\.aws|\.env)(?:\/|\b)|\b(?:sk-[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{12,})\b)/iu;
const credentialIdentity = /(?:\b(?:your|my|real|production|existing)\b.{0,50}\b(?:password|passphrases?|secrets?|credentials?|api[ _-]?key|access[ _-]?token|private[ _-]?key)\b|\b(?:passwords?|secrets?|credentials?|tokens?|api[ _-]?key)\b.{0,40}\b(?:your|my|account)\b|\b(?:I|you|we|please)\s+(?:sign[ -]?in|log[ -]?in|authenticate|authorize)\b)/iu;
// Selecting a credential value is not implementation planning. A missing secret marker or a
// trailing "for the implementation" cannot turn a value-selection form into trusted code intent.
const credentialValueChoice = /\b(?:passwords?|passphrases?|secrets?|credentials?|tokens?|api[ _-]?keys?|access[ _-]?tokens?|private[ _-]?keys?|cookies?)\b\s+(?:values?\s+)?(?:should|shall|will|can|do|does|may)\s+(?:I|we|you|(?:the|our)\s+(?:app|application|client|provider))\s+(?:use|enter|provide|supply|send|paste|choose|select)\b/iu;
// Credential stores by path segment, matched against lexical and runner-resolved targets.
const protectedPath = new RegExp(String.raw`(?:^|[\\/\s"'=:])(?:` + [
  String.raw`\.env[^\\/\s"']*`, String.raw`\.ssh`, String.raw`\.aws`, String.raw`\.azure`, String.raw`\.codex`, String.raw`\.claude`,
  String.raw`\.netrc`, String.raw`\.npmrc`, String.raw`\.pypirc`, String.raw`\.pgpass`, String.raw`\.git-credentials`, String.raw`\.docker`,
  String.raw`\.kube`, String.raw`\.gnupg`, String.raw`\.password-store`,
  String.raw`\.config[\\/](?:gh|hub|gcloud|op|github-copilot|containers[\\/]auth\.json)`,
  String.raw`\.terraform\.d[\\/]credentials[^\\/\s"']*`, String.raw`\.local[\\/]share[\\/]keyrings`,
  String.raw`Library[\\/]Keychains`, String.raw`credentials`, String.raw`id_(?:rsa|ed25519|ecdsa|dsa)`,
  // Provider credential files by name, wherever a home or account directory places them.
  String.raw`auth\.json`, String.raw`\.credentials\.json`, String.raw`\.claude\.json`,
].join("|") + String.raw`)(?:[\\/\s"']|$)`, "iu");

/** The runner-resolved targets of an operation, only when they are complete: every lexical target
 * the effect can touch has a runner-derived physical path, relative ones under a verified cwd.
 * Null for globs, scripts, interpreters, unparsed commands and missing evidence. Never a grant. */
export function campaignResolvedOperationTargets(request: PendingApproval): string[] | null {
  const operation = request.context?.operation;
  const selectors = campaignCodeOperationTargets(request.context?.toolName, operation);
  const evidence = operation?.filesystem;
  if (!selectors || !selectors.paths.length || !evidence || !Array.isArray(evidence.targets) ||
      evidence.targets.length !== selectors.paths.length) return null;
  // `jump/..` resolves after the symlink before it; a lexical reading would name another file.
  const parentSegment = (path: string | undefined) => Boolean(path?.split(/[\\/]+/u).includes(".."));
  if (selectors.paths.some(parentSegment) || parentSegment(selectors.cwd)) return null;
  const normalize = (value: string | undefined) => value?.replaceAll("\\", "/").replace(/\/+$/u, "");
  const absolute = (path: string) => path.startsWith("/") || /^[a-z]:[\\/]/iu.test(path);
  if (selectors.paths.some((path) => !absolute(path)) &&
      (!selectors.cwd || !evidence.cwd || normalize(selectors.cwd) !== normalize(evidence.cwd))) return null;
  const resolved = selectors.paths.map((path, index) => {
    const target = evidence.targets[index];
    return target?.path === path && typeof target.resolvedPath === "string" && absolute(target.resolvedPath) ? target.resolvedPath : null;
  });
  return resolved.every((path): path is string => path !== null) ? resolved : null;
}

/** The worktree allowlist (#2940): an effect is approvable only when the runner's evidence is
 * complete and attests (v230 `containment`) that every resolved real target, and the resolved cwd,
 * lies inside this session's own canonical worktree root, the root the server knows for it. Outside
 * targets, escaping symlinks, partial or older evidence all fail. Never a grant by itself. */
export function campaignContainedOperation(request: PendingApproval, repositoryRoot: string | undefined): boolean {
  const resolved = campaignResolvedOperationTargets(request);
  const evidence = request.context?.operation?.filesystem;
  const containment = evidence?.containment;
  const normalize = (value: string | undefined) => value?.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!resolved || !containment || containment.version !== 1 || typeof containment.root !== "string" ||
      typeof containment.sessionRoot !== "string" || !repositoryRoot ||
      normalize(containment.sessionRoot) !== normalize(repositoryRoot)) return false;
  const root = normalize(containment.root)!;
  const inside = (path: string | undefined) => {
    const value = normalize(path);
    return Boolean(value && (value === root || value.startsWith(`${root}/`)) && !/(?:^|\/)\.\.(?:\/|$)/u.test(value));
  };
  return resolved.every(inside) && (evidence!.cwd === undefined || inside(evidence!.cwd));
}
const sensitiveSubject = /\b(?:auth(?:entication)?|passwords?|secrets?|credentials?|tokens?|api[ _-]?key|oauth|identity|login|account|permission|access)\b/iu;
const planningIntent = /\b(?:implement(?:ation)?|design|approach|schema|library|framework|test|mock|fixture|component|feature|architecture|provider|flow|validation|review|tradeoff|format|should)\b/iu;
// A design form's answer is structurally one offered option, so it can carry no value back. There,
// asking ABOUT credential handling ("copy the API key") is design (#3844); asking FOR a credential,
// an identity, a sign-in or access is not. Everything else keeps the broader screen above.
const designCredentialNoun = String.raw`(?:passwords?|passphrases?|secrets?|credentials?|api[ _-]?keys?|access[ _-]?tokens?|private[ _-]?keys?|cookies?|bearer|e-?mail(?:[ _-]?address(?:es)?)?)`;
const designCredentialRequest = new RegExp([
  // Disclosing a credential or identity to, or collecting one from, whoever answers.
  String.raw`\b(?:paste|enter|provide|supply|reveal|show|print|share|give|tell|send\s+(?:me|us))\b.{0,80}\b${designCredentialNoun}`,
  String.raw`\b(?:${designCredentialNoun}|tokens?)\b.{0,40}\b(?:values?|here|please|to\s+(?:me|us))\b`,
  String.raw`\b(?:${designCredentialNoun}|tokens?)\s+(?:values?\s+)?(?:should|shall|will|can|do|does|may)\s+(?:I|we|you|(?:the|our)\s+(?:app|application|client|provider))\s+(?:use|enter|provide|supply|send|paste|choose|select)\b`,
  // A real identity's credential, rather than credentials as a kind of data.
  String.raw`\b(?:your|my|our|real|production|live|personal)\b.{0,50}\b${designCredentialNoun}`,
  String.raw`\b(?:${designCredentialNoun}|tokens?)\b.{0,40}\b(?:your|my)\b`,
  // Performing a sign-in, as opposed to a sign-in as the subject of the design.
  String.raw`\b(?:sign|log)\s+(?:in|on)\b`, String.raw`\b(?:I|you|we|please)\s+(?:sign[ -]?in|log[ -]?in|authenticate|authorize)\b`,
  String.raw`\b(?:authenticate|authorize)\b.{0,60}\b(?:me|your|my|account|device|browser|now)\b`, String.raw`\b(?:gh|railway|vercel|npm|aws)\s+(?:auth\s+)?login\b`,
  // An option granting access, wider provider permissions or a lasting permission.
  String.raw`\b(?:grant|give|enlarge|increase|broaden|widen|expand|extend|elevate|escalate|disable|bypass|remove|lift|relax)\b.{0,60}\b(?:access|permissions?|scopes?|guardrails?|sandbox|polic(?:y|ies)|limits?|protections?)\b`,
  String.raw`\b(?:wider|broader|more|additional|extra|elevated|admin)\s+(?:provider\s+)?(?:access|permissions?|scopes?)\b`,
  String.raw`\b(?:always|permanently|persistently|indefinitely)\s+(?:allow|approve|trust|grant|permit)\b`, String.raw`\ballow\s+(?:always|permanently)\b`,
  String.raw`\b(?:lasting|persistent|permanent|standing|durable)\s+(?:permissions?|access|grants?|approvals?)\b`, String.raw`\b(?:chmod|chown|sudo)\b`,
  // Values the form carries itself: credential-shaped literals and email addresses.
  String.raw`\b(?:sk-[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{12,})\b`, String.raw`[^\s@]+@[^\s@]+\.[a-z]{2,}`,
].join("|"), "iu");
/** Credential-store paths a design form names, matched only on path-like words so that the subject
 * "credentials" stays discussable while "~/.codex/auth.json" or ".env" does not. */
const designCredentialPath = (text: string) => text.split(/\s+/u).some((word) => {
  const path = word.replace(/[.,;:!?)\]]+$/u, "");
  return /[\\/]|^[.~]/u.test(path) && protectedPath.test(path);
});

/** Exact finite operation selectors shared by the runner's evidence collector and resolver.
 * This parses effects, never authorization; unresolved filesystem targets still fail closed. */
export function campaignCodeOperationTargets(toolName: string | undefined, operation: ApprovalContext["operation"]): { cwd?: string; paths: string[] } | null {
  if (["Read", "Edit", "Write", "MultiEdit", "applyPatch", "fileChange"].includes(toolName ?? "")) {
    return operation?.kind === "file" && typeof operation.path === "string" && operation.path.length <= 1024 ? { paths: [operation.path] } : null;
  }
  if (!["Bash", "commandExecution"].includes(toolName ?? "") || operation?.kind !== "command") return null;
  const command = operation.input;
  if (typeof command !== "string" || !command || command.length > 2000 ||
      (operation.cwd !== undefined && typeof operation.cwd !== "string") || /[\n\r$`;&|<>()[\]{}'"\\*?~#!]/u.test(command)) return null;
  const words = command.trim().split(/\s+/u);
  if (words.length > 32) return null;
  // Git inspection can execute repository-configured helpers (including clean filters even
  // with external diff/textconv disabled). Command flags alone do not prove bounded effects.
  if (words[0] === "cat") return words.length > 1 ? { cwd: operation.cwd, paths: words.slice(1) } : null;
  return null;
}

/** Concrete repository operations need both lexical containment and runner-derived physical
 * targets. No reason, title, child intent, symlink escape or unresolved target is effect proof. */
export function repositoryCodeToolIntent(request: PendingApproval, repositoryRoot?: string): boolean {
  const normalizedRoot = repositoryRoot?.replaceAll("\\", "/").replace(/\/+$/u, "");
  const codePath = (value: string): boolean => {
    const path = value.replaceAll("\\", "/");
    return Boolean(normalizedRoot && path.startsWith(`${normalizedRoot}/`) &&
      !/(?:^|\/)\.\.(?:\/|$)/u.test(path) && !/[\x00-\x20$`;&|<>()[\]{}~*?]/u.test(path) &&
      !/(?:^|\/)(?:\.env[^/]*|\.ssh|\.aws|\.codex|\.claude|credentials|id_rsa|id_ed25519)(?:\/|$)/iu.test(path) &&
      /\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|java|kt|swift|c|cpp|h|cs|rb|md|html|css)$/iu.test(path));
  };
  const operation = request.context?.operation;
  const selectors = campaignCodeOperationTargets(request.context?.toolName, operation);
  const evidence = operation?.filesystem;
  if (!selectors || !evidence || !Array.isArray(evidence.targets) || evidence.targets.length !== selectors.paths.length ||
      (evidence.cwd !== undefined && typeof evidence.cwd !== "string")) return false;
  const atRoot = Boolean(selectors.cwd && normalizedRoot &&
    selectors.cwd.replaceAll("\\", "/").replace(/\/+$/u, "") === normalizedRoot &&
    evidence.cwd?.replaceAll("\\", "/").replace(/\/+$/u, "") === normalizedRoot);
  if (!selectors.paths.length) return atRoot;
  return selectors.paths.every((path, index) => {
    const absolute = path.startsWith("/") || /^[a-z]:[\\/]/iu.test(path);
    const lexical = absolute ? path : atRoot ? `${selectors.cwd}/${path}` : "";
    const target = evidence.targets[index];
    return target?.path === path && typeof target.resolvedPath === "string" && codePath(lexical) && codePath(target.resolvedPath);
  });
}

/** Why a request fails the protected screen. Credential, sign-in and access-expansion classes are
 * declined under Full Control; runner guardrails stay with the Human; the rest are decidable. */
type ProtectedRequestClass = "secrets_and_sign_in" | "provider_access_expansion" | "persistent_permissions" |
  "guardrail" | "escalation" | "unverified_form";

/** Trusted is a caller-side fact derived from the normalized provider bridge or typed route,
 * not a field taken from a child-authored snapshot. Unknown sensitive forms fail closed.
 * Credential text is screened before every other class, so it always wins the classification.
 * `designForm` is equally caller-side: set only where no answer can carry a value back (the
 * typed implementation route, which selects one offered option id, or a root's own question,
 * which is dismissed without applying any answer). */
function protectedRequestClass(request: PendingApproval, verifiedPlanning: boolean, verifiedCodeOperation: boolean, designForm = false): ProtectedRequestClass | null {
  if (request.kind === "authentication") return "secrets_and_sign_in";
  if (request.runnerGuardrail) return "guardrail";
  if (request.kind === "question") {
    if (request.questions?.some((q) => {
      if (q.secret || q.inputFormat === "email") return true;
      const text = [q.id, q.header, q.question, q.context, ...q.options.flatMap((o) => [o.label, o.description])].join(" ");
      if (designForm) return designCredentialRequest.test(text) || designCredentialPath(text) || (sensitiveSubject.test(text) && !planningIntent.test(text));
      return protectedAction.test(text) || credentialIdentity.test(text) || credentialValueChoice.test(text) || (sensitiveSubject.test(text) && (!verifiedPlanning || !planningIntent.test(text)));
    })) return "secrets_and_sign_in";
  } else {
    // Arbitrary tool text cannot attest that reading credentials is implementation work.
    const text = [request.title, request.context?.toolName, request.context?.input, request.context?.path, request.context?.network].join(" ");
    if (!verifiedCodeOperation && (protectedAction.test(text) || credentialIdentity.test(text) || sensitiveSubject.test(text))) return "secrets_and_sign_in";
  }
  // A benign-looking path can still resolve into a credential store, for example through a
  // repository symlink. The runner-resolved targets decide, not the name the command used.
  const operation = request.context?.operation;
  if ((operation?.kind === "file" && protectedPath.test(operation.path)) || (operation?.kind === "command" && protectedPath.test(operation.input)) ||
      operation?.filesystem?.targets?.some((target) => target.credentialStore === true ||
        protectedPath.test(target.path) || protectedPath.test(target.resolvedPath))) return "secrets_and_sign_in";
  // Envelope facts apply to every request kind, so no form can carry access or a grant past them.
  if (request.context?.network || request.context?.providerPermissionExpansion) return "provider_access_expansion";
  if (operation?.kind === "permission_grant") return "persistent_permissions";
  if (request.context?.escalatedBy) return "escalation";
  if (request.kind === "question" && !request.questions?.length) return "unverified_form";
  return null;
}

export function campaignRequestProtected(request: PendingApproval, verifiedPlanning: boolean, verifiedCodeOperation = false): boolean {
  return protectedRequestClass(request, verifiedPlanning, verifiedCodeOperation) !== null;
}

/** Which unproven-effect class a tool approval belongs to. Informational only: each class is
 * decided once by the Orchestrator, and none is evidence of a bounded effect. */
function toolEffectClass(request: PendingApproval): FullControlRequestClass {
  const operation = request.context?.operation;
  if (operation?.kind !== "command") return "unverified_tool_effects";
  const words = operation.input.trim().split(/\s+/u);
  const program = (words[0] === "env" ? words.find((word, index) => index > 0 && !word.includes("=")) : words[0]) ?? "";
  if (/(?:^|\/)git$/u.test(program)) return "git_execution_without_bounded_effect_proof";
  if (operation.cwd === undefined) return "relative_shell_commands_without_verified_cwd";
  return "script_execution_without_bounded_effect_proof";
}

export function resolveCampaignAuthority(input: {
  control?: CampaignControl;
  parentControl: ParentControlMode;
  decisions: ParentControlDecisionPolicy;
  root: boolean;
  supported: boolean;
  request?: PendingApproval;
  snapshot?: WorkflowDecisionResourceSnapshot;
  /** Set only from a trusted bridge envelope, never from question text or snapshot metadata. */
  trustedSource?: CampaignRequestSource | "workflow_route";
  humanRequired?: boolean;
  /** Server-resolved workspace/worktree root, not a resource selector supplied by an agent. */
  repositoryRoot?: string;
}): CampaignAuthorityEvaluation {
  const request = input.request;
  const category = input.snapshot?.category;
  const operation: CampaignAuthorityOperation = category ?? (request?.kind === "question" ? "question" : request?.governancePolicyId ? "policy_ask" : "tool_approval");
  const result = (owner: "human" | "orchestrator", basis: CampaignAuthorityEvaluation["basis"], reason: CampaignAuthorityEvaluation["reason"],
    extra: Pick<CampaignAuthorityEvaluation, "requestClass" | "disposition"> = {}): CampaignAuthorityEvaluation => ({ owner, basis, reason, operation,
    ...(input.control?.mode === "full_control" && validCampaignControl(input.control) ? { boundaryRevision: input.control.boundary.revision } : {}), ...extra });
  // The server answers a declined occurrence itself; owning it never lets the Orchestrator approve it.
  const declined = (requestClass: FullControlRequestClass) => result("orchestrator", "standing_decline", "declined_request", { requestClass, disposition: "decline" });
  if (Boolean(request) === Boolean(input.snapshot)) return result("human", "human_required", "unverified_intent");
  if (category === "automation_creation" || category === "campaign_follow_up_admission") return result("human", "human_required", "protected_request");
  if (!input.supported) return result("human", "human_required", "unsupported_provider");
  // Rules a person marked Human Required, and built-in safety rules, stay theirs in every mode.
  if (input.humanRequired) return result("human", "human_required", "human_required_rule",
    input.control?.mode === "full_control" ? { requestClass: "human_required_rules" } : {});
  // These categories need a separate server-derived bounded issue admission. Custom retains
  // human ownership, and a boundary operation alone cannot make a proposal eligible.
  if ((category === "issue_closure" || category === "campaign_issue_scope") &&
      !(input.control?.mode === "full_control" && validCampaignControl(input.control) && input.control.boundary.issueAuthority &&
        input.snapshot && "issueAdmission" in input.snapshot && input.snapshot.issueAdmission)) return result("human", "human_required", "protected_request");
  if (!input.control || input.control.mode === "custom" || category === "review_round_extension") {
    // Extra review rounds follow the explicit Parent Control grant under Full Control too: they are
    // never part of a boundary's own operations (#3369).
    const eligible = !input.root && (category ? campaignWorkflowOwner(input.control, input.decisions, category, true) === "orchestrator" : Boolean(request && parentControlRequestEligible(input.parentControl, request)));
    return result(eligible ? "orchestrator" : "human", "custom_policy", "custom_owner");
  }
  if (!validCampaignControl(input.control)) return result("human", "human_required", "outside_boundary");
  if (request?.standingAdmissionFailure) return result("human", "human_required", "provider_delivery_unavailable");
  const boundary = input.control.boundary;
  if (category === "follow_up_issue_publication" && boundary.issueAuthority &&
      !(input.snapshot && "issueAdmission" in input.snapshot && input.snapshot.issueAdmission)) return result("human", "human_required", "unverified_intent");
  if (!boundary.operations.includes(operation) || (input.snapshot && "repository" in input.snapshot &&
      input.snapshot.repository.toLowerCase() !== boundary.repository.toLowerCase())) return result("human", "human_required", "outside_boundary");
  if (category) {
    if (input.trustedSource !== "workflow_route") return result("human", "human_required", "unverified_intent");
    if (category === "implementation_question") {
      const snapshot = input.snapshot as Extract<WorkflowDecisionResourceSnapshot, { category: "implementation_question" }>;
      // The route normalizes the snapshot to text and options, and approval selects one option id.
      if (protectedRequestClass({ requestId: "", title: "", options: [], kind: "question", questions: [{ id: "", question: snapshot.question, options: snapshot.options }] }, true, false, true)) return declined("secrets_and_sign_in");
    }
    return result("orchestrator", input.root ? "standing_authorization" : "campaign_delegation", "authorized_operation");
  }
  const generic = request!;
  const question = generic.kind === "question";
  const verifiedCode = input.trustedSource === "provider_tool" && repositoryCodeToolIntent(generic, input.repositoryRoot);
  // A root's own question is dismissed without applying any answer, so it is a design form and a
  // credential-design question becomes `root_questions`, whose notice names the typed route. A
  // child's provider question can be answered with free text, so it keeps the broader screen.
  const designForm = input.root && question && input.trustedSource === "provider_question";
  const screened = protectedRequestClass(generic, input.trustedSource === "provider_question", verifiedCode, designForm);
  if (screened === "secrets_and_sign_in" || screened === "provider_access_expansion" || screened === "persistent_permissions") return declined(screened);
  // Runner guardrails and cost or limit pauses belong to budget and guardrail authority: human-only.
  if (screened === "guardrail" || (generic.kind && !["question", "permission", "policy_hook"].includes(generic.kind))) return result("human", "human_required", "protected_request");
  // Only a one-time allow is ever delivered. A grant offering no such option is never converted.
  if (!question && !generic.options.some((option) => option.kind === "allow_once")) return declined("persistent_permissions");
  // Hook asks are minted by the server's own authenticated hook route, not a provider bridge.
  const provenanceVerified = question ? input.trustedSource === "provider_question"
    : input.trustedSource === "provider_tool" || (generic.kind === "policy_hook" && input.trustedSource === undefined);
  let requestClass: FullControlRequestClass | undefined;
  if (!provenanceVerified) {
    requestClass = input.trustedSource === "provider_elicitation" ? "external_elicitation" : "unverified_tool_effects";
  } else if (screened === "escalation" || screened === "unverified_form") {
    requestClass = "unverified_tool_effects";
  } else if (!question && !repositoryCodeToolIntent(generic, input.repositoryRoot)) {
    requestClass = toolEffectClass(generic);
  } else if (input.root && question) {
    // A root's own question has nobody to answer it: the root is the campaign's only owner and its
    // provider is parked. Applying one of its options would put words in a person's mouth, so the
    // server dismisses it and tells the root to decide with its typed tools.
    requestClass = "root_questions";
  }
  if (generic.governancePolicyId && !boundary.delegatablePolicyIds.includes(generic.governancePolicyId)) requestClass ??= "undelegated_policy_asks";
  const classified = requestClass ? { requestClass } : {};
  // The worktree allowlist: absent evidence is not evidence of absence, and no denylist can name
  // every credential store. No runner isolation mode hides those stores from the child (bwrap binds
  // `/` read-only, Seatbelt allows file reads, provider mode has no sandbox), so an effect is
  // approvable only when every resolved target is inside the session's own worktree. Anything else
  // (outside targets, escaping symlinks, globs, scripts, Git, older evidence) is declined for all.
  if (!question && !campaignContainedOperation(generic, input.repositoryRoot)) {
    return result("orchestrator", "standing_decline", "unresolved_effects", { ...classified, disposition: "decline" });
  }
  // A parked root cannot judge its own request, and text never proves an effect is safe. It allows
  // once only a verified bounded effect outside any undelegated ask rule and declines the rest,
  // including every question of its own, so an unverified root effect can never reach a secret and an
  // ask a person wanted checked is never self-approved. A child's goes to the Orchestrator.
  if (input.root && requestClass) {
    return result("orchestrator", "standing_decline", "authorized_operation", { ...classified, disposition: "decline" });
  }
  return result("orchestrator", input.root ? "standing_authorization" : "campaign_delegation", "authorized_operation", classified);
}

/** What still comes to the Human under Full Control: only asks from governance rules the person
 * marked Human Required, and only while such a rule exists. Every other class is decided by the
 * Orchestrator or declined as blocked work (`FULL_CONTROL_DECLINED_CLASSES`). */
export function fullControlStandingHumanRequired(humanRequiredRules: boolean): FullControlRequestClass[] {
  return humanRequiredRules ? ["human_required_rules"] : [];
}

/** Whether any enabled ask rule is one a person marked Human Required. Built-in safety rules are
 * code-owned and fire only in their own narrow scopes, so they are not counted here. */
export function humanRequiredRulesExist(policies: readonly GovernancePolicy[]): boolean {
  return policies.some((rule) => rule.enabled && rule.effect === "ask" && !rule.builtin && rule.conditions?.humanRequired === true);
}

export const FULL_CONTROL_HUMAN_REQUIRED_LABELS: Record<string, string> = {
  secrets_and_sign_in: "Secrets and Sign-In",
  persistent_permissions: "Persistent Permission Grants",
  provider_access_expansion: "Provider Access Expansion",
  external_elicitation: "External Provider Forms",
  root_questions: "Root Questions",
  unverified_tool_effects: "Tool Effects That Cannot Be Verified",
  git_execution_without_bounded_effect_proof: "Git Commands Without Bounded Effect Proof",
  script_execution_without_bounded_effect_proof: "Scripts Without Bounded Effect Proof",
  human_required_rules: "Human Required Governance Rules",
  undelegated_policy_asks: "Ask Rules Not Named for the Orchestrator",
  relative_shell_commands_without_verified_cwd: "Relative Shell Commands Without a Verified Directory",
};

export const FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON = "Asks from rules you marked Human Required still come to you under Full Control.";

/** Delivered once to a child whose tool request was declined because the runner could not resolve
 * every target it touches. Content-safe: it never repeats the command, path or tool input. */
export const FULL_CONTROL_UNRESOLVED_DECLINE_MESSAGE = "[Wollipog Full Control] A tool request in this session was declined " +
  "because the runner could not resolve every file it would touch to a real path inside this session's worktree (for example " +
  "a file outside the worktree, a symlink leading out of it, a glob, a script, an interpreter with inline code, or a Git " +
  "command), so it could not rule out credential access. Nobody was asked and the request will not be replayed. Retry with " +
  "explicit file paths inside your worktree, such as reading or editing named files, or continue without it.";

/** Delivered to a Full Control root after the server dismisses its own question (#2940). No person
 * sees a root's questions, and none of its options is applied for it. Content-safe: it never
 * repeats the question. */
export const FULL_CONTROL_ROOT_QUESTION_MESSAGE = "[Wollipog Full Control] Your question was dismissed: under Full Control " +
  "no person sees this campaign's questions, and none of its options was chosen for you. You own every Orchestrator-owned " +
  "decision under your standing authorization, so decide it yourself and continue with the typed tools. To approve your own " +
  "pending workflow decision, such as an issue closure or scope change, call resolve_descendant_workflow_decision with your own " +
  "session ID as sessionId, then execute it (for a closure, close_github_issue with the same occurrenceId and resourceDigest). " +
  "A human-owned decision still waits for a person in Wollipog; report it instead of asking.";

/** Shown beside the Human Required list: the classes the Orchestrator cannot supply. */
export const FULL_CONTROL_DECLINED_NOTE = "Requests for credentials, sign-in, wider provider access or a lasting permission grant are declined automatically and shown as blocked work in Campaign Status. You are not asked.";

/** Evidence the Orchestrator cannot inspect directly. Under Full Control it never routes to the
 * Human: the Orchestrator approves only what it inspected, asks for screenshots, or denies. */
export const FULL_CONTROL_EVIDENCE_EXCEPTIONS: ReadonlyArray<{ id: "video_evidence" | "external_evidence"; exception: string; reason: string }> = [
  { id: "video_evidence", exception: "Video Evidence Review", reason: "The Orchestrator can't watch video yet, so it asks for screenshots or denies the claim as unproven." },
  { id: "external_evidence", exception: "External Evidence Review", reason: "The Orchestrator can't open evidence stored outside private Session artifacts (links only), so it asks for screenshots or denies the claim as unproven." },
];

/** When an older runner is why Full Control is unsupported, `requirement` holds the shared runner
 * sentence (also `reason`) and the versions an HTTP 409 returns beside it (#3803). */
export interface CampaignAuthorityPreflight {
  supported: boolean;
  reason?: string;
  requirement?: { error: string } & RunnerCapabilityRequirementDetails;
}

function olderRunner(requirement: { error: string } & RunnerCapabilityRequirementDetails): CampaignAuthorityPreflight {
  return { supported: false, reason: requirement.error, requirement };
}

export function campaignAuthorityPreflight(control: CampaignControl | undefined, driver: string, protocolVersion: number | null | undefined,
  peerContract?: unknown): CampaignAuthorityPreflight {
  if (!control || control.mode === "custom") return { supported: true };
  if (!validCampaignControl(control)) return { supported: false, reason: "Full Control requires a valid human-authorized boundary." };
  if (control.boundary.evidenceAuthority && !supportsPacedVideoReviewPeer(protocolVersion, peerContract)) {
    if (!runnerSupportsProtocol(protocolVersion, "pacedVideoReview")) {
      return olderRunner(runnerCapabilityRequirementError(protocolVersion, "pacedVideoReview", "production evidence authority"));
    }
    return { supported: false,
      reason: "Production evidence authority requires the exact private media contract; compatibility metadata does not establish runtime readiness." };
  }
  if (control.boundary.budgetAuthority && !runnerSupportsProtocol(protocolVersion, "campaignBudgetAdmission")) {
    return olderRunner(runnerCapabilityRequirementError(protocolVersion, "campaignBudgetAdmission", "campaign limits"));
  }
  if ((protocolVersion ?? 0) < (control.boundary.issueAuthority ? 217 : 215) || !["codex-app-server", "claude-code"].includes(driver)) return { supported: false, reason: "This provider path cannot enforce the Full Control authority contract; use Custom or update the runner." };
  return { supported: true };
}
