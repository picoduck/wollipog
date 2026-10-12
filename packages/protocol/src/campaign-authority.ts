import { PACED_VIDEO_REVIEW_MIN_PROTOCOL } from "./paced-video-review.js";
import { campaignEvidenceAuthorityBound, type CampaignEvidenceAuthority } from "./campaign-evidence-authority.js";
import { parentControlRequestEligible } from "./index.js";
import { validCampaignBudgetAuthority, type CampaignBudgetAuthority } from "./campaign-budget.js";
import type { ApprovalContext, ParentControlDecisionPolicy, ParentControlMode, PendingApproval, WorkflowDecisionCategory, WorkflowDecisionResourceSnapshot } from "./index.js";

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
  budgetAuthority?: CampaignBudgetAuthority;
  /** Narrowed destination/provider disclosure. UI Evidence Approval remains the sole authority. */
  evidenceAuthority?: CampaignEvidenceAuthority;
}

export type CampaignControl = { mode: "custom" } | { mode: "full_control"; boundary: CampaignAuthorityBoundary };
export type CampaignRequestSource = "provider_question" | "provider_tool" | "provider_elicitation";
export interface CampaignAuthorityEvaluation {
  owner: "human" | "orchestrator";
  basis: "human_required" | "custom_policy" | "campaign_delegation" | "standing_authorization";
  reason: "custom_owner" | "authorized_operation" | "outside_boundary" | "protected_request" |
    "unverified_intent" | "unsupported_provider" | "human_required_rule" | "evidence_review_unavailable" | "provider_delivery_unavailable";
  operation: CampaignAuthorityOperation;
  boundaryRevision?: number;
}

const operations: CampaignAuthorityOperation[] = ["implementation_question", "pr_merge", "merged_branch_deletion",
  "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"];

/** Category-level projection only. A concrete request still needs provenance, resource and
 * sensitive-effect evaluation; this value is never a consumable grant. */
export function campaignWorkflowOwner(control: CampaignControl | undefined, decisions: ParentControlDecisionPolicy,
  category: WorkflowDecisionCategory, supported: boolean): "human" | "orchestrator" {
  if (!supported || category === "issue_closure" || category === "campaign_issue_scope") return "human";
  if (!control || control.mode === "custom") return decisions[category];
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
    Object.keys(b).every((key) => ["version", "revision", "issueScopeRevision", "repository", "objective", "authorizedByUserId", "authorizedAt", "operations", "delegatablePolicyIds", "budgetAuthority", "evidenceAuthority"].includes(key)) &&
    (b.budgetAuthority === undefined || validCampaignBudgetAuthority(b.budgetAuthority)) &&
    Number.isSafeInteger(b.revision) && b.revision > 0 && bounded(b.repository, 256) && /^[\w.-]+\/[\w.-]+$/u.test(b.repository) &&
    Number.isSafeInteger(b.issueScopeRevision) && b.issueScopeRevision > 0 &&
    bounded(b.objective, 4000) && bounded(b.authorizedByUserId, 256) && Number.isSafeInteger(b.authorizedAt) && b.authorizedAt > 0 &&
    Array.isArray(b.operations) && b.operations.length <= operations.length && new Set(b.operations).size === b.operations.length &&
    b.operations.every((operation) => operations.includes(operation)) &&
    Array.isArray(b.delegatablePolicyIds) && b.delegatablePolicyIds.length <= 100 &&
    new Set(b.delegatablePolicyIds).size === b.delegatablePolicyIds.length && b.delegatablePolicyIds.every((id) => bounded(id, 256)) &&
    (b.evidenceAuthority === undefined || campaignEvidenceAuthorityBound(b.evidenceAuthority, b)));
}

