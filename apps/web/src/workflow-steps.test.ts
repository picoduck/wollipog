import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WorkflowArtifactView,
  WorkflowAttemptView,
  WorkflowInstanceDetail,
  WorkflowNodeDefinition,
  WorkflowNodeState,
  WorkflowNodeStatus,
} from "@wollipog/protocol";
import { formatFuture } from "./format.js";
import { statusMeta, statusValues } from "./status-meta.js";
import {
  attemptFailureSentence,
  attemptStatusLabel,
  attentionStepId,
  gateArtifact,
  isRetry,
  stepOutcomeLabel,
  stepsAfter,
  stepSubline,
  stepWaitLine,
  workflowSteps,
} from "./workflow-steps.js";

const agentNode = (nodeId: string, role: string, agentId: string, extra: Partial<WorkflowNodeDefinition> = {}): WorkflowNodeDefinition => ({
  nodeId, kind: "agent", role, agentId, inputs: [], outputs: [], retry: { maxAttempts: 3, backoffMs: 1_000 }, timeoutMs: 1_000, ...extra,
});

/** Build, approve, review: the page's usual shape, with a human gate on the builder's patch. */
const NODES: WorkflowNodeDefinition[] = [
  agentNode("build", "builder", "claude", { outputs: [{ name: "implementation_patch", kind: "patch" }] }),
  { nodeId: "approve", kind: "human_gate", role: "approver", inputs: [{ name: "implementation_patch", kind: "patch" }], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 },
  agentNode("review", "reviewer", "codex", {
    inputs: [{ name: "implementation_patch", kind: "patch" }],
    outputs: [{ name: "review_report", kind: "review_report" }, { name: "review_verdict", kind: "verdict" }],
  }),
  agentNode("address", "remediator", "claude", { outputs: [{ name: "implementation_patch", kind: "patch" }] }),
];
const EDGES: WorkflowInstanceDetail["definition"]["edges"] = [
  { edgeId: "e1", from: "build", to: "approve", on: "success" },
  { edgeId: "e2", from: "approve", to: "review", on: "success" },
  { edgeId: "e3", from: "review", to: "address", on: "changes_requested" },
  { edgeId: "e4", from: "address", to: "review", on: "success" },
];

function detail(states: Partial<Record<string, Partial<WorkflowNodeState>>>, attempts: WorkflowAttemptView[] = []): WorkflowInstanceDetail {
  return {
    instanceId: "wfi", workflowId: "wf", workflowVersion: 2, runId: "run", status: "running", transitionCount: 3,
    createdBy: { kind: "system", id: "test" }, createdAt: 1, updatedAt: 1, events: [], attempts,
    nodeStates: NODES.map((node) => ({ nodeId: node.nodeId, status: "pending", attemptCount: 0, ...states[node.nodeId] })),
    definition: {
      workflowId: "wf", version: 2, source: "custom", name: "Build and Review", maxTransitions: 24, nodes: NODES, edges: EDGES,
      createdBy: { kind: "system", id: "test" }, createdAt: 1,
    },
  } as WorkflowInstanceDetail;
}

const attempt = (nodeId: string, n: number, status: WorkflowAttemptView["status"], sessionId?: string): WorkflowAttemptView => ({
  attemptId: `${nodeId}-${n}`, instanceId: "wfi", nodeId, attempt: n, status, dispatchKey: `${nodeId}-${n}`,
  startedAt: n, deadlineAt: n + 1, ...(sessionId ? { sessionId } : {}),
});

test("every WorkflowNodeStatus maps to a workflowNode entry, and only Awaiting Decision is amber", () => {
  // Typed as a full record, so a new protocol status fails to compile until it is listed here.
  const all: Record<WorkflowNodeStatus, true> = {
    pending: true, ready: true, running: true, waiting_gate: true, succeeded: true, failed: true, skipped: true, stopped: true,
  };
  assert.deepEqual(new Set(statusValues("workflowNode")), new Set(Object.keys(all)));
  for (const status of Object.keys(all) as WorkflowNodeStatus[]) {
    const meta = statusMeta("workflowNode", status);
    assert.notEqual(meta.label, "Status Unavailable", status);
    assert.equal(meta.tone === "warning", status === "waiting_gate", `${status} is amber only while it awaits a decision`);
  }
});

test("steps follow the definition's order with Title Case roles and the sessions they ran in", () => {
  const steps = workflowSteps(detail(
    { review: { status: "running", attemptCount: 1, sessionId: "s-codex" } },
    [attempt("build", 1, "succeeded", "s-claude")],
  ));
  assert.deepEqual(steps.map((step) => [step.number, step.role, step.sessionId]), [
    [1, "Builder", "s-claude"],
    [2, "Approver", null],
    [3, "Reviewer", "s-codex"],
    // Remediator hasn't run, but dispatch runs every step of an agent in that agent's one member.
    [4, "Remediator", "s-claude"],
  ]);
});

