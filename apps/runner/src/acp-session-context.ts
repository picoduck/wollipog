import { isAbsolute, resolve } from "node:path";
import type {
  AcpMcpServerConfig,
  AcpSessionContextConfig,
  AgentContext,
} from "@wollipog/protocol";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpNegotiation } from "./acp-contract.js";

const MAX_SERVERS = 32;
const MAX_ARGS = 64;
const MAX_ENTRIES = 64;
const MAX_DIRECTORIES = 16;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/;
const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_HEADER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;

export interface AcpContextScopes {
  runner?: AcpMcpServerConfig[];
  workspace?: AcpMcpServerConfig[];
  agent?: AcpMcpServerConfig[];
  session?: AcpSessionContextConfig;
  additionalDirectoryGrants?: string[];
  additionalDirectoriesEnabled?: boolean;
  context?: AgentContext;
}

/** Merge precedence is runner < workspace < agent < session, replacing equal names in place. */
export function resolveAcpSessionContext(scopes: AcpContextScopes): AcpSessionContextConfig {
  const merged = new Map<string, AcpMcpServerConfig>();
  for (const source of [scopes.runner, scopes.workspace, scopes.agent, scopes.session?.mcpServers]) {
    for (const server of source ?? []) {
      validateServer(server, scopes.context);
      merged.set(server.name, structuredClone(server));
    }
  }
  const mcpServers = [...merged.values()].filter((server) => !server.disabled);
  if (mcpServers.length > MAX_SERVERS) throw new Error(`ACP MCP configuration exceeds ${MAX_SERVERS} enabled servers`);

  const requested = unique(scopes.session?.additionalDirectories ?? []);
  if (requested.length > MAX_DIRECTORIES) throw new Error(`ACP additional directories exceed ${MAX_DIRECTORIES}`);
  if (requested.length && !scopes.additionalDirectoriesEnabled) {
    throw new Error("ACP additional directories are disabled by the runner preview feature flag");
  }
  // A configured grant in a different context must not break sessions that did not request it.
  // Validate/canonicalize the policy surface only when it is actually activated.
  const grants = requested.length
    ? new Set((scopes.additionalDirectoryGrants ?? []).map((path) => normalizeAbsolute(path, scopes.context)))
    : new Set<string>();
  const additionalDirectories = requested.map((path) => {
    const normalized = normalizeAbsolute(path, scopes.context);
    if (!grants.has(normalized)) throw new Error(`ACP additional directory is not granted for this workspace: ${path}`);
    return normalized;
  });
  return {
    ...(mcpServers.length ? { mcpServers } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
  };
}

/** Convert secret references to ACP wire values at the last responsible moment. */
export function materializeAcpMcpServers(
  configured: AcpMcpServerConfig[] | undefined,
  negotiation: AcpNegotiation,
  env: NodeJS.ProcessEnv = process.env,
): McpServer[] {
  return (configured ?? []).map((server): McpServer => {
    if (server.type === "http" && !negotiation.stable.mcpHttp) {
      throw new Error(`ACP agent does not advertise HTTP MCP support required by '${server.name}'`);
    }
    if (server.type === "sse" && !negotiation.stable.mcpSse) {
      throw new Error(`ACP agent does not advertise SSE MCP support required by '${server.name}'`);
    }
    if (server.type === "stdio") {
      return {
        name: server.name,
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, ref]) => ({ name, value: secret(ref.fromEnv, server.name, env) })),
      };
    }
    return {
      type: server.type,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, ref]) => ({ name, value: secret(ref.fromEnv, server.name, env) })),
    };
  });
}

function validateServer(server: AcpMcpServerConfig, context?: AgentContext): void {
  if (!server || typeof server !== "object" || typeof server.name !== "string" || !SAFE_NAME.test(server.name)) throw new Error("ACP MCP server name is invalid");
  const allowed = server.type === "stdio"
    ? new Set(["type", "name", "command", "args", "env", "disabled"])
    : new Set(["type", "name", "url", "headers", "disabled"]);
  if (Object.keys(server).some((key) => !allowed.has(key))) throw new Error(`ACP MCP server '${server.name}' contains unsupported fields`);
  if (server.disabled != null && typeof server.disabled !== "boolean") throw new Error(`ACP MCP server '${server.name}' has invalid disabled flag`);
  if (server.type === "stdio") {
    if (typeof server.command !== "string" || !isContextAbsolute(server.command, context)) {
      throw new Error(`ACP stdio MCP command for '${server.name}' must be an absolute path`);
    }
    if (!Array.isArray(server.args ?? []) || (server.args?.length ?? 0) > MAX_ARGS || (server.args ?? []).some((arg) => typeof arg !== "string" || arg.length > 4096)) {
      throw new Error(`ACP stdio MCP args for '${server.name}' are invalid`);
    }
    validateRefs(server.env, server.name, SAFE_ENV);
    return;
  }
  if (server.type !== "http" && server.type !== "sse") throw new Error(`ACP MCP server '${server.name}' uses an unsupported transport`);
  let url: URL;
  try { url = new URL(server.url); } catch { throw new Error(`ACP MCP URL for '${server.name}' is invalid`); }
  if (url.username || url.password) throw new Error(`ACP MCP URL for '${server.name}' must not contain credentials`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"))) {
    throw new Error(`ACP remote MCP URL for '${server.name}' must use HTTPS (HTTP is allowed only on loopback)`);
  }
  validateRefs(server.headers, server.name, SAFE_HEADER);
}

function validateRefs(refs: Record<string, { fromEnv: string }> | undefined, server: string, keyPattern: RegExp): void {
  const entries = Object.entries(refs ?? {});
  if (entries.length > MAX_ENTRIES) throw new Error(`ACP MCP references for '${server}' exceed ${MAX_ENTRIES}`);
  for (const [name, ref] of entries) {
    if (!keyPattern.test(name) || typeof ref !== "object" || ref == null || Object.keys(ref).length !== 1 || !SAFE_ENV.test(ref.fromEnv)) {
      throw new Error(`ACP MCP environment reference for '${server}' is invalid`);
    }
  }
}

function secret(name: string, server: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value == null) throw new Error(`ACP MCP server '${server}' requires runner environment variable '${name}'`);
  return value;
}

function isContextAbsolute(path: string, context?: AgentContext): boolean {
  if (!context) return path.startsWith("/") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
  return context.kind === "wsl" ? path.startsWith("/") : isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizeAbsolute(path: string, context?: AgentContext): string {
  if (typeof path !== "string" || !path.trim() || path.length > 4096 || !isContextAbsolute(path, context)) {
    throw new Error(`ACP additional directory must be an absolute ${context?.kind === "wsl" ? "WSL" : "host"} path: ${path}`);
  }
  if (context?.kind === "wsl") return path.replace(/\/+$/, "") || "/";
  return resolve(path);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
