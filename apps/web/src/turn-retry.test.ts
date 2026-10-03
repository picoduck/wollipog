import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESTART_RESUMING_DRIVERS,
  restartResumesConversation,
  TURN_RETRY_BUSY_REASON,
  TURN_RETRY_FRESH_RESTART_REASON,
  TURN_RETRY_RESTARTING_REASON,
  TURN_RETRY_STOP_FAILED_REASON,
  turnRetryPlan,
  type TurnRetryInput,
} from "./turn-retry.js";

const ready: TurnRetryInput = {
  status: "idle", driver: "codex-app-server", runnerOnline: true, promptRefusal: null, restartRefusal: null,
  policyPaused: false, stopFailed: false,
};

test("only Codex App Server and Pi resume their conversation on Restart, as the runner decides", () => {
  // apps/runner/src/session-manager.ts passes the prior agentSessionId on an explicit Restart only
  // for these drivers. A change there must change this list, and this test, together.
  assert.deepEqual([...RESTART_RESUMING_DRIVERS].sort(), ["codex-app-server", "pi"]);
  for (const driver of ["claude-code", "codex", "acp", null, undefined] as const) {
    assert.equal(restartResumesConversation(driver), false, String(driver));
  }
});

test("Retry Turn prompts an idle session of any driver", () => {
  for (const driver of ["claude-code", "codex", "codex-app-server", "pi", "acp"] as const) {
    assert.deepEqual(turnRetryPlan({ ...ready, driver }), { kind: "prompt" }, driver);
  }
});

test("Retry Turn restarts a failed or stopped session first only where the restart resumes", () => {
  for (const status of ["failed", "stopped", "completed"] as const) {
    for (const driver of ["codex-app-server", "pi"] as const) {
      assert.deepEqual(turnRetryPlan({ ...ready, status, driver }), { kind: "restart_then_prompt" }, `${status} ${driver}`);
    }
    for (const driver of ["claude-code", "codex", "acp"] as const) {
      assert.deepEqual(turnRetryPlan({ ...ready, status, driver }),
        { kind: "unavailable", reason: TURN_RETRY_FRESH_RESTART_REASON }, `${status} ${driver}`);
    }
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
  assert.equal(reason({ status: "stopped", stopFailed: true, driver: "claude-code" }), TURN_RETRY_STOP_FAILED_REASON,
    "a failed Stop blocks any restart, so it is named before the new-conversation reason");
  assert.equal(reason({ status: "stopped", restarting: true }), TURN_RETRY_RESTARTING_REASON);
  assert.equal(reason({ policyPaused: true }), "Session is paused by guardrails. Review the pending decision to continue.");
  for (const status of ["running", "starting", "queued", "input_required"] as const) {
    assert.equal(reason({ status }), TURN_RETRY_BUSY_REASON, status);
  }
  assert.equal(reason({ promptRefusal: "Viewers can't send messages.", runnerOnline: false }), "Viewers can't send messages.",
    "the composer's order: a refusal before the runner");
});
