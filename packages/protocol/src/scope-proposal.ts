import type { CampaignAuthorityOperation } from "./campaign-authority.js";
import { campaignRepositoryLocation } from "./campaign-work-ledger.js";
import type { AgentQuestion, DecisionErrorClass, DecisionTypedAnswersView, PendingApproval, WorkflowDecisionResourceSnapshot } from "./index.js";

/**
 * The Orchestrator proposes a Full Control campaign's scope (#4282). The owner's first message
 * reaches the Orchestrator unread by the server; the campaign starts with an empty scope and
 * dispatches nothing until the Orchestrator's initial proposal is admitted. A proposal states, for
 * each issue, whether the owner named it or the Orchestrator chose it, with a rationale, plus the
 * count the owner asked for, the constraints the Orchestrator read and the operations the message
 * withholds. Ranking criteria ("highest priority") are the Orchestrator's call and never checked.
 *
 * The server's deterministic floors run first and refuse naming the issue and condition. A proposal
 * that states nothing checkable beyond issues the owner named is admitted after the floors with no
 * model call. Anything else is the Decision Model's constraint check (`scope_check`, typed questions
 * in one call): it admits, refuses naming the question and issue, or, when it is uncertain or fails,
 * the owner gets exactly one approval request for the proposal, presented as an Owner Question.
 * Nothing is ever parsed from the message text.
 */

/** The operations a Full Control boundary can grant, in Title Case, for every surface that names one. */
export const CAMPAIGN_OPERATION_LABELS: Readonly<Partial<Record<CampaignAuthorityOperation, string>>> = {
  implementation_question: "Implementation Questions",
  pr_merge: "PR Merge",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  ui_evidence_approval: "UI Evidence Approval",
  issue_closure: "Issue Closure",
  campaign_issue_scope: "Issue Scope Changes",
  question: "Questions",
  tool_approval: "Tool Approvals",
  policy_ask: "Policy Asks",
};

export function campaignOperationLabel(operation: CampaignAuthorityOperation): string {
  return CAMPAIGN_OPERATION_LABELS[operation] ?? operation;
}

export type ScopeProposalIssueOrigin = "owner_named" | "orchestrator_chosen";

/** Bounds on what a proposal may carry. */
export const SCOPE_PROPOSAL_LIMITS = {
  issues: 100,
  rationaleChars: 500,
  constraints: 10,
  constraintChars: 200,
  repositoryNames: 10,
  ownerMessageChars: 4000,
  titleChars: 300,
} as const;

/** One issue the Orchestrator proposes, as the Orchestrator sends it. */
export interface CampaignScopeProposalIssueInput {
  repository: string;
  number: number;
  origin: ScopeProposalIssueOrigin;
  /** Why this issue: the owner's words that name it, or why the Orchestrator chose it. */
  rationale: string;
}

/** The structured proposal an Orchestrator sends beside its additions (protocol 308). Its issues
 * are exactly the request's additions. */
export interface CampaignScopeProposalInput {
  issues: CampaignScopeProposalIssueInput[];
  /** The number of issues the owner asked for, or null when the message states none. */
  requestedCount: number | null;
  /** Each checkable constraint the Orchestrator read from the message ("open", "UI only", "skip
   * anything labeled security"). Ranking criteria are not constraints and do not belong here. */
  constraints: string[];
  /** Operations the message withholds ("fix but don't merge" withholds `pr_merge`). */
  withheldOperations: CampaignAuthorityOperation[];
  /** The repositories the owner's message limits the work to, each in the message's own words ("the
   * api repo") (#4117, #4118). The server resolves each against the boundary, and the constraint check
   * judges whether the message really limits the work to them. */
  repositoryNames?: string[];
}

