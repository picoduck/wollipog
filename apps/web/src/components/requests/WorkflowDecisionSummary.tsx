import React from "react";
import { CampaignIssueScopeSummary } from "../CampaignIssueScopePanel.js";
import { temporaryBranchDecisionKeptByPolicy, type CampaignAuthorityEvaluation, type PendingApproval, type PullRequestClosingReferenceCheck, type WorkflowDecisionOwnerRule, type WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { IssueClosureSummary } from "../IssueClosureSummary.js";
import { AutomationCreationSummary } from "../AutomationCreationSummary.js";
import { LocationSwitchSummary } from "./LocationSwitchSummary.js";
import { followUpLimitText } from "../../follow-up-limit.js";
import { issueRefLabel } from "../../campaign-status.js";
import { StructuredQuestionText } from "../StructuredQuestionText.js";

/** The issues a merge would close (#3713; GitLab since #3762). The control plane creates the
 * decision only when they are exactly the snapshot's declared ones, so with a check this is what the
 * forge reported; a runner that predates the check reports nothing, and then only the declaration
 * is known. */
function MergeClosures({ declared, check, gitlab }: { declared: string[]; check?: PullRequestClosingReferenceCheck; gitlab: boolean }) {
  if (!check) {
    return <>Not checked: the runner predates this check.{declared.length ? ` Declared: ${declared.join(", ")}.` : ""}</>;
  }
  if (!check.closures.length) return <>None</>;
  return <ul>{check.closures.map((closure) => <li key={closure.issue}>
    {closure.issue}{closure.excerpt ? <>: <q>{closure.excerpt}</q></> : gitlab ? " (reported by GitLab)" : " (linked on GitHub)"}
  </li>)}</ul>;
}

/** The installed or user-authored rule that keeps a decision for its owner (#4137), as facts rows
 * for a `.facts` list. The requester supplied both values, so they render only as plain text. */
export function OwnerRuleFactRows({ rule }: { rule: WorkflowDecisionOwnerRule }) {
  return <>
    <div><dt>Rule Source</dt><dd><code>{rule.source}</code></dd></div>
    <div><dt>Rule</dt><dd><q>{rule.quote}</q></dd></div>
  </>;
}

/** Why only the owner can make a decision a rule kept for them (#4137), and which rule it is. */
export function OwnerRuleSummary({ rule }: { rule: WorkflowDecisionOwnerRule }) {
  return <>
    <p>An installed or user-authored rule keeps this decision for a person, so no agent can make it.</p>
    <dl className="facts"><OwnerRuleFactRows rule={rule} /></dl>
  </>;
}

/** What a workflow decision decides, as facts (§5.4): the Request Card's body for the kinds without
 * a review of their own, and the read-only summary of a decision the Orchestrator owns. */
export function WorkflowDecisionSummary({ snapshot, closingReferenceCheck, scopeMaxIssuesIncrease, authority, authorityReason }: {
  snapshot: WorkflowDecisionResourceSnapshot;
  authority?: "human" | "orchestrator";
  authorityReason?: CampaignAuthorityEvaluation["reason"];
  /** The card's server-derived Maximum Issues increase, for a scope request (#4334). */
  scopeMaxIssuesIncrease?: PendingApproval["scopeMaxIssuesIncrease"];
  /** The server-recorded closing-reference read of a GitHub merge, when there was one. */
  closingReferenceCheck?: PullRequestClosingReferenceCheck;
}) {
  switch (snapshot.category) {
    case "automation_creation":
      return <AutomationCreationSummary snapshot={snapshot} />;
    case "location_switch":
      return <LocationSwitchSummary snapshot={snapshot} />;
    case "campaign_repository_addition":
      // A repository addition (#4117): the Location and the repository it verified as come from the
      // server's inspection; the reason is the Orchestrator's own words, shown as such.
      return <section aria-label="Add Repository Details">
        <dl className="facts">
          <div><dt>Location</dt><dd>{snapshot.locationName}</dd></div>
          <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
          <div><dt>{snapshot.work.kind === "follow_up" ? "Follow-Up" : "Work Item"}</dt><dd>{snapshot.work.title}</dd></div>
          <div><dt>Orchestrator's Reason</dt><dd><q>{snapshot.reason}</q></dd></div>
        </dl>
        <p>Approving adds this repository to the campaign, so the Orchestrator can work in it like its other repositories.
          Declining changes nothing, and the work that needs it stays blocked on you.</p>
      </section>;
    case "implementation_question":
      return <>
        <p>{snapshot.question}</p>
        <ul>{snapshot.options.map((option) => <li key={option.optionId}>{option.label}</li>)}</ul>
      </>;
    case "owner_decision":
      // A decision the campaign's owner kept (#4064): the root's question, what it rests on, and
      // the options, of which only the owner chooses one.
      // Its material is the root's Markdown, links included (#4270), never a monospace block. An
      // Owner Question (#4270) is normally answered as a question; this summary is its read-only form.
      return <>
        <p>{snapshot.question}</p>
        {snapshot.material && <div><StructuredQuestionText>{snapshot.material}</StructuredQuestionText></div>}
        {!snapshot.ruleDelegation && snapshot.options.length > 0 && <ul>{snapshot.options.map((option) => <li key={option.optionId}>
          {option.label}{option.optionId === snapshot.recommendedOptionId ? " (Recommended)" : ""}
          {option.description ? <>: {option.description}</> : null}
        </li>)}</ul>}
        <p>{snapshot.kind === "question"
          ? "The Orchestrator asked you this question. Only you can answer it, in your own words, and it keeps working while it waits."
          : "You kept this decision, so only you can make it. The Orchestrator keeps working while it waits."}</p>
      </>;
    case "campaign_issue_scope":
      return <CampaignIssueScopeSummary snapshot={snapshot} {...(scopeMaxIssuesIncrease ? { derivedIncrease: scopeMaxIssuesIncrease } : {})} />;
    case "issue_closure":
      return <IssueClosureSummary snapshot={snapshot} />;
    case "campaign_follow_up_admission":
      // One follow-up past the campaign's approval limit (#2940): approving admits exactly this one,
      // with this title and issue. Its recommendation or work item id stays under Request Details.
      return <>
        {snapshot.rebinds && <p>
          Replaces the approved follow-up <q>{snapshot.title}</q> with the recommendation <q>{snapshot.recommendationTitle}</q>.
        </p>}
        <dl className="facts">
          {snapshot.recommendationTitle !== undefined && (snapshot.rebinds || snapshot.recommendationTitle !== snapshot.title) &&
            <div><dt>Recommendation</dt><dd>{snapshot.recommendationTitle}</dd></div>}
          <div><dt>{snapshot.rebinds ? "Approved Follow-Up" : "Follow-Up"}</dt><dd>{snapshot.title}</dd></div>
          {snapshot.issue && <div><dt>Issue</dt><dd>{issueRefLabel(snapshot.issue)}</dd></div>}
          <div><dt>Follow-Up Limit</dt><dd>{followUpLimitText(snapshot.acceptedFollowUps, snapshot.limit)}</dd></div>
        </dl>
        <p>{snapshot.rebinds
          ? "You approved that follow-up past the limit. Approving this lets the Orchestrator accept this recommendation as that follow-up's work instead."
          : snapshot.revises
          ? "You approved this follow-up past the limit. Approving this change lets the Orchestrator give it this title and issue."
          : "Approving admits only this follow-up. Change the limit in Campaign Status to let more start without approval."}</p>
      </>;
    case "pr_merge":
      return <dl className="facts">
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Pull Request</dt><dd>#{snapshot.pullRequest}</dd></div>
        <div><dt>Head Commit</dt><dd><code>{snapshot.headSha.slice(0, 12)}</code></dd></div>
        <div><dt>Closes on Merge</dt><dd>
          <MergeClosures declared={snapshot.intendedClosures ?? []} gitlab={snapshot.mergeMethod !== undefined}
            {...(closingReferenceCheck ? { check: closingReferenceCheck } : {})} />
        </dd></div>
      </dl>;
    case "review_round_extension":
      // What the person is asked to grant: more cross-model review rounds, and why (#3369).
      return <dl className="facts">
        <div><dt>Pull Request</dt><dd>{snapshot.repository}#{snapshot.pullRequest}</dd></div>
        <div><dt>Head Commit</dt><dd><code>{snapshot.headSha.slice(0, 12)}</code></dd></div>
        {snapshot.upvotedHeadSha && <div><dt>Upvoted Head</dt><dd><code>{snapshot.upvotedHeadSha.slice(0, 12)}</code></dd></div>}
        <div><dt>Review Epoch</dt><dd>{snapshot.epoch}</dd></div>
        <div><dt>Rounds Used</dt><dd>{snapshot.roundsUsed}</dd></div>
        <div><dt>Open Blocking Findings</dt><dd>{snapshot.blockingFindings}</dd></div>
        <div><dt>Extra Rounds</dt><dd>{snapshot.extraRounds}</dd></div>
        <div><dt>Reason</dt><dd>{snapshot.reason}</dd></div>
      </dl>;
    case "merged_branch_deletion":
      return <dl className="facts">
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Branch</dt><dd><code>{snapshot.branch}</code></dd></div>
        {snapshot.merged === false ? <>
          <div><dt>{snapshot.creation ? "Created Tip" : "Requested Tip"}</dt><dd><code>{snapshot.headSha}</code></dd></div>
          {snapshot.creation && <>
            <div><dt>Created By</dt><dd>{snapshot.creation.sessionTitle} · <code>{snapshot.creation.sessionId}</code></dd></div>
            <div><dt>Creation Proof</dt><dd>Contained in {snapshot.creation.defaultBranch} at <code>{snapshot.creation.defaultHeadSha}</code>.
              {" "}Verified when the receipt was issued; checked again before deletion.</dd></div>
          </>}
          <div><dt>Deletion Check</dt><dd>{snapshot.creation
            ? authority === "orchestrator"
              ? "After approval, the Orchestrator may delete this branch at the exact created tip, with no open head or base pull requests."
              : temporaryBranchDecisionKeptByPolicy(authorityReason)
                ? "This campaign keeps branch deletion with you. The Orchestrator cannot approve deletion, even with a creation receipt."
                : "This deletion is outside the Orchestrator's current verified authority. A receipt alone does not make it delegatable; the decision remains with you."
            : "No matching creation receipt exists. The Orchestrator cannot delete this branch; it stays the owner's decision."}</dd></div>
        </> : <div><dt>Merge Commit</dt><dd><code>{snapshot.mergeCommitSha.slice(0, 12)}</code></dd></div>}
      </dl>;
    case "follow_up_issue_publication":
      return <dl className="facts">
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Issue Title</dt><dd>{snapshot.sanitizedTitle}</dd></div>
        <div><dt>Labels</dt><dd>{snapshot.labels.join(", ") || "None"}</dd></div>
        {/* The exact body that is published: a person approving it reads it first. */}
        <div><dt>Issue Body</dt><dd><div className="code-well"><pre>{snapshot.sanitizedBody}</pre></div></dd></div>
      </dl>;
    case "ui_evidence_approval":
      return <p>{snapshot.evidence.length} evidence {snapshot.evidence.length === 1 ? "item" : "items"} awaiting human review.</p>;
  }
}
