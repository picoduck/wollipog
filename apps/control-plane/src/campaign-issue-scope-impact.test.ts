import test from "node:test";
import assert from "node:assert/strict";
import type { SessionView, CampaignIssueScopeSnapshot, WorkflowDecisionView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { scopeSnapshot, scopePreservesHumanApproval } from "./campaign-issue-scope.js";

test("human approvals depending on changed issues or follow-up slots never survive scope approval (#4547)", () => {
  const db = { campaignWorkLedger: { sessionsUnrelatedToIssues: () => new Set<string>() } } as unknown as ControlPlaneDb;
  const request: CampaignIssueScopeSnapshot = { repository: "team/repo", before: [100], additions: [101], removals: [], category: "campaign_issue_scope",
    expectedRevision: 3, explanation: "Add related work", affectedAssignments: [], affectedDecisions: [], activeChildren: [] };
  for (const resourceSnapshot of [
    { category: "issue_closure", repository: "team/repo", issue: 101 },
    { category: "issue_closure", repository: "other/repo", issue: 101 },
    { category: "follow_up_issue_publication" }, { category: "campaign_follow_up_admission" },
  ]) {
    const d = { resourceSnapshot, sessionId: "root", authority: "human", status: "approved", policyRevision: 4 } as WorkflowDecisionView;
    assert.equal(scopePreservesHumanApproval(db, "root", request, d, 4), false, resourceSnapshot.category);
  }
  const removal = { ...request, additions: [], removals: [100] };
  const closure = { resourceSnapshot: { category: "issue_closure", repository: "team/repo", issue: 100 },
    sessionId: "root", authority: "human", status: "approved", policyRevision: 4 } as WorkflowDecisionView;
  assert.equal(scopePreservesHumanApproval(db, "root", removal, closure, 4), false);
});

test("scope removal impact distinguishes equal issue numbers across repositories", () => {
  const root = { id: "root", orchestratorPolicy: { issueNumbers: [124] } } as SessionView;
  const db = {
    campaignWorkLedger: { page: () => ({ ok: true, data: { items: [
      { issue: { repository: "TEAM/REPO", number: 124 }, currentAttempt: { sessionId: "member" } },
      { issue: { repository: "other/repo", number: 124 }, currentAttempt: { sessionId: "foreign-member" } },
    ], nextCursor: null } }), sessionsUnrelatedToIssues: () => new Set<string>() },
    unconsumedWorkflowDecisionsForController: () => [],
    authorityBoundWorkflowDecisionsForController: () => [],
    campaignDescendantIds: () => [],
  } as unknown as ControlPlaneDb;
  const snapshot = scopeSnapshot(db, root, "team/repo", { requestId: "remove", expectedRevision: 1,
    additions: [], removals: [{ repository: "team/repo", number: 124 }], explanation: "Remove member" });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.affectedAssignments, [{ sessionId: "member", issue: 124 }]);
});
