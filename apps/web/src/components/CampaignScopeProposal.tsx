import React, { useId } from "react";
import { scopeProposalRepositoryConstraints, type CampaignScopeCheckView, type CampaignScopeProposal, type CampaignScopeProposalView, type FullControlScopeGrant,
  type ScopeProposalCheck as ScopeProposalCheckName } from "@wollipog/protocol";
import { DECISION_FAILURE_LABELS } from "./CampaignDecisionModelChecks.js";
import { DecisionAnswerChecklist } from "./DecisionAnswerChecklist.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import type { StatusTone } from "../status-meta.js";
import { operationLabel } from "./CampaignScopeGrant.js";

/** What each proposal led to, as a Title Case badge. */
const OUTCOMES: Record<CampaignScopeProposalView["outcome"], { label: string; tone: StatusTone }> = {
  admitted: { label: "Admitted", tone: "success" },
  applied: { label: "Applied", tone: "success" },
  waiting_for_owner: { label: "Waiting for You", tone: "warning" },
  owner_approved: { label: "Approved by You", tone: "success" },
  owner_declined: { label: "Declined by You", tone: "neutral" },
  replaced: { label: "Replaced", tone: "neutral" },
};

const CHECKS: Partial<Record<ScopeProposalCheckName, string>> = {
  chosen_issues: "issues the Orchestrator chose",
  requested_count: "a count you asked for",
  unreferenced_named_issues: "issues your message writes only as plain numbers",
  unproposed_references: "issues your message mentions that it doesn't propose as ones you named",
  later_named_issues: "issues it says you named but proposes only now",
  constraints: "constraints it read",
  withheld_operations: "operations it withholds",
  repository_limit: "the repositories it says you limited the work to",
  repository_mentioned: "a repository your message names, with no limit stated",
};

/** How a proposal was checked: the floors alone, the Decision Model's constraint check, or the
 * owner's approval, and why. */
function checkedBy(proposal: CampaignScopeProposal): string {
  const what = proposal.checks.flatMap((check) => CHECKS[check] ?? []);
  const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0] ?? "nothing it could check";
  if (proposal.route === "admitted") {
    return proposal.constraintCheck
      ? `Deterministic checks, then the Decision Model confirmed ${list} against your message.`
      : "Deterministic checks only. It named only issues your message references, so no model was asked.";
  }
  switch (proposal.ownerCause) {
    case "issue_ceiling_exceeded": return "The Decision Model confirmed the proposal against your message, but the matching issues exceed Maximum Issues, so it needs your approval.";
    case "proposal_unstructured": return "Deterministic checks, then your approval: the Orchestrator's machine can't send a structured proposal.";
    case "repository_name_unresolved": return "Deterministic checks, then your approval: a repository your message names matches nothing or several, so no repository limit applies and no model was asked.";
    case "constraint_check_uncertain": return `Deterministic checks, then the Decision Model couldn't confirm ${list}, so it needs your approval.`;
    case "constraint_check_failed": return `Deterministic checks, then the Decision Model's check of ${list} failed, so it needs your approval.`;
    default: return `Deterministic checks, then your approval: it includes ${list}, which no Decision Model checked.`;
  }
}

/** The Decision Model's verdict on a proposal, derived by the server from the answers. */
const CHECK_VERDICTS: Record<string, { label: string; tone: StatusTone }> = {
  admit: { label: "Within Your Message", tone: "success" },
  refuse: { label: "Outside Your Message", tone: "danger" },
};

function checkVerdict(check: CampaignScopeCheckView): { label: string; tone: StatusTone } {
  if (check.state === "pending") return { label: "Checking", tone: "info" };
  if (check.state === "failed") return { label: "Check Failed", tone: "warning" };
  if (check.state === "uncertain") return { label: "Uncertain", tone: "warning" };
  return CHECK_VERDICTS[check.verdict ?? ""] ?? { label: "Uncertain", tone: "warning" };
}

/** The constraint check's verdict and each typed question with its answer and confidence (#4282). */
export function ScopeProposalCheck({ check }: { check: CampaignScopeCheckView }) {
  const verdict = checkVerdict(check);
  // The same row structure as Decision Model Checks: the checklist sits in the value column of an
  // Answers row, so the label column stays aligned.
  return <dl className="facts">
    <div><dt>Decision Model Verdict</dt><dd><StatusBadge noDot tone={verdict.tone} label={verdict.label} />
      {check.reason ? <> {check.reason}</> : null}
      {check.failureClass ? <> {DECISION_FAILURE_LABELS[check.failureClass]}</> : null}</dd></div>
    {check.typedAnswers ? <div><dt>Answers</dt><dd><DecisionAnswerChecklist typed={check.typedAnswers} /></dd></div> : null}
  </dl>;
}

