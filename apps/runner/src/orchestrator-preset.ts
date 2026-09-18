import type { AcpImplementationDiagnostics } from "./acp-contract.js";
import {
  runnerSupportsProtocol,
  type AgentDefinition,
  type AgentCapabilities,
  type SessionLaunchSpec,
} from "@wollipog/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsCommandSpec } from "./windows-cmd.js";
import { existsSync } from "node:fs";
import { killTree, spawnAgent, type SpawnAgentOptions, type WslBwrapSpawnIsolation } from "./spawn.js";

const execFileAsync = promisify(execFile);

export const ORCHESTRATOR_PRESET = "orchestrator";
export const ORCHESTRATOR_ENV_KEY = "WOLLIPOG_PERMISSION_PRESET";
export const CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION = "0.75.1";
const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_AGENT_ACP_REPOSITORY = "https://github.com/agentclientprotocol/claude-agent-acp";

const ORCHESTRATOR_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash", "AskUserQuestion"];
const ORCHESTRATOR_CLAUDE_BASH_RULES = [
  "git log", "git log:*", "git diff", "git diff:*", "git show", "git show:*",
  "git blame:*", "git status", "git status:*", "git worktree list", "git worktree list:*",
  "git branch", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch --show-current",
  "gh issue list", "gh issue list:*", "gh issue view:*", "gh issue status", "gh issue status:*",
  "gh pr list", "gh pr list:*", "gh pr view:*", "gh pr checks:*", "gh pr diff:*", "gh pr status",
  "gh pr status:*",
];

// Provider mode has no runner-owned filesystem boundary. Keep Git commands whose option space can
// write files (for example `git log --output=...`) exact; broader inspection remains available
// through the interactive provider approval channel.
const PROVIDER_ORCHESTRATOR_CLAUDE_BASH_RULES = [
  "git log", "git diff", "git show", "git status", "git status:*",
  "git worktree list", "git worktree list:*",
  "git branch", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch --show-current",
  "gh issue list", "gh issue list:*", "gh issue view:*", "gh issue status", "gh issue status:*",
  "gh pr list", "gh pr list:*", "gh pr view:*", "gh pr checks:*", "gh pr diff:*", "gh pr status",
  "gh pr status:*",
];

export type OrchestratorIsolationMode = "provider" | "bwrap" | "seatbelt" | "windows-job";

/** Whether a native harness can enforce the optional Strict Project Isolation boundary. Provider
 * mode may still support the Orchestrator role when its ordinary permission contract is verified. */
export function supportsNativeOrchestratorBoundary(
  driver: SessionLaunchSpec["driver"],
  platform: NodeJS.Platform,
  isolationMode: OrchestratorIsolationMode | undefined,
): boolean {
  if (driver === "codex" || driver === "codex-app-server") {
    return platform === "linux" || platform === "darwin";
  }
  if (driver !== "claude-code" && driver !== "acp" && driver !== "pi") return false;
  return (platform === "linux" && isolationMode === "bwrap") ||
    (platform === "darwin" && isolationMode === "seatbelt");
}

/** Every Orchestrator system-prompt append starts with this sentence, so runner-injected
 * instructions can be recognised and replaced on resume without touching user-supplied text. */
export const ORCHESTRATOR_INSTRUCTIONS_PREFIX = "You are running with the Wollipog Orchestrator role.";

