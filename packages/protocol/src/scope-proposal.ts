import type { CampaignAuthorityOperation } from "./campaign-authority.js";
import type { AgentQuestion, PendingApproval, WorkflowDecisionResourceSnapshot } from "./index.js";

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
 * model call. Anything else needs the constraint check; until the Decision Model's constraint check
 * ships, and whenever it later fails or is uncertain, the owner gets exactly one approval request
 * for the proposal, presented as an Owner Question. Nothing is ever parsed from the message text.
 */

export type ScopeProposalIssueOrigin = "owner_named" | "orchestrator_chosen";

/** Bounds on what a proposal may carry. */
export const SCOPE_PROPOSAL_LIMITS = {
  issues: 100,
  rationaleChars: 500,
  constraints: 10,
  constraintChars: 200,
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
}

/** What a proposal needs checked beyond the floors. Empty means the no-model fast path. */
export type ScopeProposalCheck = "requested_count" | "chosen_issues" | "constraints" | "withheld_operations" | "proposal_unstructured";

/** Why a proposal is the owner's one approval. `constraint_check_unavailable`: it states checkable
 * constraints and no constraint check is available yet (#4282, slice 1), or a later one failed;
 * `proposal_unstructured`: the Orchestrator's runner predates structured proposals, so nothing about
 * its proposal can be checked. */
export type ScopeProposalOwnerCause = "constraint_check_unavailable" | "proposal_unstructured";

/** The proposal as the server recorded it on the scope request: the Orchestrator's own words beside
 * the floors' facts. Server-derived; it changes who decides, never what is granted. */
export interface CampaignScopeProposal {
  /** The campaign's initial scope: nothing is dispatched until one is admitted. */
  initial: boolean;
  /** Digest of the owner's exact message the owner-named floor checked. */
  messageDigest: string;
  issues: Array<{ number: number; origin: ScopeProposalIssueOrigin; rationale: string; title: string }>;
  requestedCount: number | null;
  constraints: string[];
  withheldOperations: CampaignAuthorityOperation[];
  /** What it needs checked beyond the floors; empty on the fast path. */
  checks: ScopeProposalCheck[];
  /** `admitted`: the floors admitted it with no model call, as an Orchestrator-owned change.
   * `owner`: the owner's one approval, presented as an Owner Question. */
  route: "admitted" | "owner";
  ownerCause?: ScopeProposalOwnerCause;
  /** With `route: "owner"`: the owner's message as the boundary records it, for the question. */
  ownerMessage?: string;
}

/** The initial scope the campaign admitted (#4282), recorded on the first message's scope. */
export interface FullControlInitialScope {
  admittedAt: number;
  /** The scope decision that admitted it. */
  occurrenceId: string;
  requestedCount: number | null;
  constraints: string[];
  withheldOperations: CampaignAuthorityOperation[];
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
}

const OPERATIONS: readonly CampaignAuthorityOperation[] = ["implementation_question", "pr_merge", "merged_branch_deletion",
  "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"];
const CHECKS: readonly ScopeProposalCheck[] = ["requested_count", "chosen_issues", "constraints", "withheld_operations", "proposal_unstructured"];

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
  if (Object.keys(v).some((key) => !["issues", "requestedCount", "constraints", "withheldOperations"].includes(key))) return "proposal has an unknown field";
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
    withheldOperations: [...v.withheldOperations as CampaignAuthorityOperation[]].sort() };
}

/**
 * What a proposal needs checked beyond the deterministic floors (#4282). The fast path — nothing to
 * check — holds only when every issue is one the owner named (the floor proved its number is in the
 * owner's exact message), no constraint is stated, no operation is withheld, and any stated count is
 * exactly the named issues. Everything else is the constraint check's, which fails closed to the
 * owner until it exists.
 */
