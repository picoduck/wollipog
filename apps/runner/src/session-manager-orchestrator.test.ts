import assert from "node:assert/strict";
import { test } from "node:test";
import { preserveAcpOrchestratorSessionState } from "./session-manager.js";

const providerState = {
  capabilities: {
    models: [{ id: "provider-model" }],
    effortLevels: ["high"],
    slashCommands: [{ name: "provider-command", source: "builtin" as const }],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["provider-default"],
    elicitation: { "provider-default": ["acp-permission" as const] },
  },
  config: { model: "provider-model", effort: "high", permissionMode: "provider-default" },
};

test("ACP runtime state cannot replace the runner-owned Orchestrator preset", () => {
  assert.deepEqual(
    preserveAcpOrchestratorSessionState({ permissionMode: "orchestrator", maxChildSessions: 2 }, providerState),
    {
      capabilities: {
        ...providerState.capabilities,
        permissionModes: ["orchestrator"],
        elicitation: { orchestrator: ["none"] },
      },
      config: {
        permissionMode: "orchestrator",
        maxChildSessions: 2,
        model: "provider-model",
        effort: "high",
      },
    },
  );
  assert.deepEqual(
    preserveAcpOrchestratorSessionState({ permissionMode: "provider-default" }, providerState),
    {
      capabilities: providerState.capabilities,
      config: providerState.config,
    },
    "ordinary ACP sessions keep provider-reported controls",
  );
});
