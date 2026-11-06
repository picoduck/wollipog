import { createHash } from "node:crypto";
import { CAMPAIGN_ISSUE_FACT_LIMITS, DECISION_QUESTION_PARAMETER_MAX_CHARS, type CampaignAuthorityOperation, type CampaignIssueFacts,
  type CampaignScopeCheckView, type CampaignScopeProposal, type FullControlInitialScope, SCOPE_GRANT_DEFAULT_SELECTION_COUNT } from "@wollipog/protocol";
import type { DecisionOccurrenceRecord } from "./db.js";
import { DECISION_KINDS, DecisionInputError, decisionRequestDigest, prepareDecision, type DecisionInputs } from "./decision-kinds.js";

/**
 * The Decision Model's constraint check of an Orchestrator's scope proposal (#4282): what it reads,
 * how a repeated proposal joins its occurrence, and how Campaign Status reads the outcome.
 *
 * The owner's exact message is the only instruction-like text; the proposal, every issue fact and
 * the campaign's admitted bounds are quoted, untrusted data. The questions are the `scope_check`
 * kind's own (`SCOPE_CHECK_TYPED`), parameterized per owner-named issue and per chosen issue and
 * stated constraint, and none asks about priority.
 */

/** Room the issue facts may take in one Decision input. Each body excerpt starts at its share of
 * this and shrinks until the rendered input, questions and markup escaping included, fits. */
const ISSUE_FACTS_BUDGET_CHARS = 24_000;

