import { supportsPacedVideoReviewPeer } from "./paced-video-review.js";
import { campaignEvidenceAuthorityBound, type CampaignEvidenceAuthority } from "./campaign-evidence-authority.js";
import { parentControlRequestEligible, runnerCapabilityRequirementError, runnerSupportsProtocol, type RunnerCapabilityRequirementDetails } from "./index.js";
import { validCampaignBudgetAuthority, type CampaignBudgetAuthority } from "./campaign-budget.js";
import { canonicalCampaignIssues } from "./campaign-issue-scope.js";
import { campaignRepositoryLocation, type CampaignIssueRef } from "./campaign-work-ledger.js";
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
    /** The authorized epics in the launch repository. A boundary stored before #4118 holds only
     * these, and they read as that repository's. */
    epics: number[];
    /** The authorized epics in the boundary's other repositories (#4118), canonical and never
     * empty. Read every epic through `campaignBoundaryEpics`. */
    otherEpics?: CampaignIssueRef[];
    relatedFollowUps: boolean;
    maxIssues: number;
    closureReasons: Array<"completed" | "not_planned">;
  };
  budgetAuthority?: CampaignBudgetAuthority;
  /** Narrowed destination/provider disclosure. UI Evidence Approval remains the sole authority. */
  evidenceAuthority?: CampaignEvidenceAuthority;
  /** Every verified repository of the campaign's Project (#4117), one entry per repository, the
   * launch Location's first; the first entry's repository is `repository`. Omitted on boundaries
   * minted before v288 or for a pre-v288 root runner: those read as one entry of `repository`. */
  repositories?: CampaignBoundaryRepository[];
}

/** One boundary repository and its verified Project Locations, by Location id: the Project's
 * default Location first, then the rest in Project order. */
export interface CampaignBoundaryRepository {
  repository: string;
  locationIds: string[];
}

export const CAMPAIGN_BOUNDARY_REPOSITORIES_MAX = 50;
export const CAMPAIGN_BOUNDARY_LOCATIONS_MAX = 100;

/** The boundary's repositories, with a boundary that predates the list read as its one entry. */
export function campaignBoundaryRepositories(boundary: Pick<CampaignAuthorityBoundary, "repository" | "repositories">): CampaignBoundaryRepository[] {
  return boundary.repositories?.map((entry) => ({ repository: entry.repository, locationIds: [...entry.locationIds] }))
    ?? [{ repository: boundary.repository, locationIds: [] }];
}

/** The boundary entry for a repository, compared case-insensitively. */
export function campaignBoundaryRepository(boundary: Pick<CampaignAuthorityBoundary, "repository" | "repositories">,
  repository: string): CampaignBoundaryRepository | null {
  const wanted = repository.toLowerCase();
  return campaignBoundaryRepositories(boundary).find((entry) => entry.repository.toLowerCase() === wanted) ?? null;
}

/** Every epic the boundary authorizes, repository-qualified (#4118), the launch repository's first. */
export function campaignBoundaryEpics(boundary: Pick<CampaignAuthorityBoundary, "repository" | "issueAuthority">): CampaignIssueRef[] {
  const repository = boundary.repository.toLowerCase();
  return [...(boundary.issueAuthority?.epics ?? []).map((number) => ({ repository, number })),
    ...(boundary.issueAuthority?.otherEpics ?? []).map((issue) => ({ ...issue }))];
}

/** A campaign's repository list on its own: one entry per repository, unique Location ids, within
 * bounds. A Full Control boundary also requires its first entry to be the boundary's repository. */
export function validCampaignRepositoryList(value: unknown): value is CampaignBoundaryRepository[] {
  return Array.isArray(value) && value.length > 0 && typeof (value[0] as CampaignBoundaryRepository | null)?.repository === "string" &&
    validBoundaryRepositories(value, (value[0] as CampaignBoundaryRepository).repository);
}

