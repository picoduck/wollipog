import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";
import { projectCampaignStatusForUi } from "./campaign-status-compatibility.js";

test("REST and websocket projections keep settled scope details off older dashboards (#4601)", () => {
  const live = { occurrenceId: "live", approval: "pending", armed: false };
  const settled = { occurrenceId: "settled", approval: "pending", armed: true, settledOutcome: "consumed" };
  const snapshot = { affectedDecisions: ["live", "settled"] };
  const request = { scopeDecisionDetails: [live, settled], workflowDecision: { resourceSnapshot: snapshot } };
  const session = { id: "root", pendingApproval: { ...request, requests: [request] } };
  for (const payload of [session, { session }, { sessions: [session] }, { items: [session] }, [session]]) {
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
