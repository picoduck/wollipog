import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, AgentHarnessDefaultsView } from "@wollipog/protocol";
import { savedSessionPermissionMode } from "./session-preset-defaults.js";

const agent: AgentDefinition = {
  id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
  capabilities: {
    models: [{ id: "model-a", displayName: "Model A", efforts: ["high"] }],
    effortLevels: ["low"], permissionModes: ["default", "orchestrator"],
    slashCommands: [], supportsImages: false, supportsApprovals: true,
  },
};
const view: AgentHarnessDefaultsView = { defaults: [{
  agentId: "codex", name: "Codex", driver: "codex-app-server", context: { kind: "native" },
  installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
}] };

test("saved preset identity includes agent, driver, context, and WSL distro", () => {
  assert.equal(savedSessionPermissionMode(view, agent), "orchestrator");
  assert.equal(savedSessionPermissionMode(view, { ...agent, id: "other" }), undefined);
  assert.equal(savedSessionPermissionMode(view, { ...agent, driver: "codex" }), undefined);
  assert.equal(savedSessionPermissionMode(view, { ...agent, context: { kind: "wsl", distro: "Ubuntu" } }), undefined);
  const wsl = structuredClone(view);
  wsl.defaults[0]!.context = { kind: "wsl", distro: "Ubuntu" };
  assert.equal(savedSessionPermissionMode(wsl, { ...agent, context: { kind: "wsl", distro: "Ubuntu" } }), "orchestrator");
  assert.equal(savedSessionPermissionMode(wsl, { ...agent, context: { kind: "wsl", distro: "Debian" } }), undefined);
});

test("saved preset follows whole-combination capability drift, including model-specific effort", () => {
  for (const preference of [
    { permissionMode: "orchestrator", model: "missing" },
    { permissionMode: "orchestrator", effort: "high" },
    { permissionMode: "orchestrator", model: "model-a", effort: "low" },
    { permissionMode: "unknown" },
    {},
  ]) {
    assert.equal(savedSessionPermissionMode({ defaults: [{ ...view.defaults[0]!, preference }] }, agent), undefined);
  }
  assert.equal(savedSessionPermissionMode({ defaults: [{ ...view.defaults[0]!,
    preference: { permissionMode: "orchestrator", model: "model-a", effort: "high" },
  }] }, agent), "orchestrator");
  const hidden = structuredClone(agent);
  hidden.capabilities!.models[0]!.hidden = true;
  assert.equal(savedSessionPermissionMode({ defaults: [{ ...view.defaults[0]!,
    preference: { permissionMode: "orchestrator", model: "model-a" },
  }] }, hidden), undefined);
  assert.equal(savedSessionPermissionMode(null, agent), undefined);
  assert.equal(savedSessionPermissionMode(view, { ...agent, capabilities: undefined }), undefined);
});
