import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  assertClaudeAgentAcpOrchestratorIdentity,
  CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION,
  codexOrchestratorMcpArgs,
  codexOrchestratorMcpProbe,
  isolateCodexMcpServers,
  orchestratorAcpSessionMeta,
  orchestratorInstructions,
  orchestratorLaunchArgs,
  stripOrchestratorLaunchArgs,
  supportsClaudeAgentAcpOrchestrator,
  withOrchestratorPreset,
} from "./orchestrator-preset.js";

const mcp = { command: "/runner", args: ["agent", "mcp"], env: { WOLLIPOG_PERMISSION_PRESET: "orchestrator" } };

test("Orchestrator instructions separate delegation from explicit parent implementation", () => {
  const provider = orchestratorInstructions(["/repo"], false);
  assert.match(provider, /Delegate Implementation is the default/);
  assert.match(provider, /ordinary multi-issue implementation request does not.*authorize.*child creation/i);
  assert.match(provider, /create or update planning artifacts/);
  assert.match(provider, /explicitly asks this parent to implement/);
  assert.match(provider, /overlapping ownership/);
  assert.match(provider, /dedicated Wollipog worktree/);
  assert.match(provider, /testing, cross-model review, UI evidence, merge, and cleanup/);
  assert.doesNotMatch(provider, /Project locations are read-only/);

  const strict = orchestratorInstructions(["/repo"], true);
  assert.match(strict, /Strict Project Isolation is enabled/);
  assert.match(strict, /Project locations are read-only: "\/repo"/);
  assert.match(strict, /Do not implement project changes yourself/);
  assert.match(strict, /create branches or worktrees for yourself/);
});