/** What a proposal needs checked beyond the floors. Empty means the no-model fast path.
 * `unreferenced_named_issues`: an issue marked owner-named whose number the message writes only as
 * a bare number, never as an issue reference (`#12`, `owner/repo#12` or the issue's URL), so the
 * floor alone can't tell it from a count or a version. `unproposed_references`: the owner's message
 * references an issue of the campaign repository that the proposal doesn't add as owner-named, so
 * whether the owner asked for it, or only mentioned it as background, needs the check.
 * `later_named_issues`: a later addition marks an issue owner-named. An issue the owner asked for
 * belongs in the initial scope, and an earlier check may have found it only mentioned, so a later
 * one is always checked. `repository_name_unresolved`: a repository the proposal names matches no
 * boundary repository or several, so the whole limit grants nothing and the proposal is the owner's.
 * `repository_limit`: every name matches one, but whether the owner's words limit the work to them,
 * rather than excluding or only mentioning them, needs the check. `repository_mentioned`: the
 * message writes the name of one of several campaign repositories and the proposal states no limit,
 * so whether the owner limited the work and the proposal left that out needs the check. */
export type ScopeProposalCheck = "requested_count" | "chosen_issues" | "unreferenced_named_issues" | "unproposed_references" | "later_named_issues" |
  "constraints" | "withheld_operations" | "proposal_unstructured" | "repository_name_unresolved" | "repository_limit" | "repository_mentioned";

/** Why a proposal is the owner's one approval. `constraint_check_uncertain` and
 * `constraint_check_failed`: the Decision Model's constraint check could not settle it, or failed
 * after the runtime's retries; `constraint_check_unavailable`: no check could run at all (no
 * organization, or inputs too large for one call), and every record before the check shipped;
 * `proposal_unstructured`: the Orchestrator's runner predates structured proposals, so nothing about
 * its proposal can be checked; `repository_name_unresolved`: the repository the owner's message names
 * matches no boundary repository or several (#4118). */
export type ScopeProposalOwnerCause = "constraint_check_uncertain" | "constraint_check_failed" | "constraint_check_unavailable" |
  "proposal_unstructured" | "repository_name_unresolved";

/** The Decision Model's constraint check of a recorded proposal: its audited occurrence and what the
 * server derived from the answers. A refused check records no proposal: the Orchestrator revises. */
export interface CampaignScopeConstraintCheck {
  occurrenceId: string;
  verdict: "admit" | "uncertain" | "failed";
  /** The server's bounded sentence naming the deciding answer, never the model's prose. */
  reason?: string;
}

/** One repository name a proposal states, and the boundary repository it resolved to, if exactly one. */
export interface ScopeProposalRepositoryConstraint { name: string; repository: string | null }

/** The proposal as the server recorded it on the scope request: the Orchestrator's own words beside
 * the floors' facts. Server-derived; it changes who decides, never what is granted. */
export interface CampaignScopeProposal {
  /** The campaign's initial scope: nothing is dispatched until one is admitted. */
  initial: boolean;
  /** Digest of the owner's exact message the owner-named floor checked. */
  messageDigest: string;
  /** `repository` names an issue outside the launch repository (#4118); a launch issue stays implicit,
   * as the snapshot's top-level numbers do. */
  issues: Array<{ repository?: string; number: number; origin: ScopeProposalIssueOrigin; rationale: string; title: string }>;
  /** The repositories the Orchestrator says the owner's message limits the work to, as the server
   * resolved their names (#4117): each `repository` is the one boundary repository `name` matched, or
   * null when it matched none or several. A list with any null limits nothing. Each name is only
   * proven to be written in the message; the `repository_limit` check judges whether the message
   * limits the work to them. Read it with `scopeProposalRepositoryConstraints`. */
  repositoryConstraints?: ScopeProposalRepositoryConstraint[];
  /** Server-proven literal owner-named request in one repository (protocol 348). Never agent input. */
  repositoryLimitVerified?: true;
  /** The one name a record from before the list held (#4118). Read as a one-entry list. */
  repositoryConstraint?: ScopeProposalRepositoryConstraint;
  requestedCount: number | null;
  constraints: string[];
  withheldOperations: CampaignAuthorityOperation[];
  /** What it needs checked beyond the floors; empty on the fast path. */
  checks: ScopeProposalCheck[];
  /** `admitted`: an Orchestrator-owned change, admitted by the floors with no model call, or by the
   * constraint check's admit. `owner`: the owner's one approval, presented as an Owner Question. */
  route: "admitted" | "owner";
  ownerCause?: ScopeProposalOwnerCause;
  /** With `route: "owner"`: the owner's message as the boundary records it, for the question. */
  ownerMessage?: string;
  /** The constraint check that admitted it or sent it to the owner; absent when none ran. */
  constraintCheck?: CampaignScopeConstraintCheck;
}

