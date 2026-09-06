import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { isolateCodexMcpServers, orchestratorLaunchArgs, stripOrchestratorLaunchArgs, withOrchestratorPreset } from "./orchestrator-preset.js";

const mcp = { command: "/runner", args: ["agent", "mcp"], env: { WOLLIPOG_PERMISSION_PRESET: "orchestrator" } };

test("orchestrator capability is native-only and never revives conductor", () => {
  const agent: AgentDefinition = { id: "agent", name: "Agent", command: "agent", args: [], env: {}, driver: "codex",
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["read-only"] } };
  assert.deepEqual(withOrchestratorPreset([agent])[0]!.capabilities!.permissionModes, ["read-only", "orchestrator"]);
  assert.deepEqual(withOrchestratorPreset([{ ...agent, id: "conductor" }]), []);
  for (const unsupported of [{ ...agent, driver: "acp" as const }, { ...agent, context: { kind: "wsl" as const, distro: "Ubuntu" } }]) {
    assert.equal(withOrchestratorPreset([unsupported])[0]!.capabilities!.permissionModes!.includes("orchestrator"), false);
  }
});

test("native orchestrator flags disable execution, hooks, and ambient tool sources", () => {
  const claude = orchestratorLaunchArgs("claude-code", mcp);
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.ok(claude.includes('{"disableAllHooks":true}'));
  const codex = orchestratorLaunchArgs("codex", mcp);
  for (const setting of ['sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"']) assert.ok(codex.includes(setting));
  for (const feature of ["shell_tool", "unified_exec", "js_repl", "code_mode", "hooks", "multi_agent", "plugins", "apps"]) {
    assert.equal(codex[codex.indexOf(feature) - 1], "--disable");
  }
  assert.throws(() => orchestratorLaunchArgs("acp", mcp), /native harness/);
});

test("resume replaces stale safety flags without stacking managed MCP configuration", () => {
  for (const driver of ["codex", "claude-code"] as const) {
    const flags = orchestratorLaunchArgs(driver, mcp);
    assert.deepEqual(stripOrchestratorLaunchArgs(["--model", "example", ...flags], driver), ["--model", "example"]);
  }
  assert.deepEqual(stripOrchestratorLaunchArgs(["--yolo", "--sandbox=workspace-write", "-a", "on-request", "-C", "/other", "--enable", "shell_tool"], "codex"), []);
});

test("Codex MCP isolation disables every ambient server and fails closed on unverifiable output", () => {
  assert.deepEqual(isolateCodexMcpServers(JSON.stringify([
    { name: "wollipog", enabled: true }, { name: "ambient", enabled: true }, { name: "already_off", enabled: false },
  ])), ["-c", "mcp_servers.ambient.enabled=false", "-c", "mcp_servers.already_off.enabled=false"]);
  for (const invalid of ["not json", "{}", "[]", '[{"name":"wollipog","enabled":false}]',
    '[{"name":"wollipog","enabled":true},{"name":"unsafe.key"}]']) {
    assert.throws(() => isolateCodexMcpServers(invalid), /cannot verify/);
  }
});