test("orchestrator capability requires a native harness or discovery-verified WSL bridge and never revives conductor", () => {
  const agent: AgentDefinition = { id: "agent", name: "Agent", command: "agent", args: [], env: {}, driver: "codex",
    codexAppServer: { status: "supported", appServerAvailable: true,
      orchestratorApproval: { status: "supported" } },
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["read-only"] } };
  assert.deepEqual(withOrchestratorPreset([agent], { platform: "linux" })[0]!.capabilities!.permissionModes,
    ["read-only", "orchestrator"]);
  assert.deepEqual(withOrchestratorPreset([{ ...agent, id: "conductor" }]), []);
  for (const unsupported of [{ ...agent, driver: "acp" as const }, { ...agent, context: { kind: "wsl" as const, distro: "Ubuntu" } }]) {
    assert.equal(withOrchestratorPreset([unsupported])[0]!.capabilities!.permissionModes!.includes("orchestrator"), false);
  }
  const wsl = { ...agent, context: { kind: "wsl" as const, distro: "Ubuntu" },
    wslAgentControl: { protocolVersion: 1 as const, nodeRuntime: "/usr/bin/node",
      safeLauncherProtocolVersion: 1 as const, bwrapRuntime: "/usr/bin/bwrap" } };
  assert.equal(withOrchestratorPreset([wsl])[0]!.capabilities!.permissionModes!.includes("orchestrator"), false,
    "fresh launcher attestation is not advertised without runner-owned bwrap mode");
  assert.equal(withOrchestratorPreset([wsl], { wslIsolationMode: "provider" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), false);
  assert.equal(withOrchestratorPreset([wsl], { wslIsolationMode: "bwrap" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true);
  const wslClaude = { ...wsl, driver: "claude-code" as const,
    capabilities: { ...wsl.capabilities, permissionModes: ["default", "dontAsk"] } };
  assert.equal(withOrchestratorPreset([wslClaude], {
    platform: "win32", env: {}, exists: () => false, wslIsolationMode: "bwrap",
  })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true,
  "WSL Claude uses its in-distro runtime and does not depend on Git for Windows");
  assert.equal(withOrchestratorPreset([{ ...wsl, driver: "acp" }])[0]!.capabilities!.permissionModes!.includes("orchestrator"), false);
  assert.equal(withOrchestratorPreset([{ ...agent, context: { kind: "wsl", distro: "Ubuntu" },
    capabilities: { ...agent.capabilities!, permissionModes: ["read-only", "orchestrator"] } }])[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), false, "stale configured capability cannot self-attest the bridge");

  const claude = { ...agent, driver: "claude-code" as const,
    capabilities: { ...agent.capabilities!, permissionModes: ["default", "dontAsk"] } };
  assert.equal(withOrchestratorPreset([claude], { platform: "linux", isolationMode: "provider" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true);
  assert.equal(withOrchestratorPreset([claude], { platform: "linux", isolationMode: "bwrap" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true);
  assert.equal(withOrchestratorPreset([claude], { platform: "darwin", isolationMode: "provider" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true);
  assert.equal(withOrchestratorPreset([claude], { platform: "darwin", isolationMode: "seatbelt" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true);
  const staleClaude = { ...claude, capabilities: { ...claude.capabilities,
    permissionModes: ["default", "dontAsk", "orchestrator"] } };
  assert.equal(withOrchestratorPreset([staleClaude], { platform: "linux", isolationMode: "provider" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true,
    "provider-mode Claude remains available without claiming strict filesystem isolation");
});

test("Codex orchestrator capability requires the discovery-verified automatic-review contract", () => {
  const agent: AgentDefinition = {
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
    context: { kind: "native" },
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: true,
      supportsApprovals: true, permissionModes: ["auto-review"] },
  };
  const unsupported = withOrchestratorPreset([{
    ...agent,
    codexAppServer: {
      status: "supported", appServerAvailable: true, installedVersion: "0.153.0",
      orchestratorApproval: {
        status: "unsupported",
        failure: "Codex 0.153.0 cannot enforce Orchestrator automatic approval review; upgrade to 0.154.0 or newer.",
      },
    },
  }], { platform: "linux" })[0]!;
  assert.equal(unsupported.capabilities!.permissionModes!.includes("orchestrator"), false);

  const supported = withOrchestratorPreset([{
    ...agent,
    codexAppServer: {
      status: "supported", appServerAvailable: true, installedVersion: "0.154.0",
      orchestratorApproval: { status: "supported" },
    },
  }], { platform: "linux" })[0]!;
  assert.equal(supported.capabilities!.permissionModes!.includes("orchestrator"), true);
});

test("Codex MCP isolation probes an in-distro WSL binary through exact argv", () => {
  const built = codexOrchestratorMcpProbe({
    command: "/usr/bin/codex",
    args: ["--strict-config", "-c", "mcp_servers.wollipog.enabled=true"],
    env: { CODEX_HOME: "/home/me/.codex", EXISTING: "override" },
    context: { kind: "wsl", distro: "Ubuntu-24.04" },
  }, "/home/me/repo", { WSLENV: "EXISTING/u", EXISTING: "host" });
  assert.deepEqual(built.probe, {
    file: "wsl.exe",
    args: ["-d", "Ubuntu-24.04", "--cd", "/home/me/repo", "--exec", "/usr/bin/codex",
      "-c", "mcp_servers.wollipog.enabled=true", "mcp", "list", "--json"],
  });
  assert.equal(built.nativeCwd, undefined, "Linux cwd is passed only to wsl.exe, never Win32 exec cwd");
  assert.equal(built.env.WSLENV, "EXISTING/u:CODEX_HOME");
  assert.equal(built.env.EXISTING, "override");
});

test("native Windows advertises provider-mode Claude without claiming strict filesystem confinement", () => {
  const agent: AgentDefinition = {
    id: "claude-code", name: "Claude Code", command: "claude.cmd", args: [], driver: "claude-code",
    env: {}, context: { kind: "native" },
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: true,
      supportsApprovals: true, permissionModes: ["default", "dontAsk"] },
  };
  const exists = (path: string) => path === "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(withOrchestratorPreset([agent], { platform: "win32", env: {}, exists })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true);
  const ready = { ...agent, env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" } };
  assert.equal(withOrchestratorPreset([ready], { platform: "win32", env: {}, exists })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true);
  const missingDontAsk = { ...ready, capabilities: { ...ready.capabilities!, permissionModes: ["default"] } };
  assert.equal(withOrchestratorPreset([missingDontAsk], { platform: "win32", env: {}, exists })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true,
    "provider mode requires interactive Default, not dontAsk");
  const missingInteractiveApproval = { ...ready, capabilities: {
    ...ready.capabilities!, supportsApprovals: false, permissionModes: ["dontAsk"],
  } };
  assert.equal(withOrchestratorPreset([missingInteractiveApproval], { platform: "win32" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), false);
  const relative = { ...agent, env: { CLAUDE_CODE_GIT_BASH_PATH: "Git\\bin\\bash.exe" } };
  assert.equal(withOrchestratorPreset([relative], { platform: "win32", env: {}, exists })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true);
  const codex = { ...agent, id: "codex", command: "codex.exe", driver: "codex" as const,
    capabilities: { ...agent.capabilities!, permissionModes: ["workspace-write"] },
    codexAppServer: { status: "supported" as const, appServerAvailable: true,
      orchestratorApproval: { status: "supported" as const } } };
  assert.equal(withOrchestratorPreset([codex], { platform: "win32" })[0]!.capabilities!.permissionModes!.includes("orchestrator"), false,
    "Windows Codex stays fail closed until its filesystem sandbox can be attested");
  assert.equal(withOrchestratorPreset([codex], { platform: "freebsd" })[0]!.capabilities!.permissionModes!.includes("orchestrator"), false,
    "Codex stays fail closed on platforms without an audited provider sandbox");
  const acp: AgentDefinition = {
    id: "claude-acp", name: "Claude ACP", command: "npx.cmd",
    args: ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`],
    env: {}, driver: "acp", context: { kind: "native" },
  };
  assert.equal(withOrchestratorPreset([acp], { platform: "win32", env: {}, exists })[0]!.capabilities, undefined);
  assert.equal(withOrchestratorPreset([{ ...acp, env: ready.env }], { platform: "win32", env: {}, exists })[0]!.capabilities, undefined);
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
  const advertised = withOrchestratorPreset([configured], { platform: "linux", isolationMode: "bwrap" })[0]!.capabilities!;
  assert.deepEqual(advertised.permissionModes, ["orchestrator"]);
  assert.equal(advertised.supportsImages, true);
  assert.equal(advertised.supportsApprovals, true);
  const secondAdvertisement = withOrchestratorPreset([configured], {
    platform: "linux", isolationMode: "bwrap",
  })[0]!.capabilities!;
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

test("Claude ACP orchestrator metadata grants planning tools while preserving the implementation boundary", () => {
  const meta = orchestratorAcpSessionMeta(["/repo"]) as {
    claudeCode: { options: Record<string, unknown> };
  };
  assert.deepEqual(meta.claudeCode.options.tools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash", "AskUserQuestion"]);
  const allowed = meta.claudeCode.options.allowedTools as string[];
  for (const tool of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__wollipog__*",
    "Bash(git diff:*)", "Bash(gh issue comment:*)"]) assert.ok(allowed.includes(tool));
  assert.equal(allowed.includes("Bash(git branch:*)"), false, "branch inspection does not permit mutation flags");
  assert.equal(allowed.some((tool) => tool.includes("git push") || tool.includes("gh pr create")), false);
  assert.equal(meta.claudeCode.options.permissionMode, "dontAsk");
  assert.match(JSON.stringify(meta.claudeCode.options.systemPrompt), /Project locations are read-only.*\/repo/s);
  assert.deepEqual(meta.claudeCode.options.settingSources, []);
  assert.deepEqual(meta.claudeCode.options.settings, { disableAllHooks: true });
  assert.deepEqual(meta.claudeCode.options.mcpServers, {});
  assert.deepEqual(meta.claudeCode.options.additionalDirectories, ["/repo"]);
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

test("native orchestrator flags enable bounded planning while disabling implementation and ambient tool sources", () => {
  const claude = orchestratorLaunchArgs("claude-code", mcp, ["/repo"]);
  assert.match(claude[claude.indexOf("--tools") + 1] ?? "", /Read/);
  assert.match(claude[claude.indexOf("--tools") + 1] ?? "", /AskUserQuestion/);
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(claude[claude.indexOf("--add-dir") + 1], "/repo");
  assert.match(claude[claude.indexOf("--allowedTools") + 1] ?? "", /Bash\(git log:\*\)/);
  assert.equal(claude.some((arg) => /[\r\n]/u.test(arg)), false, "Windows-safe argv contains no multiline prompt");
  assert.doesNotMatch(claude[claude.indexOf("--allowedTools") + 1] ?? "", /git push|gh pr create/);
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.ok(claude.includes("--setting-sources"), "use the option recognized by the Claude CLI");
  assert.equal(claude[claude.indexOf("--setting-sources") + 1], "");
  assert.equal(claude.includes("--settings-sources"), false, "the historical spelling prevents launch");
  assert.ok(claude.includes('{"disableAllHooks":true}'));
  const codex = orchestratorLaunchArgs("codex", mcp, ["/repo"]);
  for (const setting of ['sandbox_mode="workspace-write"', "sandbox_workspace_write.writable_roots=[]",
    "sandbox_workspace_write.network_access=true", "sandbox_workspace_write.exclude_slash_tmp=true",
    'web_search="live"']) assert.ok(codex.includes(setting));
  assert.equal(codex.includes("--approve-for-me"), false,
    "the broad shortcut must not let Guardian approve a project-filesystem sandbox escape");
  assert.ok(codex.includes('approvals_reviewer="auto_review"'));
  assert.ok(codex.includes('approval_policy={ "granular" = { "mcp_elicitations" = true, "request_permissions" = false, "rules" = false, "sandbox_approval" = false, "skill_approval" = false } }'));
  assert.equal(codex.includes('approval_policy="never"'), false);
  assert.ok(codex.some((arg) => arg.includes('"default_tools_approval_mode" = "approve"')),
    "only the isolated runner-owned Wollipog MCP server is pre-approved");
  assert.equal(codex.some((arg) => arg.includes("exclude_tmpdir_env_var")), false,
    "TMPDIR names scratch and must remain writable through the explicit workspace root");
  for (const feature of ["hooks", "multi_agent", "plugins", "apps"]) {
    assert.equal(codex[codex.indexOf(feature) - 1], "--disable");
  }
  for (const feature of ["shell_tool", "unified_exec", "js_repl", "code_mode"]) {
    assert.equal(codex.includes(feature), false);
  }
  assert.match(codex.find((arg) => arg.startsWith("developer_instructions=")) ?? "", /Project locations are read-only/);
  assert.match(codex.find((arg) => arg.startsWith("developer_instructions=")) ?? "", /call get_campaign/);
  assert.match(codex.find((arg) => arg.startsWith("developer_instructions=")) ?? "", /created directly by an authenticated human/);
  for (const args of [claude, codex]) {
    assert.match(args.join(" "), /blocking question.*structured/iu);
  }
  assert.throws(() => orchestratorLaunchArgs("acp", mcp), /native harness/);
});

test("provider-mode Orchestrator keeps implementation tools behind provider approvals", () => {
  const claude = orchestratorLaunchArgs("claude-code", mcp, ["/repo"], false);
  assert.equal(claude.includes("--tools"), false);
  assert.equal(claude.includes("--disallowedTools"), false);
  assert.equal(claude.includes("--permission-mode"), false,
    "the Claude driver supplies its verified interactive Default permission channel");
  assert.match(claude[claude.indexOf("--append-system-prompt") + 1] ?? "", /Strict Project Isolation is disabled/);
  assert.match(claude[claude.indexOf("--append-system-prompt") + 1] ?? "", /dedicated Wollipog worktree/);
  const codex = orchestratorLaunchArgs("codex", mcp, ["/repo"], false);
  assert.equal(codex.includes("sandbox_workspace_write.writable_roots=[]"), false);
  assert.match(codex.find((arg) => arg.startsWith("developer_instructions=")) ?? "", /does not grant unrestricted execution/);
});

test("resume replaces stale safety flags without stacking managed MCP configuration", () => {
  for (const driver of ["codex", "claude-code"] as const) {
    const flags = orchestratorLaunchArgs(driver, mcp);
    assert.deepEqual(stripOrchestratorLaunchArgs(["--model", "example", ...flags], driver), ["--model", "example"]);
  }
  assert.deepEqual(stripOrchestratorLaunchArgs([
    "--model", "example", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
  ], "claude-code"), ["--model", "example"]);
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

test("Direct WSL Codex MCP inventory runs only through the prepared target-local launcher", async () => {
  const isolation = {
    backend: "wsl-bwrap" as const,
    distro: "Ubuntu",
    command: "/usr/local/lib/wollipog/wsl-bwrap-launcher-v1",
    args: [],
    cwd: "/srv/canonical",
    network: "deny" as const,
    wslAgentControl: {} as never,
  };
  let observed: { cwd: string; args: string[] } | undefined;
  const result = await codexOrchestratorMcpArgs({
    command: "/usr/bin/codex",
    args: ["--strict-config", "-c", "mcp_servers={}"],
    env: {},
    context: { kind: "wsl", distro: "Ubuntu" },
    isolation,
  }, isolation.cwd, {
    runIsolated: async (_opts, cwd, args) => {
      observed = { cwd, args };
      return JSON.stringify([
        { name: "wollipog", enabled: true },
        { name: "ambient", enabled: true },
      ]);
    },
  });
  assert.deepEqual(observed, {
    cwd: "/srv/canonical",
    args: ["-c", "mcp_servers={}", "mcp", "list", "--json"],
  });
  assert.deepEqual(result, ["-c", "mcp_servers.ambient.enabled=false"]);
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
