import React from "react";
import type { GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { githubIssueClosureRefusalReasonText, issueClosureExclusionReasonText } from "@wollipog/protocol";

export function IssueClosureSummary({ snapshot }: { snapshot: GithubIssueClosureSnapshot }) {
  const previous = snapshot.previousRefusal;
  // Live children the work ledger proves unrelated (#3237): shown so the approver can check that
  // input, though they are outside the binding. A snapshot from an earlier release did not record them.
  const excluded = snapshot.excludedChildren;
  return <section aria-label="Issue Closure Details">
    {previous && <p role="note">
      The last approved closure of this issue was refused before anything was written, so it used up that approval.{" "}
      {githubIssueClosureRefusalReasonText(previous.refusal)}
    </p>}
    <dl className="facts">
      <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
      <div><dt>Issue</dt><dd><a className="link" href={snapshot.url} target="_blank" rel="noreferrer">#{snapshot.issue}: {snapshot.title}</a></dd></div>
      <div><dt>Closure Reason</dt><dd>{snapshot.reason === "completed" ? "Completed" : "Not Planned"}</dd></div>
      <div><dt>Explanation</dt><dd>{snapshot.explanation}</dd></div>
      <div><dt>Supporting Evidence</dt><dd><ul>{snapshot.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></div>
      <div><dt>Closing Comment</dt><dd>{snapshot.comment === undefined ? "None" : <pre className="approval-context">{snapshot.comment}</pre>}</dd></div>
      <div><dt>Open Pull Requests</dt><dd>{snapshot.openPullRequests.length ? <ul>{snapshot.openPullRequests.map((pr) =>
        <li key={pr.number}><a className="link" href={pr.url} target="_blank" rel="noreferrer">#{pr.number}: {pr.title}</a></li>)}</ul> : "None"}</dd></div>
      <div><dt>Active Child Assignments</dt><dd>{snapshot.activeChildren.length ? <ul>{snapshot.activeChildren.map((child) =>
        <li key={child.sessionId}>{child.title}</li>)}</ul> : "None"}</dd></div>
      <div><dt>Excluded Children</dt><dd>{excluded === undefined ? "Not Recorded" : excluded.length ? <ul>{excluded.map((child) =>
        <li key={child.sessionId}>{child.title}: {issueClosureExclusionReasonText(child.reason, snapshot.repository)}</li>)}</ul> : "None"}</dd></div>
    </dl>
    {(snapshot.openPullRequests.length > 0 || snapshot.activeChildren.length > 0) &&
      <p>Work is still associated with this issue. Review these assignments and pull requests before approving closure.</p>}
    {excluded && excluded.length > 0 &&
      <p>The campaign work ledger records the excluded children's work as unrelated to this issue, so their activity does not revoke this approval. Check that each reason matches what they are doing.</p>}
    <p>This approves one closure of this issue. It does not verify implementation or campaign completion.</p>
  </section>;
}
