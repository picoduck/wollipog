import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { agentDisplayName } from "./agent-presentation.js";

function agent(id: string, name: string): AgentDefinition {
  return { id, name, command: "agent", args: [], env: {}, driver: "claude-code" };
}

test("generated Conductor labels normalize across the wire-name compatibility window", () => {
  assert.equal(agentDisplayName(agent("legacy", "Conductor (Agent Manager)")), "Conductor (Wollipog)");
  assert.equal(agentDisplayName(agent("current", "Conductor (Wollipog)")), "Conductor (Wollipog)");
  assert.equal(agentDisplayName(agent("conductor", "Custom Conductor")), "Conductor (Wollipog)");
  assert.equal(agentDisplayName(agent("custom", "My Conductor")), "My Conductor");
});
