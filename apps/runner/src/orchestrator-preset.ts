import type { AcpImplementationDiagnostics } from "./acp-contract.js";
import type { AgentDefinition, AgentCapabilities, SessionLaunchSpec } from "@wollipog/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsCommandSpec } from "./windows-cmd.js";
import { existsSync } from "node:fs";
import { verifiedNativeClaudeGitBashPath } from "./discovery/claude-code.js";

const execFileAsync = promisify(execFile);

export const ORCHESTRATOR_PRESET = "orchestrator";
export const ORCHESTRATOR_ENV_KEY = "WOLLIPOG_PERMISSION_PRESET";
export const CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION = "0.75.1";
const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_AGENT_ACP_REPOSITORY = "https://github.com/agentclientprotocol/claude-agent-acp";

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

/** Runner-owned metadata interpreted by the exact adapter release above. Empty built-in tools plus
 * a sole allowlisted Wollipog MCP server are the enforcement boundary; client-service refusal in
 * AcpClient is defense in depth. User/project settings and hooks are excluded at query creation. */
export function orchestratorAcpSessionMeta(): Record<string, unknown> {
  return {
    claudeCode: {
      options: {
        tools: [],
        allowedTools: ["mcp__wollipog__*"],
        disallowedTools: [
          "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task",
          "WebFetch", "WebSearch",
        ],
        settingSources: [],
        settings: { disableAllHooks: true },
        hooks: {},
        mcpServers: {},
        additionalDirectories: [],
      },
    },
  };
}

/** A runner-owned capability, distinct from provider permission modes. ACP adapters may execute
 * their own internal tools, so client-side fs/terminal refusal cannot establish this boundary. */
export function withOrchestratorPreset(
  agents: AgentDefinition[],
  host: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: typeof existsSync } = {},
): AgentDefinition[] {
  return agents.filter((agent) => agent.id !== "conductor").map((agent) => {
    const acpSupported = supportsClaudeAgentAcpOrchestrator(agent);
    const contextKind = agent.context?.kind ?? "native";
    const wslSupported = contextKind === "wsl" && agent.wslAgentControl?.protocolVersion === 1 &&
      ["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "acp");
    if (contextKind === "wsl" && !wslSupported && agent.capabilities?.permissionModes?.includes(ORCHESTRATOR_PRESET)) {
      return { ...agent, capabilities: { ...agent.capabilities,
        permissionModes: agent.capabilities.permissionModes.filter((mode) => mode !== ORCHESTRATOR_PRESET) } };
    }
    if ((contextKind !== "native" && !wslSupported) ||
        (!acpSupported && !["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "acp"))) return agent;
    if (contextKind === "native" && (agent.driver === "claude-code" || acpSupported) &&
        (host.platform ?? process.platform) === "win32") {
      if (!verifiedNativeClaudeGitBashPath(agent.env ?? {}, { env: host.env, exists: host.exists })) return agent;
    }
    if (acpSupported && !agent.capabilities) {
      return { ...agent, capabilities: acpOrchestratorCapabilities() };
    }
    if (!agent.capabilities) return agent;
    if (agent.driver === "claude-code" && !agent.capabilities.permissionModes?.includes("default")) return agent;
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

/** The native harness removes execution tools; the control plane independently scopes the
 * credential. Unknown feature flags fail launch rather than falling back to an unrestricted mode. */
export function orchestratorLaunchArgs(
  driver: SessionLaunchSpec["driver"],
  mcp: { command: string; args: string[]; env: Record<string, string> },
): string[] {
  if (driver === "claude-code") {
    return ["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--allowedTools", "mcp__wollipog__*",
      "--disallowedTools", "Bash,Write,Edit,MultiEdit,NotebookEdit,Agent,Task",
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}'];
  }
  if (driver !== "codex" && driver !== "codex-app-server") {
    throw new Error("the orchestrator preset requires a native harness that can disable execution tools");
  }
  return [
    "--strict-config",
    ...["shell_tool", "unified_exec", "js_repl", "code_mode", "apps", "plugins", "hooks",
      "multi_agent", "browser_use", "computer_use", "image_generation"].flatMap((feature) => ["--disable", feature]),
    "-c", 'sandbox_mode="read-only"',
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    "-c", `mcp_servers=${toml({ wollipog: { ...mcp, enabled: true } })}`,
  ];
}

/** Replace controlled launch flags on every resume, including stale persisted provisioning. */
export function stripOrchestratorLaunchArgs(args: string[], driver: SessionLaunchSpec["driver"]): string[] {
  const result: string[] = [];
  // Retire the old misspelling too: persisted launch arguments may predate the fix.
  const claudeFlags = new Set(["--tools", "--allowedTools", "--disallowedTools", "--mcp-config", "--settings", "--setting-sources", "--settings-sources"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=")[0]!;
    if (driver === "claude-code" && (claudeFlags.has(flag) || flag === "--strict-mcp-config" || flag === "--disable-slash-commands")) {
      if (claudeFlags.has(flag) && !arg.includes("=")) i++;
      continue;
    }
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
      if (/^(?:features\.|mcp_servers[.=]|sandbox_mode=|approval_policy=|web_search=)/.test(setting)) {
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

export async function codexOrchestratorMcpArgs(
  opts: { command: string; args: string[]; env?: Record<string, string>; context?: AgentDefinition["context"] },
  cwd: string,
): Promise<string[]> {
  try {
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
