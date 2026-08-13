import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowDefinitionSpec } from "@wollipog/protocol";
import { BUILD_REVIEW_WORKFLOW, canTransitionWorkflowNode, validateWorkflowDefinition } from "./workflow-graphs.js";

test("built-in build-review workflow is a bounded, artifact-wired review loop", () => {
  const result = validateWorkflowDefinition(BUILD_REVIEW_WORKFLOW);
  assert.equal(result.ok, true);
  assert.equal(BUILD_REVIEW_WORKFLOW.maxTransitions, 24);
  assert.deepEqual(BUILD_REVIEW_WORKFLOW.nodes.map((node) => [node.nodeId, node.kind, node.agentId]), [
    ["build", "agent", "claude"], ["review", "agent", "codex"], ["address", "agent", "claude"],
  ]);
  assert.ok(BUILD_REVIEW_WORKFLOW.edges.some((edge) => edge.from === "address" && edge.to === "review"));
});

test("workflow validation accepts human/policy gates and rejects unsafe or disconnected graphs", () => {
  const gated: WorkflowDefinitionSpec = {
    name: "Gated delivery", maxTransitions: 8,
    nodes: [
      { nodeId: "build", kind: "agent", role: "builder", agentId: "claude", inputs: [], outputs: [{ name: "patch", kind: "patch" }], retry: { maxAttempts: 2, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "policy", kind: "policy_gate", role: "policy", policyId: "release:protected", inputs: [{ name: "patch", kind: "patch" }], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "human", kind: "human_gate", role: "approver", inputs: [{ name: "patch", kind: "patch" }], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
    ],
    edges: [
      { edgeId: "build_policy", from: "build", to: "policy", on: "success" },
      { edgeId: "policy_human", from: "policy", to: "human", on: "success" },
    ],
  };
  assert.equal(validateWorkflowDefinition(gated).ok, true);
  assert.match(validateWorkflowDefinition({ ...gated, maxTransitions: 0 }).ok ? "" : validateWorkflowDefinition({ ...gated, maxTransitions: 0 }).error, /maxTransitions/);
  const disconnected = {
    ...gated,
    nodes: [...gated.nodes, { ...gated.nodes[0], nodeId: "orphan_a" }, { ...gated.nodes[0], nodeId: "orphan_b" }],
    edges: [...gated.edges,
      { edgeId: "orphan_ab", from: "orphan_a", to: "orphan_b", on: "success" as const },
      { edgeId: "orphan_ba", from: "orphan_b", to: "orphan_a", on: "success" as const },
    ],
  };
  const disconnectedResult = validateWorkflowDefinition(disconnected);
  assert.match(disconnectedResult.ok ? "" : disconnectedResult.error, /reachable/);
  const selfProduced = {
    ...gated,
    nodes: gated.nodes.map((node) => node.nodeId === "build"
      ? { ...node, inputs: [{ name: "patch", kind: "patch" as const }] }
      : node),
  };
  const selfProducedResult = validateWorkflowDefinition(selfProduced);
  assert.match(selfProducedResult.ok ? "" : selfProducedResult.error, /unproduced/);
  const cyclicInputDeadlock: WorkflowDefinitionSpec = {
    name: "Deadlocked inputs", maxTransitions: 8,
    nodes: [
      { nodeId: "start", kind: "human_gate", role: "start", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "consume", kind: "agent", role: "consumer", agentId: "claude", inputs: [{ name: "late", kind: "patch" }], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "produce", kind: "agent", role: "producer", agentId: "codex", inputs: [], outputs: [{ name: "late", kind: "patch" }], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
    ],
    edges: [
      { edgeId: "start_consume", from: "start", to: "consume", on: "success" },
      { edgeId: "consume_produce", from: "consume", to: "produce", on: "success" },
      { edgeId: "produce_consume", from: "produce", to: "consume", on: "success" },
    ],
  };
  const deadlockResult = validateWorkflowDefinition(cyclicInputDeadlock);
  assert.match(deadlockResult.ok ? "" : deadlockResult.error, /deadlock/);
  assert.match(validateWorkflowDefinition({ ...gated, nodes: gated.nodes.map((node) => node.nodeId === "policy" ? { ...node, inputs: [{ name: "missing", kind: "verdict" as const }] } : node) }).ok ? "" : validateWorkflowDefinition({ ...gated, nodes: gated.nodes.map((node) => node.nodeId === "policy" ? { ...node, inputs: [{ name: "missing", kind: "verdict" as const }] } : node) }).error, /unproduced/);
});

test("workflow node state machine permits retry/loop re-entry but not terminal resurrection", () => {
  assert.equal(canTransitionWorkflowNode("pending", "ready"), true);
  assert.equal(canTransitionWorkflowNode("running", "ready"), true);
  assert.equal(canTransitionWorkflowNode("succeeded", "ready"), true);
  assert.equal(canTransitionWorkflowNode("stopped", "ready"), false);
  assert.equal(canTransitionWorkflowNode("skipped", "running"), false);
});
