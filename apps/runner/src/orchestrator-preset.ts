import type { AgentDefinition, SessionLaunchSpec } from "@wollipog/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ORCHESTRATOR_PRESET = "orchestrator";
export const ORCHESTRATOR_ENV_KEY = "WOLLIPOG_PERMISSION_PRESET";

/** A runner-owned capability, distinct from provider permission modes. ACP adapters may execute
 * their own internal tools, so client-side fs/terminal refusal cannot establish this boundary. */
export function withOrchestratorPreset(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter((agent) => agent.id !== "conductor").map((agent) => {
    if (!agent.capabilities || (agent.context?.kind ?? "native") !== "native" ||
        !["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "acp")) return agent;
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
      "--settings-sources", "", "--settings", '{"disableAllHooks":true}'];
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
  const claudeFlags = new Set(["--tools", "--allowedTools", "--disallowedTools", "--mcp-config", "--settings", "--settings-sources"]);
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
  opts: { command: string; args: string[]; env?: Record<string, string> },
  cwd: string,
): Promise<string[]> {
  try {
    // The read-only mcp subcommand rejects --strict-config; retain it on the actual
    // provider launch, where unsupported safety features must fail closed.
    const { stdout } = await execFileAsync(opts.command, [...opts.args.filter((arg) => arg !== "--strict-config"), "mcp", "list", "--json"], {
      cwd, env: { ...process.env, ...opts.env }, timeout: 10_000, maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return isolateCodexMcpServers(stdout);
  } catch {
    throw new Error("Orchestrator launch refused: unable to isolate Codex MCP servers.");
  }
}
