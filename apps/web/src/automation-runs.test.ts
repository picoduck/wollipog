import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE,
  AUTOMATION_TARGET_UNAVAILABLE,
  type AutomationCommandState,
  type AutomationCommandView,
  type AutomationExecution,
  type AutomationExecutionStatus,
} from "@wollipog/protocol";
import {
  attemptsLabel,
  deliveredLabel,
  newestRunsFirst,
  oneSentence,
  runDuration,
  runOpenTarget,
  runReason,
  runStartedAt,
  runStartedBy,
  runStepLabel,
  runStepStatus,
} from "./automation-runs.js";
import { statusMeta } from "./status-meta.js";

/* Run History's and Run Details' words (#2970). */

const AT = Date.UTC(2026, 9, 20, 7);

function run(overrides: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    executionId: "axe_1",
    automationId: "automation-a",
    idempotencyKey: "automation-a:1",
    scheduledFor: AT,
    automationRevision: 1,
    actionKind: "create_session",
    status: "succeeded",
    actor: { kind: "system", id: "automation:automation-a" },
    createdAt: AT,
    ...overrides,
  };
}

function command(overrides: Partial<AutomationCommandView> = {}): AutomationCommandView {
  return {
    commandId: "cmd_1", executionId: "axe_1", ordinal: 0, runnerId: "runner-1", sessionId: "s-1",
    kind: "start_session", state: "completed", revision: 1, attemptCount: 1, createdAt: AT, updatedAt: AT,
    ...overrides,
  };
}

/** Title Case: every word capitalized but the short ones §17.1 keeps lowercase. */
function assertTitleCase(label: string, context: string) {
  for (const word of label.split(/\s+/)) {
    if (["a", "an", "the", "and", "or", "of", "for", "to", "in", "on"].includes(word)) continue;
    assert.match(word, /^[A-Z]/, `${context}: "${label}"`);
  }
}

test("every automation run status has a Title Case word, and Expired is a warning", () => {
  // A Record over the union: a status the protocol adds fails to compile here until it has a word.
  const statuses: Record<AutomationExecutionStatus, string> = {
    dispatching: "Starting", running: "Running", succeeded: "Succeeded",
    failed: "Failed", skipped: "Skipped", expired: "Expired",
  };
  for (const [status, label] of Object.entries(statuses)) {
    const meta = statusMeta("automation_run", status);
    assert.equal(meta.label, label);
    assertTitleCase(meta.label, status);
  }
  assert.equal(statusMeta("automation_run", "dispatching").pulse, true);
  assert.equal(statusMeta("automation_run", "succeeded").tone, "success");
  assert.equal(statusMeta("automation_run", "failed").tone, "danger");
  assert.equal(statusMeta("automation_run", "skipped").tone, "neutral");
  assert.equal(statusMeta("automation_run", "expired").tone, "warning");
});

test("every runner command state is a step word, and a replaced command reads Retried", () => {
  const states: Record<AutomationCommandState, string> = {
    staged: "Queued", pending: "Queued", sent: "Sent", accepted: "Accepted",
    started: "Running", completed: "Done", rejected: "Failed", uncertain: "Unconfirmed",
  };
  for (const [state, label] of Object.entries(states) as [AutomationCommandState, string][]) {
    const meta = statusMeta("automation_step", runStepStatus(command({ state })));
    assert.equal(meta.label, label);
    assertTitleCase(meta.label, state);
  }
  assert.equal(statusMeta("automation_step", runStepStatus(command({ state: "rejected", supersededBy: "cmd_2" }))).label, "Retried");
  assert.equal(runStepLabel("start_session"), "Start Session");
  assert.equal(runStepLabel("prompt_session"), "Send Prompt");
  assert.equal(attemptsLabel(1), "1 attempt");
  assert.equal(attemptsLabel(2), "2 attempts");
});

test("runs read newest first by their scheduled time, then by id, as the control plane lists them", () => {
  const runs = [
    run({ executionId: "axe_a", scheduledFor: AT - 60_000 }),
    run({ executionId: "axe_c", scheduledFor: AT }),
    run({ executionId: "axe_b", scheduledFor: AT }),
  ];
  assert.deepEqual(newestRunsFirst(runs).map((execution) => execution.executionId), ["axe_c", "axe_b", "axe_a"]);
  assert.deepEqual(runs.map((execution) => execution.executionId), ["axe_a", "axe_c", "axe_b"], "the input is not reordered");
});