test("a step's session is only one the control plane recorded; before its agent has run it has none", () => {
  // Nothing has run: no step has a session, whatever the run's members are.
  assert.deepEqual(workflowSteps(detail({})).map((step) => step.sessionId), [null, null, null, null]);
  // The node's own record outranks its attempts, and its latest attempt outranks an older one.
  const recorded = workflowSteps(detail(
    { build: { status: "running", attemptCount: 2, sessionId: "s-node" } },
    [attempt("build", 1, "failed", "s-old"), attempt("build", 2, "running", "s-attempt")],
  ));
  assert.equal(recorded[0]!.sessionId, "s-node");
  const fromAttempts = workflowSteps(detail({}, [attempt("build", 1, "failed", "s-old"), attempt("build", 2, "failed", "s-new")]));
  assert.equal(fromAttempts[0]!.sessionId, "s-new");
  // Another step of the same agent shares it; a different agent never does.
  assert.equal(fromAttempts[3]!.sessionId, "s-new", "Remediator is Builder's agent");
  assert.equal(fromAttempts[2]!.sessionId, null, "Reviewer is another agent");
});

test("round 2's reproductions: a cut-short title and an agent named orchestrator never guess a member", () => {
  // CR-2.1: the control plane titles a member `${title} · ${roleId}`.slice(0, 120), so a long run
  // title cuts the suffix off. Titles are not read: the step has no session until it runs, and then
  // it has the one recorded, title or not.
  const node = { nodeId: "build", kind: "agent", agentId: "claude", role: "builder", inputs: [], outputs: [], retry: { maxAttempts: 2, backoffMs: 0 }, timeoutMs: 1_000 } as WorkflowNodeDefinition;
  const single = (states: WorkflowNodeState[]) => ({ ...detail({}), definition: { ...detail({}).definition, nodes: [node], edges: [] }, nodeStates: states, attempts: [] }) as WorkflowInstanceDetail;
  assert.equal(workflowSteps(single([]))[0]!.sessionId, null);
  assert.equal(workflowSteps(single([{ nodeId: "build", status: "running", attemptCount: 1, sessionId: "s-worker" }]))[0]!.sessionId, "s-worker");
  // CR-2.2: a logical agent named "orchestrator" whose worker was deleted, beside the run's
  // controller titled "Run · orchestrator": its step never resolves to the controller.
  const orchestratorNamed = { ...node, nodeId: "work", agentId: "orchestrator", role: "worker" } as WorkflowNodeDefinition;
  const controllerOnly = { ...single([]), definition: { ...single([]).definition, nodes: [orchestratorNamed] } } as WorkflowInstanceDetail;
  assert.equal(workflowSteps(controllerOnly)[0]!.sessionId, null);
});

test("the step that needs the person is selected first: a gate, else failed or ready, else running", () => {
  const select = (states: Parameters<typeof detail>[0]) => attentionStepId(workflowSteps(detail(states)));
  assert.equal(select({ build: { status: "succeeded" }, approve: { status: "waiting_gate" }, review: { status: "failed" } }), "approve");
  assert.equal(select({ build: { status: "running" }, review: { status: "ready" } }), "review");
  assert.equal(select({ build: { status: "running" } }), "build");
  assert.equal(select({ build: { status: "succeeded" }, approve: { status: "succeeded" } }), "approve", "else the last step that started");
  assert.equal(select({}), "build");
});

test("sub-lines say what an agent produces or what you decide, and a waiting step what it waits for", () => {
  const steps = workflowSteps(detail({}));
  assert.equal(stepSubline(steps[0]!, "Claude Code"), "Claude Code produces a patch");
  assert.equal(stepSubline(steps[1]!, null), "You approve or reject the patch");
  assert.equal(stepSubline(steps[2]!, "Codex"), "Codex produces a review report and a verdict");
  assert.equal(stepSubline(steps[2]!, null), "The agent produces a review report and a verdict", "never an agent id");
  assert.equal(stepWaitLine(steps[1]!, steps, EDGES), "Starts when Builder succeeds");
  assert.equal(stepWaitLine(steps[2]!, steps, EDGES), "Starts when you approve the patch or Remediator succeeds");
  assert.equal(stepWaitLine(steps[3]!, steps, EDGES), "Starts when Reviewer requests changes");
  assert.equal(stepWaitLine(steps[0]!, steps, EDGES), "Waiting to start");
  assert.deepEqual(stepsAfter(steps[1]!, steps, EDGES, "success"), ["Reviewer"]);
  assert.deepEqual(stepsAfter(steps[1]!, steps, EDGES, "failure"), []);
});

