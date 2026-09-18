import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  advertisesOrchestratorAdditiveRole,
  type AgentDefinition,
} from "@wollipog/protocol";
import {
  additiveOrchestratorLaunchArgs,
  assertClaudeAgentAcpOrchestratorIdentity,
  CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION,
  codexOrchestratorMcpArgs,
  codexOrchestratorMcpProbe,
  declaredCodexMcpServerNames,
  isolateCodexMcpServers,
  orchestratorAcpSessionMeta,
  orchestratorInstructions,
  orchestratorLaunchArgs,
  projectOrchestratorPresetForPeer,
  reservedCodexMcpNameCollision,
  stripAdditiveOrchestratorLaunchArgs,
  stripOrchestratorLaunchArgs,
  supportsClaudeAgentAcpOrchestrator,
  withOrchestratorAdditiveRole,
  withOrchestratorPreset,
  type OrchestratorIsolationMode,
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
  assert.match(provider, /Do not ask the human to approve routine coordination shell commands/);
  assert.match(provider, /Read, Grep, or Glob for local files and review ledgers/);
  assert.match(provider, /use @me plus --body/);
  assert.match(provider, /retry it canonically/);
  assert.doesNotMatch(provider, /Project locations are read-only/);

  const strict = orchestratorInstructions(["/repo"], true);
  assert.match(strict, /Strict Project Isolation is enabled/);
  assert.match(strict, /Project locations are read-only: "\/repo"/);
  assert.match(strict, /Do not implement project changes yourself/);
  assert.match(strict, /create branches or worktrees for yourself/);
});

test("orchestrator capability requires a native harness or discovery-verified WSL bridge", () => {
  const agent: AgentDefinition = { id: "agent", name: "Agent", command: "agent", args: [], env: {}, driver: "codex",
    codexAppServer: { status: "supported", appServerAvailable: true,
      orchestratorApproval: { status: "supported" } },
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["read-only"] } };
  assert.deepEqual(withOrchestratorPreset([agent], { platform: "linux" })[0]!.capabilities!.permissionModes,
    ["read-only", "orchestrator"]);
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
  const pi = { ...agent, id: "pi", command: "pi", driver: "pi" as const,
    capabilities: { ...agent.capabilities!, permissionModes: [] },
    piAgentControl: { protocolVersion: 1 as const } };
  assert.equal(withOrchestratorPreset([pi], { platform: "linux", isolationMode: "bwrap" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), true);
  assert.equal(withOrchestratorPreset([pi], { platform: "linux", isolationMode: "provider" })[0]!
    .capabilities!.permissionModes!.includes("orchestrator"), false,
  "Pi needs the runner-owned filesystem boundary in addition to its extension bridge");
  assert.equal(withOrchestratorPreset([{ ...pi, piAgentControl: undefined,
    capabilities: { ...pi.capabilities, permissionModes: ["orchestrator"] } }], {
    platform: "linux", isolationMode: "bwrap",
  })[0]!.capabilities!.permissionModes!.includes("orchestrator"), false,
  "a stale permission mode cannot self-attest the Pi extension bridge");

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

test("provider-only native Claude Orchestrator is hidden from control planes that cannot request it", () => {
  const claude: AgentDefinition = {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes: ["default", "dontAsk", "orchestrator"],
    },
  };
  assert.equal(projectOrchestratorPresetForPeer([claude], {
    controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorExecutionPolicy - 1,
    platform: "linux",
    isolationMode: "provider",
  })[0]!.capabilities!.permissionModes!.includes("orchestrator"), false);
  assert.equal(projectOrchestratorPresetForPeer([claude], {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    platform: "linux",
    isolationMode: "provider",
  })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true);
  assert.equal(projectOrchestratorPresetForPeer([claude], {
    controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorExecutionPolicy - 1,
    platform: "linux",
    isolationMode: "bwrap",
  })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true,
  "old peers may still launch the legacy strict Claude configuration when its boundary exists");
  const noStrictMode = {
    ...claude,
    capabilities: {
      ...claude.capabilities!,
      permissionModes: ["default", "orchestrator"],
    },
  };
  assert.equal(projectOrchestratorPresetForPeer([noStrictMode], {
    controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorExecutionPolicy - 1,
    platform: "linux",
    isolationMode: "bwrap",
  })[0]!.capabilities!.permissionModes!.includes("orchestrator"), true,
  "managed strict Claude uses the verified runner control channel rather than dontAsk");
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
    "Bash(git diff:*)"]) assert.ok(allowed.includes(tool));
  assert.equal(allowed.some((tool) => tool.startsWith("Bash(gh issue edit") ||
    tool.startsWith("Bash(gh issue comment")), false, "unscoped issue writes are never statically authorized");
  assert.equal(allowed.includes("Bash(git branch:*)"), false, "branch inspection does not permit mutation flags");
  assert.equal(allowed.some((tool) => tool.includes("git push") || tool.includes("gh pr create")), false);
  // `dontAsk` is carried, but it is NOT what makes the preset fail-closed, and must never be read
  // as though it were. Against the pinned adapter 0.75.1 it is inert twice over: `createSession`
  // assigns `permissionMode` *after* spreading `_meta.claudeCode.options` into the SDK options, so
  // this field is overwritten by the settings-derived mode; and `dontAsk` is not one of the session
  // modes the adapter makes available at all (`buildAvailableModes` offers default, acceptEdits,
  // plan, auto, and bypassPermissions only), so it would be clamped to "default" even if it did
  // arrive. It is retained only as a forward-compatible hint to an adapter that honors it.
  //
  // Two other mechanisms close the preset, and they are the ones to protect:
  //   1. the static tool boundary asserted above and below — `tools`/`allowedTools` grant no
  //      implementation tool, and `disallowedTools` denies edits and child spawning outright;
  //   2. AcpClient cancelling every `session/request_permission` for a preset session, which is
  //      asserted directly in acp-conformance.test.ts.
  // See ADR 0010's audit section (#1306).
  assert.equal(meta.claudeCode.options.permissionMode, "dontAsk",
    "retained as an inert forward-compatible hint; the assertions below are what enforce the preset");
  assert.deepEqual(meta.claudeCode.options.disallowedTools,
    ["Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"],
    "the tool boundary denies implementation and child-spawning tools regardless of permission mode");
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
  const pi = orchestratorLaunchArgs("pi", mcp, ["/repo"]);
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
    assert.ok(pi.includes(flag));
  }
  assert.equal(pi[pi.indexOf("--exclude-tools") + 1], "bash,edit,write");
  assert.match(pi[pi.indexOf("--append-system-prompt") + 1] ?? "", /Project locations are read-only/);
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
  for (const args of [claude, codex, pi]) {
    assert.match(args.join(" "), /blocking question.*structured/iu);
  }
  assert.throws(() => orchestratorLaunchArgs("acp", mcp), /native harness/);
});

