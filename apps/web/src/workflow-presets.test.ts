import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, WorkflowDefinition } from "@wollipog/protocol";
import { conductorAgentId, defaultWorkflowBindings, workflowAgentRoles, workflowBindingsComplete } from "./workflow-presets.js";

const definition = {
  workflowId: "builtin:build-review", version: 1, source: "builtin", name: "Build review",
  maxTransitions: 4, edges: [], createdBy: { kind: "system" }, createdAt: 1,
  nodes: [
    { nodeId: "build", kind: "agent", role: "builder", agentId: "claude", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1000 },
    { nodeId: "review", kind: "agent", role: "reviewer", agentId: "codex", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1000 },
    { nodeId: "address", kind: "agent", role: "remediator", agentId: "claude", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1000 },
  ],
} as WorkflowDefinition;

const agent = (value: Partial<AgentDefinition> & Pick<AgentDefinition, "id" | "name">): AgentDefinition => ({
  command: "x", args: [], env: {}, available: true, ...value,
});

test("workflow presets dedupe graph roles and bind primary provider-native agents", () => {
  const agents = [
    agent({ id: "claude-code", name: "Claude", driver: "claude-code" }),
    agent({ id: "codex", name: "Codex", driver: "codex-app-server" }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
    agent({ id: "conductor", name: "Conductor", driver: "claude-code" }),
  ];
  assert.deepEqual(workflowAgentRoles(definition), ["claude", "codex"]);
  assert.deepEqual(defaultWorkflowBindings(definition, agents), { claude: "claude-code", codex: "codex" });
  assert.equal(workflowBindingsComplete(definition, { claude: "claude-code", codex: "codex" }), true);
  assert.equal(conductorAgentId(agents), "conductor");
});

test("workflow preset binding fails closed when a required provider is unavailable", () => {
  const agents = [
    agent({ id: "claude-code", name: "Claude", driver: "claude-code", available: false }),
    agent({ id: "conductor", name: "Conductor", driver: "claude-code", available: false }),
  ];
  assert.deepEqual(defaultWorkflowBindings(definition, agents), {});
  assert.equal(workflowBindingsComplete(definition, {}), false);
  assert.equal(conductorAgentId(agents), undefined);
});