test("a gate decides on the newest artifact of its input that the producing step saved", () => {
  const steps = workflowSteps(detail({ build: { status: "succeeded", attemptCount: 1, sessionId: "s-claude" } }));
  const artifact = (artifactId: string, kind: WorkflowArtifactView["kind"], sessionId: string, createdAt: number) =>
    ({ artifactId, kind, sessionId, createdAt, name: artifactId }) as WorkflowArtifactView;
  const artifacts = [
    artifact("old-patch", "patch", "s-claude", 1),
    artifact("other-patch", "patch", "s-codex", 9),
    artifact("new-patch", "patch", "s-claude", 5),
    artifact("report", "review_report", "s-claude", 10),
  ];
  assert.equal(gateArtifact(steps[1]!, steps, artifacts)?.artifactId, "new-patch");
  assert.equal(gateArtifact(steps[1]!, steps, artifacts.filter((item) => item.sessionId !== "s-claude"))?.artifactId, "other-patch");
  assert.equal(gateArtifact(steps[1]!, steps, []), null);
  assert.equal(gateArtifact(steps[0]!, steps, artifacts), null, "an agent step is no gate");
});

test("a failed attempt never reads Succeeded, and an outcome that contradicts the status is not shown", () => {
  const outcome = (state: Partial<WorkflowNodeState>, nodeId = "build") =>
    stepOutcomeLabel(workflowSteps(detail({ [nodeId]: state }))[NODES.findIndex((node) => node.nodeId === nodeId)]!);
  assert.equal(outcome({ status: "succeeded", outcome: "success" }), "Succeeded");
  assert.equal(outcome({ status: "succeeded", outcome: "changes_requested" }, "review"), "Changes Requested");
  assert.equal(outcome({ status: "failed", outcome: "success" }), null);
  assert.equal(outcome({ status: "ready", outcome: "success" }), null);
  assert.equal(outcome({ status: "succeeded", outcome: "failure" }), null);
  assert.equal(outcome({ status: "failed", outcome: "failure" }), "Failed");
  assert.equal(outcome({ status: "succeeded", outcome: "success" }, "approve"), "Approved");
  assert.equal(outcome({ status: "failed", outcome: "failure" }, "approve"), "Rejected");
  assert.equal(attemptStatusLabel("cancelled"), "Canceled");
  const retried = workflowSteps(detail({ build: { status: "ready", attemptCount: 1 } }, [attempt("build", 1, "timed_out")]))[0]!;
  assert.equal(attemptFailureSentence(retried), "Attempt 1 of 3 timed out.");
});

test("a step a loop made ready again is ready, not a failed retry", () => {
  const review = (state: Partial<WorkflowNodeState>, attempts: WorkflowAttemptView[]) => workflowSteps(detail({ review: state }, attempts))[2]!;
  // Remediator succeeded and the loop made Reviewer ready again: its count stays, its last attempt succeeded.
  assert.equal(isRetry(review({ status: "ready", attemptCount: 1 }, [attempt("review", 1, "succeeded")])), false);
  assert.equal(isRetry(review({ status: "ready", attemptCount: 1, readyAt: 5, error: "boom" }, [attempt("review", 1, "failed")])), true);
  assert.equal(isRetry(review({ status: "ready", attemptCount: 2 }, [attempt("review", 1, "succeeded"), attempt("review", 2, "timed_out")])), true);
  // Without the attempts, the retry's own marks decide.
  assert.equal(isRetry(review({ status: "ready", attemptCount: 1, readyAt: 5 }, [])), true);
  assert.equal(isRetry(review({ status: "ready", attemptCount: 1 }, [])), false);
  assert.equal(isRetry(review({ status: "ready", attemptCount: 0 }, [])), false);
});

test("formatFuture names the time and the wait in the clock's minutes, in a fixed zone", () => {
  const now = Date.UTC(2026, 9, 20, 2, 31, 0);
  const at = (minutes: number, seconds = 0) => now + minutes * 60_000 + seconds * 1_000;
  assert.equal(formatFuture(at(5), now, "UTC", "en-US"), "2:36 AM, in 5 minutes");
  assert.equal(formatFuture(at(4, 10), now, "UTC", "en-US"), "2:35 AM, in 4 minutes");
  // At 2:31:50, 2:36 is five of the clock's minutes away, as its time says.
  assert.equal(formatFuture(at(5), now + 50_000, "UTC", "en-US"), "2:36 AM, in 5 minutes");
  assert.equal(formatFuture(at(1), now, "UTC", "en-US"), "2:32 AM, in 1 minute");
  assert.equal(formatFuture(at(0, 30), now, "UTC", "en-US"), "2:31 AM, in less than a minute");
  assert.equal(formatFuture(at(64), now, "UTC", "en-US"), "3:35 AM, in 1 hour 4 minutes");
  assert.equal(formatFuture(at(120), now, "UTC", "en-US"), "4:31 AM, in 2 hours");
  assert.equal(formatFuture(at(23 * 60), now, "UTC", "en-US"), "Tomorrow, 1:31 AM, in 23 hours");
  assert.equal(formatFuture(now, now, "UTC", "en-US"), "now");
  // The same moment in another zone keeps the wait and moves the time.
  assert.equal(formatFuture(at(5), now, "America/New_York", "en-US"), "10:36 PM, in 5 minutes");
});
