import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type PendingApproval } from "@wollipog/protocol";
import { projectCampaignStatusForUi } from "./campaign-status-compatibility.js";

test("REST and websocket projections keep settled scope details off older dashboards (#4601)", () => {
  const live: NonNullable<PendingApproval["scopeDecisionDetails"]>[number] = {
    occurrenceId: "live", category: "pr_merge", resource: "picoduck/wollipog#4608 at a23b456", approval: "pending", armed: false };
  const settled: typeof live = { ...live, occurrenceId: "settled", armed: true, settledOutcome: "consumed" };
  const request: PendingApproval = { requestId: "scope", title: "Scope Approval", options: [], scopeDecisionDetails: [live, settled],
    workflowDecision: { occurrenceId: "scope", requestId: "scope", sessionId: "root", controllingSessionId: "root",
      category: "campaign_issue_scope", resourceKey: "scope", resourceDigest: "a".repeat(64), policyRevision: 1,
      authority: "human", status: "pending", createdAt: 1, resourceSnapshot: {
        category: "campaign_issue_scope", repository: "picoduck/wollipog", before: [], additions: [4601], removals: [],
        expectedRevision: 1, explanation: "Related work", affectedAssignments: [], activeChildren: [], affectedDecisions: ["live", "settled"],
      } } };
  const pendingApproval = { ...request, additionalRequests: [request] } satisfies PendingApproval;
  const session = { id: "root", pendingApproval };
  // The scope card may be second, behind an unrelated request with no details of its own.
  const secondOnly = { id: "root", pendingApproval: { requestId: "q", title: "Question", options: [],
    additionalRequests: [request] } satisfies PendingApproval };
  for (const payload of [session, { session }, { sessions: [session] }, { items: [session] }, [session], { session: secondOnly }]) {
    for (const version of [undefined, null, 379]) {
      const projected = projectCampaignStatusForUi(payload, version);
      assert.notEqual(projected, payload);
      assert.equal(JSON.stringify(projected).includes("settledOutcome"), false);
      assert.equal(JSON.stringify(projected).includes('"occurrenceId":"settled"'), false);
      assert.ok(JSON.stringify(projected).includes('"occurrenceId":"live"'));
      assert.ok(JSON.stringify(projected).includes('"affectedDecisions":["live","settled"]'));
    }
    assert.equal(projectCampaignStatusForUi(payload, RUNNER_CAPABILITY_MIN_PROTOCOL.scopeSettledDecisionDetails), payload);
  }
  assert.deepEqual(session.pendingApproval.scopeDecisionDetails, [live, settled], "canonical data is unchanged");
  assert.equal(projectCampaignStatusForUi({ session: { pendingApproval: { scopeDecisionDetails: [live] } } }, 379).session.pendingApproval.scopeDecisionDetails[0], live);
});