export function orchestratorInstructions(
  projectPaths: readonly string[],
  strictProjectIsolation = true,
): string {
  const locations = [...new Set(projectPaths.filter(Boolean))];
  return [
    `${ORCHESTRATOR_INSTRUCTIONS_PREFIX} Delegate Implementation is the default: plan, assign work to child sessions, monitor them, and verify their results.`,
    "An ordinary multi-issue implementation request does not by itself authorize an orchestration campaign or child creation. Create children only when the human explicitly requests orchestration or delegation.",
    "When this Orchestrator was created directly by an authenticated human, that creation authorizes routine child creation within its existing audience, workspace access, and configured limits. Explicit governance ask or deny policies remain authoritative; agent-created descendants and ambiguous legacy sessions do not inherit this authorization.",
    strictProjectIsolation
      ? "Strict Project Isolation is enabled. Your working directory is private per-session scratch space. You may create notes and ledgers there, but nowhere else."
      : "Strict Project Isolation is disabled. Provider permissions and governance still apply; this role does not grant unrestricted execution or an operating-system read-only boundary.",
    strictProjectIsolation
      ? (locations.length
          ? `Project locations are read-only: ${locations.map((path) => JSON.stringify(path)).join(", ")}.`
          : "Project locations are read-only and may be inspected by absolute path.")
      : "You may create or update planning artifacts that the repository and human permit without spawning a child.",
    strictProjectIsolation
      ? "Do not implement project changes yourself."
      : "Do not edit project files merely because work was requested. If the human explicitly asks this parent to implement, first check open child assignments and pull requests for overlapping ownership, then create and select a dedicated Wollipog worktree for yourself. Follow the repository's testing, cross-model review, UI evidence, merge, and cleanup workflow exactly.",
    "You may read and search project files and user skill directories, inspect Git history and branches, read GitHub issues, pull requests, checks, review threads, and comments, search or fetch the web, and use Wollipog session-management tools.",
    "Do not ask the human to approve routine coordination shell commands. Use separate semantic Git and GitHub commands, keep only stdin presentation filters in pipelines, use Read, Grep, or Glob for local files and review ledgers, and use @me plus --body for campaign-scoped issue writes. If the runner asks you to reformulate a routine command, retry it canonically.",
    "At campaign start and after any human policy change, call get_campaign. Treat its policy revision, effective decision owners, limits, compatibility fallbacks, and status as authoritative. Never broaden that policy or change account defaults.",
    "Use capability discovery before selecting an Automatic child harness, model, or effort, then pass one compatible runnerId, agentId, model, and effort combination atomically to create_session. Identical model ids do not make different harnesses equivalent. Fixed campaign values cannot be overridden. Every child receives the server-derived policy block in its initial assignment.",
    "Route implementation questions, PR merge, merged-branch deletion, follow-up issue publication, and UI evidence through exact typed workflow decisions. A preference to execute work is never approval for its external effects. Authentication, secrets, persistent grants, governance, budgets, and tool guardrails remain human-only.",
    "Record every follow-up with record_campaign_follow_up before acting. Recommend Only stops after reporting; Execute Approved may start only a unique recommendation and still preserves sanitization, dependency checks, cross-model review, exact-head CI, typed publication, UI, merge, and deletion gates. An enqueued PR is unfinished: keep supervising it through merge-group CI and the forge's actual MERGED state.",
    "Use list_descendant_requests without blocking unrelated children. Resolve only requests currently assigned to the Orchestrator. UI evidence remains human-owned whenever get_campaign says the client cannot inspect it.",
    "Whenever progress depends on a human response, a blocking question must use the structured request_user_input tool in Codex or AskUserQuestion tool in Claude. A prose-only blocking question is not a valid escalation. If the provider does not expose its structured question tool, report a visible compatibility failure and stop instead of silently returning to idle.",
    "After receiving an exact completed child report and accounting for its follow-ups, call verify_campaign_child. Retain keeps verified children available. Stop and Archive uses the durable lifecycle and does not reach Verified Complete until campaign-owned worktrees are retired.",
    "GitHub writes are limited to assigning or unassigning issues, changing issue labels, and posting plan or status comments.",
    strictProjectIsolation
      ? "Do not edit project files, run builds, tests, or typechecks in a project location, commit, push, create branches or worktrees for yourself, open pull requests, merge, or perform control-plane mutations outside descendant session management."
      : "Provider edit and shell permissions remain subject to the selected provider policy and existing governance. Use typed workflow decisions for merge, branch deletion, follow-up publication, and UI evidence; never self-approve or relax isolation.",
    strictProjectIsolation
      ? "If a requested operation is outside that boundary, explain that Strict Project Isolation refuses it and delegate the implementation to a child session."
      : "If explicit parent implementation cannot obtain a dedicated non-overlapping worktree or a required approval is denied, stop that implementation path and report the specific blocker.",
  ].join(" ");
}