test("provider-mode Claude Orchestrator pre-authorizes routine coordination but not implementation", () => {
  const claude = orchestratorLaunchArgs("claude-code", mcp, ["/repo"], false);
  assert.equal(claude.includes("--tools"), false);
  assert.equal(claude.includes("--disallowedTools"), false);
  assert.equal(claude.includes("--permission-mode"), false,
    "the Claude driver supplies its verified interactive Default permission channel");
  const allowed = (claude[claude.indexOf("--allowedTools") + 1] ?? "").split(",");
  assert.deepEqual(allowed.filter((tool) => tool.startsWith("Bash(")), [
    "Bash(git log)", "Bash(git diff)", "Bash(git show)", "Bash(git status)", "Bash(git status:*)",
    "Bash(git worktree list)", "Bash(git worktree list:*)",
    "Bash(git branch)", "Bash(git branch -a)", "Bash(git branch -r)", "Bash(git branch -v)",
    "Bash(git branch -vv)", "Bash(git branch --show-current)",
    "Bash(gh issue list)", "Bash(gh issue list:*)", "Bash(gh issue view:*)", "Bash(gh issue status)",
    "Bash(gh issue status:*)", "Bash(gh pr list)", "Bash(gh pr list:*)", "Bash(gh pr view:*)",
    "Bash(gh pr checks:*)", "Bash(gh pr diff:*)", "Bash(gh pr status)", "Bash(gh pr status:*)",
  ], "provider-mode Bash permissions stay at the audited read-only coordination surface");
  for (const routine of [
    "mcp__wollipog__*", "Read", "Grep", "Glob", "WebFetch", "WebSearch",
    "Bash(git log)", "Bash(git diff)", "Bash(git show)",
    "Bash(git status:*)", "Bash(git worktree list:*)", "Bash(gh issue view:*)",
    "Bash(gh pr list:*)", "Bash(gh pr view:*)",
  ]) assert.ok(allowed.includes(routine), `${routine} should not produce a provider permission request`);
  for (const implementation of [
    "Write", "Edit", "Bash", "Bash(pnpm test:*)", "Bash(git push:*)", "Bash(gh pr create:*)",
    "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git blame:*)",
  ]) {
    assert.equal(allowed.includes(implementation), false,
      `${implementation} must remain behind the provider permission channel`);
  }
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
  assert.deepEqual(stripOrchestratorLaunchArgs([
    "--model", "example", "--no-extensions", "--exclude-tools", "bash", "--extension", "/tmp/old.mjs",
    "--append-system-prompt", "old",
  ], "pi"), ["--model", "example"]);
});