/** What the check reads about the campaign besides the proposal. */
export interface ScopeCheckCampaign {
  repository: string;
  /** The operations the boundary grants now. */
  operations: readonly CampaignAuthorityOperation[];
  /** Issues already in scope. */
  inScope: readonly number[];
  /** The admitted initial scope, for a later addition. */
  admitted?: FullControlInitialScope;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const oneLine = (value: string) => value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();

/** `owner/repo#12 Title`, bounded so a suffix still fits the question parameter. */
function issueLabel(repository: string, number: number, title: string, room: number): string {
  const head = `${repository}#${number}`;
  const rest = oneLine(title);
  if (!rest) return head.slice(0, room);
  const full = `${head} ${rest}`;
  return full.length <= room ? full : `${full.slice(0, Math.max(head.length, room - 1))}…`;
}

/** The question parameters: one per owner-named issue, one per chosen issue and stated constraint.
 * Every parameter fits the framework's bound, the constraint never shortened, so the refusal names
 * both the issue and the constraint it breaks. */
export function scopeCheckParameters(repository: string, proposal: Pick<CampaignScopeProposal, "issues" | "constraints">): Record<string, string[]> {
  const max = DECISION_QUESTION_PARAMETER_MAX_CHARS;
  const named = proposal.issues.filter((issue) => issue.origin === "owner_named")
    .map((issue) => issueLabel(repository, issue.number, issue.title, max));
  const chosen = proposal.issues.filter((issue) => issue.origin === "orchestrator_chosen");
  const pairs = chosen.flatMap((issue) => proposal.constraints.map((constraint) => {
    const suffix = ` — ${oneLine(constraint)}`;
    return `${issueLabel(repository, issue.number, issue.title, Math.max(24, max - suffix.length))}${suffix}`.slice(0, max);
  }));
  return { ...(named.length ? { named_asked_for: named } : {}), ...(pairs.length ? { constraint_met: pairs } : {}) };
}

function inputsWith(ownerMessage: string, proposal: CampaignScopeProposal, explanation: string, facts: readonly CampaignIssueFacts[],
  campaign: ScopeCheckCampaign, excerpt: number): DecisionInputs {
  return {
    ownerMessage,
    data: {
      proposal: JSON.stringify({
        issues: proposal.issues.map((issue) => ({ number: issue.number, origin: issue.origin, rationale: issue.rationale })),
        requestedCount: proposal.requestedCount, constraints: proposal.constraints, withheldOperations: proposal.withheldOperations,
        rationale: explanation,
      }),
      issues: JSON.stringify(facts.map((fact) => ({ number: fact.number, title: fact.title, state: fact.state, labels: fact.labels,
        bodyExcerpt: fact.bodyExcerpt.slice(0, excerpt) }))),
      campaign: JSON.stringify({
        repository: campaign.repository, operations: campaign.operations, inScope: campaign.inScope,
        ...(campaign.admitted ? { admitted: { requestedCount: campaign.admitted.requestedCount, constraints: campaign.admitted.constraints,
          withheldOperations: campaign.admitted.withheldOperations } } : {}),
      }),
    },
    questions: { parameters: scopeCheckParameters(campaign.repository, proposal) },
  };
}

/** The check's inputs, or null when even issue facts without body excerpts, or the questions, cannot
 * fit one Decision call: such a proposal is never checked in part, so it is the owner's. */
export function scopeCheckInputs(ownerMessage: string, proposal: CampaignScopeProposal, explanation: string,
  facts: readonly CampaignIssueFacts[], campaign: ScopeCheckCampaign): DecisionInputs | null {
  const start = Math.max(200, Math.min(CAMPAIGN_ISSUE_FACT_LIMITS.bodyExcerptChars,
    Math.floor(ISSUE_FACTS_BUDGET_CHARS / Math.max(1, facts.length)) - 400));
  for (const excerpt of [start, Math.floor(start / 2), Math.floor(start / 4), 200, 0]) {
    const inputs = inputsWith(ownerMessage, proposal, explanation, facts, campaign, excerpt);
    if (scopeCheckInputDigest(inputs) !== null) return inputs;
  }
  return null;
}

/** The digest the runtime records for these inputs, or null when they exceed one Decision call. */
export function scopeCheckInputDigest(inputs: DecisionInputs): string | null {
  try {
    return decisionRequestDigest(DECISION_KINDS.scope_check, prepareDecision(DECISION_KINDS.scope_check, inputs).rendered);
  } catch (error) {
    if (error instanceof DecisionInputError) return null;
    throw error;
  }
}

/** One check per campaign, boundary revision, scope revision and proposal as structured: its
 * additions with their origins, the count, the constraints and the withheld operations. The
 * rationale stays out, so a reworded rationale joins the recorded occurrence and returns its
 * verdict, its owner request or its admission: rewording never buys a second verdict. */
export function scopeCheckKey(rootId: string, boundaryRevision: number, revision: number,
  proposal: Pick<CampaignScopeProposal, "issues" | "requestedCount" | "constraints" | "withheldOperations">): string {
  const subject = sha256(JSON.stringify({
    issues: [...proposal.issues].map((issue) => [issue.number, issue.origin]).sort((a, b) => (a[0] as number) - (b[0] as number)),
    requestedCount: proposal.requestedCount, constraints: proposal.constraints, withheldOperations: [...proposal.withheldOperations].sort(),
  })).slice(0, 32);
  return `scope_check:${rootId}:${boundaryRevision}:${revision}:${subject}`;
}

/** The count a proposal's chosen issues may not exceed (#4282, as #4102): the count the owner
 * stated, else the admitted one for a later addition, else the default selection of 3. A floor
 * only: it narrows, and the constraint check still confirms the count against the message. */
export function scopeProposalChosenLimit(proposal: Pick<CampaignScopeProposal, "requestedCount">, admitted?: FullControlInitialScope): number {
  return proposal.requestedCount ?? admitted?.requestedCount ?? SCOPE_GRANT_DEFAULT_SELECTION_COUNT;
}

/** A check's occurrence as Campaign Status shows it. */
export function scopeCheckView(occurrence: DecisionOccurrenceRecord): CampaignScopeCheckView {
  return {
    occurrenceId: occurrence.occurrenceId,
    state: occurrence.state,
    ...(occurrence.verdict ? { verdict: occurrence.verdict } : {}),
    ...(occurrence.reason ? { reason: occurrence.reason } : {}),
    ...(occurrence.failureClass ? { failureClass: occurrence.failureClass as CampaignScopeCheckView["failureClass"] } : {}),
    ...(occurrence.typedAnswers ? { typedAnswers: occurrence.typedAnswers } : {}),
  };
}