function validBoundaryRepositories(value: unknown, repository: string): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > CAMPAIGN_BOUNDARY_REPOSITORIES_MAX) return false;
  const repositories = new Set<string>();
  const locations = new Set<string>();
  for (const entry of value as CampaignBoundaryRepository[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some((key) => key !== "repository" && key !== "locationIds") ||
        typeof entry.repository !== "string" || campaignRepositoryLocation(entry.repository) === null ||
        !Array.isArray(entry.locationIds)) return false;
    const name = entry.repository.toLowerCase();
    if (repositories.has(name)) return false;
    repositories.add(name);
    for (const id of entry.locationIds) {
      if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f\x7f]/u.test(id) || locations.has(id)) return false;
      locations.add(id);
    }
  }
  return locations.size <= CAMPAIGN_BOUNDARY_LOCATIONS_MAX &&
    (value as CampaignBoundaryRepository[])[0]!.repository.toLowerCase() === repository.toLowerCase();
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
  /** Human approval superseding this exact personal rule within the current campaign. */
  supersededOwnerRule?: { rule: import("./workflow-decision-owner-rule.js").WorkflowDecisionOwnerRule; occurrenceId: string };
  owner: "human" | "orchestrator";
  basis: "human_required" | "custom_policy" | "campaign_delegation" | "standing_authorization" | "standing_decline";
  reason: "custom_owner" | "authorized_operation" | "outside_boundary" | "protected_request" |
    "unverified_intent" | "unsupported_provider" | "human_required_rule" | "evidence_review_unavailable" | "provider_delivery_unavailable" |
    "declined_request" | "unresolved_effects" |
    /** #4062: a Full Control merge that would close an issue outside the campaign's issue scope. */
    "outside_issue_scope" |
    /** #4062: a Full Control merge whose closures nothing reads (a GitLab merge, or a GitHub merge
     * from a runner older than the closing-reference check) and whose declared ones prove nothing. */
    "unverified_closures" |
    /** #4119: a merge in a repository without required checks whose head reports no checks at
     * all. Nothing reported is never green, so it stays the person's in every mode. */
    "no_checks" |
    /** #4058: a Full Control closure of an issue inside the boundary that failed delegated proof.
     * It stays the person's; the closure snapshot's `deliveryGaps` name what a new request needs. */
    "closure_proof_incomplete" |
    /** #4075: a Full Control review_round_extension that would take this pull request's
     * Orchestrator-granted rounds past the server-enforced cap. It stays the person's. */
    "review_extension_cap_reached" |
    /** #4064: the campaign's owner kept this decision: an owner decision, or an occurrence the root
     * handed to the owner (and any later request for the same resource). Only a person resolves it. */
    "owner_kept" |
    /** #4104: the Decision Model failed or was uncertain whether this question asks for a
     * credential, a sign-in or access. Its owner only classifies it: Decline, or Let the
     * Orchestrator Answer. Nobody answers the question itself until then. */
    "credential_screen_review" |
    /** #4104: the Decision Model has not screened this request yet. Nobody may answer it until it does. */
    "credential_screen_pending";
  operation: CampaignAuthorityOperation;
  boundaryRevision?: number;
  /** Full Control only: which formerly human class this occurrence belongs to. Content-safe. */
  requestClass?: FullControlRequestClass;
  /** The server answers this occurrence itself with its one-time reject or dismissal. A
   * declined occurrence can never be approved or answered by anyone acting for the campaign. */
  disposition?: "decline";
  /** A publication the server could not admit (#2940). Under an issue boundary every human-owned
   * publication carries one, including one that names no recommendation (#4065). */
  admissionFailure?: CampaignPublicationAdmissionFailure;
  /** The fixed catalog sentence, or a server-fixed origin_outside_scope reason distinguishing
   * missing/foreign work, removed issues, unproven investigation provenance and older runners.
   * Never request content or a Decision Model's free-text reason. */
  admissionMessage?: string;
  /** With `outside_issue_scope`: each issue the merge would close outside the scope, as sorted `owner/repo#N`. */
  unscopedClosures?: string[];
  /** #4104: the Decision Model screen this evaluation used, content-safe (no reason text). */
  credentialScreen?: CredentialScreenFact;
}