test("provider-mode Claude resume replaces the routine authorization baseline exactly once", () => {
  const stale = [
    "--model", "example", "--allowedTools", "Bash(echo stale)",
    "--append-system-prompt", "stale", "--add-dir", "/stale",
  ];
  const reprovisioned = [
    ...stripOrchestratorLaunchArgs(stale, "claude-code"),
    ...orchestratorLaunchArgs("claude-code", mcp, ["/repo"], false),
  ];
  assert.equal(reprovisioned.filter((arg) => arg === "--allowedTools").length, 1);
  assert.equal(reprovisioned.includes("Bash(echo stale)"), false);
  assert.match(reprovisioned[reprovisioned.indexOf("--allowedTools") + 1] ?? "", /mcp__wollipog__\*/);
  assert.deepEqual(reprovisioned.flatMap((arg, index) => arg === "--add-dir" ? [reprovisioned[index + 1]] : []),
    ["/repo"]);
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

test("additive Orchestrator launch arguments are injected and removed without touching user flags", () => {
  const user = [
    "--add-dir", "/home/user/notes", "--allowedTools", "Bash(npm test:*)",
    "--append-system-prompt", "Be terse.", "--mcp-config", "/home/user/mcp.json", "--settings", "/home/user/settings.json",
  ];
  const added = additiveOrchestratorLaunchArgs("claude-code", mcp, ["/repo"]);
  assert.deepEqual(added.slice(0, 2), ["--allowedTools", "mcp__wollipog__*"]);
  assert.equal(added[2], "--append-system-prompt");
  assert.match(added[3]!, /^You are running with the Wollipog Orchestrator role/);
  assert.match(added[3]!, /Strict Project Isolation is disabled/);
  assert.deepEqual(added.slice(4), ["--add-dir", "/repo"]);
  for (const flag of ["--tools", "--strict-mcp-config", "--permission-mode", "--disallowedTools", "--setting-sources", "--settings"]) {
    assert.equal(added.includes(flag), false, `${flag} would narrow the ordinary launch`);
  }
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...user, ...added], "claude-code", ["/repo"]), user);
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(user, "claude-code", ["/repo"]), user, "user flags are never mistaken for injected ones");
  const inline = [
    "--allowedTools=mcp__wollipog__*", "--add-dir=/repo",
    `--append-system-prompt=${orchestratorInstructions(["/repo"], false)}`,
  ];
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...inline, ...user], "claude-code", ["/repo"]), user);
  assert.throws(() => additiveOrchestratorLaunchArgs("acp", mcp, []),
    /native Claude Code, Codex, and Pi/);
});

test("the additive Pi Orchestrator is the ordinary launch plus only the instructions", () => {
  const added = additiveOrchestratorLaunchArgs("pi", mcp, ["/repo"]);
  // Pi's Wollipog tools arrive through the Agent Control extension every verified Pi session
  // already loads, selected by WOLLIPOG_PERMISSION_PRESET in the agent env. Nothing else is needed.
  assert.equal(added.length, 2, "exactly one flag pair reaches Pi");
  assert.equal(added[0], "--append-system-prompt");
  assert.match(added[1]!, /^You are running with the Wollipog Orchestrator role/);
  assert.match(added[1]!, /Strict Project Isolation is disabled/);
  // Every coupled-preset restriction must be absent: the selected mode owns approvals, and the
  // user's own extensions, skills, prompt templates, context files, and tools all survive.
  for (const forbidden of ["--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-context-files", "--exclude-tools", "--tools", "--no-tools", "--no-builtin-tools",
    "--no-approve", "--extension"]) {
    assert.equal(added.includes(forbidden), false, `the additive Pi launch never injects ${forbidden}`);
  }
  // A non-strict Pi Orchestrator differs from the ordinary launch by exactly these two arguments,
  // including when the user's own configuration narrows the launch.
  const ordinary = ["--provider", "anthropic", "--no-skills", "--exclude-tools", "write"];
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...ordinary, ...added], "pi", ["/repo"]), ordinary,
    "resume removes exactly what it injected, keeping the user's own narrowing flags");
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(ordinary, "pi", ["/repo"]), ordinary,
    "a user's own --no-skills/--exclude-tools is never mistaken for an injected flag");
  // Idempotent across repeated provisioning.
  assert.deepEqual(
    stripAdditiveOrchestratorLaunchArgs(
      stripAdditiveOrchestratorLaunchArgs([...ordinary, ...added], "pi", ["/repo"]), "pi", ["/repo"]),
    ordinary);
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...ordinary, ...added, ...added], "pi", ["/repo"]), ordinary);
});

test("the additive Pi strip leaves a user's own --append-system-prompt alone", () => {
  const added = additiveOrchestratorLaunchArgs("pi", mcp, []);
  const user = ["--append-system-prompt", "Be terse."];
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...user, ...added], "pi", []), user);
  // Measured against pi 0.85.0: `dist/cli/args.js` pushes each `--append-system-prompt` value onto
  // an array and `dist/core/agent-session.js` joins them with a blank line, so the runner's append
  // never displaces the user's — both reach the system prompt, and there is no reserved name.
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...added, ...user], "pi", []), user);
  // Also measured there: the flag is matched by exact string equality and consumes the NEXT
  // argument. `--append-system-prompt=TEXT` is a different thing entirely — it falls through to the
  // unknown-flag branch and is handed to extensions — so the strip must not touch the inline form.
  const inline = [`--append-system-prompt=${orchestratorInstructions([], false)}`];
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(inline, "pi", []), inline,
    "Pi does not parse the inline form as an append, so removing it would delete a user argument");
});