/** The initial scope the campaign admitted (#4282), recorded on the first message's scope. */
export interface FullControlInitialScope {
  admittedAt: number;
  /** The scope decision that admitted it. */
  occurrenceId: string;
  requestedCount: number | null;
  constraints: string[];
  withheldOperations: CampaignAuthorityOperation[];
  /** The repositories its proposal was limited to (#4117): a later addition stays inside them, and
   * only an approved `campaign_repository_addition` adds one. Read it with `initialScopeRepositoryLimits`. */
  repositoryLimits?: string[];
  /** The one repository a record from before the list held (#4118). Read as a one-entry list. */
  repositoryLimit?: string;
}

/** A proposal's repository names as a list, a record from before the list reading as one entry. */
export function scopeProposalRepositoryConstraints(proposal: Pick<CampaignScopeProposal, "repositoryConstraints" | "repositoryConstraint"> | null | undefined): ScopeProposalRepositoryConstraint[] {
  return proposal?.repositoryConstraints ?? (proposal?.repositoryConstraint ? [proposal.repositoryConstraint] : []);
}

/** The repositories a proposal limits the work to, or none. A list with a name that resolved to
 * nothing limits nothing: a partly resolved list never applies in part. */
export function scopeProposalRepositoryLimits(proposal: Pick<CampaignScopeProposal, "repositoryConstraints" | "repositoryConstraint"> | null | undefined): string[] {
  const named = scopeProposalRepositoryConstraints(proposal);
  return named.every((item) => item.repository !== null) ? [...new Set(named.map((item) => item.repository!))] : [];
}

/** The repositories an admitted initial scope is limited to, or none when it has no limit. */
export function initialScopeRepositoryLimits(initial: Pick<FullControlInitialScope, "repositoryLimits" | "repositoryLimit"> | null | undefined): string[] {
  return initial?.repositoryLimits ?? (initial?.repositoryLimit ? [initial.repositoryLimit] : []);
}

/** One proposal for Campaign Status's Scope Proposal section. */
export interface CampaignScopeProposalView {
  occurrenceId: string;
  createdAt: number;
  /** The Orchestrator's overall rationale, as it proposed it. */
  explanation: string;
  proposal: CampaignScopeProposal;
  /** `admitted` while the Orchestrator-owned change waits to be applied, `applied` once it is in
   * scope; `waiting_for_owner`, then `owner_approved` or `owner_declined`; `replaced` when a later
   * request superseded it, or it was revoked or withdrawn before it was applied. */
  outcome: "admitted" | "applied" | "waiting_for_owner" | "owner_approved" | "owner_declined" | "replaced";
  /** The constraint check's audited answers, read from its occurrence, for the checklist. */
  check?: CampaignScopeCheckView;
}

/** One constraint check as Campaign Status shows it: the occurrence's state, the server's verdict and
 * reason, a failure's class, and each typed question with its answer and confidence. */
export interface CampaignScopeCheckView {
  occurrenceId: string;
  state: "pending" | "decided" | "uncertain" | "failed";
  verdict?: string;
  reason?: string;
  failureClass?: DecisionErrorClass;
  typedAnswers?: DecisionTypedAnswersView;
}

const OPERATIONS: readonly CampaignAuthorityOperation[] = ["implementation_question", "pr_merge", "merged_branch_deletion",
  "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"];
