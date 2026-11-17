import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASSISTANT_MCP_SERVER_NAME, type SessionLaunchSpec } from "@wollipog/protocol";
import { assertSafeSessionFileId } from "./session-file-id.js";

/** First line of the role instructions. Also the marker that finds them in persisted arguments,
 * so a relaunch replaces them instead of appending a second copy. */
export const ASSISTANT_INSTRUCTIONS_PREFIX = "You are the Wollipog Assistant";

/** Concise role instructions for an `assistant`-role session (#4663). The shared `wollipog`
 * assistant skill carries the detail. */
export const ASSISTANT_INSTRUCTIONS = [
  `${ASSISTANT_INSTRUCTIONS_PREFIX}, working in one of your owner's threads inside Wollipog.`,
  `You act on your owner's Wollipog installation only through the Assistant tools of the \`${ASSISTANT_MCP_SERVER_NAME}\` MCP server. ` +
    "Call assistant_discover first to learn the installation, your connection's grant and the operations it allows.",
  "Before a mutation, choose a new command ID and keep it. If a call's outcome is unknown, read its receipt with the same ID " +
    "instead of sending the command again.",
  "Report what you did and what each call returned, including refusals, plainly and briefly.",
  "Never confirm, approve or answer anything on your owner's behalf. A destructive action, an approval or a question for the " +
    "owner waits for the owner, in Wollipog; tell them it is waiting and stop.",
  "Credentials, governance, budgets and persistent permission grants stay with your owner. Never ask for a credential or " +
    "try to read one.",
].join("\n\n");

/** The relay-only stdio adapter and its environment: an endpoint and a relay key, never a credential. */
export interface AssistantMcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Harness drivers that can carry the assistant launch. */
export function assistantLaunchSupported(driver: SessionLaunchSpec["driver"]): boolean {
  return driver === "claude-code" || driver === "codex" || driver === "codex-app-server";
}

/** Claude Code's per-session config naming only the assistant server, in the runner's data
 * directory, never the session's worktree. */
export function assistantMcpConfigPath(configDir: string, sessionId: string): string {
  assertSafeSessionFileId(sessionId);
  return join(configDir, `${sessionId}.assistant-mcp.json`);
}

export function writeAssistantMcpConfig(file: string, mcp: AssistantMcpLaunch): void {
  mkdirSync(dirname(file), { recursive: true });
  const body = { mcpServers: { [ASSISTANT_MCP_SERVER_NAME]: { type: "stdio", command: mcp.command, args: mcp.args, env: mcp.env } } };
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows uses the owning account ACL. */ }
}

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }`;
  }
  throw new Error("unsupported Assistant MCP configuration value");
}

const CLAUDE_ALLOWED_TOOLS = `mcp__${ASSISTANT_MCP_SERVER_NAME}`;
const CODEX_SERVER_KEY = `mcp_servers.${ASSISTANT_MCP_SERVER_NAME}=`;

/** Removes the role instructions and proxy server an earlier launch of this session added. A
 * user's own instructions and servers are left where they were. */
export function stripAssistantLaunchArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (typeof value === "string" && (
      (args[i] === "--append-system-prompt" && value.startsWith(ASSISTANT_INSTRUCTIONS_PREFIX)) ||
      (args[i] === "--mcp-config" && value.endsWith(".assistant-mcp.json")) ||
      (args[i] === "--allowedTools" && value === CLAUDE_ALLOWED_TOOLS) ||
      (args[i] === "-c" && (value.startsWith(CODEX_SERVER_KEY) ||
        value.startsWith(`developer_instructions=${JSON.stringify(ASSISTANT_INSTRUCTIONS_PREFIX).slice(0, -1)}`))))) {
      i++;
      continue;
    }
    kept.push(args[i]!);
  }
  return kept;
}

/** The launch arguments of an `assistant`-role session: its baseline, its thread's proxy server
 * under the stable name `wollipog_assistant`, pre-authorized because every call is authorized
 * again by the control plane, and the role instructions. It receives no general Wollipog
 * agent-control server, CLI or credential. Refuses a harness that cannot carry it, so it never
 * launches as an ordinary session instead. */
export function assistantLaunchArgs(driver: SessionLaunchSpec["driver"], args: readonly string[],
  mcp: AssistantMcpLaunch & { configFile?: string }, guide?: string): string[] {
  if (!assistantLaunchSupported(driver)) {
    throw new Error("Wollipog Assistant threads run only on Claude Code or Codex. Start the thread with one of them.");
  }
  const baseline = stripAssistantLaunchArgs(args);
  // The shared `wollipog` skill follows the role instructions; both start with the same marker.
  const instructions = guide?.trim() ? `${ASSISTANT_INSTRUCTIONS}\n\n${guide.trim()}` : ASSISTANT_INSTRUCTIONS;
  if (driver === "claude-code") {
    if (!mcp.configFile) throw new Error("a Claude Code assistant launch needs its proxy configuration file");
    return [...baseline, "--mcp-config", mcp.configFile, "--allowedTools", CLAUDE_ALLOWED_TOOLS,
      "--append-system-prompt", instructions];
  }
  // Codex has no append form: the last `developer_instructions` wins, as for an Orchestrator.
  // The relay endpoint and key reach the adapter by name from the provider's environment, never
  // as values in process arguments, which other local users can list.
  return [...baseline,
    "-c", `${CODEX_SERVER_KEY}${toml({ command: mcp.command, args: mcp.args, env_vars: Object.keys(mcp.env), enabled: true,
      default_tools_approval_mode: "approve" })}`,
    "-c", `developer_instructions=${JSON.stringify(instructions)}`];
}