test("a run starts when it started, or at its scheduled time when it never did, and took its finished span", () => {
  assert.equal(runStartedAt(run({ startedAt: AT + 7_000 })), AT + 7_000);
  assert.equal(runStartedAt(run({ status: "skipped" })), AT);
  assert.equal(runDuration(run({ startedAt: AT, completedAt: AT + 4 * 60_000 + 2_000 })), "4m 2s");
  assert.equal(runDuration(run({ startedAt: AT, completedAt: AT + 3_600_000 + 5 * 60_000 })), "1h 5m");
  assert.equal(runDuration(run({ status: "running", startedAt: AT })), null, "still running");
  assert.equal(runDuration(run({ status: "expired", completedAt: AT })), null, "never started");
});

test("a signed delivery is started by Signed Trigger, the schedule by Schedule", () => {
  assert.equal(runStartedBy(run()), "Schedule");
  assert.equal(runStartedBy(run({ actor: { kind: "policy", id: "webhook:atr_1" } })), "Signed Trigger");
  assert.equal(runStartedBy(run({ triggerDelivery: { fields: [], parameterNames: [] } })), "Signed Trigger");
});

test("a skipped or expired run says why in one sentence, never the internal message", () => {
  assert.equal(runReason(run({ status: "skipped", error: "execution 'axe_9f2c' is still active" })),
    "Skipped because the last run was still going.");
  assert.equal(runReason(run({ status: "skipped", error: "misfire policy skipped at least 3 overdue occurrence(s)" })),
    "Skipped because its scheduled time was missed.");
  assert.equal(runReason(run({ status: "skipped" })), "Skipped.");
  const expire = { kind: "expire", afterMinutes: 60 } as const;
  assert.equal(runReason(run({ status: "expired", error: AUTOMATION_TARGET_UNAVAILABLE }), expire),
    "The machine stayed offline for 60 minutes.");
  assert.equal(runReason(run({ status: "expired", error: AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE }), { kind: "expire", afterMinutes: 1 }),
    "The agent installation stayed unavailable for 1 minute.");
  assert.equal(runReason(run({ status: "expired", actionKind: "prompt_session" }), expire),
    "The session wasn't ready for 60 minutes.");
  // The limit the run was claimed with wins over the automation's current one.
  const snapshot = { runnerPolicy: { kind: "alternate", targets: [], expireAfterMinutes: 15 } } as unknown as AutomationExecution["specSnapshot"];
  assert.equal(runReason(run({ status: "expired", specSnapshot: snapshot }), expire), "The machine stayed offline for 15 minutes.");
  assert.equal(runReason(run({ status: "expired" }), { kind: "wait" }), "Gave up waiting for the machine.");
  for (const status of ["dispatching", "running", "succeeded", "failed"] as const) {
    assert.equal(runReason(run({ status, error: "x" }), expire), null);
  }
});

test("a run opens its workflow run, else its session, else nothing", () => {
  assert.deepEqual(runOpenTarget(run({ runId: "run-1", sessionId: "s-1" })), { label: "Open Run", view: { name: "run", id: "run-1" } });
  assert.deepEqual(runOpenTarget(run({ sessionId: "s-1" })), { label: "Open Session", view: { name: "session", id: "s-1" } });
  assert.equal(runOpenTarget(run()), null);
});

test("a delivery names what it brought, never its content or digest", () => {
  assert.equal(deliveredLabel({ fields: ["prompt", "parameters"], promptSha256: "a".repeat(64), parameterNames: ["issue", "run_id"] }),
    "Prompt text, Named values (issue, run_id)");
  assert.equal(deliveredLabel({ fields: ["parameters"], parameterNames: [] }), "Named values");
  assert.equal(deliveredLabel({ fields: ["target"], parameterNames: [], targetSelector: "pull_request" }), "Target by pull request");
  assert.equal(deliveredLabel({ fields: [], parameterNames: [] }), "Nothing beyond the signed request");
});

test("an error reads as its first sentence, capitalized and ended, cut at a word past 200 characters", () => {
  assert.equal(oneSentence("runner command 'cmd_1' became rejected"), "Runner command 'cmd_1' became rejected.");
  assert.equal(oneSentence("The agent exited. Exit code 1.\nstack trace"), "The agent exited.");
  assert.equal(oneSentence("  version 1.2.3 is too old  "), "Version 1.2.3 is too old.", "a dot inside a word is not an end");
  const long = oneSentence(`${"word ".repeat(60)}end`);
  assert.ok(long.length <= 201, long);
  assert.match(long, /^Word( word)+…$/);
});
