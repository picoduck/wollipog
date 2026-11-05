import React, { useId } from "react";
import type { CampaignAuthorityOperation, CampaignScopeGrantReview, DecisionErrorClass, FullControlScopeGrant, ScopeGrantDropReason } from "@wollipog/protocol";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";

/** The operations a Full Control launch can grant, in Title Case. */
const OPERATION_LABELS: Partial<Record<CampaignAuthorityOperation, string>> = {
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

const DROP_REASONS: Record<ScopeGrantDropReason, string> = {
  not_in_message: "not written in the message",
  other_repository: "outside the campaign's repositories",
  not_an_issue: "not an issue of the repository",
  range_not_in_message: "a range the message doesn't write",
  range_too_wide: "in a range too wide to expand",
  over_ceiling: "over Maximum Issues",
};

/** A sentence for each Decision failure class, so the owner sees why there is no grant. */
const FAILURE_SENTENCES: Partial<Record<DecisionErrorClass, string>> = {
  timed_out: "The Decision Model didn't answer in time.",
  transport: "The Decision Model's machine couldn't be reached.",
  rate_limited: "The Decision Model's provider was rate limited.",
  provider_overloaded: "The Decision Model's provider was overloaded.",
  invalid_output: "The Decision Model's answers didn't match the required format.",
  provider_failed: "The Decision Model's provider failed.",
  authentication: "The Decision Model's harness isn't signed in.",
  configuration: "No Decision Model could take the call.",
  model_unavailable: "The Decision Model's model isn't available.",
  harness_unavailable: "The Decision Model's harness isn't available.",
  runner_incapable: "The campaign's machine can't run Decision Model calls. Update it to the current version.",
  refused: "The Decision Model's provider refused the request.",
};

export function operationLabel(operation: CampaignAuthorityOperation): string {
  return OPERATION_LABELS[operation] ?? operation;
}

export function scopeGrantFailureSentence(failureClass: DecisionErrorClass | undefined): string {
  return (failureClass && FAILURE_SENTENCES[failureClass]) ?? "The Decision Model failed.";
}

const refs = (repository: string, numbers: readonly number[]) => numbers.length ? numbers.map((n) => `${repository}#${n}`).join(", ") : "None";

/** Campaign Status's Scope Grant section (#4102): what the owner's first message granted, the hard
 * ceilings around it, and the Decision Model that read it with its reason. */
export function CampaignScopeGrantSection({ grant }: { grant: FullControlScopeGrant }) {
  const headingId = useId();
  const repository = grant.ceilings.repositories[0] ?? "";
  const selection = grant.selection;
  const target = grant.target;
  return <section className="campaign-detail-section" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-title">Scope Grant</h3>
    {grant.status === "uncertain" && <Notice tone="warning" title="Scope Grant Uncertain">
      The Decision Model couldn't tell which issues your first message asks for, so it granted none. The Orchestrator's scope proposal comes to you for approval.
    </Notice>}
    {grant.status === "failed" && <Notice tone="warning" title="Scope Grant Unavailable">
      {scopeGrantFailureSentence(grant.failureClass)} No issues were granted from your first message, and nothing was read from its text instead. The Orchestrator's scope proposal comes to you for approval.
    </Notice>}
    <dl className="facts">
      <div><dt>Named Issues</dt><dd>{refs(repository, grant.namedIssues)}</dd></div>
      <div><dt>Selection Count</dt><dd>{selection ? <>
        {selection.count}
        {selection.defaulted && <> <StatusBadge noDot tone="info" label="Defaulted" title="Your message didn't give a count." /></>}
        {selection.capped && <> <StatusBadge noDot tone="warning" label="Capped by Maximum Issues" /></>}
      </> : "None"}</dd></div>
      {selection && <div><dt>Selection Criteria</dt><dd>{selection.criteria || "None Stated"}</dd></div>}
      {selection && <div><dt>Selection Constraints</dt><dd>{selection.constraints.length ? selection.constraints.join("; ") : "None Stated"}</dd></div>}
      <div><dt>Maximum Issues</dt><dd>{grant.ceilings.maxIssues} <StatusBadge noDot label={grant.ceilings.maxIssuesSource === "explicit" ? "Set at Launch" : "Derived"} /></dd></div>
      <div><dt>Repository</dt><dd>{grant.ceilings.repositories.join(", ")}</dd></div>
      <div><dt>Operations</dt><dd>{grant.ceilings.operations.length ? grant.ceilings.operations.map(operationLabel).join(", ") : "None"}</dd></div>
      {grant.ceilings.removedOperations?.length ? <div><dt>Withheld by Your Message</dt><dd>{grant.ceilings.removedOperations.map(operationLabel).join(", ")}</dd></div> : null}
      {grant.dropped?.length ? <div><dt>Not Granted</dt><dd>{grant.dropped.map((d) => `${d.repository}#${d.number} (${DROP_REASONS[d.reason]})`).join(", ")}</dd></div> : null}
      <div><dt>Decision Model</dt><dd>{target ? `${target.model} (${target.effort}) · ${target.harnessName} on ${target.machineName}` : "None Available"}</dd></div>
      <div><dt>{grant.status === "failed" ? "Failure" : "Reason"}</dt><dd>{grant.status === "failed" ? scopeGrantFailureSentence(grant.failureClass) : grant.reason ?? "None Given"}</dd></div>
    </dl>
  </section>;
}

/** The grant context on the owner's one typed scope approval (#4102): their own message and why the
 * Orchestrator's proposal needs them. */
export function ScopeGrantReviewFacts({ review }: { review: CampaignScopeGrantReview }) {
  const why = review.cause === "selection"
    ? "Your first message asked the campaign to choose issues. You approve its choice until the Decision Model reviews selections."
    : review.cause === "selection_uncertain"
      ? "Your first message asked the campaign to choose issues. These passed every check, but the Decision Model couldn't tell whether they fit what you asked for."
      : review.cause === "selection_failed"
        ? `Your first message asked the campaign to choose issues. These passed every check, but the Decision Model's review of them didn't finish: ${scopeGrantFailureSentence(review.failureClass)}`
        : review.cause === "selection_unverified"
          ? "Your first message asked the campaign to choose issues. The campaign's machine can't report whether these issues are open or what labels they have, so nothing checked them."
          : review.cause === "grant_uncertain"
            ? "The Decision Model couldn't tell which issues your first message asks for, so there is no grant to check this proposal against."
            : `${scopeGrantFailureSentence(review.failureClass)} There is no grant to check this proposal against.`;
  const reasonLabel = review.cause === "selection" || review.cause === "selection_unverified" ? "Grant Reason" : "Uncertain Reason";
  return <>
    <p>{why}</p>
    <dl className="facts">
      <div><dt>Your First Message</dt><dd>{review.ownerMessage}</dd></div>
      {review.reason && <div><dt>{reasonLabel}</dt><dd>{review.reason}</dd></div>}
      {review.selection && <div><dt>Selection</dt><dd>
        {review.selection.count}{review.selection.defaulted ? " (defaulted)" : ""}
        {review.selection.criteria ? `, ${review.selection.criteria}` : ""}
        {review.selection.constraints.length ? `; ${review.selection.constraints.join("; ")}` : ""}
      </dd></div>}
    </dl>
  </>;
}
