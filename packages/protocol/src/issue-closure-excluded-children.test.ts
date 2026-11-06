import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ISSUE_CLOSURE_EXCLUDED_CHILDREN_MAX, issueClosureExclusionReasonText, normalizeIssueClosureExcludedChildren,
  type IssueClosureExclusionReason,
} from "./issue-closure-excluded-children.js";

const reason = (overrides: Partial<IssueClosureExclusionReason> = {}): IssueClosureExclusionReason => ({
  attemptedIssues: [{ repository: "team/repo", number: 12 }], attemptedIssueCount: 1, attemptedWithoutIssue: 0, linkedWorkItems: 0, ...overrides,
});

test("an exclusion reason reads as one sentence built from ledger facts (#3237)", () => {
  const text = (value: IssueClosureExclusionReason) => issueClosureExclusionReasonText(value, "Team/Repo");
  assert.equal(text(reason()), "Every work-item attempt is on #12, which has never tracked this issue and has no follow-up links.");
  assert.equal(text(reason({ linkedWorkItems: 1 })),
    "Every work-item attempt is on #12, which has never tracked this issue and has 1 follow-up-linked work item that never tracked this issue either.");
  assert.equal(text(reason({ attemptedIssues: [], attemptedIssueCount: 0, attemptedWithoutIssue: 1 })),
    "Every work-item attempt is on a work item without an issue, which has never tracked this issue and has no follow-up links.");
  // Another repository's issue is qualified; several subjects read as a list.
  assert.equal(text(reason({ attemptedIssues: [{ repository: "other/repo", number: 3 }, { repository: "team/repo", number: 12 }],
    attemptedIssueCount: 2, attemptedWithoutIssue: 2, linkedWorkItems: 3 })),
    "Every work-item attempt is on other/repo#3, #12 or 2 work items without an issue, none of which has ever tracked this issue, " +
    "and that work has 3 follow-up-linked work items that never tracked this issue either.");
  assert.equal(text(reason({ attemptedIssueCount: 4 })),
    "Every work-item attempt is on #12 or 3 more issues, none of which has ever tracked this issue, and that work has no follow-up links.");
  assert.equal(text(reason({ attemptedIssues: [], attemptedIssueCount: 0 })),
    "No recorded work-item attempt has ever tracked this issue, and its work has no follow-up links.");
});

test("an excluded list is rebuilt canonically and refused when malformed (#3237)", () => {
  assert.deepEqual(normalizeIssueClosureExcludedChildren([]), []);
  assert.deepEqual(normalizeIssueClosureExcludedChildren([{ sessionId: "s_1", title: "<b>Other</b>", reason: { ...reason(), note: "x" }, extra: true }]),
    [{ sessionId: "s_1", title: "<b>Other</b>", reason: reason() }]);
  for (const value of [
    null, {}, "s_1",
    Array.from({ length: ISSUE_CLOSURE_EXCLUDED_CHILDREN_MAX + 1 }, (_, index) => ({ sessionId: `s_${index}`, title: "T", reason: reason() })),
    [{ sessionId: "s_1", title: "T", reason: reason() }, { sessionId: "s_1", title: "U", reason: reason() }],
    [{ sessionId: "", title: "T", reason: reason() }],
    [{ sessionId: "s_1", title: "", reason: reason() }],
    [{ sessionId: "s_1", title: "T" }],
    [{ sessionId: "s_1", title: "T", reason: reason({ attemptedIssueCount: 0 }) }],
    [{ sessionId: "s_1", title: "T", reason: reason({ attemptedWithoutIssue: 1.5 }) }],
    [{ sessionId: "s_1", title: "T", reason: reason({ attemptedIssues: [{ repository: "team/repo", number: 0 }] }) }],
    [{ sessionId: "s_1", title: "T", reason: reason({ attemptedIssues: [{ repository: "team\nrepo", number: 1 }] }) }],
    [{ sessionId: "s_1", title: "T", reason: reason({ attemptedIssues: Array.from({ length: 21 }, (_, index) =>
      ({ repository: "team/repo", number: index + 1 })), attemptedIssueCount: 21 }) }],
  ]) assert.equal(normalizeIssueClosureExcludedChildren(value), null, JSON.stringify(value)?.slice(0, 120));
});
