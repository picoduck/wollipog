import { createHash } from "node:crypto";
import { CAMPAIGN_ISSUE_FACT_LIMITS, type CampaignIssueFacts, type CampaignSelectionProposal,
  type FullControlScopeGrant } from "@wollipog/protocol";
import type { ControlPlaneDb, DecisionOccurrenceRecord } from "./db.js";
import { DECISION_KINDS, DecisionInputError, decisionRequestDigest, renderDecisionInput, type DecisionInputs } from "./decision-kinds.js";

/**
 * The Decision Model's review of a selection proposal (#4103): what it reads, how a repeated
 * proposal joins its occurrence, and how Campaign Status reads the outcome.
 */

/** Room the issue facts may take in one Decision input, beside the owner's message, the grant and
 * the rationale. Each body excerpt starts at its share of this and shrinks until the rendered input,
 * markup escaping included, fits. */
const ISSUE_FACTS_BUDGET_CHARS = 24_000;

/** The review's inputs, or null when even issue facts without body excerpts cannot fit one Decision
 * input as rendered. The owner's words are the only instruction-like text; the grant, every issue
 * fact and the Orchestrator's rationale are quoted, untrusted data. */
export function scopeReviewInputs(ownerMessage: string, grant: FullControlScopeGrant, facts: readonly CampaignIssueFacts[],
  rationale: string): DecisionInputs | null {
  const start = Math.max(200, Math.min(CAMPAIGN_ISSUE_FACT_LIMITS.bodyExcerptChars, Math.floor(ISSUE_FACTS_BUDGET_CHARS / Math.max(1, facts.length)) - 400));
  for (const excerpt of [start, Math.floor(start / 2), Math.floor(start / 4), 200, 0]) {
    const inputs = scopeReviewInputsWith(ownerMessage, grant, facts, rationale, excerpt);
    if (renderedScopeReview(inputs) !== null) return inputs;
  }
  return null;
}

/** The exact text every attempt sends, or null when it exceeds one Decision input. */
export function renderedScopeReview(inputs: DecisionInputs): string | null {
  try {
    return renderDecisionInput(DECISION_KINDS.scope_review, inputs);
  } catch (error) {
    if (error instanceof DecisionInputError) return null;
    throw error;
  }
}

/** The digest the runtime records for these inputs, to tell whether a pending review read them. */
export function scopeReviewInputDigest(inputs: DecisionInputs): string | null {
  const rendered = renderedScopeReview(inputs);
  return rendered === null ? null : decisionRequestDigest(DECISION_KINDS.scope_review, rendered);
}

function scopeReviewInputsWith(ownerMessage: string, grant: FullControlScopeGrant, facts: readonly CampaignIssueFacts[],
  rationale: string, excerpt: number): DecisionInputs {
  return {
    ownerMessage,
    data: {
      grant: JSON.stringify({
        repositories: grant.ceilings.repositories,
        namedIssues: grant.namedIssues,
        // The ranking criteria stay out (#4282): the review checks constraints, never priority.
        selection: grant.selection ? { count: grant.selection.count, defaulted: grant.selection.defaulted,
          constraints: grant.selection.constraints } : null,
      }),
      issues: JSON.stringify(facts.map((fact) => ({ number: fact.number, title: fact.title, state: fact.state, labels: fact.labels,
        bodyExcerpt: fact.bodyExcerpt.slice(0, excerpt) }))),
      rationale,
    },
  };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** SHA-256 of the stored grant a review reads. */
export function scopeGrantDigest(grant: FullControlScopeGrant): string {
  return sha256(JSON.stringify(grant));
}

/** One review per campaign, boundary revision, scope revision, grant and set of additions. A
 * repeated proposal of the same issues under the same authority joins the recorded occurrence
 * whatever its rationale says: it returns the same verdict, the same owner request or the same scope
 * change, so neither a retry nor a reworded rationale can admit twice or ask the owner twice. A new
 * scope revision, or any re-authorization (such as the owner changing the selection count, which
 * revokes outstanding decisions), reviews afresh. */
export function scopeReviewKey(rootId: string, boundaryRevision: number, revision: number, additions: readonly number[], grantDigest: string): string {
  const subject = sha256(JSON.stringify({ additions: [...additions].sort((a, b) => a - b), grantDigest })).slice(0, 32);
  return `scope_review:${rootId}:${boundaryRevision}:${revision}:${subject}`;
}

/** What a reviewed selection proposal led to, for Campaign Status. */
export function selectionProposalView(db: ControlPlaneDb, occurrence: DecisionOccurrenceRecord): CampaignSelectionProposal | null {
  const record = db.selectionProposal(occurrence.occurrenceId);
  if (!record) return null;
  const requestOccurrenceId = record.workflowOccurrenceId ?? occurrence.humanRequestId ?? undefined;
  const request = requestOccurrenceId ? db.workflowDecisionByOccurrence(requestOccurrenceId) : null;
  let outcome: CampaignSelectionProposal["outcome"];
  if (occurrence.state === "pending") outcome = "reviewing";
  else if (occurrence.state === "decided" && occurrence.verdict === "refuse") outcome = "refused";
  else if (occurrence.state === "decided") {
    outcome = request?.status === "consumed" ? "applied" : !request || request.status === "pending" || request.status === "approved" ? "admitted" : "replaced";
  } else {
    outcome = !request ? "waiting_for_owner" : request.status === "pending" ? "waiting_for_owner" : request.status === "consumed" || request.status === "approved"
      ? "owner_approved" : request.status === "denied" ? "owner_declined" : "replaced";
  }
  return { issues: record.issues, explanation: record.explanation, outcome, ...(requestOccurrenceId ? { requestOccurrenceId } : {}) };
}