const CHECKS: readonly ScopeProposalCheck[] = ["requested_count", "chosen_issues", "unreferenced_named_issues", "unproposed_references",
  "later_named_issues", "constraints", "withheld_operations", "proposal_unstructured", "repository_name_unresolved", "repository_limit", "repository_mentioned"];
const OWNER_CAUSES: readonly ScopeProposalOwnerCause[] = ["constraint_check_uncertain", "constraint_check_failed", "constraint_check_unavailable",
  "proposal_unstructured", "repository_name_unresolved"];

const plainText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Normalize an Orchestrator's proposal against its additions: every addition exactly once, each
 * with an origin and a rationale; bounded text; known operations. Returns an error sentence when it
 * is malformed. Normalization only trims and collapses whitespace; it never reads meaning. */
export function normalizeScopeProposalInput(value: unknown, additions: ReadonlyArray<{ repository: string; number: number }>):
    CampaignScopeProposalInput | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "proposal must be an object";
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["issues", "requestedCount", "constraints", "withheldOperations", "repositoryNames", "repositoryName"].includes(key))) return "proposal has an unknown field";
  // A v318 or v319 runner sends the one name it can hold, which reads as a one-entry list.
  if (v.repositoryName !== undefined && v.repositoryNames !== undefined) return "proposal must send repositoryNames, not also repositoryName";
  const names = v.repositoryName !== undefined ? [v.repositoryName] : v.repositoryNames;
  if (names !== undefined && (!Array.isArray(names) || !names.length || names.length > SCOPE_PROPOSAL_LIMITS.repositoryNames ||
      names.some((name) => !plainText(name, SCOPE_PROPOSAL_LIMITS.constraintChars) || !oneLine(name)))) {
    return "proposal.repositoryNames must list 1 to 10 non-empty names of at most 200 characters";
  }
  if (!Array.isArray(v.issues) || v.issues.length > SCOPE_PROPOSAL_LIMITS.issues) return "proposal.issues must list at most 100 issues";
  const issues: CampaignScopeProposalIssueInput[] = [];
  for (const raw of v.issues as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "each proposal issue must be an object";
    const issue = raw as Record<string, unknown>;
    if (Object.keys(issue).some((key) => !["repository", "number", "origin", "rationale"].includes(key))) return "a proposal issue has an unknown field";
    if (typeof issue.repository !== "string" || !Number.isSafeInteger(issue.number) || (issue.number as number) < 1) return "each proposal issue needs a repository and a positive number";
    if (issue.origin !== "owner_named" && issue.origin !== "orchestrator_chosen") return "each proposal issue's origin must be owner_named or orchestrator_chosen";
    if (!plainText(issue.rationale, SCOPE_PROPOSAL_LIMITS.rationaleChars) || !oneLine(issue.rationale)) return "each proposal issue needs a rationale of at most 500 characters";
    issues.push({ repository: issue.repository.toLowerCase(), number: issue.number as number, origin: issue.origin, rationale: oneLine(issue.rationale) });
  }
  const key = (r: { repository: string; number: number }) => `${r.repository.toLowerCase()}#${r.number}`;
  const proposed = issues.map(key);
  const added = additions.map(key);
  if (new Set(proposed).size !== proposed.length || proposed.length !== added.length || proposed.some((k) => !added.includes(k))) {
    return "proposal.issues must list exactly the additions, each once";
  }
  const count = v.requestedCount;
  if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 100)) return "proposal.requestedCount must be null or 1 to 100";
  if (!Array.isArray(v.constraints) || v.constraints.length > SCOPE_PROPOSAL_LIMITS.constraints ||
      v.constraints.some((c) => !plainText(c, SCOPE_PROPOSAL_LIMITS.constraintChars) || !oneLine(c as string))) {
    return "proposal.constraints must list at most 10 non-empty constraints of at most 200 characters";
  }
  if (!Array.isArray(v.withheldOperations) || v.withheldOperations.some((o) => !OPERATIONS.includes(o as CampaignAuthorityOperation)) ||
      new Set(v.withheldOperations).size !== v.withheldOperations.length) return "proposal.withheldOperations must list distinct known operations";
  return { issues, requestedCount: count as number | null, constraints: (v.constraints as string[]).map(oneLine),
    withheldOperations: [...v.withheldOperations as CampaignAuthorityOperation[]].sort(),
    ...(names === undefined ? {} : { repositoryNames: [...new Set((names as string[]).map(oneLine))] }) };
}