function claudeAllowedTools(bashRules: readonly string[] = ORCHESTRATOR_CLAUDE_BASH_RULES): string[] {
  return [
    "mcp__wollipog__*",
    ...ORCHESTRATOR_CLAUDE_TOOLS.filter((tool) => tool !== "Bash"),
    ...bashRules.map((rule) => `Bash(${rule})`),
  ];
}

function acpOrchestratorCapabilities(): AgentCapabilities {
  return {
    models: [],
    effortLevels: [],
    slashCommands: [],
    // These booleans describe the ACP client transport, not a provider catalog. Unknown model,
    // effort, and command controls remain permissive until the live session publishes them.
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: [ORCHESTRATOR_PRESET],
    elicitation: { [ORCHESTRATOR_PRESET]: ["none"] },
  };
}

/** Only an exact audited adapter release may receive the provider-specific restriction metadata.
 * Registry identity is runner-verified; configured launches must pin the official package exactly
 * and are independently checked again against the live ACP initialize response before session/new. */
export function supportsClaudeAgentAcpOrchestrator(agent: AgentDefinition): boolean {
  if ((agent.driver ?? "acp") !== "acp" || (agent.context?.kind ?? "native") !== "native") return false;
  if (agent.registry) {
    return agent.registry.id === "claude-acp" &&
      agent.registry.repository === CLAUDE_AGENT_ACP_REPOSITORY &&
      agent.registry.adapterVersion === CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION &&
      agent.registry.distribution === "npx" && agent.registry.installStatus === "installed";
  }
  const command = agent.command.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase();
  if (command !== "npx" && command !== "npx.cmd") return false;
  const pinned = `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`;
  return (agent.args.length === 1 && agent.args[0] === pinned) ||
    (agent.args.length === 2 && (agent.args[0] === "-y" || agent.args[0] === "--yes") &&
      agent.args[1] === pinned);
}

export function assertClaudeAgentAcpOrchestratorIdentity(
  implementation: AcpImplementationDiagnostics | null,
): void {
  if (implementation?.name !== CLAUDE_AGENT_ACP_PACKAGE ||
      implementation.version !== CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION) {
    throw new Error(
      `Orchestrator ACP launch refused: expected ${CLAUDE_AGENT_ACP_PACKAGE} ${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}.`,
    );
  }
}

/** Runner-owned metadata interpreted by the exact adapter release above. Its explicit built-in
 * allowlist, restricted Bash patterns, and sole Wollipog MCP server form the adapter boundary;
 * client-service refusal in AcpClient is defense in depth. User/project settings and hooks are
 * excluded at query creation. */
export function orchestratorAcpSessionMeta(projectPaths: readonly string[] = []): Record<string, unknown> {
  return {
    claudeCode: {
      options: {
        tools: ORCHESTRATOR_CLAUDE_TOOLS,
        allowedTools: claudeAllowedTools(),
        disallowedTools: [
          "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task",
        ],
        permissionMode: "dontAsk",
        systemPrompt: { type: "preset", preset: "claude_code", append: orchestratorInstructions(projectPaths) },
        settingSources: [],
        settings: { disableAllHooks: true },
        hooks: {},
        mcpServers: {},
        additionalDirectories: [...new Set(projectPaths.filter(Boolean))],
      },
    },
  };
}

/** A runner-owned capability, distinct from provider permission modes. ACP adapters may execute
 * their own internal tools, so client-side fs/terminal refusal cannot establish this boundary. */