test("the additive Codex Orchestrator adds only Wollipog's MCP server and instructions", () => {
  for (const driver of ["codex", "codex-app-server"] as const) {
    const added = additiveOrchestratorLaunchArgs(driver, mcp, ["/repo"]);
    // Exactly two settings: nothing else may reach the provider for the Orchestrator role.
    assert.equal(added.length, 4, `${driver} injects only two -c settings`);
    assert.deepEqual(added.filter((arg) => arg === "-c").length, 2);
    const settings = added.filter((_, index) => index % 2 === 1);
    // A dotted single-entry override merges into the user's table; the preset's whole-table form
    // merges too, which is why the preset additionally needs --strict-config and the probe.
    const server = settings.find((setting) => setting.startsWith("mcp_servers."))!;
    assert.match(server, /^mcp_servers\.wollipog=\{/, "only the wollipog entry is named");
    assert.match(server, /"command" = "\/runner"/);
    assert.match(server, /"WOLLIPOG_PERMISSION_PRESET" = "orchestrator"/, "the campaign tools stay exposed");
    assert.match(server, /"enabled" = true/);
    const instructions = settings.find((setting) => setting.startsWith("developer_instructions="))!;
    assert.match(instructions, /You are running with the Wollipog Orchestrator role/);
    assert.match(instructions, /Strict Project Isolation is disabled/);
    // Every coupled-preset restriction must be absent: the selected mode owns sandbox and approvals.
    for (const forbidden of ["--strict-config", "--disable", "--enable", "-s", "--sandbox", "-a",
      "--ask-for-approval", "--add-dir"]) {
      assert.equal(added.includes(forbidden), false, `${driver} never injects ${forbidden}`);
    }
    for (const forbidden of ["sandbox_mode=", "sandbox_workspace_write.", "approval_policy=",
      "approvals_reviewer=", "web_search=", "features."]) {
      assert.equal(settings.some((setting) => setting.startsWith(forbidden)), false,
        `${driver} never overrides ${forbidden}`);
    }

    const user = [
      "-c", "model_reasoning_effort=high", "--disable", "apps",
      "-c", 'mcp_servers.mine={ "command" = "/mine" }',
      "-c", 'developer_instructions="my own instructions"', "-s", "read-only",
    ];
    assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...user, ...added], driver), user,
      `${driver} resume removes exactly what it injected`);
    assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(user, driver), user,
      `${driver} never mistakes a user setting for an injected one`);
    const inline = added.flatMap((arg, index) => index % 2 === 0 ? [] : [`--config=${arg}`]);
    assert.deepEqual(stripAdditiveOrchestratorLaunchArgs([...inline, ...user], driver), user,
      `${driver} strips the inline --config=key=value form too`);
  }
});

test("a user's own MCP server named wollipog is never deleted by the additive Codex strip", () => {
  const userServer = ["-c", 'mcp_servers.wollipog={ command = "my-server", args = [] }'];
  const userInline = ['--config=mcp_servers.wollipog.command="my-server"'];
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(userServer, "codex-app-server", []), userServer);
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(userInline, "codex", []), userInline);
  assert.equal(reservedCodexMcpNameCollision(userServer), true);
  assert.equal(reservedCodexMcpNameCollision(userInline), true);
  const injected = additiveOrchestratorLaunchArgs("codex-app-server", {
    command: "/opt/runner", args: ["--agent-control-mcp"],
    env: { WOLLIPOG_SESSION_TOKEN_FILE: "/run/token", WOLLIPOG_PERMISSION_PRESET: "orchestrator" },
  }, ["/repo"]);
  assert.equal(reservedCodexMcpNameCollision(injected), false, "the runner's own entry is not a collision");
  const similar = ["-c", 'mcp_servers.wollipog-helper={ command = "x", env = { WOLLIPOG_PERMISSION_PRESET = "orchestrator" } }',
    "-c", 'mcp_servers.wollipog2.command="y"'];
  assert.equal(reservedCodexMcpNameCollision(similar), false, "only the exact reserved name collides");
  // Spellings measured against codex-cli 0.154.0 (`codex -c <setting> mcp list`).
  for (const spelling of [
    'mcp_servers.wollipog = { command = "mine" }',
    ' mcp_servers.wollipog={ command = "mine" }',
    'mcp_servers.wollipog.command = "mine"',
  ]) {
    assert.equal(reservedCodexMcpNameCollision(["-c", spelling]), true, `codex names this server wollipog: ${spelling}`);
    assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(["-c", spelling], "codex", []), ["-c", spelling]);
  }
  for (const spelling of [
    'mcp_servers."wollipog"={ command = "mine" }',
    "mcp_servers.'wollipog'={ command = \"mine\" }",
    'mcp_servers . wollipog = { command = "mine" }',
    'mcp_servers.wollipog .command = "mine"',
  ]) {
    assert.equal(reservedCodexMcpNameCollision(["-c", spelling]), false, `codex names a different server: ${spelling}`);
    assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(["-c", spelling], "codex", []), ["-c", spelling]);
  }
  assert.equal(reservedCodexMcpNameCollision(["-c", 'model="mcp_servers.wollipog=x"']), false,
    "a value that merely mentions the key is not a collision");
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(similar, "codex", []), similar,
    "a similarly named server is never stripped, even if its value mentions the marker");
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(injected, "codex-app-server", ["/repo"]), []);
});

