import React from "react";
import type { WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { IssueClosureSummary } from "../IssueClosureSummary.js";

/** What a workflow decision decides, as facts (§5.4): the Request Card's body for the kinds without
 * a review of their own, and the read-only summary of a decision the Orchestrator owns. */
export function WorkflowDecisionSummary({ snapshot }: { snapshot: WorkflowDecisionResourceSnapshot }) {
  switch (snapshot.category) {
    case "implementation_question":
      return <>
        <p>{snapshot.question}</p>
        <ul>{snapshot.options.map((option) => <li key={option.optionId}>{option.label}</li>)}</ul>
      </>;
    case "issue_closure":
      return <IssueClosureSummary snapshot={snapshot} />;
    case "pr_merge":
      return <dl className="facts">
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Pull Request</dt><dd>#{snapshot.pullRequest}</dd></div>
        <div><dt>Head Commit</dt><dd><code>{snapshot.headSha.slice(0, 12)}</code></dd></div>
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