/**
 * What a proposal needs checked beyond the deterministic floors (#4282). The fast path — nothing to
 * check — holds only when every issue is one the owner named and the owner's exact message writes as
 * an issue reference (`referencedIssues`: `#n` for the launch repository, `owner/repo#n` or the issue's
 * URL for any boundary repository), no constraint is stated, no operation is withheld, and any stated
 * count is exactly the named issues. A reference the message writes but the proposal doesn't add as
 * owner-named also needs the check: the owner may have asked for it, or only mentioned it as
 * background. The reference list only narrows: a number it misses goes to the check, never past it.
 * Everything else is the Decision Model's constraint check.
 */
export function scopeProposalChecks(proposal: Pick<CampaignScopeProposalInput, "issues" | "requestedCount" | "constraints" | "withheldOperations">,
    referencedIssues: ReadonlyArray<{ repository: string; number: number }>): ScopeProposalCheck[] {
  const checks: ScopeProposalCheck[] = [];
  const chosen = proposal.issues.some((issue) => issue.origin === "orchestrator_chosen");
  const same = (a: { repository: string; number: number }, b: { repository: string; number: number }) =>
    a.number === b.number && a.repository.toLowerCase() === b.repository.toLowerCase();
  if (chosen) checks.push("chosen_issues");
  if (proposal.issues.some((issue) => issue.origin === "owner_named" && !referencedIssues.some((ref) => same(ref, issue)))) checks.push("unreferenced_named_issues");
  if (referencedIssues.some((ref) => !proposal.issues.some((issue) => issue.origin === "owner_named" && same(ref, issue)))) checks.push("unproposed_references");
  if (proposal.requestedCount !== null && (chosen || proposal.requestedCount !== proposal.issues.length)) checks.push("requested_count");
  if (proposal.constraints.length) checks.push("constraints");
  if (proposal.withheldOperations.length) checks.push("withheld_operations");
  return checks;
}