test("the additive Orchestrator role is advertised independently of the coupled preset", () => {
  const caps = (permissionModes: string[]) => ({
    models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
    permissionModes,
  });
  const pi = (piAgentControl?: { protocolVersion: 1 }): AgentDefinition => ({
    id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi",
    context: { kind: "native" }, capabilities: caps(["default", "dontAsk", "bypassPermissions"]),
    ...(piAgentControl ? { piAgentControl } : {}),
  });
  const advertise = (agents: AgentDefinition[], isolationMode: OrchestratorIsolationMode) =>
    withOrchestratorAdditiveRole(withOrchestratorPreset(agents, { platform: "linux", isolationMode }));

  // The case #1294 fixes: the default runner isolation cannot host the preset's filesystem
  // boundary, but the additive role never needed one. The role is advertised; the preset is not.
  const [providerPi] = advertise([pi({ protocolVersion: 1 })], "provider");
  assert.equal(providerPi!.capabilities?.orchestratorAdditive, true,
    "a bridge-verified Pi can launch the additive role under the default provider isolation");
  assert.equal(providerPi!.capabilities?.permissionModes?.includes("orchestrator"), false,
    "...while the coupled preset stays correctly unavailable");

  // With the strict boundary, both advertisements appear.
  const [bwrapPi] = advertise([pi({ protocolVersion: 1 })], "bwrap");
  assert.equal(bwrapPi!.capabilities?.orchestratorAdditive, true);
  assert.equal(bwrapPi!.capabilities?.permissionModes?.includes("orchestrator"), true);

  // Without the verified bridge, neither: the additive Pi launch enforces its approvals through it.
  for (const isolationMode of ["provider", "bwrap"] as const) {
    const [unverified] = advertise([pi()], isolationMode);
    assert.equal(unverified!.capabilities?.orchestratorAdditive, undefined,
      `an unverified Pi bridge never attests the additive role (${isolationMode})`);
    assert.equal(unverified!.capabilities?.permissionModes?.includes("orchestrator"), false);
  }

  // Claude is unchanged by this function: its additive precondition is the one it already used.
  const claude = (permissionModes: string[], supportsApprovals = true): AgentDefinition => ({
    id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
    context: { kind: "native" }, capabilities: { ...caps(permissionModes), supportsApprovals },
  });
  assert.equal(advertise([claude(["default"])], "bwrap")[0]!.capabilities?.orchestratorAdditive, true);
  assert.equal(advertise([claude(["default"])], "provider")[0]!.capabilities?.orchestratorAdditive, true,
    "Claude's additive role does not require the strict filesystem boundary either");
  assert.equal(advertise([claude(["acceptEdits"])], "bwrap")[0]!.capabilities?.orchestratorAdditive, undefined,
    "Claude still needs its Default mode and approval channel");
  assert.equal(advertise([claude(["default"], false)], "bwrap")[0]!.capabilities?.orchestratorAdditive, undefined);

  // Codex's additive role carries neither of the preset's preconditions (#1308); the matrix below
  // covers the platform axis as well.
  const codex = (approval?: "supported"): AgentDefinition => ({
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex",
    context: { kind: "native" }, capabilities: caps(["on-request"]),
    ...(approval ? { codexAppServer: { orchestratorApproval: { status: approval } } } : {}),
  });
  assert.equal(advertise([codex("supported")], "bwrap")[0]!.capabilities?.orchestratorAdditive, true);
  assert.equal(advertise([codex()], "bwrap")[0]!.capabilities?.orchestratorAdditive, true,
    "granular approval support is the coupled preset's precondition, not the additive launch's");

  // Never for a non-native context, and never for ACP, which has no additive shape at all.
  const wslPi: AgentDefinition = { ...pi({ protocolVersion: 1 }), context: { kind: "wsl", distro: "Ubuntu" } };
  assert.equal(advertise([wslPi], "bwrap")[0]!.capabilities?.orchestratorAdditive, undefined,
    "the additive launch requires host execution");
  const acp: AgentDefinition = {
    id: "acp", name: "Claude Agent", command: "npx",
    args: [`@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`],
    env: {}, driver: "acp", context: { kind: "native" }, capabilities: caps(["default"]),
  };
  assert.equal(advertise([acp], "bwrap")[0]!.capabilities?.orchestratorAdditive, undefined,
    "the ACP provider permission contract was audited and found not sound, so it has no additive role");

  // The shared control-plane/web predicate reads the same advertisement.
  assert.equal(advertisesOrchestratorAdditiveRole("pi", providerPi!.capabilities), true);
  assert.equal(advertisesOrchestratorAdditiveRole("pi", caps(["orchestrator"])), false,
    "a preset advertisement is never a substitute for Pi's additive attestation");
  assert.equal(advertisesOrchestratorAdditiveRole("claude-code", caps(["orchestrator"])), true,
    "pre-v163 Claude and Codex runners keep working from the preset advertisement");
  assert.equal(advertisesOrchestratorAdditiveRole("codex", caps(["orchestrator"])), true);
  assert.equal(advertisesOrchestratorAdditiveRole("acp", caps(["orchestrator"])), false);
});

