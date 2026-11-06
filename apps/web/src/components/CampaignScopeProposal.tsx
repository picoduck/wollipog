import React, { useId } from "react";
import type { CampaignScopeProposal, CampaignScopeProposalView, FullControlScopeGrant, ScopeProposalCheck } from "@wollipog/protocol";
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

const CHECKS: Partial<Record<ScopeProposalCheck, string>> = {
  chosen_issues: "issues the Orchestrator chose",
  requested_count: "a count you asked for",
  unreferenced_named_issues: "issues your message writes only as plain numbers",
  constraints: "constraints it read",
  withheld_operations: "operations it withholds",
};

/** How a proposal was checked: the floors alone, or the owner's approval, and why. */
function checkedBy(proposal: CampaignScopeProposal): string {
  if (proposal.route === "admitted") return "Deterministic checks only. It named only issues your message references, so no model was asked.";
  if (proposal.ownerCause === "proposal_unstructured") return "Deterministic checks, then your approval: the Orchestrator's machine can't send a structured proposal.";
  const what = proposal.checks.flatMap((check) => CHECKS[check] ?? []);
  const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0] ?? "nothing it could check";
  return `Deterministic checks, then your approval: it includes ${list}, which no Decision Model checks yet.`;
}

/** The facts of one Orchestrator proposal (#4282): each issue with whether you named it or the
 * Orchestrator chose it and why, the count, constraints and withheld operations it read, and its
 * rationale. Ranking is the Orchestrator's call; nothing here judges it. */
export function ScopeProposalFacts({ repository, proposal, explanation }: { repository: string; proposal: CampaignScopeProposal; explanation: string }) {
  return <>
    <dl className="facts">
      <div><dt>Scope</dt><dd>{proposal.initial ? "Initial Scope" : "Addition"}</dd></div>
      <div><dt>Issues</dt><dd>{proposal.issues.length ? <ul className="campaign-detail-list">{proposal.issues.map((issue) => <li key={issue.number}>
        {repository}#{issue.number}{issue.title ? ` ${issue.title}` : ""}{" "}
        <StatusBadge noDot tone={issue.origin === "owner_named" ? "info" : "neutral"} label={issue.origin === "owner_named" ? "Named by You" : "Chosen by Orchestrator"} />
        {issue.rationale ? <>: {issue.rationale}</> : null}
      </li>)}</ul> : "None: the Orchestrator found nothing in your message that needs issue scope."}</dd></div>
      <div><dt>Count You Asked For</dt><dd>{proposal.requestedCount ?? "None Stated"}</dd></div>
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
      <div><dt>Repository</dt><dd>{grant.ceilings.repositories.join(", ")}</dd></div>
      {!ceilingsShown && <div><dt>Operations</dt><dd>{grant.ceilings.operations.length ? grant.ceilings.operations.map(operationLabel).join(", ") : "None"}</dd></div>}
    </dl>
    {proposals.map((view, index) => {
      const outcome = OUTCOMES[view.outcome];
      return <article key={view.occurrenceId} aria-label={index === 0 ? "Latest Proposal" : `Earlier Proposal ${index}`}>
        <h4>{index === 0 ? "Latest Proposal" : "Earlier Proposal"} <StatusBadge noDot tone={outcome.tone} label={outcome.label} /></h4>
        <ScopeProposalFacts repository={repository} proposal={view.proposal} explanation={view.explanation} />
      </article>;
    })}
  </section>;
}