// Screen actual requests to disclose credentials, authenticate, administer identity or change
// access. Mentioning an authentication implementation is deliberately insufficient on its own.
const protectedAction = /(?:\b(?:paste|enter|provide|supply|reveal|show|print|read|retrieve|extract|send|upload|copy|use|share|give|fetch|load|export)\b.{0,80}\b(?:password|passphrases?|secrets?|credentials?|api[ _-]?key|access[ _-]?token|private[ _-]?key|cookie|bearer)\b|\b(?:sign[ -]?in|log[ -]?in|authenticate|authorize)\b.{0,60}\b(?:me|your|my|account|device|browser|now)\b|\b(?:grant|enlarge|increase|broaden|disable|bypass|remove)\b.{0,60}\b(?:access|permission|guardrail|sandbox|policy|limit|protection)\b|\b(?:passwords?|secrets?|credentials?|tokens?|api[ _-]?key)\b.{0,40}\b(?:value|here|please)\b|\b(?:gh|railway|vercel|npm|aws)\s+(?:auth\s+)?login\b|\b(?:chmod|chown|sudo)\b|(?:\.ssh|\.aws|\.env)(?:\/|\b)|\b(?:sk-[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{12,})\b)/iu;
const credentialIdentity = /(?:\b(?:your|my|real|production|existing)\b.{0,50}\b(?:password|passphrases?|secrets?|credentials?|api[ _-]?key|access[ _-]?token|private[ _-]?key)\b|\b(?:passwords?|secrets?|credentials?|tokens?|api[ _-]?key)\b.{0,40}\b(?:your|my|account)\b|\b(?:I|you|we|please)\s+(?:sign[ -]?in|log[ -]?in|authenticate|authorize)\b)/iu;
// Selecting a credential value is not implementation planning. A missing secret marker or a
// trailing "for the implementation" cannot turn a value-selection form into trusted code intent.
const credentialValueChoice = /\b(?:passwords?|passphrases?|secrets?|credentials?|tokens?|api[ _-]?keys?|access[ _-]?tokens?|private[ _-]?keys?|cookies?)\b\s+(?:values?\s+)?(?:should|shall|will|can|do|does|may)\s+(?:I|we|you|(?:the|our)\s+(?:app|application|client|provider))\s+(?:use|enter|provide|supply|send|paste|choose|select)\b/iu;
const sensitiveSubject = /\b(?:auth(?:entication)?|passwords?|secrets?|credentials?|tokens?|api[ _-]?key|oauth|identity|login|account|permission|access)\b/iu;
const planningIntent = /\b(?:implement(?:ation)?|design|approach|schema|library|framework|test|mock|fixture|component|feature|architecture|provider|flow|validation|review|tradeoff|format|should)\b/iu;

/** Exact finite operation selectors shared by the runner's evidence collector and resolver.
 * This parses effects, never authorization; unresolved filesystem targets still fail closed. */
export function campaignCodeOperationTargets(toolName: string | undefined, operation: ApprovalContext["operation"]): { cwd?: string; paths: string[] } | null {
  if (["Read", "Edit", "Write", "MultiEdit", "applyPatch", "fileChange"].includes(toolName ?? "")) {
    return operation?.kind === "file" && typeof operation.path === "string" && operation.path.length <= 1024 ? { paths: [operation.path] } : null;
  }
  if (!["Bash", "commandExecution"].includes(toolName ?? "") || operation?.kind !== "command") return null;
  const command = operation.input;
  if (typeof command !== "string" || !command || command.length > 2000 ||
      (operation.cwd !== undefined && typeof operation.cwd !== "string") || /[\n\r$`;&|<>()[\]{}'"\\]/u.test(command)) return null;
  let words = command.trim().split(/\s+/u);
  if (words.length > 32) return null;
  let cwd = operation.cwd;
  if (words[0] === "git" && words[1] === "-C") {
    cwd = words[2]; words = ["git", ...words.slice(3)];
  }
  if (words[0] === "cat") return words.length > 1 ? { cwd, paths: words.slice(1) } : null;
  if (words[0] === "git" && words[1] === "diff") {
    const args = words.slice(2);
    return args.filter((arg) => arg.startsWith("-")).every((arg) =>
      ["--", "--no-ext-diff", "--cached", "--staged", "--stat", "--name-only"].includes(arg) || /^-U\d+$/u.test(arg))
      ? { cwd, paths: args.filter((arg) => !arg.startsWith("-")) } : null;
  }
  if (words[0] === "git" && words[1] === "status" && words.slice(2).every((arg) => ["--short", "--branch", "--porcelain"].includes(arg))) return { cwd, paths: [] };
  return null;
}

/** Concrete repository operations need both lexical containment and runner-derived physical
 * targets. No reason, title, child intent, symlink escape or unresolved target is effect proof. */
export function repositoryCodeToolIntent(request: PendingApproval, repositoryRoot?: string): boolean {
  const normalizedRoot = repositoryRoot?.replaceAll("\\", "/").replace(/\/+$/u, "");
  const codePath = (value: string): boolean => {
    const path = value.replaceAll("\\", "/");
    return Boolean(normalizedRoot && path.startsWith(`${normalizedRoot}/`) &&
      !/(?:^|\/)\.\.(?:\/|$)/u.test(path) && !/[\x00-\x20$`;&|<>()[\]{}~]/u.test(path) &&
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

/** A parked root provider cannot run another tool to answer itself. Its own recommended choice,
 * or first offered assumption, can be applied from the standing authorization. Free-text forms
 * lacking a bounded suggested answer are explicitly unsupported by this admission path. */
export function standingRootQuestionAnswers(request: PendingApproval): Record<string, string | string[]> | null {
  if (request.kind !== "question" || !request.questions?.length) return null;
  const answers: Record<string, string | string[]> = {};
  for (const question of request.questions) {
    if (!question.options?.length || question.secret || question.inputFormat === "email") return null;
    const recommended = question.options.filter((option) => /\(recommended\)/iu.test(option.label));
    if (recommended.length > 1) return null;
    const ordered = recommended.length ? [...recommended, ...question.options.filter((option) => option !== recommended[0])] : question.options;
    const count = question.multiSelect ? Math.max(1, question.minSelections ?? 1) : 1;
    if (count > ordered.length || (question.maxSelections !== undefined && count > question.maxSelections)) return null;
    const choices = ordered.slice(0, count).map((option) => option.label);
    answers[question.id] = question.multiSelect ? choices : choices[0]!;
  }
  return answers;
}

/** Trusted is a caller-side fact derived from the normalized provider bridge or typed route,
 * not a field taken from a child-authored snapshot. Unknown sensitive forms fail closed. */
export function campaignRequestProtected(request: PendingApproval, verifiedPlanning: boolean, verifiedCodeOperation = false): boolean {
  if (request.kind === "authentication" || request.context?.escalatedBy || request.runnerGuardrail) return true;
  if (request.context?.network || request.context?.providerPermissionExpansion) return true;
  if (request.context?.operation?.kind === "permission_grant") return true;
  if (request.kind === "question") {
    if (!request.questions?.length) return true;
    return request.questions.some((q) => {
      if (q.secret || q.inputFormat === "email") return true;
      const text = [q.id, q.header, q.question, q.context, ...q.options.flatMap((o) => [o.label, o.description])].join(" ");
      return protectedAction.test(text) || credentialIdentity.test(text) || credentialValueChoice.test(text) || (sensitiveSubject.test(text) && (!verifiedPlanning || !planningIntent.test(text)));
    });
  }
  if (verifiedCodeOperation) return false;
  const text = [request.title, request.context?.toolName, request.context?.input, request.context?.path, request.context?.network].join(" ");
  // Arbitrary tool text cannot attest that reading credentials is implementation work.
  return protectedAction.test(text) || credentialIdentity.test(text) || sensitiveSubject.test(text);
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
  const result = (owner: "human" | "orchestrator", basis: CampaignAuthorityEvaluation["basis"], reason: CampaignAuthorityEvaluation["reason"]): CampaignAuthorityEvaluation => ({ owner, basis, reason, operation,
    ...(input.control?.mode === "full_control" && validCampaignControl(input.control) ? { boundaryRevision: input.control.boundary.revision } : {}) });
  if (Boolean(request) === Boolean(input.snapshot)) return result("human", "human_required", "unverified_intent");
  if (!input.supported) return result("human", "human_required", "unsupported_provider");
  if (input.humanRequired) return result("human", "human_required", "human_required_rule");
  // These contracts are intentionally still enforced by their separate human-only routes.
  if (category === "issue_closure" || category === "campaign_issue_scope") return result("human", "human_required", "protected_request");
  if (!input.control || input.control.mode === "custom") {
    const eligible = !input.root && (category ? campaignWorkflowOwner(input.control, input.decisions, category, true) === "orchestrator" : Boolean(request && parentControlRequestEligible(input.parentControl, request)));
    return result(eligible ? "orchestrator" : "human", "custom_policy", "custom_owner");
  }
  if (!validCampaignControl(input.control)) return result("human", "human_required", "outside_boundary");
  if (request?.standingAdmissionFailure) return result("human", "human_required", "provider_delivery_unavailable");
  const boundary = input.control.boundary;
  if (!boundary.operations.includes(operation) || (input.snapshot && "repository" in input.snapshot &&
      input.snapshot.repository.toLowerCase() !== boundary.repository.toLowerCase())) return result("human", "human_required", "outside_boundary");
  if (!input.trustedSource || input.trustedSource === "provider_elicitation") return result("human", "human_required", "unverified_intent");
  if ((category && input.trustedSource !== "workflow_route") ||
      (request?.kind === "question" && input.trustedSource !== "provider_question") ||
      (request && request.kind !== "question" && input.trustedSource !== "provider_tool")) return result("human", "human_required", "unverified_intent");
  if (category === "implementation_question") {
    const snapshot = input.snapshot as Extract<WorkflowDecisionResourceSnapshot, { category: "implementation_question" }>;
    if (campaignRequestProtected({ requestId: "", title: "", options: [], kind: "question", questions: [{ id: "", question: snapshot.question, options: snapshot.options }] }, true)) return result("human", "human_required", "protected_request");
  } else if (request) {
    if (request.kind && !["question", "permission", "policy_hook"].includes(request.kind)) return result("human", "human_required", "protected_request");
    if (campaignRequestProtected(request, input.trustedSource === "provider_question",
        input.trustedSource === "provider_tool" && repositoryCodeToolIntent(request, input.repositoryRoot))) return result("human", "human_required", "protected_request");
    if (request.kind !== "question" && !repositoryCodeToolIntent(request, input.repositoryRoot)) {
      return result("human", "human_required", request.context?.operation ? "outside_boundary" : "unverified_intent");
    }
    if (input.root && request.kind === "question" && !standingRootQuestionAnswers(request)) return result("human", "human_required", "unverified_intent");
    if (request.governancePolicyId && !boundary.delegatablePolicyIds.includes(request.governancePolicyId)) return result("human", "human_required", "human_required_rule");
    if (request.kind !== "question" && !request.options.some((option) => option.kind === "allow_once")) return result("human", "human_required", "protected_request");
  }
  return result("orchestrator", input.root ? "standing_authorization" : "campaign_delegation", "authorized_operation");
}

export function campaignAuthorityPreflight(control: CampaignControl | undefined, driver: string, protocolVersion: number | null | undefined): { supported: boolean; reason?: string; humanRequiredRequests?: string[] } {
  if (!control || control.mode === "custom") return { supported: true };
  if (!validCampaignControl(control)) return { supported: false, reason: "Full Control requires a valid human-authorized boundary." };
  if (control.boundary.evidenceAuthority && (protocolVersion ?? 0) < PACED_VIDEO_REVIEW_MIN_PROTOCOL) return { supported: false, reason: "Production evidence authority requires a protocol-v218 runner; unsupported peers cannot admit protected media work." };
  if (control.boundary.budgetAuthority && (protocolVersion ?? 0) < 217) return { supported: false, reason: "Campaign limits require a protocol-v217 runner; unsupported peers cannot admit protected work." };
  if ((protocolVersion ?? 0) < 215 || !["codex-app-server", "claude-code"].includes(driver)) return { supported: false, reason: "This provider path cannot enforce the Full Control authority contract; use Custom or update the runner." };
  return { supported: true, humanRequiredRequests: ["secrets_and_sign_in", "persistent_permissions", "provider_access_expansion", "external_elicitation", "root_forms_without_suggested_answers", "unverified_tool_effects", "script_execution_without_bounded_effect_proof", "human_required_rules",
    ...(driver === "claude-code" ? ["relative_shell_commands_without_verified_cwd"] : [])] };
}
