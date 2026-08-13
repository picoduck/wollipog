import assert from "node:assert/strict";
import test from "node:test";
import type { AcpNegotiation } from "./acp-contract.js";
import { materializeAcpMcpServers, resolveAcpSessionContext } from "./acp-session-context.js";

const negotiation = (overrides: Partial<AcpNegotiation["stable"]> = {}): AcpNegotiation => ({
  protocolVersion: 1,
  schemaAuthority: { package: "@agentclientprotocol/sdk", version: "1.2.1" },
  agentInfo: null,
  authMethods: [],
  stable: {
    loadSession: true,
    promptImage: false,
    promptAudio: false,
    promptEmbeddedContext: false,
    mcpHttp: true,
    mcpSse: true,
    sessionList: false,
    sessionDelete: false,
    sessionAdditionalDirectories: true,
    sessionResume: true,
    sessionClose: true,
    logout: false,
    ...overrides,
  },
  experimentalAdvertised: [],
});

test("MCP scopes merge runner < workspace < agent < session without retaining disabled entries", () => {
  const result = resolveAcpSessionContext({
    runner: [{ type: "http", name: "shared", url: "https://runner.example/mcp" }],
    workspace: [{ type: "http", name: "shared", url: "https://workspace.example/mcp" }],
    agent: [{ type: "sse", name: "agent", url: "https://agent.example/sse" }],
    session: { mcpServers: [
      { type: "http", name: "shared", url: "https://session.example/mcp" },
      { type: "sse", name: "agent", url: "https://disabled.example/sse", disabled: true },
    ] },
  });
  assert.deepEqual(result.mcpServers, [{ type: "http", name: "shared", url: "https://session.example/mcp" }]);
});

test("additional directories require both preview flag and an exact workspace grant", () => {
  assert.throws(() => resolveAcpSessionContext({
    session: { additionalDirectories: ["C:\\outside"] },
    additionalDirectoryGrants: ["C:\\outside"],
  }), /preview feature flag/);
  assert.throws(() => resolveAcpSessionContext({
    session: { additionalDirectories: ["C:\\outside"] },
    additionalDirectoryGrants: ["C:\\other"],
    additionalDirectoriesEnabled: true,
  }), /not granted/);
  assert.deepEqual(resolveAcpSessionContext({
    session: { additionalDirectories: ["/srv/shared"] },
    additionalDirectoryGrants: ["/srv/shared/"],
    additionalDirectoriesEnabled: true,
    context: { kind: "wsl", distro: "Ubuntu" },
  }).additionalDirectories, ["/srv/shared"]);
});

test("an unused grant from another execution context cannot break an ordinary ACP session", () => {
  assert.deepEqual(resolveAcpSessionContext({
    additionalDirectoryGrants: ["C:\\native-only"],
    additionalDirectoriesEnabled: true,
    context: { kind: "wsl", distro: "Ubuntu" },
  }), {});
});

test("MCP materialization resolves secret references only from runner env", () => {
  const wire = materializeAcpMcpServers([
    { type: "stdio", name: "local", command: "C:\\tools\\mcp.exe", env: { TOKEN: { fromEnv: "MCP_TOKEN" } } },
    { type: "http", name: "remote", url: "https://mcp.example/rpc", headers: { Authorization: { fromEnv: "MCP_AUTH" } } },
  ], negotiation(), { MCP_TOKEN: "stdio-secret", MCP_AUTH: "header-secret" });
  assert.deepEqual(wire[0], { name: "local", command: "C:\\tools\\mcp.exe", args: [], env: [{ name: "TOKEN", value: "stdio-secret" }] });
  assert.deepEqual(wire[1], { type: "http", name: "remote", url: "https://mcp.example/rpc", headers: [{ name: "Authorization", value: "header-secret" }] });
  assert.throws(() => materializeAcpMcpServers([
    { type: "http", name: "remote", url: "https://mcp.example/rpc", headers: { Authorization: { fromEnv: "MISSING" } } },
  ], negotiation(), {}), /requires runner environment variable 'MISSING'/);
});

test("unsupported remote transports fail closed and draft MCP-over-ACP is rejected", () => {
  assert.throws(() => materializeAcpMcpServers([
    { type: "sse", name: "remote", url: "https://mcp.example/sse" },
  ], negotiation({ mcpSse: false })), /does not advertise SSE MCP support/);
  assert.throws(() => resolveAcpSessionContext({
    session: { mcpServers: [{ type: "acp", name: "draft", serverId: "x" } as never] },
  }), /unsupported (transport|fields)/);
  assert.throws(() => resolveAcpSessionContext({
    session: { mcpServers: [{ type: "http", name: "cleartext", url: "http:\/\/example.com" }] },
  }), /must use HTTPS/);
  assert.throws(() => resolveAcpSessionContext({
    session: { mcpServers: [{ type: "http", name: "hidden", url: "https:\/\/example.com", password: "must-not-persist" } as never] },
  }), /unsupported fields/);
});
