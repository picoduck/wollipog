import type { AcpImplementationDiagnostics } from "./acp-contract.js";
import type { AgentDefinition, AgentCapabilities, SessionLaunchSpec } from "@wollipog/protocol";
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

const ORCHESTRATOR_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash"];
const ORCHESTRATOR_CLAUDE_BASH_RULES = [
  "git log", "git log:*", "git diff", "git diff:*", "git show", "git show:*",
  "git blame:*", "git status", "git status:*", "git worktree list", "git worktree list:*",
  "git branch", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch --show-current",
  "gh issue list", "gh issue list:*", "gh issue view:*", "gh issue status", "gh issue status:*",
  "gh issue edit --add-assignee:*", "gh issue edit --remove-assignee:*",
  "gh issue edit --add-label:*", "gh issue edit --remove-label:*", "gh issue comment:*",
  "gh pr list", "gh pr list:*", "gh pr view:*", "gh pr checks:*", "gh pr diff:*", "gh pr status",
  "gh pr status:*",
];

export function orchestratorInstructions(projectPaths: readonly string[]): string {
  const locations = [...new Set(projectPaths.filter(Boolean))];
  return [
    "You are running with the Wollipog Orchestrator preset. Plan, delegate to child sessions, and verify their results; do not implement project changes yourself.",
    "Your working directory is private per-session scratch space. You may create notes and ledgers there, but nowhere else.",
    locations.length
      ? `Project locations are read-only: ${locations.map((path) => JSON.stringify(path)).join(", ")}.`
      : "Project locations are read-only and may be inspected by absolute path.",
    "You may read and search project files and user skill directories, inspect Git history and branches, read GitHub issues, pull requests, checks, review threads, and comments, search or fetch the web, and use Wollipog session-management tools.",
    "GitHub writes are limited to assigning or unassigning issues, changing issue labels, and posting plan or status comments.",
    "Do not edit project files, run builds, tests, or typechecks in a project location, commit, push, create branches or worktrees for yourself, open pull requests, merge, or perform control-plane mutations outside descendant session management.",
    "If a requested operation is outside that boundary, explain that the Orchestrator preset refuses it and delegate the implementation to a child session.",
  ].join(" ");
}

function claudeAllowedTools(): string[] {
  return [
    "mcp__wollipog__*",
    ...ORCHESTRATOR_CLAUDE_TOOLS.filter((tool) => tool !== "Bash"),
    ...ORCHESTRATOR_CLAUDE_BASH_RULES.map((rule) => `Bash(${rule})`),
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
    wslIsolationMode?: "provider" | "bwrap" | "seatbelt" | "windows-job" } = {},
): AgentDefinition[] {
  return agents.filter((agent) => agent.id !== "conductor").map((agent) => {
    const acpSupported = supportsClaudeAgentAcpOrchestrator(agent);
    const contextKind = agent.context?.kind ?? "native";
    const wslSupported = contextKind === "wsl" && agent.wslAgentControl?.protocolVersion === 1 &&
      agent.wslAgentControl.safeLauncherProtocolVersion === 1 &&
      host.wslIsolationMode === "bwrap" &&
      ["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "acp");
    if (contextKind === "wsl" && !wslSupported && agent.capabilities?.permissionModes?.includes(ORCHESTRATOR_PRESET)) {
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    if ((contextKind !== "native" && !wslSupported) ||
        (!acpSupported && !["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "acp"))) return agent;
    // Windows Job Objects do not attest filesystem confinement, and Claude Bash-prefix rules
    // cannot prevent an otherwise read-only Git command from redirecting output into a project.
    if (contextKind === "native" && (host.platform ?? process.platform) === "win32") return agent;
    if (acpSupported && !agent.capabilities) {
      return { ...agent, capabilities: acpOrchestratorCapabilities() };
    }
    if (!agent.capabilities) return agent;
    if (agent.driver === "claude-code" &&
        !(agent.capabilities.permissionModes?.includes("default") &&
          agent.capabilities.permissionModes.includes("dontAsk"))) return agent;
    return { ...agent, capabilities: {
      ...agent.capabilities,
      permissionModes: [...new Set([...(agent.capabilities.permissionModes ?? []), ORCHESTRATOR_PRESET])],
    } };
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
): string[] {
  const instructions = orchestratorInstructions(projectPaths);
  if (driver === "claude-code") {
    return ["--tools", ORCHESTRATOR_CLAUDE_TOOLS.join(","), "--strict-mcp-config", "--disable-slash-commands",
      "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools().join(","),
      "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Agent,Task",
      "--append-system-prompt", instructions,
      ...projectPaths.flatMap((path) => ["--add-dir", path]),
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}'];
  }
  if (driver !== "codex" && driver !== "codex-app-server") {
    throw new Error("the orchestrator preset requires a native harness that can enforce its planning boundary");
  }
  return [
    "--strict-config",
    ...["apps", "plugins", "hooks",
      "multi_agent", "browser_use", "computer_use", "image_generation"].flatMap((feature) => ["--disable", feature]),
    "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write.writable_roots=[]",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c", 'approval_policy="never"',
    "-c", 'web_search="live"',
    "-c", `developer_instructions=${toml(instructions)}`,
    "-c", `mcp_servers=${toml({ wollipog: { ...mcp, enabled: true } })}`,
  ];
}

/** Replace controlled launch flags on every resume, including stale persisted provisioning. */
export function stripOrchestratorLaunchArgs(args: string[], driver: SessionLaunchSpec["driver"]): string[] {
  const result: string[] = [];
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
      if (/^(?:features\.|mcp_servers[.=]|sandbox_mode=|sandbox_workspace_write\.|approval_policy=|web_search=|developer_instructions=)/.test(setting)) {
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