export function withOrchestratorPreset(
  agents: AgentDefinition[],
  host: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: typeof existsSync;
    isolationMode?: OrchestratorIsolationMode; wslIsolationMode?: OrchestratorIsolationMode } = {},
): AgentDefinition[] {
  return agents.map((agent) => {
    const acpSupported = supportsClaudeAgentAcpOrchestrator(agent);
    const contextKind = agent.context?.kind ?? "native";
    const wslSupported = contextKind === "wsl" && agent.wslAgentControl?.protocolVersion === 1 &&
      agent.wslAgentControl.safeLauncherProtocolVersion === 1 &&
      (host.isolationMode ?? host.wslIsolationMode) === "bwrap" &&
      ["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "acp");
    const codexApprovalSupported = agent.driver !== "codex" && agent.driver !== "codex-app-server" ||
      agent.codexAppServer?.orchestratorApproval?.status === "supported";
    const piSupported = agent.driver !== "pi" || agent.piAgentControl?.protocolVersion === 1;
    if (!codexApprovalSupported && agent.capabilities?.permissionModes?.includes(ORCHESTRATOR_PRESET)) {
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    if (!piSupported && agent.capabilities?.permissionModes?.includes(ORCHESTRATOR_PRESET)) {
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    if (contextKind === "wsl" && !wslSupported && agent.capabilities?.permissionModes?.includes(ORCHESTRATOR_PRESET)) {
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    if (!codexApprovalSupported || !piSupported || (contextKind !== "native" && !wslSupported) ||
        (!acpSupported && !["claude-code", "codex", "codex-app-server", "pi"].includes(agent.driver ?? "acp"))) return agent;
    const nativeBoundaryRequired = acpSupported || ["codex", "codex-app-server", "pi"].includes(agent.driver ?? "acp");
    if (contextKind === "native" && nativeBoundaryRequired && !supportsNativeOrchestratorBoundary(
      agent.driver ?? "acp", host.platform ?? process.platform, host.isolationMode ?? host.wslIsolationMode,
    )) {
      if (!agent.capabilities?.permissionModes?.includes(ORCHESTRATOR_PRESET)) return agent;
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    if (acpSupported && !agent.capabilities) {
      return { ...agent, capabilities: acpOrchestratorCapabilities() };
    }
    if (!agent.capabilities) return agent;
    if (agent.driver === "claude-code" &&
        !(agent.capabilities.supportsApprovals &&
          agent.capabilities.permissionModes?.includes("default"))) {
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes?.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    return { ...agent, capabilities: {
      ...agent.capabilities,
      permissionModes: [...new Set([...(agent.capabilities.permissionModes ?? []), ORCHESTRATOR_PRESET])],
    } };
  });
}

/** An older control plane cannot request the provider-mode policy, so do not advertise a native
 * Claude Orchestrator that could only run without Strict Project Isolation. Strict-capable Claude,
 * native Codex, ACP, and verified Direct WSL peers retain their legacy-safe advertisement. */
export function projectOrchestratorPresetForPeer(
  agents: AgentDefinition[],
  host: {
    controlPlaneProtocolVersion: number | null;
    platform?: NodeJS.Platform;
    isolationMode?: OrchestratorIsolationMode;
  },
): AgentDefinition[] {
  if (runnerSupportsProtocol(host.controlPlaneProtocolVersion, "orchestratorExecutionPolicy")) {
    return agents;
  }
  return agents.map((agent) => {
    const permissionModes = agent.capabilities?.permissionModes;
    if ((agent.context?.kind ?? "native") !== "native" || agent.driver !== "claude-code" ||
        !permissionModes?.includes(ORCHESTRATOR_PRESET)) return agent;
    const legacyStrictSupported = supportsNativeOrchestratorBoundary(
      agent.driver,
      host.platform ?? process.platform,
      host.isolationMode,
    ) && agent.capabilities?.supportsApprovals === true && permissionModes.includes("default");
    if (legacyStrictSupported) return agent;
    return {
      ...agent,
      capabilities: {
        ...agent.capabilities!,
        permissionModes: permissionModes.filter(
          (mode) => mode !== ORCHESTRATOR_PRESET,
        ),
      },
    };
  });
}

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }`;
  }
  throw new Error("unsupported orchestrator MCP configuration value");
}

/** The native harness grants only the planning surface described above; the control plane
 * independently scopes the credential. Unknown feature flags fail launch rather than falling back
 * to an unrestricted mode. */
export function orchestratorLaunchArgs(
  driver: SessionLaunchSpec["driver"],
  mcp: { command: string; args: string[]; env: Record<string, string> },
  projectPaths: readonly string[] = [],
  strictProjectIsolation = true,
): string[] {
  const instructions = orchestratorInstructions(projectPaths, strictProjectIsolation);
  if (driver === "claude-code") {
    if (!strictProjectIsolation) {
      return ["--strict-mcp-config", "--allowedTools",
        claudeAllowedTools(PROVIDER_ORCHESTRATOR_CLAUDE_BASH_RULES).join(","),
        "--append-system-prompt", instructions,
        ...projectPaths.flatMap((path) => ["--add-dir", path])];
    }
    return ["--tools", ORCHESTRATOR_CLAUDE_TOOLS.join(","), "--strict-mcp-config", "--disable-slash-commands",
      "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools().join(","),
      "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Agent,Task",
      "--append-system-prompt", instructions,
      ...projectPaths.flatMap((path) => ["--add-dir", path]),
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}'];
  }
  if (driver === "pi") {
    return [
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "--exclude-tools", "bash,edit,write",
      "--append-system-prompt", instructions,
    ];
  }
  if (driver !== "codex" && driver !== "codex-app-server") {
    throw new Error("the orchestrator preset requires a native harness that can enforce its planning boundary");
  }
  return [
    "--strict-config",
    ...["apps", "plugins", "hooks",
      "multi_agent", "browser_use", "computer_use", "image_generation"].flatMap((feature) => ["--disable", feature]),
    "-c", 'sandbox_mode="workspace-write"',
    ...(strictProjectIsolation ? ["-c", "sandbox_workspace_write.writable_roots=[]"] : []),
    "-c", "sandbox_workspace_write.network_access=true",
    ...(strictProjectIsolation ? ["-c", "sandbox_workspace_write.exclude_slash_tmp=true"] : []),
    "-c", 'approvals_reviewer="auto_review"',
    "-c", `approval_policy=${toml({ granular: {
      mcp_elicitations: true,
      request_permissions: false,
      rules: false,
      sandbox_approval: false,
      skill_approval: false,
    } })}`,
    "-c", 'web_search="live"',
    "-c", `developer_instructions=${toml(instructions)}`,
    "-c", `mcp_servers=${toml({ wollipog: {
      ...mcp,
      enabled: true,
      default_tools_approval_mode: "approve",
    } })}`,
  ];
}

const ADDITIVE_CLAUDE_ALLOWED_TOOLS = "mcp__wollipog__*";

/** Codex merges a dotted `mcp_servers.<name>` override into the user's table (verified against
 * codex-cli 0.154.0), so naming the single Wollipog entry adds it without touching, disabling, or
 * re-declaring any configured server. The coupled preset's whole-table form merges too, which is
 * exactly why it also needs `--strict-config` and the explicit isolation probe. */
const ADDITIVE_CODEX_MCP_KEY = "mcp_servers.wollipog";
/** The role marker is present in every runner-built Wollipog MCP entry and never in a user's own. */
const ADDITIVE_CODEX_MCP_MARKER = ORCHESTRATOR_ENV_KEY;

/** Exactly `mcp_servers.wollipog` (the whole entry or one of its fields), never a server whose
 * name merely starts with it, such as `mcp_servers.wollipog-helper`. */
function namesReservedCodexMcpServer(setting: string): boolean {
  return setting.startsWith(`${ADDITIVE_CODEX_MCP_KEY}=`) || setting.startsWith(`${ADDITIVE_CODEX_MCP_KEY}.`);
}

/** A user-supplied launch argument that configures an MCP server under Wollipog's reserved name.
 * The additive launch names its single entry by that key, so it would silently replace it. */
export function reservedCodexMcpNameCollision(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    const flag = arg.split("=", 1)[0]!;
    if (flag !== "-c" && flag !== "--config") return false;
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
    return typeof value === "string" && namesReservedCodexMcpServer(value) &&
      !value.includes(ADDITIVE_CODEX_MCP_MARKER);
  });
}

export function additiveCodexMcpServerArg(
  mcp: { command: string; args: string[]; env: Record<string, string> },
): string {
  return `mcp_servers.wollipog=${toml({ ...mcp, enabled: true, default_tools_approval_mode: "approve" })}`;
}

/**
 * Independent provider permissions (protocol v160 for Claude Code, v161 for the Codex drivers): the
 * harness launches exactly as an equivalent normal session and only gains Wollipog's orchestration
 * tools, instructions, and — for Claude — project read locations. Nothing here narrows the
 * permission mode, sandbox, approval policy, built-in tool inventory, apps, plugins, hooks,
 * multi-agent or multimodal tools, settings sources, or configured MCP servers.
 *
 * Claude's Wollipog server arrives through the general Agent Control MCP config that ordinary
 * sessions already receive, so only the pre-authorization, instructions, and Project Locations are
 * added here. Codex has no such per-session config file, so the server is named inline instead.
 *
 * Codex has no append form for instructions: `developer_instructions` is a plain string, the last
 * `-c` wins, and `additional_developer_instructions` is managed-configuration-only and ignored from
 * the CLI. Setting it therefore replaces a user's own top-level `developer_instructions` for the
 * duration of an Orchestrator session — the same thing today's coupled preset does, so it is not a
 * regression, but it is the one part of the Codex launch that is not purely additive.
 *
 * No sandbox, approval, reviewer, or `--add-dir` override is injected: Project Locations are named
 * in the instructions text, and anything stronger would be the preset's fixed policy again.
 */
export function additiveOrchestratorLaunchArgs(
  driver: SessionLaunchSpec["driver"],
  mcp: { command: string; args: string[]; env: Record<string, string> },
  projectPaths: readonly string[] = [],
): string[] {
  const instructions = orchestratorInstructions(projectPaths, false);
  if (driver === "claude-code") {
    return [
      "--allowedTools", ADDITIVE_CLAUDE_ALLOWED_TOOLS,
      "--append-system-prompt", instructions,
      ...projectPaths.flatMap((path) => ["--add-dir", path]),
    ];
  }
  if (driver === "codex" || driver === "codex-app-server") {
    return [
      "-c", additiveCodexMcpServerArg(mcp),
      "-c", `developer_instructions=${toml(instructions)}`,
    ];
  }
  throw new Error("independent provider permissions are supported only for the native Claude Code and Codex Orchestrators");
}

/** Remove only the arguments `additiveOrchestratorLaunchArgs` injects, leaving every user- or
 * catalog-supplied flag (including the user's own `--add-dir`, `--allowedTools`, `--settings`,
 * `--mcp-config`, `--disable`, sandbox/approval overrides, and unrelated `-c` settings) untouched.
 * Idempotent on every resume, in both the `--flag value` and inline `--flag=value` forms. */
export function stripAdditiveOrchestratorLaunchArgs(
  args: readonly string[],
  driver: SessionLaunchSpec["driver"],
  projectPaths: readonly string[] = [],
): string[] {
  const projects = new Set(projectPaths);
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=", 1)[0]!;
    const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
    const value = inline ?? args[i + 1];
    const injected = driver === "claude-code"
      ? (flag === "--allowedTools" && value === ADDITIVE_CLAUDE_ALLOWED_TOOLS) ||
        (flag === "--append-system-prompt" && typeof value === "string" && value.startsWith(ORCHESTRATOR_INSTRUCTIONS_PREFIX)) ||
        (flag === "--add-dir" && typeof value === "string" && projects.has(value))
      // Only a `wollipog` MCP entry carrying the runner's own role marker and an
      // instructions value carrying the runner's own prefix are ours. A user's own
      // `-c mcp_servers.wollipog=...` or `-c developer_instructions=...` is left where it was;
      // provisioning refuses the former as a reserved-name collision instead of deleting it.
      : (flag === "-c" || flag === "--config") && typeof value === "string" &&
        ((namesReservedCodexMcpServer(value) && value.includes(ADDITIVE_CODEX_MCP_MARKER)) ||
          (value.startsWith("developer_instructions=") && value.includes(ORCHESTRATOR_INSTRUCTIONS_PREFIX)));
    if (injected) {
      if (inline === undefined) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

/** Replace controlled launch flags on every resume, including stale persisted provisioning. */
export function stripOrchestratorLaunchArgs(args: string[], driver: SessionLaunchSpec["driver"]): string[] {
  const result: string[] = [];
  if (driver === "pi") {
    const valueFlags = new Set(["--tools", "--exclude-tools", "--append-system-prompt", "--extension", "-e"]);
    const booleanFlags = new Set(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools"]);
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!.split("=")[0]!;
      if (booleanFlags.has(flag)) continue;
      if (valueFlags.has(flag)) {
        if (!args[i]!.includes("=")) i++;
        continue;
      }
      result.push(args[i]!);
    }
    return result;
  }
  // Retire the old misspelling too: persisted launch arguments may predate the fix.
  const claudeFlags = new Set(["--tools", "--allowedTools", "--disallowedTools", "--mcp-config", "--settings", "--setting-sources", "--settings-sources", "--permission-mode", "--append-system-prompt", "--add-dir"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=")[0]!;
    if (driver === "claude-code" && (claudeFlags.has(flag) || flag === "--strict-mcp-config" || flag === "--disable-slash-commands")) {
      if (claudeFlags.has(flag) && !arg.includes("=")) i++;
      continue;
    }
    if (driver === "claude-code" && ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"].includes(flag)) continue;
    if (driver !== "claude-code" && flag === "--strict-config") continue;
    if (driver !== "claude-code" && ["--yolo", "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--approve-for-me", "--search", "--dangerously-bypass-hook-trust"].includes(flag)) continue;
    if (driver !== "claude-code" && ["-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir"].includes(flag)) {
      if (!arg.includes("=")) i++;
      continue;
    }
    if (driver !== "claude-code" && (flag === "--enable" || flag === "--disable")) {
      if (!arg.includes("=")) i++;
      continue;
    }
    if (driver !== "claude-code" && (flag === "-c" || flag === "--config")) {
      const setting = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1] ?? "";
      if (/^(?:features\.|mcp_servers[.=]|sandbox_mode=|sandbox_workspace_write\.|approval_policy=|approvals_reviewer=|web_search=|developer_instructions=)/.test(setting)) {
        if (!arg.includes("=")) i++;
        continue;
      }
    }
    result.push(arg);
  }
  return result;
}

/** Codex merges MCP tables, even when the CLI supplies an empty table. Enumerate the
 * effective configuration at the actual launch cwd and explicitly disable every other
 * server. Never include probe output (which may contain credentials) in errors/logs. */
export function isolateCodexMcpServers(output: string): string[] {
  let servers: unknown;
  try { servers = JSON.parse(output); } catch { throw new Error("cannot verify orchestrator MCP isolation"); }
  if (!Array.isArray(servers) || !servers.some((server) => server?.name === "wollipog" && server?.enabled === true)) {
    throw new Error("cannot verify orchestrator MCP isolation");
  }
  return servers.flatMap((server) => {
    if (!server || typeof server.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(server.name)) {
      throw new Error("cannot verify orchestrator MCP isolation");
    }
    return server.name === "wollipog" ? [] : ["-c", `mcp_servers.${server.name}.enabled=false`];
  });
}

interface CodexOrchestratorProbeOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  context?: AgentDefinition["context"];
  isolation?: WslBwrapSpawnIsolation | SpawnAgentOptions["isolation"];
}

interface CodexOrchestratorProbeDependencies {
  runIsolated?: (opts: CodexOrchestratorProbeOptions, cwd: string, args: string[]) => Promise<string>;
}

/** The effective MCP inventory is provider-owned behavior, so a Direct WSL probe is provider
 * execution too. Run it through the already-prepared fd-safe boundary; a direct `wsl.exe`
 * metadata probe would reopen the exact host path that the launcher exists to close. */
async function runIsolatedCodexMcpProbe(
  opts: CodexOrchestratorProbeOptions,
  cwd: string,
  args: string[],
): Promise<string> {
  if (opts.isolation?.backend !== "wsl-bwrap" || opts.context?.kind !== "wsl") {
    throw new Error("isolated Codex MCP probe requires the target-local WSL launcher");
  }
  const child = spawnAgent({
    command: opts.command,
    args,
    cwd,
    env: opts.env,
    context: opts.context,
    scrubInheritedEnv: ["OPENAI_API_KEY"],
    isolation: opts.isolation,
  });
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      failure = new Error("isolated Codex MCP probe timed out");
      killTree(child);
      // The provider may already have closed while its dedicated WSL relay is wedged. In that
      // state killTree is intentionally a no-op, so explicitly sever the broker and relay before
      // settling the bounded probe instead of waiting forever for a close event that may not come.
      child.wslAgentControl?.dispose();
      const relay = child.wslAgentControl?.relay;
      if (relay && relay.exitCode === null && relay.signalCode === null) relay.kill();
      finish(failure);
    }, 10_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) {
        failure = new Error("isolated Codex MCP probe output exceeded its bound");
        child.stdout.removeAllListeners("data");
        child.stdout.resume();
        killTree(child);
        return;
      }
      stdout += chunk;
    });
    // The diagnostics may contain provider configuration. Drain without retaining or surfacing it;
    // otherwise a full pipe can deadlock the bounded probe before its close event.
    child.stderr.resume();
    child.once("error", () => finish(new Error("isolated Codex MCP probe could not start")));
    child.once("close", (code) => {
      const result = failure ?? (code === 0
        ? undefined
        : new Error(`isolated Codex MCP probe exited with code ${code ?? "unknown"}`));
      // The probe and real provider deliberately reuse one pinned session directory. Wait for
      // relay teardown so its unlink cleanup cannot race the next relay's exclusive bootstrap.
      const relay = child.wslAgentControl?.relay;
      if (relay && relay.exitCode === null && relay.signalCode === null) relay.once("close", () => finish(result));
      else finish(result);
    });
  });
}

export async function codexOrchestratorMcpArgs(
  opts: CodexOrchestratorProbeOptions,
  cwd: string,
  dependencies: CodexOrchestratorProbeDependencies = {},
): Promise<string[]> {
  try {
    if (opts.isolation?.backend === "wsl-bwrap") {
      if (opts.context?.kind !== "wsl") throw new Error("target-local WSL isolation context mismatch");
      const probeArgs = [...opts.args.filter((arg) => arg !== "--strict-config"), "mcp", "list", "--json"];
      const stdout = await (dependencies.runIsolated ?? runIsolatedCodexMcpProbe)(opts, cwd, probeArgs);
      return isolateCodexMcpServers(stdout);
    }
    const { probe, env, nativeCwd } = codexOrchestratorMcpProbe(opts, cwd);
    const { stdout } = await execFileAsync(probe.file, probe.args, {
      ...(nativeCwd ? { cwd: nativeCwd } : {}), env, timeout: 10_000, maxBuffer: 1024 * 1024,
      windowsHide: true,
      ...(probe.windowsVerbatimArguments ? { windowsVerbatimArguments: true, argv0: probe.argv0 } : {}),
    });
    return isolateCodexMcpServers(stdout);
  } catch {
    throw new Error("Orchestrator launch refused: unable to isolate Codex MCP servers.");
  }
}

/** Build the MCP inventory probe in the provider's real execution context. In particular, a WSL
 * path is never passed to Win32 exec directly, and explicit agent env crosses through WSLENV just
 * as it does for the subsequent provider launch. */
export function codexOrchestratorMcpProbe(
  opts: { command: string; args: string[]; env?: Record<string, string>; context?: AgentDefinition["context"] },
  cwd: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): { probe: { file: string; args: string[]; windowsVerbatimArguments?: boolean; argv0?: string };
  env: NodeJS.ProcessEnv; nativeCwd?: string } {
  // The read-only mcp subcommand rejects --strict-config; retain it on the actual provider launch,
  // where unsupported safety features must fail closed.
  const probeArgs = [...opts.args.filter((arg) => arg !== "--strict-config"), "mcp", "list", "--json"];
  const wsl = opts.context?.kind === "wsl" ? opts.context : undefined;
  const env = { ...hostEnv, ...opts.env };
  if (!wsl) return { probe: windowsCommandSpec(opts.command, probeArgs), env, nativeCwd: cwd };
  if (opts.env) {
    const existing = (env.WSLENV ?? "").split(":").filter(Boolean);
    const known = new Set(existing.map((entry) => entry.split("/")[0]?.toLowerCase()));
    env.WSLENV = [...existing, ...Object.keys(opts.env).filter((name) => !known.has(name.toLowerCase()))].join(":");
  }
  return { probe: { file: "wsl.exe",
    args: ["-d", wsl.distro, "--cd", cwd, "--exec", opts.command, ...probeArgs] }, env };
}
