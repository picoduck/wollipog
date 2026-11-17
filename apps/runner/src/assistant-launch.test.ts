import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type SessionLaunchSpec } from "@wollipog/protocol";
import { provisionAgentControl, type AgentControlHost } from "./agent-control.js";
import {
  ASSISTANT_INSTRUCTIONS,
  assistantLaunchArgs,
  assistantMcpConfigPath,
  stripAssistantLaunchArgs,
} from "./assistant-launch.js";
import { ASSISTANT_RELAY_ENDPOINT_ENV, ASSISTANT_RELAY_KEY_ENV, AssistantProxies } from "./assistant-proxy.js";

function assistantSpec(driver: SessionLaunchSpec["driver"], args: string[] = []): SessionLaunchSpec {
  return {
    sessionId: "s_assistant", workspaceId: "ws", workspacePath: "/home/owner", agentId: "agent",
    command: driver === "claude-code" ? "claude" : "codex", args, env: { PROVIDER_SETTING: "kept" }, useWorktree: false,
    driver, context: { kind: "native" },
    assistant: { threadId: "thr_fixture" },
  };
}

async function withHost(run: (host: AgentControlHost, root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wollipog-assistant-launch-"));
  try { await run({ isSea: true, execPath: "/opt/wollipog-runner", execArgv: [], configDir: root }, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const relay = { endpoint: "tcp://127.0.0.1:41234", relayKey: "k".repeat(43) };
function fakeProxy() {
  const provisioned: string[] = [];
  return { provisioned, provision: async (sessionId: string) => { provisioned.push(sessionId); return relay; } };
}
const config = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION };
const adapterEnv = { [ASSISTANT_RELAY_ENDPOINT_ENV]: relay.endpoint, [ASSISTANT_RELAY_KEY_ENV]: relay.relayKey };

test("a Claude Code assistant launch names only the proxy server, pre-authorized, and no agent-control surface", async () => {
  await withHost(async (host, root) => {
    const proxy = fakeProxy(), registered: string[] = [];
    const launch = assistantSpec("claude-code", ["--user-flag"]);
    await provisionAgentControl(launch, { ...config, assistantProxy: proxy, registerCredential: (id) => registered.push(id) }, () => {}, host);
    const configFile = assistantMcpConfigPath(root, launch.sessionId);
    assert.deepEqual(launch.args, ["--user-flag", "--mcp-config", configFile, "--allowedTools", "mcp__wollipog_assistant",
      "--append-system-prompt", ASSISTANT_INSTRUCTIONS]);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { mcpServers: { wollipog_assistant: {
      type: "stdio", command: "/opt/wollipog-runner", args: ["--assistant-mcp"], env: adapterEnv } } });
    assert.deepEqual(launch.env, { PROVIDER_SETTING: "kept" }, "no Wollipog endpoint, token path or relay key reaches the agent's own environment");
    assert.deepEqual(registered, [], "no agent-control credential is minted or registered");
    assert.deepEqual(readdirSync(root), ["s_assistant.assistant-mcp.json"], "no token, ready, general MCP config or CLI file");
    // A relaunch from the persisted arguments replaces the injected arguments rather than adding more.
    await provisionAgentControl(launch, { ...config, assistantProxy: proxy }, () => {}, host);
    assert.equal(launch.args.filter((arg) => arg === "--mcp-config").length, 1);
    assert.equal(launch.args.filter((arg) => arg === ASSISTANT_INSTRUCTIONS).length, 1);
    assert.deepEqual(proxy.provisioned, ["s_assistant", "s_assistant"], "every launch provisions a fresh credential");
  });
});

for (const driver of ["codex", "codex-app-server"] as const) {
  test(`a ${driver} assistant launch names the proxy server inline and replaces it on relaunch`, async () => {
    await withHost(async (host, root) => {
      const launch = assistantSpec(driver, ["--user-flag"]);
      await provisionAgentControl(launch, { ...config, assistantProxy: fakeProxy() }, () => {}, host);
      const server = `mcp_servers.wollipog_assistant={ "command" = "/opt/wollipog-runner", "args" = ["--assistant-mcp"], ` +
        `"env_vars" = ["${ASSISTANT_RELAY_ENDPOINT_ENV}", "${ASSISTANT_RELAY_KEY_ENV}"], ` +
        `"enabled" = true, "default_tools_approval_mode" = "approve" }`;
      const expected = ["--user-flag", "-c", server, "-c", `developer_instructions=${JSON.stringify(ASSISTANT_INSTRUCTIONS)}`];
      assert.deepEqual(launch.args, expected);
      assert.ok(!launch.args.join(" ").includes(relay.relayKey), "the relay key is never a process argument");
      assert.deepEqual(launch.env, { PROVIDER_SETTING: "kept", ...adapterEnv }, "the adapter reads the relay by name");
      assert.deepEqual(readdirSync(root), []);
      await provisionAgentControl(launch, { ...config, assistantProxy: fakeProxy() }, () => {}, host);
      assert.deepEqual(launch.args, expected);
    });
  });
}

test("an assistant launch refuses another harness, a second role, WSL and an older control plane", async () => {
  await withHost((host) => {
    const proxied = { ...config, assistantProxy: fakeProxy() };
    for (const driver of ["pi", "acp"] as const) {
      assert.throws(() => provisionAgentControl(assistantSpec(driver), proxied, () => {}, host), /only on Claude Code or Codex/);
    }
    const orchestrator = { ...assistantSpec("claude-code"), orchestrator: { strictProjectIsolation: false } } as SessionLaunchSpec;
    assert.throws(() => provisionAgentControl(orchestrator, proxied, () => {}, host), /no other role/);
    const wsl: SessionLaunchSpec = { ...assistantSpec("claude-code"), context: { kind: "wsl", distro: "Ubuntu" } };
    assert.throws(() => provisionAgentControl(wsl, proxied, () => {}, host), /native Claude Code or Codex/);
    assert.throws(() => provisionAgentControl(assistantSpec("claude-code"),
      { ...proxied, controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole - 1 }, () => {}, host), /newer Wollipog control plane/);
    assert.throws(() => provisionAgentControl(assistantSpec("claude-code"), config, () => {}, host), /cannot proxy/);
  });
});

test("the shared skill follows the role instructions and is replaced, not repeated, on relaunch", async () => {
  await withHost(async (host) => {
    const launch: SessionLaunchSpec = { ...assistantSpec("claude-code"), assistant: { threadId: "thr_fixture", guide: "## Discover First\n\nCall assistant_discover." } };
    await provisionAgentControl(launch, { ...config, assistantProxy: fakeProxy() }, () => {}, host);
    await provisionAgentControl(launch, { ...config, assistantProxy: fakeProxy() }, () => {}, host);
    const prompts = launch.args.filter((_arg, index) => launch.args[index - 1] === "--append-system-prompt");
    assert.deepEqual(prompts, [`${ASSISTANT_INSTRUCTIONS}\n\n## Discover First\n\nCall assistant_discover.`]);
  });
});

test("Claude Code's proxy entry goes to the masked hook state directory and leaves with the proxy", async () => {
  await withHost(async (host, root) => {
    const hookState = mkdtempSync(join(tmpdir(), "wollipog-assistant-hook-state-"));
    try {
      const proxies = new AssistantProxies({ configDir: hookState, register: () => {} });
      const launch = assistantSpec("claude-code");
      await provisionAgentControl(launch, { ...config, assistantProxy: proxies, assistantConfigDir: hookState }, () => {}, host);
      const configFile = assistantMcpConfigPath(hookState, launch.sessionId);
      assert.ok(launch.args.includes(configFile));
      assert.deepEqual(readdirSync(root), [], "nothing lands in the agent-control directory other sessions can read");
      assert.deepEqual(readdirSync(hookState), ["s_assistant.assistant-mcp.json"]);
      await proxies.revoke(launch.sessionId);
      assert.deepEqual(readdirSync(hookState), [], "the dead relay key's file is removed");
    } finally { rmSync(hookState, { recursive: true, force: true }); }
  });
});

test("stripping keeps a user's own instructions and servers", () => {
  const own = ["--append-system-prompt", "Prefer short answers", "-c", 'developer_instructions="Mine"',
    "--mcp-config", "/home/owner/.mcp.json", "--allowedTools", "Bash", "-c", "mcp_servers.mine={}"];
  const mcp = { command: "/opt/wollipog-runner", args: ["--assistant-mcp"], env: adapterEnv, configFile: "/cfg/s.assistant-mcp.json" };
  assert.deepEqual(stripAssistantLaunchArgs([...own, ...assistantLaunchArgs("claude-code", [], mcp), ...assistantLaunchArgs("codex", [], mcp)]), own);
});
