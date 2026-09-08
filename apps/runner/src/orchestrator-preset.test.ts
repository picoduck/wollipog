import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  assertClaudeAgentAcpOrchestratorIdentity,
  CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION,
  isolateCodexMcpServers,
  orchestratorAcpSessionMeta,
  orchestratorLaunchArgs,
  stripOrchestratorLaunchArgs,
  supportsClaudeAgentAcpOrchestrator,
  withOrchestratorPreset,
} from "./orchestrator-preset.js";

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

test("native Windows Claude advertises orchestrator only with verified Git Bash", () => {
  const agent: AgentDefinition = {
    id: "claude-code", name: "Claude Code", command: "claude.cmd", args: [], driver: "claude-code",
    env: {}, context: { kind: "native" },
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: true,
      supportsApprovals: true, permissionModes: ["default"] },
  };
  const exists = (path: string) => path === "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(withOrchestratorPreset([agent], { platform: "win32", exists })[0]!.capabilities!.permissionModes!.includes("orchestrator"), false);
  const ready = { ...agent, env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" } };
  assert.equal(withOrchestratorPreset([ready], { platform: "win32", exists })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true);
  const relative = { ...agent, env: { CLAUDE_CODE_GIT_BASH_PATH: "Git\\bin\\bash.exe" } };
  assert.equal(withOrchestratorPreset([relative], { platform: "win32", exists })[0]!.capabilities!.permissionModes!.includes("orchestrator"), false);
  const acp: AgentDefinition = {
    id: "claude-acp", name: "Claude ACP", command: "npx.cmd",
    args: ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`],
    env: {}, driver: "acp", context: { kind: "native" },
  };
  assert.equal(withOrchestratorPreset([acp], { platform: "win32", exists })[0]!.capabilities, undefined);
  assert.deepEqual(withOrchestratorPreset([{ ...acp, env: ready.env }], { platform: "win32", exists })[0]!.capabilities!.permissionModes, ["orchestrator"]);
});

test("only the exact audited native Claude ACP adapter advertises orchestrator", () => {
  const configured: AgentDefinition = {
    id: "claude-acp",
    name: "Claude Agent",
    command: "npx",
    args: ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`],
    env: {},
    driver: "acp",
    context: { kind: "native" },
    source: "config",
  };
  assert.equal(supportsClaudeAgentAcpOrchestrator(configured), true);
  const advertised = withOrchestratorPreset([configured])[0]!.capabilities!;
  assert.deepEqual(advertised.permissionModes, ["orchestrator"]);
  assert.equal(advertised.supportsImages, true);
  assert.equal(advertised.supportsApprovals, true);
  const secondAdvertisement = withOrchestratorPreset([configured])[0]!.capabilities!;
  assert.notEqual(advertised.permissionModes, secondAdvertisement.permissionModes,
    "catalog advertisements do not share mutable capability arrays");
  for (const unsupported of [
    { ...configured, args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
    { ...configured, args: ["-y", "@agentclientprotocol/claude-agent-acp@0.75.0"] },
    { ...configured, args: ["evil-package", `@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`] },
    { ...configured, command: "wrapper" },
    { ...configured, context: { kind: "wsl" as const, distro: "Ubuntu" } },
  ]) assert.equal(supportsClaudeAgentAcpOrchestrator(unsupported), false);

  const registry = {
    ...configured,
    command: "node",
    args: ["/registry/adapter.js"],
    source: "registry" as const,
    registry: {
      id: "claude-acp",
      schemaVersion: "1.0.0",
      adapterVersion: CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION,
      description: "Claude Agent",
      repository: "https://github.com/agentclientprotocol/claude-agent-acp",
      transport: "stdio" as const,
      distribution: "npx" as const,
      installPreview: "npx pinned adapter",
      installStatus: "installed" as const,
      authentication: "required-live-verification" as const,
    },
  };
  assert.equal(supportsClaudeAgentAcpOrchestrator(registry), true);
  assert.equal(supportsClaudeAgentAcpOrchestrator({
    ...registry,
    registry: { ...registry.registry, installStatus: "approved" },
  }), false);
  assert.equal(supportsClaudeAgentAcpOrchestrator({
    ...registry,
    registry: { ...registry.registry, repository: "https://example.invalid/lookalike" },
  }), false);
});

test("Claude ACP orchestrator metadata and live identity are exact and fail closed", () => {
  const meta = orchestratorAcpSessionMeta() as {
    claudeCode: { options: Record<string, unknown> };
  };
  assert.deepEqual(meta.claudeCode.options.tools, []);
  assert.deepEqual(meta.claudeCode.options.allowedTools, ["mcp__wollipog__*"]);
  assert.deepEqual(meta.claudeCode.options.settingSources, []);
  assert.deepEqual(meta.claudeCode.options.settings, { disableAllHooks: true });
  assert.deepEqual(meta.claudeCode.options.mcpServers, {});
  assert.deepEqual(meta.claudeCode.options.additionalDirectories, []);
  assert.doesNotThrow(() => assertClaudeAgentAcpOrchestratorIdentity({
    name: "@agentclientprotocol/claude-agent-acp",
    title: "Claude Agent",
    version: CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION,
  }));
  for (const implementation of [
    null,
    { name: "lookalike", title: "Claude Agent", version: CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION },
    { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.75.0" },
  ]) assert.throws(() => assertClaudeAgentAcpOrchestratorIdentity(implementation), /launch refused/);
});

test("native orchestrator flags disable execution, hooks, and ambient tool sources", () => {
  const claude = orchestratorLaunchArgs("claude-code", mcp);
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.ok(claude.includes("--setting-sources"), "use the option recognized by the Claude CLI");
  assert.equal(claude[claude.indexOf("--setting-sources") + 1], "");
  assert.equal(claude.includes("--settings-sources"), false, "the historical spelling prevents launch");
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

test("Claude resume removes both current and historical setting-source overrides", () => {
  for (const spelling of ["--setting-sources", "--settings-sources"]) {
    for (const override of [[spelling, "user,project,local"], [`${spelling}=user,project,local`]]) {
      const stripped = stripOrchestratorLaunchArgs(["--model", "example", ...override], "claude-code");
      assert.deepEqual(stripped, ["--model", "example"]);
      const reprovisioned = [...stripped, ...orchestratorLaunchArgs("claude-code", mcp)];
      assert.equal(reprovisioned.filter((arg) => arg === "--setting-sources").length, 1);
      assert.equal(reprovisioned[reprovisioned.indexOf("--setting-sources") + 1], "");
      assert.equal(reprovisioned.some((arg) => arg.startsWith("--settings-sources")), false);
    }
  }
});