/** The facts of one Orchestrator proposal (#4282): each issue with whether you named it or the
 * Orchestrator chose it and why, the count, constraints and withheld operations it read, and its
 * rationale. Ranking is the Orchestrator's call; nothing here judges it. */
export function ScopeProposalFacts({ repository, proposal, explanation }: { repository: string; proposal: CampaignScopeProposal; explanation: string }) {
  const repositoryNames = scopeProposalRepositoryConstraints(proposal);
  return <>
    <dl className="facts">
      <div><dt>Scope</dt><dd>{proposal.initial ? "Initial Scope" : "Addition"}</dd></div>
      <div><dt>Issues</dt><dd>{proposal.issues.length ? <ul className="campaign-detail-list">{proposal.issues.map((issue) => <li key={`${issue.repository ?? repository}#${issue.number}`}>
        {issue.repository ?? repository}#{issue.number}{issue.title ? ` ${issue.title}` : ""}{" "}
        <StatusBadge noDot tone={issue.origin === "owner_named" ? "info" : "neutral"} label={issue.origin === "owner_named" ? "Named by You" : "Chosen by Orchestrator"} />
        {issue.rationale ? <>: {issue.rationale}</> : null}
      </li>)}</ul> : "None: the Orchestrator found nothing in your message that needs issue scope."}</dd></div>
      <div><dt>Count You Asked For</dt><dd>{proposal.requestedCount ?? "None Stated"}</dd></div>
      {repositoryNames.length > 0 && <div><dt>{repositoryNames.length > 1 ? "Repositories You Named" : "Repository You Named"}</dt><dd>{repositoryNames.map((item) =>
        <div key={item.name}>{item.name}: {item.repository ?? "matches no repository in this campaign, or more than one"}</div>)}</dd></div>}
      <div><dt>Constraints It Read</dt><dd>{proposal.constraints.length ? proposal.constraints.join("; ") : "None"}</dd></div>
      <div><dt>Withheld Operations</dt><dd>{proposal.withheldOperations.length ? proposal.withheldOperations.map(operationLabel).join(", ") : "None"}</dd></div>
      <div><dt>Rationale</dt><dd>{explanation}</dd></div>
      <div><dt>Checked By</dt><dd>{checkedBy(proposal)}</dd></div>
    </dl>
  </>;
}

/** Campaign Status's Scope Proposal section (#4282): the Orchestrator reads the owner's first message
 * and proposes the scope. It shows each proposal with its rationale and what it led to; until one is
 * admitted, nothing is dispatched. */
export function CampaignScopeProposalSection({ grant, proposals, ceilingsShown = false }: {
  grant: FullControlScopeGrant;
  proposals: readonly CampaignScopeProposalView[];
  /** The Full Control section shows the boundary's Maximum Issues and operations (#2940); then this
   * section leaves those two rows out instead of repeating them. */
  ceilingsShown?: boolean;
}) {
  const headingId = useId();
  const repository = grant.ceilings.repositories[0] ?? "";
  return <section className="campaign-detail-section" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-title">Scope Proposal</h3>
    {!proposals.length && <Notice tone="info" title="Waiting for the Orchestrator's Proposal">
      The Orchestrator reads your first message and proposes the campaign's issue scope. Nothing is dispatched until it is admitted.
    </Notice>}
    <dl className="facts">
      {!ceilingsShown && <div><dt>Maximum Issues</dt><dd>{grant.ceilings.maxIssues} <StatusBadge noDot label={grant.ceilings.maxIssuesSource === "explicit" ? "Set by You" : "Derived"} /></dd></div>}
      <div><dt>{grant.ceilings.repositories.length > 1 ? "Repositories" : "Repository"}</dt><dd>{grant.ceilings.repositories.join(", ")}</dd></div>
      {!ceilingsShown && <div><dt>Operations</dt><dd>{grant.ceilings.operations.length ? grant.ceilings.operations.map(operationLabel).join(", ") : "None"}</dd></div>}
    </dl>
    {proposals.map((view, index) => {
      const outcome = OUTCOMES[view.outcome];
      return <article key={view.occurrenceId} aria-label={index === 0 ? "Latest Proposal" : `Earlier Proposal ${index}`}>
        <h4>{index === 0 ? "Latest Proposal" : "Earlier Proposal"} <StatusBadge noDot tone={outcome.tone} label={outcome.label} /></h4>
        <ScopeProposalFacts repository={repository} proposal={view.proposal} explanation={view.explanation} />
        {view.check ? <ScopeProposalCheck check={view.check} /> : null}
      </article>;
    })}
  </section>;
}
