import React from "react";
import { CampaignIssueScopeSummary } from "../CampaignIssueScopePanel.js";
import type { PullRequestClosingReferenceCheck, WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { IssueClosureSummary } from "../IssueClosureSummary.js";
import { AutomationCreationSummary } from "../AutomationCreationSummary.js";
import { followUpLimitText } from "../../follow-up-limit.js";

/** The issues a GitHub merge would close (#3713). The control plane creates the decision only when
 * they are exactly the snapshot's declared ones, so with a check this is what GitHub reported; a
 * runner that predates the check reports nothing, and then only the declaration is known. */
function MergeClosures({ declared, check }: { declared: string[]; check?: PullRequestClosingReferenceCheck }) {
  if (!check) {
    return <>Not checked: the runner predates this check.{declared.length ? ` Declared: ${declared.join(", ")}.` : ""}</>;
  }
  if (!check.closures.length) return <>None</>;
  return <ul>{check.closures.map((closure) => <li key={closure.issue}>
    {closure.issue}{closure.excerpt ? <>: <q>{closure.excerpt}</q></> : " (linked on GitHub)"}
  </li>)}</ul>;
}

/** What a workflow decision decides, as facts (§5.4): the Request Card's body for the kinds without
 * a review of their own, and the read-only summary of a decision the Orchestrator owns. */
export function WorkflowDecisionSummary({ snapshot, closingReferenceCheck }: {
  snapshot: WorkflowDecisionResourceSnapshot;
  /** The server-recorded closing-reference read of a GitHub merge, when there was one. */
  closingReferenceCheck?: PullRequestClosingReferenceCheck;
}) {
  switch (snapshot.category) {
    case "automation_creation":
      return <AutomationCreationSummary snapshot={snapshot} />;
    case "implementation_question":
      return <>
        <p>{snapshot.question}</p>
        <ul>{snapshot.options.map((option) => <li key={option.optionId}>{option.label}</li>)}</ul>
      </>;
    case "campaign_issue_scope":
      return <CampaignIssueScopeSummary snapshot={snapshot} />;
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
          {snapshot.issue && <div><dt>Issue</dt><dd>{snapshot.issue.repository}#{snapshot.issue.number}</dd></div>}
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
        {snapshot.mergeMethod === undefined && <div><dt>Closes on Merge</dt><dd>
          <MergeClosures declared={snapshot.intendedClosures ?? []} {...(closingReferenceCheck ? { check: closingReferenceCheck } : {})} />
        </dd></div>}
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
        <div><dt>Merge Commit</dt><dd><code>{snapshot.mergeCommitSha.slice(0, 12)}</code></dd></div>
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
