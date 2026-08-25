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

test("discovered Codex transports keep their canonical user-facing names", () => {
  assert.equal(agentDisplayName({ ...agent("codex-app", "Codex"), driver: "codex-app-server", source: "discovered" }), "Codex App Server");
  assert.equal(agentDisplayName({ ...agent("codex-exec", "Codex"), driver: "codex", source: "discovered" }), "Codex (Non-Interactive)");
});

test("generated legacy App Server names normalize without rewriting custom configured names", () => {
  assert.equal(agentDisplayName({ ...agent("codex-app", "Codex — Interactive"), driver: "codex-app-server" }), "Codex App Server");
  assert.equal(agentDisplayName({ ...agent("codex-app", "Codex Interactive"), driver: "codex-app-server" }), "Codex App Server");
  assert.equal(agentDisplayName({ ...agent("codex-app", "My Codex"), driver: "codex-app-server" }), "My Codex");
});
