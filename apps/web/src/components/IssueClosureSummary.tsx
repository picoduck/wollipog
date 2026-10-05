import React from "react";
import type { GithubIssueClosureSnapshot } from "@wollipog/protocol";

export function IssueClosureSummary({ snapshot }: { snapshot: GithubIssueClosureSnapshot }) {
  return <section aria-label="Issue Closure Details">
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
    </dl>
    {(snapshot.openPullRequests.length > 0 || snapshot.activeChildren.length > 0) &&
      <p>Work is still associated with this issue. Review these assignments and pull requests before approving closure.</p>}
    <p>This approves one closure of this issue. It does not verify implementation or campaign completion.</p>
  </section>;
}