/** The exact shape of a recorded proposal: server-derived, bounded, and with nothing outside it. */
export function validScopeProposal(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ["initial", "messageDigest", "issues", "requestedCount", "constraints", "withheldOperations", "checks", "route", "ownerCause", "ownerMessage",
    "constraintCheck", "repositoryConstraint", "repositoryConstraints", "repositoryLimitVerified"];
  if (Object.keys(v).some((key) => !keys.includes(key))) return false;
  if (typeof v.initial !== "boolean" || typeof v.messageDigest !== "string" || !/^[0-9a-f]{64}$/u.test(v.messageDigest)) return false;
  if (!Array.isArray(v.issues) || v.issues.length > SCOPE_PROPOSAL_LIMITS.issues || v.issues.some((raw) => {
    const issue = raw as Record<string, unknown>;
    return !issue || typeof issue !== "object" || Object.keys(issue).some((key) => !["repository", "number", "origin", "rationale", "title"].includes(key)) ||
      (issue.repository !== undefined && (typeof issue.repository !== "string" || !campaignRepositoryLocation(issue.repository))) ||
      !Number.isSafeInteger(issue.number) || (issue.number as number) < 1 ||
      (issue.origin !== "owner_named" && issue.origin !== "orchestrator_chosen") || !plainText(issue.rationale, SCOPE_PROPOSAL_LIMITS.rationaleChars) ||
      !plainText(issue.title, SCOPE_PROPOSAL_LIMITS.titleChars);
  })) return false;
  if (v.repositoryConstraint !== undefined && v.repositoryConstraints !== undefined) return false;
  const list = v.repositoryConstraints !== undefined ? v.repositoryConstraints : v.repositoryConstraint !== undefined ? [v.repositoryConstraint] : [];
  if (!Array.isArray(list) || list.length > SCOPE_PROPOSAL_LIMITS.repositoryNames || (v.repositoryConstraints !== undefined && !list.length) || list.some((raw) => {
    const named = raw as Record<string, unknown>;
    return !named || typeof named !== "object" || Array.isArray(named) || Object.keys(named).some((key) => key !== "name" && key !== "repository") ||
      !plainText(named.name, SCOPE_PROPOSAL_LIMITS.constraintChars) || !named.name ||
      (named.repository !== null && (typeof named.repository !== "string" || !campaignRepositoryLocation(named.repository)));
  })) return false;
  const unresolved = list.some((named) => (named as { repository: unknown }).repository === null);
  // A name that resolved to nothing grants nothing, for the whole list: it is always the owner's.
  if (unresolved !== (Array.isArray(v.checks) && v.checks.includes("repository_name_unresolved"))) return false;
  // An agent's claim still needs the check. Only the server's literal owner-named proof may omit it.
  if (v.repositoryLimitVerified !== undefined && (v.repositoryLimitVerified !== true || !v.initial || unresolved || list.length !== 1 ||
      v.issues.some((raw) => (raw as { origin: string }).origin !== "owner_named"))) return false;
  if ((list.length > 0 && !unresolved && !v.repositoryLimitVerified) !== (Array.isArray(v.checks) && v.checks.includes("repository_limit"))) return false;
  if (v.requestedCount !== null && (!Number.isSafeInteger(v.requestedCount) || (v.requestedCount as number) < 1 || (v.requestedCount as number) > 100)) return false;
  if (!Array.isArray(v.constraints) || v.constraints.length > SCOPE_PROPOSAL_LIMITS.constraints ||
      v.constraints.some((c) => !plainText(c, SCOPE_PROPOSAL_LIMITS.constraintChars))) return false;
  if (!Array.isArray(v.withheldOperations) || v.withheldOperations.some((o) => !OPERATIONS.includes(o as CampaignAuthorityOperation))) return false;
  if (!Array.isArray(v.checks) || v.checks.some((c) => !CHECKS.includes(c as ScopeProposalCheck))) return false;
  const check = v.constraintCheck as Record<string, unknown> | undefined;
  if (check !== undefined && (!check || typeof check !== "object" || Array.isArray(check) ||
      Object.keys(check).some((key) => !["occurrenceId", "verdict", "reason"].includes(key)) ||
      typeof check.occurrenceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(check.occurrenceId) ||
      !["admit", "uncertain", "failed"].includes(check.verdict as string) ||
      (check.reason !== undefined && !plainText(check.reason, 300)))) return false;
  // Only a constraint check's admit admits a proposal that states anything checkable.
  if (v.route === "admitted") {
    return v.ownerCause === undefined && v.ownerMessage === undefined && !v.checks.includes("repository_name_unresolved") &&
      (v.checks.length === 0 ? check === undefined : check?.verdict === "admit");
  }
  if (v.route !== "owner" || !OWNER_CAUSES.includes(v.ownerCause as ScopeProposalOwnerCause) ||
      !plainText(v.ownerMessage, SCOPE_PROPOSAL_LIMITS.ownerMessageChars)) return false;
  // A check names its outcome exactly when the owner route is that check's.
  if (v.ownerCause === "constraint_check_uncertain") return check?.verdict === "uncertain";
  if (v.ownerCause === "constraint_check_failed") return check?.verdict === "failed";
  return check === undefined;
}

/* ------------------------- The owner's one approval, as an Owner Question ------------------------- */