test("the additive Codex advertisement matches the additive launch, and leaves the preset's preconditions alone", () => {
  const capabilities = () => ({
    models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
    permissionModes: ["on-request", "never"],
  });
  const codex = (
    driver: "codex" | "codex-app-server",
    approval: "supported" | "unsupported",
  ): AgentDefinition => ({
    id: driver, name: driver, command: driver, args: [], env: {}, driver,
    context: { kind: "native" }, capabilities: capabilities(),
    codexAppServer: { orchestratorApproval: approval === "supported"
      ? { status: "supported" }
      : { status: "unsupported", failure: "Update the Codex CLI for granular approvals." } },
  });

  // Every axis the two advertisements could depend on. The additive launch adds Wollipog's MCP
  // entry and the instructions to the ordinary launch and injects no sandbox, approval, or reviewer
  // setting, so `provisionAgentControl` accepts it for a native Codex installation on the host
  // whatever the platform, the runner's execution isolation, or the granular-approval probe says.
  // The coupled preset needs both, and this change leaves that answer exactly as it was.
  for (const driver of ["codex", "codex-app-server"] as const) {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const isolationMode of ["provider", "bwrap", "seatbelt", "windows-job"] as const) {
        for (const approval of ["supported", "unsupported"] as const) {
          const where = `${driver} ${platform} ${isolationMode} approval=${approval}`;
          const [advertised] = withOrchestratorAdditiveRole(
            withOrchestratorPreset([codex(driver, approval)], { platform, isolationMode }),
          );
          assert.equal(advertised!.capabilities?.orchestratorAdditive, true,
            `the additive role is advertised: ${where}`);
          assert.equal(advertisesOrchestratorAdditiveRole(driver, advertised!.capabilities), true, where);
          assert.equal(
            advertised!.capabilities?.permissionModes?.includes("orchestrator"),
            approval === "supported" && (platform === "linux" || platform === "darwin"),
            `the coupled preset keeps its granular-approval and audited-sandbox preconditions: ${where}`,
          );
          assert.deepEqual(advertised!.capabilities?.permissionModes?.slice(0, 2), ["on-request", "never"],
            `the ordinary permission modes are untouched: ${where}`);
        }
      }
    }
  }

  // The conditions the additive launch genuinely does impose are still enforced.
  const wsl: AgentDefinition = {
    ...codex("codex", "supported"), context: { kind: "wsl", distro: "Ubuntu" },
  };
  assert.equal(
    withOrchestratorAdditiveRole(withOrchestratorPreset([wsl], { platform: "linux", isolationMode: "bwrap" }))[0]!
      .capabilities?.orchestratorAdditive,
    undefined,
    "the additive Codex launch still requires native host execution",
  );
  const undiscovered: AgentDefinition = { ...codex("codex", "supported"), capabilities: undefined };
  assert.equal(
    withOrchestratorAdditiveRole([undiscovered])[0]!.capabilities?.orchestratorAdditive,
    undefined,
    "an installation with no discovered capabilities advertises nothing",
  );
});

test("projectOrchestratorPresetForPeer keeps the additive role advertisement", () => {
  const agent: AgentDefinition = {
    id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi",
    context: { kind: "native" }, piAgentControl: { protocolVersion: 1 },
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
      permissionModes: ["default"], orchestratorAdditive: true,
    },
  };
  for (const controlPlaneProtocolVersion of [null, 143, PROTOCOL_VERSION]) {
    const [projected] = projectOrchestratorPresetForPeer([agent], {
      controlPlaneProtocolVersion, platform: "linux", isolationMode: "provider",
    });
    assert.equal(projected!.capabilities?.orchestratorAdditive, true,
      `the role attestation survives projection for a v${controlPlaneProtocolVersion} peer`);
  }
});

