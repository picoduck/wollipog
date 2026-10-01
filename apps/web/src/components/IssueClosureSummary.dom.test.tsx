import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueClosureSummary } from "./IssueClosureSummary.js";
test("issue closure summary displays exact action, evidence, comment, and current work", () => {
  const markup = renderToStaticMarkup(<IssueClosureSummary snapshot={{ category: "issue_closure",
    repository: "team/repo", issue: 123, title: "Obsolete task", url: "https://github.com/team/repo/issues/123",
    forgeDigest: "a".repeat(64), reason: "not_planned", explanation: "Replaced by a new design.",
    evidence: ["See replacement issue 124."], comment: "Retired. <literal>",
    openPullRequests: [{ number: 77, title: "Active fix", url: "https://github.com/team/repo/pull/77", headSha: "b".repeat(40) }],
    activeChildren: [{ sessionId: "child", title: "Implement issue 123", assignmentDigest: "c".repeat(64) }],
  }} />);
  for (const text of ["team/repo", "#123: Obsolete task", "Not Planned", "Replaced by a new design.",
    "See replacement issue 124.", "Retired. &lt;literal&gt;", "#77: Active fix", "Implement issue 123",
    "Work is still associated", "does not verify implementation"]) assert.ok(markup.includes(text), text);
  assert.ok(markup.includes('href="https://github.com/team/repo/issues/123"'));
});