/** The answer field of a scope proposal's Owner Question. */
export const SCOPE_PROPOSAL_ANSWER_ID = "scope_proposal_answer";
export const SCOPE_PROPOSAL_APPROVE_LABEL = "Approve Scope";
export const SCOPE_PROPOSAL_DECLINE_LABEL = "Decline Scope";
export const SCOPE_PROPOSAL_ANSWER_MAX_LENGTH = 4000;

type ScopeProposalSnapshot = Extract<WorkflowDecisionResourceSnapshot, { category: "campaign_issue_scope" }> & { scopeProposal: CampaignScopeProposal };

/** The scope request a pending card carries when it is the owner's one approval of an Orchestrator's
 * proposal. Only a person-owned `campaign_issue_scope` card whose proposal took the owner route. */
export function scopeProposalOfRequest(request: Pick<PendingApproval, "kind" | "workflowDecision"> | null | undefined): ScopeProposalSnapshot | null {
  if (request?.kind !== "workflow_decision" || request.workflowDecision?.authority !== "human") return null;
  const snapshot = request.workflowDecision.resourceSnapshot;
  return snapshot?.category === "campaign_issue_scope" && snapshot.scopeProposal?.route === "owner" ? snapshot as ScopeProposalSnapshot : null;
}

const CHECK_PHRASES: Record<ScopeProposalCheck, string> = {
  chosen_issues: "issues the Orchestrator chose",
  requested_count: "a count you asked for",
  unreferenced_named_issues: "issues it says you named that your message writes only as plain numbers",
  unproposed_references: "issues your message mentions that it doesn't propose as ones you named",
  later_named_issues: "issues it says you named but proposes only now",
  constraints: "constraints it read from your message",
  withheld_operations: "operations your message rules out",
  proposal_unstructured: "a proposal the Orchestrator's machine can't structure",
  repository_name_unresolved: "a repository name that matches no repository in this campaign, or more than one",
  repository_limit: "repositories it read your message as limiting the work to",
  repository_mentioned: "a repository your message names, with no limit stated",
};

const listed = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