test("Integration Isolation changes only the integration surface of the additive launch", () => {
  const projects = ["/repo"];
  for (const driver of ["claude-code", "codex", "codex-app-server", "pi"] as const) {
    const plain = additiveOrchestratorLaunchArgs(driver, mcp, projects);
    const isolated = additiveOrchestratorLaunchArgs(driver, mcp, projects, true);
    assert.deepEqual(additiveOrchestratorLaunchArgs(driver, mcp, projects, false), plain,
      `${driver}: a disabled policy is byte-identical to the launch before this policy existed`);
    // Everything the plain additive launch carries is still there, in the same order.
    assert.deepEqual(isolated.slice(isolated.length - plain.length), plain,
      `${driver}: Integration Isolation only prepends; it rewrites nothing the additive launch already sent`);
    const added = isolated.slice(0, isolated.length - plain.length);
    // No permission-mode, sandbox, approval, reviewer, tool-inventory, or working-directory change.
    for (const forbidden of [
      "--permission-mode", "--tools", "--disallowedTools", "--exclude-tools", "--no-tools",
      "--no-builtin-tools", "--restricted", "--bare", "--add-dir", "-C", "--cd", "-s", "--sandbox",
      "-a", "--ask-for-approval", "--strict-config", "--dangerously-skip-permissions",
    ]) {
      assert.equal(added.includes(forbidden), false,
        `${driver}: Integration Isolation must not inject ${forbidden}`);
    }
    for (const setting of added) {
      assert.equal(/^(sandbox_mode|sandbox_workspace_write|approval_policy|approvals_reviewer|model)/u.test(setting), false,
        `${driver}: Integration Isolation must not inject the setting ${setting}`);
    }
    assert.deepEqual(
      stripAdditiveOrchestratorLaunchArgs(isolated, driver, projects, true), [],
      `${driver}: the strip removes exactly what the isolated launch injected`);
    // Repeated provisioning is idempotent: strip then re-add reproduces the same argument vector.
    assert.deepEqual(
      [...stripAdditiveOrchestratorLaunchArgs(isolated, driver, projects, true),
        ...additiveOrchestratorLaunchArgs(driver, mcp, projects, true)],
      isolated, `${driver}: provisioning an already-provisioned launch is idempotent`);
  }
});

test("Integration Isolation uses the measured per-harness integration levers", () => {
  const plainClaude = additiveOrchestratorLaunchArgs("claude-code", mcp, ["/repo"]);
  const claude = additiveOrchestratorLaunchArgs("claude-code", mcp, ["/repo"], true);
  // Claude isolates MCP servers and NOTHING else. Measured against claude 2.1.270 with a stub stdio
  // server that writes a marker on start: a user-scope `~/.claude.json` server and a project
  // `.mcp.json` server both start normally, and under `--strict-mcp-config` neither does while the
  // `--mcp-config` server still does.
  assert.deepEqual(claude, ["--strict-mcp-config", ...plainClaude],
    "the isolated Claude launch differs from the additive one by exactly --strict-mcp-config");
  // Claude cannot drop the user's hooks without also dropping either their permission rules or
  // Wollipog's own governance hooks, so it under-delivers rather than over-reaching. None of these
  // may appear: each would change something other than the integration surface.
  for (const forbidden of [
    "--setting-sources", "--settings", "--tools", "--permission-mode", "--disallowedTools",
    "--disable-slash-commands", "--restricted", "--bare", "--allow-dangerously-skip-permissions",
  ]) {
    assert.equal(claude.includes(forbidden), false,
      `Integration Isolation must not inject ${forbidden} for Claude Code`);
  }
  assert.equal(claude.join(" ").includes("disableAllHooks"), false,
    "disableAllHooks also stops the --settings file's own hooks, removing Wollipog's governance channel");

  for (const driver of ["codex", "codex-app-server"] as const) {
    const codex = additiveOrchestratorLaunchArgs(driver, mcp, [], true);
    for (const feature of ["apps", "plugins", "hooks"]) {
      assert.equal(codex[codex.indexOf(feature) - 1], "--disable", `${driver} disables ${feature}`);
    }
    for (const builtIn of ["multi_agent", "browser_use", "computer_use", "image_generation"]) {
      assert.equal(codex.includes(builtIn), false,
        `${driver}: ${builtIn} is Codex's own built-in tool inventory, not a user-configured integration`);
    }
  }

  const pi = additiveOrchestratorLaunchArgs("pi", mcp, [], true);
  assert.deepEqual(pi.slice(0, 4),
    ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]);
  assert.equal(pi.includes("--exclude-tools"), false,
    "excluding built-in tools is tool inventory, which the coupled preset owns and this policy does not touch");
});

