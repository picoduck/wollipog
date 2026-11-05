import { createHash } from "node:crypto";
import { CAMPAIGN_ISSUE_FACT_LIMITS, DECISION_INPUT_MAX_CHARS, type CampaignIssueFacts, type CampaignSelectionProposal,
  type FullControlScopeGrant } from "@wollipog/protocol";
import type { ControlPlaneDb, DecisionOccurrenceRecord } from "./db.js";
import type { DecisionInputs } from "./decision-kinds.js";

/**
 * The Decision Model's review of a selection proposal (#4103): what it reads, how a repeated
 * proposal joins its occurrence, and how Campaign Status reads the outcome.
 */

/** Room the issue facts may take in one Decision input, beside the owner's message, the grant and
 * the rationale. Each body excerpt shrinks so that any number of issues fits. */
const ISSUE_FACTS_BUDGET_CHARS = 24_000;

/** The review's inputs. The owner's words are the only instruction-like text; the grant, every
 * issue fact and the Orchestrator's rationale are quoted, untrusted data. */
export function scopeReviewInputs(ownerMessage: string, grant: FullControlScopeGrant, facts: readonly CampaignIssueFacts[],
  rationale: string): DecisionInputs {
  const excerpt = Math.max(200, Math.min(CAMPAIGN_ISSUE_FACT_LIMITS.bodyExcerptChars, Math.floor(ISSUE_FACTS_BUDGET_CHARS / Math.max(1, facts.length)) - 400));
  return {
    ownerMessage,
    data: {
      grant: JSON.stringify({
        repositories: grant.ceilings.repositories,
        namedIssues: grant.namedIssues,
        selection: grant.selection ? { count: grant.selection.count, defaulted: grant.selection.defaulted,
          criteria: grant.selection.criteria, constraints: grant.selection.constraints } : null,
      }),
      issues: JSON.stringify(facts.map((fact) => ({ number: fact.number, title: fact.title, state: fact.state, labels: fact.labels,
        bodyExcerpt: fact.bodyExcerpt.slice(0, excerpt) }))),
      rationale,
    },
  };
}

/** Whether these inputs fit one Decision input with room for its framing. */
export function scopeReviewInputsFit(inputs: DecisionInputs): boolean {
  return (inputs.ownerMessage?.length ?? 0) + Object.values(inputs.data).reduce((sum, value) => sum + value.length, 0) <
    DECISION_INPUT_MAX_CHARS - 4_000;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** SHA-256 of the stored grant a review reads. */
export function scopeGrantDigest(grant: FullControlScopeGrant): string {
  return sha256(JSON.stringify(grant));
}

/** One review per campaign, scope revision, grant and set of additions. A repeated proposal of the
 * same issues at the same revision joins the recorded occurrence whatever its rationale says: it
 * returns the same verdict, the same owner request or the same scope change, so neither a retry nor a
 * reworded rationale can admit twice or ask the owner twice. A new scope revision reviews afresh. */
export function scopeReviewKey(rootId: string, revision: number, additions: readonly number[], grantDigest: string): string {
  const subject = sha256(JSON.stringify({ additions: [...additions].sort((a, b) => a - b), grantDigest })).slice(0, 32);
  return `scope_review:${rootId}:${revision}:${subject}`;
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
