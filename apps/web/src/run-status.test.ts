import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunView, SessionView, WorkflowDefinition, WorkflowInstanceView, WorkflowNodeState } from "@wollipog/protocol";
import { indexRunWorkflows, runStatus, runType, runTypeLabel } from "./run-status.js";

const run = (id: string, sessionIds: string[] = [], createdAt = 10): RunView => ({
  id, title: id, prompt: "", workspaceId: null, workspaceName: null, createdAt, updatedAt: createdAt, sessionIds,
});

const member = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({ id, status: "idle", pendingApproval: null, agentName: "Claude Code", driver: "claude-code", ...over }) as SessionView;

const instance = (runId: string, status: WorkflowInstanceView["status"], nodeStates: Partial<WorkflowNodeState>[] = [], createdAt = 10) =>
  ({
    instanceId: `instance-${runId}-${createdAt}`, workflowId: "builtin:build-review", workflowVersion: 1, runId, status,
    transitionCount: 0, createdBy: { kind: "system" }, createdAt, updatedAt: createdAt,
    nodeStates: nodeStates.map((node, index) => ({ nodeId: `n${index}`, status: "pending", attemptCount: 0, ...node })),
  }) as WorkflowInstanceView;

const definition = { workflowId: "builtin:build-review", name: "Build and Review" } as WorkflowDefinition;

const sessions = (...members: SessionView[]) => new Map(members.map((session) => [session.id, session]));

test("a workflow waiting at a gate is Awaiting Decision, ahead of a member that needs approval", () => {
  const approval = member("a", {
    status: "input_required",
    pendingApproval: { requestId: "r1", kind: "permission", toolName: "Bash", input: {}, options: [] } as never,
  });
  assert.equal(runStatus(run("r", ["a"]), sessions(approval), instance("r", "waiting_gate", [{ status: "waiting_gate" }])), "awaiting_decision");
  // A node at its gate is enough even when the instance still reads running.
  assert.equal(runStatus(run("r"), sessions(), instance("r", "running", [{ status: "waiting_gate" }])), "awaiting_decision");
  assert.equal(runStatus(run("r", ["a"]), sessions(approval), null), "approval_required");
});

test("a member waiting on an answer is Approval Required", () => {
  const asking = member("a", { status: "input_required" });
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(asking, member("b", { status: "running" })), null), "approval_required");
});

test("a comparison with one running member is Running; an idle finished one has no badge", () => {
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(member("a"), member("b", { status: "running" })), null), "running");
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(member("a"), member("b", { status: "starting" })), null), "running");
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(member("a"), member("b", { status: "completed" })), null), null);
  // A member the store does not hold is skipped, not guessed.
  assert.equal(runStatus(run("r", ["gone"]), sessions(), null), null);
});

test("a workflow node that runs is Running, and a failed workflow is Failed", () => {
  assert.equal(runStatus(run("r"), sessions(), instance("r", "running", [{ status: "succeeded" }, { status: "running" }])), "running");
  assert.equal(runStatus(run("r"), sessions(), instance("r", "failed", [{ status: "failed" }])), "failed");
  assert.equal(runStatus(run("r"), sessions(), instance("r", "succeeded", [{ status: "succeeded" }])), null);
});

test("a run's type comes from its newest workflow instance, and is unknown until the load covers it", () => {
  const workflows = indexRunWorkflows(
    [instance("wf", "running", [], 10), instance("wf", "waiting_gate", [], 20)],
    [definition],
    ["wf", "cmp"],
  );
  const workflow = runType(run("wf"), workflows);
  assert.equal(workflow.kind, "workflow");
  assert.equal(runTypeLabel(workflow), "Build and Review");
  assert.equal(workflow.kind === "workflow" && workflow.instance.status, "waiting_gate");
  assert.equal(runTypeLabel(runType(run("cmp"), workflows)), "Comparison");
  // Arrived after the load, or nothing loaded yet: no type rather than a wrong one.
  assert.equal(runType(run("later"), workflows).kind, "unknown");
  assert.equal(runTypeLabel(runType(run("cmp"), null)), null);
  // A workflow whose definition is not listed keeps a generic name.
  const unnamed = indexRunWorkflows([instance("wf", "running")], [], ["wf"]);
  assert.equal(runTypeLabel(runType(run("wf"), unnamed)), "Workflow");
});

test("a full page of instances leaves older runs unknown instead of calling them comparisons", () => {
  const page = [instance("new", "running", [], 50), instance("mid", "running", [], 40)];
  const workflows = indexRunWorkflows(page, [definition], ["new", "mid", "recent", "old"], 2);
  assert.equal(runType(run("recent", [], 45), workflows).kind, "comparison");
  assert.equal(runType(run("old", [], 30), workflows).kind, "unknown");
});