test("the Integration Isolation strip leaves user arguments alone and is exact about their forms", () => {
  // A disabled policy never touches these flags at all, whoever supplied them.
  const userClaude = ["--strict-mcp-config", "--setting-sources", "user", "--mcp-config", "/user.json"];
  assert.deepEqual(stripAdditiveOrchestratorLaunchArgs(userClaude, "claude-code", [], false), userClaude);
  // With the policy on, only `--strict-mcp-config` is ours. Settings sources are never touched: the
  // isolated Claude launch does not inject one, so removing one would delete a user argument — and
  // dropping the settings files would drop the user's permission rules with them.
  assert.deepEqual(
    stripAdditiveOrchestratorLaunchArgs(
      ["--setting-sources", "user", "--strict-mcp-config", "--mcp-config", "/user.json"], "claude-code", [], true),
    ["--setting-sources", "user", "--mcp-config", "/user.json"]);
  assert.deepEqual(
    stripAdditiveOrchestratorLaunchArgs(["--setting-sources=user", "--settings", "/user.json"], "claude-code", [], true),
    ["--setting-sources=user", "--settings", "/user.json"],
    "neither form of a settings argument is ever removed by this policy");

  // Codex: only the three features this policy disables, and only per-server MCP disables.
  assert.deepEqual(
    stripAdditiveOrchestratorLaunchArgs(
      ["--disable", "apps", "--disable", "web_search", "--disable=hooks",
        "-c", "mcp_servers.other.enabled=false", "-c", "mcp_servers.wollipog.enabled=false",
        "-c", "model=\"o3\""],
      "codex", [], true),
    ["--disable", "web_search", "-c", "mcp_servers.wollipog.enabled=false", "-c", "model=\"o3\""],
    "an unrelated --disable, the reserved Wollipog entry, and unrelated -c settings survive");

  // Pi: the long and short forms of exactly the four discovery switches, nothing else.
  assert.deepEqual(
    stripAdditiveOrchestratorLaunchArgs(
      ["--no-extensions", "-ns", "--no-builtin-tools", "--extension", "/user.js"], "pi", [], true),
    ["--no-builtin-tools", "--extension", "/user.js"]);
});

test("Integration Isolation keeps Codex MCP servers the agent definition declares, and the preset keeps none", () => {
  const inventory = JSON.stringify([
    { name: "wollipog", enabled: true },
    { name: "declared", enabled: true },
    { name: "ambient", enabled: true },
  ]);
  // The coupled preset's audited boundary is unchanged: everything but Wollipog's entry is disabled,
  // whether or not the launch declared it.
  assert.deepEqual(isolateCodexMcpServers(inventory), [
    "-c", "mcp_servers.declared.enabled=false",
    "-c", "mcp_servers.ambient.enabled=false",
  ]);
  // The additive isolated shape removes only the ambient one. A server the operator named in the
  // agent definition is part of the harness installation (ADR 0011), and disabling it would
  // override the very launch argument that declared it.
  assert.deepEqual(
    isolateCodexMcpServers(inventory, declaredCodexMcpServerNames([
      "-c", "mcp_servers.declared.command=\"/usr/bin/declared\"",
    ])),
    ["-c", "mcp_servers.ambient.enabled=false"]);
});

test("declared Codex MCP names are parsed exactly as codex-cli 0.154.0 parses -c keys", () => {
  // All three argument forms, and a dotted sub-key, declare the server.
  assert.deepEqual([...declaredCodexMcpServerNames(["-c", "mcp_servers.a=\"x\""])], ["a"]);
  assert.deepEqual([...declaredCodexMcpServerNames(["--config", "mcp_servers.b.command=\"x\""])], ["b"]);
  assert.deepEqual([...declaredCodexMcpServerNames(["--config=mcp_servers.c.env.TOKEN=\"x\""])], ["c"]);
  // Measured grammar: the key is trimmed as a WHOLE and split on dots, with no per-segment trimming
  // or unquoting. Each of these therefore names a different server than the bare spelling would.
  assert.deepEqual([...declaredCodexMcpServerNames(["-c", "  mcp_servers.d=\"x\""])], ["d"],
    "leading whitespace on the whole key is trimmed");
  assert.deepEqual([...declaredCodexMcpServerNames(["-c", "mcp_servers.\"e\"=\"x\""])], ["\"e\""],
    "a quoted segment is the literal name including its quotes");
  assert.deepEqual([...declaredCodexMcpServerNames(["-c", "mcp_servers . f=\"x\""])], [],
    "a spaced segment does not parse as the mcp_servers table at all");
  assert.deepEqual([...declaredCodexMcpServerNames(["-c", "mcp_servers.g .command=\"x\""])], ["g "],
    "an inner segment keeps its trailing space");
  // Non-MCP settings, valueless keys, and Wollipog's own reserved entry are never declarations.
  assert.deepEqual([...declaredCodexMcpServerNames([
    "-c", "model=\"o3\"", "-c", "mcp_servers", "-c", "mcp_servers.wollipog.enabled=true",
    "--model", "mcp_servers.h=\"x\"",
  ])], [], "only -c/--config settings under mcp_servers, and never the reserved Wollipog name");
  // The exemption cannot resurrect Wollipog's reserved name, which isolation always keeps anyway.
  assert.deepEqual(
    isolateCodexMcpServers(JSON.stringify([{ name: "wollipog", enabled: true }, { name: "z", enabled: true }]),
      declaredCodexMcpServerNames(["-c", "mcp_servers.wollipog=\"x\""])),
    ["-c", "mcp_servers.z.enabled=false"]);
});