export function scopeProposalChecks(proposal: Pick<CampaignScopeProposalInput, "issues" | "requestedCount" | "constraints" | "withheldOperations">): ScopeProposalCheck[] {
  const checks: ScopeProposalCheck[] = [];
  const chosen = proposal.issues.some((issue) => issue.origin === "orchestrator_chosen");
  if (chosen) checks.push("chosen_issues");
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
  const keys = ["initial", "messageDigest", "issues", "requestedCount", "constraints", "withheldOperations", "checks", "route", "ownerCause", "ownerMessage"];
  if (Object.keys(v).some((key) => !keys.includes(key))) return false;
  if (typeof v.initial !== "boolean" || typeof v.messageDigest !== "string" || !/^[0-9a-f]{64}$/u.test(v.messageDigest)) return false;
  if (!Array.isArray(v.issues) || v.issues.length > SCOPE_PROPOSAL_LIMITS.issues || v.issues.some((raw) => {
    const issue = raw as Record<string, unknown>;
    return !issue || typeof issue !== "object" || Object.keys(issue).length !== 4 || !Number.isSafeInteger(issue.number) || (issue.number as number) < 1 ||
      (issue.origin !== "owner_named" && issue.origin !== "orchestrator_chosen") || !plainText(issue.rationale, SCOPE_PROPOSAL_LIMITS.rationaleChars) ||
      !plainText(issue.title, SCOPE_PROPOSAL_LIMITS.titleChars);
  })) return false;
  if (v.requestedCount !== null && (!Number.isSafeInteger(v.requestedCount) || (v.requestedCount as number) < 1 || (v.requestedCount as number) > 100)) return false;
  if (!Array.isArray(v.constraints) || v.constraints.length > SCOPE_PROPOSAL_LIMITS.constraints ||
      v.constraints.some((c) => !plainText(c, SCOPE_PROPOSAL_LIMITS.constraintChars))) return false;
  if (!Array.isArray(v.withheldOperations) || v.withheldOperations.some((o) => !OPERATIONS.includes(o as CampaignAuthorityOperation))) return false;
  if (!Array.isArray(v.checks) || v.checks.some((c) => !CHECKS.includes(c as ScopeProposalCheck))) return false;
  if (v.route === "admitted") return v.checks.length === 0 && v.ownerCause === undefined && v.ownerMessage === undefined;
  return v.route === "owner" && (v.ownerCause === "constraint_check_unavailable" || v.ownerCause === "proposal_unstructured") &&
    plainText(v.ownerMessage, SCOPE_PROPOSAL_LIMITS.ownerMessageChars);
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
  constraints: "constraints it read from your message",
  withheld_operations: "operations your message rules out",
  proposal_unstructured: "a proposal the Orchestrator's machine can't structure",
};

const listed = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

const escapeMarkdown = (value: string) => value.replace(/([\\`*_[\]<>#|])/gu, "\\$1");

/** The question's Markdown background: the owner's words, each issue with its origin and rationale,
 * the count, constraints and withheld operations, and why it came to the owner. */
export function scopeProposalMaterial(snapshot: ScopeProposalSnapshot): string {
  const proposal = snapshot.scopeProposal;
  const lines: string[] = [];
  if (proposal.ownerMessage) lines.push("**Your message**", "", `> ${escapeMarkdown(proposal.ownerMessage)}`, "");
  lines.push(proposal.issues.length ? "**Proposed issues**" : "**Proposed issues:** none", "");
  for (const issue of proposal.issues) {
    const origin = issue.origin === "owner_named" ? "you named it" : "the Orchestrator chose it";
    lines.push(`- ${escapeMarkdown(snapshot.repository)}#${issue.number}${issue.title ? ` ${escapeMarkdown(issue.title)}` : ""} (${origin}): ${escapeMarkdown(issue.rationale)}`);
  }
  if (proposal.issues.length) lines.push("");
  lines.push(`**Count you asked for:** ${proposal.requestedCount ?? "none stated"}`, "");
  if (proposal.constraints.length) lines.push("**Constraints it read**", "", ...proposal.constraints.map((c) => `- ${escapeMarkdown(c)}`), "");
  if (proposal.withheldOperations.length) lines.push(`**Withheld operations:** ${proposal.withheldOperations.map((o) => `\`${o}\``).join(", ")}`, "");
  lines.push("**Rationale**", "", escapeMarkdown(snapshot.explanation), "");
  const why = proposal.ownerCause === "proposal_unstructured"
    ? "the Orchestrator's machine can't send a structured proposal, so nothing could check it"
    : `it includes ${listed(proposal.checks.map((check) => CHECK_PHRASES[check])) || "nothing the server could check"}, which no Decision Model has checked`;
  lines.push(`This needs your approval because ${why}. ` +
    "Approving admits exactly these issues. Something Else declines it and sends your words to the Orchestrator.");
  return lines.join("\n");
}

/** The proposal as one agent question: approve, decline, or answer in the owner's own words. */
export function scopeProposalAgentQuestions(snapshot: ScopeProposalSnapshot): AgentQuestion[] {
  return [{
    id: SCOPE_PROPOSAL_ANSWER_ID,
    header: "Scope Proposal",
    question: snapshot.scopeProposal.initial ? "Approve the Orchestrator's proposed initial scope?" : "Approve the Orchestrator's proposed scope addition?",
    context: scopeProposalMaterial(snapshot),
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
  return { ...request, kind: "question", title: "Scope Proposal", async: true, questions: scopeProposalAgentQuestions(snapshot) };
}