const escapeMarkdown = (value: string) => value.replace(/([\\`*_[\]<>#|])/gu, "\\$1");

/** The question's Markdown background: the owner's words, each issue with its origin and rationale,
 * the count, constraints and withheld operations, and why it came to the owner. */
export function scopeProposalMaterial(snapshot: ScopeProposalSnapshot, maxIssuesIncrease?: PendingApproval["scopeMaxIssuesIncrease"]): string {
  const proposal = snapshot.scopeProposal;
  const lines: string[] = [];
  if (proposal.ownerMessage) lines.push("**Your message**", "", `> ${escapeMarkdown(proposal.ownerMessage)}`, "");
  lines.push(proposal.issues.length ? "**Proposed issues**" : "**Proposed issues:** none", "");
  for (const issue of proposal.issues) {
    const origin = issue.origin === "owner_named" ? "you named it" : "the Orchestrator chose it";
    lines.push(`- ${escapeMarkdown(issue.repository ?? snapshot.repository)}#${issue.number}${issue.title ? ` ${escapeMarkdown(issue.title)}` : ""} (${origin}): ${escapeMarkdown(issue.rationale)}`);
  }
  if (proposal.issues.length) lines.push("");
  lines.push(`**Count you asked for:** ${proposal.requestedCount ?? "none stated"}`, "");
  for (const named of scopeProposalRepositoryConstraints(proposal)) {
    lines.push(`**Repository you named:** ${escapeMarkdown(named.name)}${named.repository
      ? ` (${escapeMarkdown(named.repository)})` : " (matches no repository in this campaign, or more than one)"}`, "");
  }
  if (proposal.constraints.length) lines.push("**Constraints it read**", "", ...proposal.constraints.map((c) => `- ${escapeMarkdown(c)}`), "");
  if (proposal.withheldOperations.length) lines.push(`**Withheld operations:** ${proposal.withheldOperations.map(campaignOperationLabel).join(", ")}`, "");
  const raisedTo = maxIssuesIncrease ? maxIssuesIncrease.from + maxIssuesIncrease.increase : null;
  if (maxIssuesIncrease) lines.push(`**Maximum Issues:** ${maxIssuesIncrease.from} to ${raisedTo}`, "");
  lines.push("**Rationale**", "", escapeMarkdown(snapshot.explanation), "");
  const includes = listed(proposal.checks.map((check) => CHECK_PHRASES[check])) || "nothing the server could check";
  const reason = proposal.constraintCheck?.reason ? ` (${escapeMarkdown(proposal.constraintCheck.reason.replace(/\.$/u, ""))})` : "";
  const why = proposal.ownerCause === "proposal_unstructured"
    ? "the Orchestrator's machine can't send a structured proposal, so nothing could check it"
    : proposal.ownerCause === "repository_name_unresolved"
      ? "a repository your message names matches no repository in this campaign, or more than one, so no repository limit applies"
    : proposal.ownerCause === "constraint_check_uncertain"
      ? `it includes ${includes}, and the Decision Model couldn't confirm them${reason}`
      : proposal.ownerCause === "constraint_check_failed"
        ? `it includes ${includes}, and the Decision Model's check failed`
        : `it includes ${includes}, which no Decision Model has checked`;
  const limits = scopeProposalRepositoryLimits(proposal);
  lines.push(`This needs your approval because ${why}. ` +
    `Approving admits exactly these issues${maxIssuesIncrease ? ` and raises Maximum Issues from ${maxIssuesIncrease.from} to ${raisedTo}` : ""}${limits.length && proposal.initial
      ? ` and limits the campaign to ${listed(limits.map(escapeMarkdown))}; another repository can come back only if you approve adding it` : ""}. ` +
    "Something Else declines it and sends your words to the Orchestrator.");
  return lines.join("\n");
}

/** The proposal as one agent question: approve, decline, or answer in the owner's own words. */
export function scopeProposalAgentQuestions(snapshot: ScopeProposalSnapshot, maxIssuesIncrease?: PendingApproval["scopeMaxIssuesIncrease"]): AgentQuestion[] {
  return [{
    id: SCOPE_PROPOSAL_ANSWER_ID,
    header: "Scope Proposal",
    question: snapshot.scopeProposal.initial ? "Approve the Orchestrator's proposed initial scope?" : "Approve the Orchestrator's proposed scope addition?",
    context: scopeProposalMaterial(snapshot, maxIssuesIncrease),
    options: [
      { label: SCOPE_PROPOSAL_APPROVE_LABEL, description: "Admit exactly the proposed issues." },
      { label: SCOPE_PROPOSAL_DECLINE_LABEL, description: "Admit nothing; the Orchestrator revises its proposal." },
    ],
    allowOther: true,
    maxLength: SCOPE_PROPOSAL_ANSWER_MAX_LENGTH,
  }];
}

/** The owner's answer: approve, decline, or decline with their own words for the Orchestrator. */
export function scopeProposalAnswer(answers: Record<string, string | string[]>): { approve: boolean; text?: string } | null {
  const answer = Object.hasOwn(answers, SCOPE_PROPOSAL_ANSWER_ID) ? answers[SCOPE_PROPOSAL_ANSWER_ID] : undefined;
  if (typeof answer !== "string" || !answer.trim()) return null;
  if (answer === SCOPE_PROPOSAL_APPROVE_LABEL) return { approve: true };
  if (answer === SCOPE_PROPOSAL_DECLINE_LABEL) return { approve: false };
  return { approve: false, text: answer };
}

/** A pending scope-proposal card as clients present it: an Owner Question (`kind: "question"`,
 * `async`), keeping its occurrence and workflow decision. Anything else is returned unchanged. */
export function presentScopeProposalRequest(request: PendingApproval): PendingApproval {
  const snapshot = scopeProposalOfRequest(request);
  if (!snapshot) return request;
  return { ...request, kind: "question", title: "Scope Proposal", async: true, questions: scopeProposalAgentQuestions(snapshot, request.scopeMaxIssuesIncrease) };
}
