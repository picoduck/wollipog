import assert from "node:assert/strict";
import { test } from "node:test";
import { TURN_RETRY_BUSY_REASON, TURN_RETRY_STOP_FAILED_REASON, turnRetryPlan, type TurnRetryInput } from "./turn-retry.js";

const ready: TurnRetryInput = {
  status: "idle", runnerOnline: true, promptRefusal: null, restartRefusal: null, policyPaused: false, stopFailed: false,
};

test("Retry Turn prompts an idle session and restarts a failed or stopped one first", () => {
  assert.deepEqual(turnRetryPlan(ready), { kind: "prompt" });
  for (const status of ["failed", "stopped", "completed"] as const) {
    assert.deepEqual(turnRetryPlan({ ...ready, status }), { kind: "restart_then_prompt" }, status);
  }
});

test("Retry Turn names why the session cannot take a new turn", () => {
  const reason = (input: Partial<TurnRetryInput>) => {
    const plan = turnRetryPlan({ ...ready, ...input });
    return plan.kind === "unavailable" ? plan.reason : plan.kind;
  };
  assert.equal(reason({ promptRefusal: "Viewers can't send messages." }), "Viewers can't send messages.");
  assert.equal(reason({ status: "failed", sessionNoticeReason: "Conversation quarantined. Recover this session to continue." }),
    "Conversation quarantined. Recover this session to continue.");
  assert.equal(reason({ status: "failed", runnerOnline: false }), "Runner is offline.");
  assert.equal(reason({ status: "failed", restartRefusal: "Viewers can't restart sessions." }), "Viewers can't restart sessions.");
  assert.equal(reason({ status: "stopped", stopFailed: true }), TURN_RETRY_STOP_FAILED_REASON);
  assert.equal(reason({ policyPaused: true }), "Session is paused by guardrails. Review the pending decision to continue.");
  for (const status of ["running", "starting", "queued", "input_required"] as const) {
    assert.equal(reason({ status }), TURN_RETRY_BUSY_REASON, status);
  }
  assert.equal(reason({ promptRefusal: "Viewers can't send messages.", runnerOnline: false }), "Viewers can't send messages.",
    "the composer's order: a refusal before the runner");
});
