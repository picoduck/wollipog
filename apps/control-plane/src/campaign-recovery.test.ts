import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignAuthorityEvaluation } from "@wollipog/protocol";
import { requestReason, stoppedWorkerReason } from "./campaign-recovery.js";
import type { SessionStopCause } from "./db.js";

test("a stopped worker's reason follows its recorded stop provenance only (#3362)", () => {
  const causes: Array<[SessionStopCause, ReturnType<typeof stoppedWorkerReason>]> = [
    ["requested", "intentional_stop"], ["guardrail", "hard_denial"],
    ["runner_reported", "unverified_stop"], ["runner_absent", "unverified_stop"], ["runner_disconnect", "unverified_stop"],
    ["startup_settlement", "unverified_stop"], ["launch_undelivered", "unverified_stop"], ["launch_rejected", "unverified_stop"],
    ["not_launched", "unverified_stop"], ["unrecorded", "unverified_stop"],
  ];
  for (const [cause, expected] of causes) {
    for (const confirmation of [null, "runner_terminal"] as const) {
      assert.equal(stoppedWorkerReason({ cause, confirmation, confirmedAt: confirmation ? 1 : null }), expected, cause);
    }
  }
  assert.equal(stoppedWorkerReason(null), "unverified_stop", "missing provenance is unverified, never a denial or a stop");
});

const evaluation = (owner: CampaignAuthorityEvaluation["owner"], reason: CampaignAuthorityEvaluation["reason"]): CampaignAuthorityEvaluation =>
  ({ owner, basis: owner === "orchestrator" ? "campaign_delegation" : "human_required", reason, operation: "question" });

test("irrecoverable requests distinguish boundary enlargement, Human Required rules, unsupported capability and missing information (#2938)", () => {
  const cases: Array<[CampaignAuthorityEvaluation["reason"], ReturnType<typeof requestReason>]> = [
    ["outside_boundary", "boundary_enlargement"],
    ["protected_request", "human_required_rule"],
    ["human_required_rule", "human_required_rule"],
    ["custom_owner", "human_required_rule"],
    ["unsupported_provider", "unsupported_capability"],
    ["unverified_intent", "unsupported_capability"],
    ["evidence_review_unavailable", "unsupported_capability"],
    ["provider_delivery_unavailable", "unsupported_capability"],
    ["authorized_operation", "missing_human_information"],
  ];
  for (const [reason, expected] of cases) assert.equal(requestReason(evaluation("human", reason)), expected, reason);
  for (const [reason] of cases) {
    assert.equal(requestReason(evaluation("orchestrator", reason)), "authorized_action", "an Orchestrator-owned request is never escalated");
  }
});