const operations: CampaignAuthorityOperation[] = ["implementation_question", "pr_merge", "merged_branch_deletion",
  "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"];

/** Category-level projection only. A concrete request still needs provenance, resource and
 * sensitive-effect evaluation; this value is never a consumable grant. `fullControlReviewExtensions`
 * says every peer supports capped Full Control extensions (v277); for review_round_extension,
 * "orchestrator" then means within the per-pull-request cap only. */
export function campaignWorkflowOwner(control: CampaignControl | undefined, decisions: ParentControlDecisionPolicy,
  category: WorkflowDecisionCategory, supported: boolean, fullControlReviewExtensions = false): "human" | "orchestrator" {
  // A follow-up past the campaign's approval limit is the Human's in every mode (#2940), and so is a
  // decision its owner kept (#4064). A Location switch widens a session's reach (#4138), and a
  // repository addition widens the campaign's (#4117).
  if (!supported || category === "automation_creation" || category === "campaign_follow_up_admission" ||
      category === "owner_decision" || category === "location_switch" || category === "campaign_repository_addition") return "human";
  if (category === "issue_closure" || category === "campaign_issue_scope") return control?.mode === "full_control" &&
    validCampaignControl(control) && control.boundary.issueAuthority && control.boundary.operations.includes(category) ? "orchestrator" : "human";
  if (!control || control.mode === "custom") return decisions[category];
  // An explicit Parent Control grant delegates extra review rounds without a cap (#3369). Otherwise
  // Full Control owns them only up to the server-enforced cap per pull request (#4075).
  if (category === "review_round_extension") return decisions[category] === "orchestrator" ||
    (fullControlReviewExtensions && validCampaignControl(control)) ? "orchestrator" : "human";
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
    Object.keys(b).every((key) => ["version", "revision", "issueScopeRevision", "repository", "objective", "authorizedByUserId", "authorizedAt", "operations", "delegatablePolicyIds", "issueAuthority", "budgetAuthority", "evidenceAuthority", "repositories"].includes(key)) &&
    (b.issueAuthority === undefined || validIssueAuthority(b.issueAuthority, b)) &&
    (b.repositories === undefined || typeof b.repository === "string" && validBoundaryRepositories(b.repositories, b.repository)) &&
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

/** Another repository's epics: canonical, never empty, and each in a boundary repository other than the launch one. */
function validOtherEpics(value: unknown, boundary: Pick<CampaignAuthorityBoundary, "repository" | "repositories">): boolean {
  const canonical = canonicalCampaignIssues(value);
  if (!canonical?.length || JSON.stringify(canonical) !== JSON.stringify(value) || typeof boundary.repository !== "string") return false;
  const launch = boundary.repository.toLowerCase();
  return canonical.every((issue) => issue.repository !== launch && campaignBoundaryRepository(boundary, issue.repository) !== null);
}

function validIssueAuthority(value: NonNullable<CampaignAuthorityBoundary["issueAuthority"]>,
  boundary: Pick<CampaignAuthorityBoundary, "repository" | "repositories">): boolean {
  return Boolean(value && Object.keys(value).every((key) => ["epics", "otherEpics", "relatedFollowUps", "maxIssues", "closureReasons"].includes(key)) &&
    Array.isArray(value.epics) && value.epics.length <= 100 && new Set(value.epics).size === value.epics.length &&
    value.epics.every((n) => Number.isSafeInteger(n) && n > 0) && (value.otherEpics === undefined || validOtherEpics(value.otherEpics, boundary)) &&
    typeof value.relatedFollowUps === "boolean" &&
    Number.isSafeInteger(value.maxIssues) && value.maxIssues > 0 && value.maxIssues <= 100 &&
    Array.isArray(value.closureReasons) && new Set(value.closureReasons).size === value.closureReasons.length &&
    value.closureReasons.every((reason) => ["completed", "not_planned"].includes(reason)));
}

/** The Decision Model's screen of question or tool text that the deterministic floor left open
 * (#4104): "Does this ask whoever answers to supply, disclose or grant a credential, sign-in or
 * access?" Server-derived only; the control plane sets it on every evaluation and a provider or
 * runner can never supply it.
 * - `ask`: the model (or the owner, classifying a failed screen) found a request; it is declined.
 * - `discusses`: the text only discusses one; the Orchestrator decides it.
 * - `review`: the model failed or was uncertain; one person-owned request asks the owner to classify.
 * - `pending`: no outcome yet; nobody may answer it until the screen settles. */
export type CredentialScreenState = "ask" | "discusses" | "review" | "pending";

/** Content-safe facts about one screen, carried on the evaluation it affected. The model's reason
 * is never copied here; Campaign Status reads it from the audited occurrence. */
export interface CredentialScreenFact {
  state: CredentialScreenState;
  /** The audited Decision occurrence, once one exists. */
  occurrenceId?: string;
  /** The model's verdict: `ask`, `discusses` or `uncertain`. Absent when it failed. */
  verdict?: "ask" | "discusses" | "uncertain";
  failureClass?: import("./index.js").DecisionErrorClass;
  /** The owner classified a failed or uncertain screen themselves. */
  classifiedBy?: "owner";
}

// Credential-shaped literals: the value itself, which no answer may carry anywhere.
const credentialLiteral = /\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{16,}|xox[abposr]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
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

/** Quotes and backticks never hide a literal or a path from the floor. */
const withoutQuoting = (text: string) => text.replace(/[`'"‘’“”]/gu, " ");
/** Credential-store paths, matched on path-like words so that the subject "credentials" stays
 * discussable while `~/.codex/auth.json` or ".env" does not. Every character that cannot be part
 * of a path separates words, so no wrapper ((, [, <, «, *, fullwidth quotes) hides one. */
const namesCredentialPath = (text: string) => text.replace(/[^\p{L}\p{N}._~\/\\-]/gu, " ").split(/\s+/u).some((word) => {
  const path = word.replace(/\.+$/u, "");
  return /[\\/]|^[.~]/u.test(path) && protectedPath.test(path);
});
/** The text floor: a credential-shaped literal or a credential-store path, in any field. It
 * decides without a model, so no paraphrase or model outage can admit one. */
const textFloor = (text: string) => credentialLiteral.test(text) || credentialLiteral.test(withoutQuoting(text)) || namesCredentialPath(text);

/** The text the Decision Model screens for one form: every field of every question, in order. */
export function credentialScreenQuestionText(questions: NonNullable<PendingApproval["questions"]>): string {
  return questions.map((q) => [q.id, q.header, q.question, q.context, ...q.options.flatMap((o) => [o.label, o.description])]
    .filter((part): part is string => typeof part === "string" && part.length > 0).join("\n")).join("\n\n");
}

/** The text the Decision Model screens for one tool request: what it names, never its evidence. */
export function credentialScreenToolText(request: PendingApproval): string {
  return [request.title, request.context?.toolName, request.context?.input, request.context?.path, request.context?.network]
    .filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

/** Why a request fails the deterministic floor. Credential, sign-in and access-expansion classes are
 * declined under Full Control; runner guardrails stay with the Human; the rest are decidable. */
type ProtectedRequestClass = "secrets_and_sign_in" | "provider_access_expansion" | "persistent_permissions" |
  "guardrail" | "escalation" | "unverified_form";

/** The deterministic floor (#4104), the only part of the credential screen that reads text itself:
 * `authentication` requests, `secret` or `email` fields, credential-shaped literals, credential-store
 * paths, network, provider access expansion and permission-grant envelope facts, and runner
 * guardrails. It never calls a model and never depends on one. Whether text that passes it asks
 * for a credential, a sign-in or access is the Decision Model's question, not a word list's. */
function protectedRequestClass(request: PendingApproval, verifiedCodeOperation: boolean): ProtectedRequestClass | null {
  if (request.kind === "authentication") return "secrets_and_sign_in";
  if (request.runnerGuardrail) return "guardrail";
  if (request.kind === "question") {
    if (request.questions?.some((q) => q.secret || q.inputFormat === "email" ||
      textFloor(credentialScreenQuestionText([q])))) return "secrets_and_sign_in";
  } else if (!verifiedCodeOperation && textFloor(credentialScreenToolText(request))) {
    return "secrets_and_sign_in";
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

/** The floor for a typed question form (an implementation question or an owner decision, #4064):
 * the answer selects one offered option id, so only its text can carry a credential. */
export function credentialFormFloor(form: { question: string; options: Array<{ label: string; description?: string }>; material?: string }): boolean {
  return credentialFormFloorRule(form) !== null;
}

/** Content-safe name of the existing floor; never includes request text. */
export function credentialFormFloorRule(form: { question: string; options: Array<{ label: string; description?: string }>; material?: string }): "credential_literal" | "credential_store_path" | null {
  const text = [form.question, ...form.options.flatMap((option) => [option.label, option.description ?? ""]), form.material ?? ""].join("\n");
  if (credentialLiteral.test(text) || credentialLiteral.test(withoutQuoting(text))) return "credential_literal";
  return namesCredentialPath(text) ? "credential_store_path" : null;
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
  /** #4075: for a review_round_extension, whether granting it keeps the pull request's
   * Orchestrator-granted rounds within the server-enforced cap, counted durably by the server.
   * Set only when every peer supports capped Full Control extensions; absent keeps them human. */
  reviewExtensionCap?: "within" | "exceeded";
  /** #4104: the typed route's Decision Model screen of an implementation question, taken once at
   * admission. A generic request carries its own server-derived `credentialScreen` instead. */
  credentialScreen?: CredentialScreenFact;
}): CampaignAuthorityEvaluation {
  const request = input.request;
  const category = input.snapshot?.category;
  const operation: CampaignAuthorityOperation = category ?? (request?.kind === "question" ? "question" : request?.governancePolicyId ? "policy_ask" : "tool_approval");
  const result = (owner: "human" | "orchestrator", basis: CampaignAuthorityEvaluation["basis"], reason: CampaignAuthorityEvaluation["reason"],
    extra: Pick<CampaignAuthorityEvaluation, "requestClass" | "disposition" | "credentialScreen"> = {}): CampaignAuthorityEvaluation => ({ owner, basis, reason, operation,
    ...(input.control?.mode === "full_control" && validCampaignControl(input.control) ? { boundaryRevision: input.control.boundary.revision } : {}), ...extra });
  // The server answers a declined occurrence itself; owning it never lets the Orchestrator approve it.
  const declined = (requestClass: FullControlRequestClass, credentialScreen?: CredentialScreenFact) => result("orchestrator", "standing_decline",
    "declined_request", { requestClass, disposition: "decline", ...(credentialScreen ? { credentialScreen } : {}) });
  if (Boolean(request) === Boolean(input.snapshot)) return result("human", "human_required", "unverified_intent");
  // The owner kept this decision (#4064): no mode, boundary or grant makes it an agent's.
  if (category === "owner_decision") return result("human", "human_required", "owner_kept");
  if (category === "automation_creation" || category === "campaign_follow_up_admission" || category === "location_switch" ||
      category === "campaign_repository_addition") {
    return result("human", "human_required", "protected_request");
  }
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
    // Without that grant, a current Full Control boundary still owns a child's extra rounds within
    // the server-enforced cap of its pull request (#4075). Past the cap they stay the person's.
    if (!eligible && category === "review_round_extension" && input.control?.mode === "full_control" && !input.root &&
        input.reviewExtensionCap !== undefined && validCampaignControl(input.control) && input.trustedSource === "workflow_route" &&
        campaignBoundaryRepository(input.control.boundary, input.snapshot!.repository) !== null) {
      return input.reviewExtensionCap === "within" ? result("orchestrator", "campaign_delegation", "authorized_operation")
        : result("human", "human_required", "review_extension_cap_reached");
    }
    return result(eligible ? "orchestrator" : "human", "custom_policy", "custom_owner");
  }
  if (!validCampaignControl(input.control)) return result("human", "human_required", "outside_boundary");
  if (request?.standingAdmissionFailure) return result("human", "human_required", "provider_delivery_unavailable");
  const boundary = input.control.boundary;
  if (category === "follow_up_issue_publication" && boundary.issueAuthority &&
      !(input.snapshot && "issueAdmission" in input.snapshot && input.snapshot.issueAdmission)) return result("human", "human_required", "unverified_intent");
  // A gate is in the boundary when its repository is one of the boundary's entries (#4119); the
  // server checks the requester's own place and the gate's evidence against that entry.
  if (!boundary.operations.includes(operation) || (input.snapshot && "repository" in input.snapshot &&
      campaignBoundaryRepository(boundary, input.snapshot.repository) === null)) return result("human", "human_required", "outside_boundary");
  if (category) {
    if (input.trustedSource !== "workflow_route") return result("human", "human_required", "unverified_intent");
    if (category === "implementation_question") {
      const snapshot = input.snapshot as Extract<WorkflowDecisionResourceSnapshot, { category: "implementation_question" }>;
      // The route normalizes the snapshot to text and options, and approval selects one option id.
      if (credentialFormFloor(snapshot)) return declined("secrets_and_sign_in");
      // The route screens the question once, at admission (#4104). A re-evaluation of a stored
      // occurrence passes no screen: its admission already settled it, and an occurrence admitted
      // for the owner's classification stays theirs (see `credential_screen_review`).
      const screen = input.credentialScreen;
      // A model verdict is classification evidence, never a deterministic floor (#4542).
      if (screen && screen.state !== "discusses") {
        return result("human", "human_required", "credential_screen_review", { credentialScreen: { ...screen, state: "review" } });
      }
      return result("orchestrator", input.root ? "standing_authorization" : "campaign_delegation", "authorized_operation",
        screen ? { credentialScreen: screen } : {});
    }
    return result("orchestrator", input.root ? "standing_authorization" : "campaign_delegation", "authorized_operation");
  }
  const generic = request!;
  const question = generic.kind === "question";
  const verifiedCode = input.trustedSource === "provider_tool" && repositoryCodeToolIntent(generic, input.repositoryRoot);
  const screened = protectedRequestClass(generic, verifiedCode);
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
  // The Decision Model screens whatever the floor left open and an answer could still act on: every
  // question form, and a child's tool text that is not verified repository code (#4104). A root's
  // unverified effect is declined below whatever it says, so its text needs no screen. No word list
  // stands in for the model: until it answers, nobody may answer the request.
  const screenable = question ? Boolean(generic.questions?.length) : !verifiedCode && !(input.root && requestClass);
  if (screenable) {
    const screen = generic.credentialScreen ?? { state: "pending" as const };
    if (screen.state === "ask") return declined("secrets_and_sign_in", screen);
    if (screen.state === "pending") {
      return result("orchestrator", "campaign_delegation", "credential_screen_pending", { ...classified, credentialScreen: screen });
    }
    if (screen.state === "review") {
      // A parked root's question is dismissed whatever the screen says; only its class depends on
      // the verdict, and a failed screen never names a credential it did not find.
      if (input.root) return result("orchestrator", "standing_decline", "authorized_operation",
        { requestClass: requestClass ?? "root_questions", disposition: "decline", credentialScreen: screen });
      return result("human", "human_required", "credential_screen_review", { ...classified, credentialScreen: screen });
    }
    if (input.root && requestClass) {
      return result("orchestrator", "standing_decline", "authorized_operation", { ...classified, disposition: "decline", credentialScreen: screen });
    }
    return result("orchestrator", input.root ? "standing_authorization" : "campaign_delegation", "authorized_operation",
      { ...classified, credentialScreen: screen });
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

const FULL_CONTROL_ROOT_QUESTION_GUIDANCE = "You own every Orchestrator-owned " +
  "decision under your standing authorization, so decide it yourself and continue with the typed tools. To approve your own " +
  "pending workflow decision, such as an issue closure or scope change, call resolve_descendant_workflow_decision with your own " +
  "session ID as sessionId, then execute it (for a closure, close_github_issue with the same occurrenceId and resourceDigest). " +
  "A human-owned decision still waits for a person in Wollipog; report it instead of asking.";

/** The root guidance with the owner-decision route (#4064) in place of "report it instead of asking". */
const FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_GUIDANCE = FULL_CONTROL_ROOT_QUESTION_GUIDANCE.slice(0,
  FULL_CONTROL_ROOT_QUESTION_GUIDANCE.indexOf("A human-owned decision")) +
  "Decide Orchestrator-owned implementation questions and follow-up acceptance, rejection or deferral yourself. " +
  "Every question to the campaign's owner, whatever the topic, must use request_owner_decision with kind " +
  "\"question\", the question, any suggested options and the background as Markdown: the owner answers in their own words, " +
  "and the answer is delivered back to you. For an exact action the owner kept that has no typed category, use kind " +
  "\"approval\" with explicit options. Either reaches the owner's Inbox without stopping your turn or other work. " +
  "Never end a turn with a blocker needing the owner without a typed request or a recorded handoff with its reason and next action. " +
  "To give the owner one of your pending Orchestrator-owned decisions instead, such as a " +
  "child's pr_merge, call hand_workflow_decision_to_owner; that cannot be undone. Never decide a human-owned decision yourself.";

const FULL_CONTROL_ROOT_QUESTION_NOTICE = "[Wollipog Full Control] Your question was dismissed: under Full Control " +
  "no person sees this campaign's questions, and none of its options was chosen for you. ";

/** Delivered to a Full Control root after the server dismisses its own question (#2940). No person
 * sees a root's questions, and none of its options is applied for it. Content-safe: it never
 * repeats the question. */
export const FULL_CONTROL_ROOT_QUESTION_MESSAGE = FULL_CONTROL_ROOT_QUESTION_NOTICE + FULL_CONTROL_ROOT_QUESTION_GUIDANCE;

/** FULL_CONTROL_ROOT_QUESTION_MESSAGE for a root whose runner and control plane support owner
 * decisions (v281, #4064): it names the typed route for a decision the campaign's owner kept. */
export const FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_MESSAGE = FULL_CONTROL_ROOT_QUESTION_NOTICE + FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_GUIDANCE;

/** Why the server's Full Control policy settled a request itself, as far as it is safe to say
 * (#4063). Each is a policy category, never request content. The credential, sign-in, provider
 * access and lasting-grant classes are deliberately absent: naming them would describe what the
 * request filter withheld, so those declines carry the generic policy sentence instead. */
export type FullControlAutomaticBasis = "root_questions" | "external_elicitation" | "unverified_tool_effects" |
  "git_execution_without_bounded_effect_proof" | "script_execution_without_bounded_effect_proof" |
  "relative_shell_commands_without_verified_cwd" | "undelegated_policy_asks" | "unresolved_effects";

const FULL_CONTROL_AUTOMATIC_BASES: ReadonlySet<string> = new Set<FullControlAutomaticBasis>(["root_questions",
  "external_elicitation", "unverified_tool_effects", "git_execution_without_bounded_effect_proof",
  "script_execution_without_bounded_effect_proof", "relative_shell_commands_without_verified_cwd", "undelegated_policy_asks",
  "unresolved_effects"]);

/** Sent with a dismissal or decline only when the server's Full Control policy made it (#4063). A
 * person's response, or an Orchestrator's own choice among options, never carries it. */
export interface FullControlAutomaticResponse {
  policy: "full_control";
  basis?: FullControlAutomaticBasis;
}

/** The content-safe attribution for one standing decline: the class only when it is safe to name,
 * and the unresolved-effect rule ahead of the class it refines. */
export function fullControlAutomaticResponse(evaluation: Pick<CampaignAuthorityEvaluation, "reason" | "requestClass">): FullControlAutomaticResponse {
  const basis = evaluation.reason === "unresolved_effects" ? "unresolved_effects" : evaluation.requestClass;
  return { policy: "full_control", ...(basis && FULL_CONTROL_AUTOMATIC_BASES.has(basis) ? { basis: basis as FullControlAutomaticBasis } : {}) };
}

/** A received attribution, or undefined when malformed. Never invents one: a runner claims an
 * automatic response only when the server said so, and an unknown basis falls back to none. */
export function parseFullControlAutomaticResponse(value: unknown): FullControlAutomaticResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { policy, basis } = value as { policy?: unknown; basis?: unknown };
  if (policy !== "full_control") return undefined;
  return { policy, ...(typeof basis === "string" && FULL_CONTROL_AUTOMATIC_BASES.has(basis) ? { basis: basis as FullControlAutomaticBasis } : {}) };
}

/** The text an agent receives in the same tool result when the server's Full Control policy
 * dismissed its question or declined its tool call (#4063). It says Wollipog did it, that no
 * person saw it, that nothing was chosen or approved, and what to do instead. Content-safe: it
 * never repeats the request. */
export function fullControlAutomaticResponseText(kind: "question" | "tool", response: FullControlAutomaticResponse): string {
  const basis = response.basis;
  const label = basis === "unresolved_effects" ? undefined : basis && FULL_CONTROL_HUMAN_REQUIRED_LABELS[basis];
  const subject = kind === "question" ? "this question" : "this tool call";
  const verb = kind === "question" ? "dismissed" : "declined";
  const head = `[Wollipog Full Control] Wollipog ${verb} ${subject} automatically under the campaign's Full Control policy` +
    (label ? ` (${label})` : "") + ". No person saw it, ";
  if (kind === "question") {
    // Only a v282 runner receives this attribution, so its root also has the owner-decision tools.
    if (basis === "root_questions") return head + "and none of its options was chosen. " + FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_GUIDANCE;
    return head + "and none of its options was chosen. Do not ask again; continue without it, decide what you can with your " +
      "own tools, and report anything still blocked in your final report.";
  }
  if (basis === "unresolved_effects") {
    return head + "and it was not approved: the runner could not resolve every file it would touch to a real path inside " +
      "this session's worktree. Retry with explicit file paths inside your worktree, such as reading or editing named files, " +
      "or continue without it.";
  }
  return head + "and it was not approved. It will not be replayed. Continue without it, using a bounded alternative inside " +
    "your worktree where one exists, and report anything still blocked in your final report.";
}

/** Shown beside the Human Required list: the classes the Orchestrator cannot supply. */
export const FULL_CONTROL_DECLINED_NOTE = "Requests for credentials, sign-in, wider provider access or a lasting permission grant are declined automatically and shown as blocked work in Campaign Status. You are asked only when the Decision Model can't tell whether a question asks for one, and then only to classify it.";

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
  if (control.boundary.repositories && !runnerSupportsProtocol(protocolVersion, "campaignRepositoryBoundary")) {
    return olderRunner(runnerCapabilityRequirementError(protocolVersion, "campaignRepositoryBoundary", "multi-repository campaign boundaries"));
  }
  if (control.boundary.budgetAuthority && !runnerSupportsProtocol(protocolVersion, "campaignBudgetAdmission")) {
    return olderRunner(runnerCapabilityRequirementError(protocolVersion, "campaignBudgetAdmission", "campaign limits"));
  }
  const authorityFloor = control.boundary.issueAuthority ? "fullControlIssueAuthority" : "fullControlAuthority";
  if (!runnerSupportsProtocol(protocolVersion, authorityFloor) || !["codex-app-server", "claude-code"].includes(driver)) return { supported: false, reason: "This provider path cannot enforce the Full Control authority contract; use Custom or update the runner." };
  return { supported: true };
}
