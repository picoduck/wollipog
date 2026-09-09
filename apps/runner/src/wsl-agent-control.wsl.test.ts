import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, SessionLaunchSpec } from "@wollipog/protocol";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import {
  defaultAgentControlHost,
  markAgentControlCredentialReady,
  provisionAgentControl,
  removeAgentControlFiles,
} from "./agent-control.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { codexOrchestratorMcpArgs } from "./orchestrator-preset.js";
import { killTree, spawnAgent, waitForPendingKills, type AgentProcess, type BwrapSpawnIsolation } from "./spawn.js";
import { WSL_AGENT_CONTROL_HELPER_PATH } from "./wsl-agent-control.js";

const distro = process.env.WOLLIPOG_TEST_WSL_DISTRO;
const nodeRuntime = process.env.WOLLIPOG_TEST_WSL_NODE;
const enabled = process.platform === "win32" && !!distro && !!nodeRuntime;

function wslExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("wsl.exe", ["-d", distro!, "--exec", ...args],
    { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => error
      ? reject(new Error(`${args[0]} failed: ${String(stderr || stdout)}`))
      : resolve(String(stdout))));
}

function readUntil(child: AgentProcess, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}: ${output}`)), timeoutMs);
    const inspect = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      resolve(output);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", reject);
    child.once("close", () => {
      if (!pattern.test(output)) {
        clearTimeout(timer);
        reject(new Error(`provider exited before ${pattern}: ${output}`));
      }
    });
  });
}

function waitClose(child: AgentProcess): Promise<void> {
  return child.closeObserved || child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("close", () => resolve()));
}

test("real WSL2 bridge carries CLI and MCP while adversarial routes fail closed and clean up", { skip: !enabled }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-real-"));
  const host = defaultAgentControlHost(root);
  const requests: Array<{ url: string; authorization?: string; actor?: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization,
      actor: req.headers["x-wollipog-agent-session"] as string | undefined });
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/api/compatibility"
      ? JSON.stringify({ protocolVersion: PROTOCOL_VERSION })
      : JSON.stringify({ sessions: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const context = { kind: "wsl" as const, distro: distro! };
  const agent: AgentDefinition = { id: "codex-wsl", name: "Codex WSL", command: "/bin/true", args: [], env: {},
    driver: "codex-app-server", context, wslAgentControl: { protocolVersion: 1, nodeRuntime: nodeRuntime! } };
  const makeSpec = (): SessionLaunchSpec => ({ sessionId: "wsl-real-session", workspaceId: null,
    workspacePath: "/home/wollipog", agentId: agent.id, command: agent.command, args: [], env: {}, useWorktree: false,
    driver: agent.driver, context, config: { permissionMode: "orchestrator" } });
  const provision = async (spec: SessionLaunchSpec) => provisionAgentControl(spec, {
    controlPlaneUrl: `ws://127.0.0.1:${port}/runner`, controlPlaneProtocolVersion: PROTOCOL_VERSION,
    orchestratorAgent: agent,
    registerCredentialAndWait: async (sessionId, hash) => markAgentControlCredentialReady(host.configDir, sessionId, hash),
  }, () => {}, host);
  const isolate = async (spec: SessionLaunchSpec) => await resolveExecutionIsolation(
    { mode: "bwrap", network: "deny" }, context, {}, {
      driver: spec.driver!, dataDir: root, env: spec.env, sessionId: spec.sessionId,
      cwd: "/home/wollipog", ownerHash: "a".repeat(64),
    },
  ) as BwrapSpawnIsolation;
  const launch = (spec: SessionLaunchSpec, isolation: BwrapSpawnIsolation, mode: "cli" | "mcp", args: string[] = []) =>
    spawnAgent({ command: nodeRuntime!, args: [WSL_AGENT_CONTROL_HELPER_PATH, mode, ...args], cwd: "/home/wollipog",
      env: spec.env, context, isolation, windowsShell: false });
  const stop = async (child: AgentProcess) => { killTree(child); await waitForPendingKills(8_000); };

  try {
    assert.deepEqual(await codexOrchestratorMcpArgs({
      command: nodeRuntime!,
      args: ["-e", 'console.log(JSON.stringify([{name:"wollipog",enabled:true}]))'],
      context,
    }, "/home/wollipog"), [], "Codex MCP isolation probe executes the Linux target through WSL");

    const first = makeSpec();
    await provision(first);
    const firstIsolation = await isolate(first);

    const cli = launch(first, firstIsolation, "cli", ["session", "list", "--json"]);
    const cliOutput = await readUntil(cli, /"sessions":\[\]/u);
    assert.match(cliOutput, /"sessions":\[\]/u);
    await waitClose(cli);

    const mcp = launch(first, firstIsolation, "mcp");
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const mcpOutput = await readUntil(mcp, /create_session/u);
    assert.doesNotMatch(mcpOutput, /set_guardrails/u);
    await stop(mcp);

    const arbitrary = launch(first, firstIsolation, "cli", ["admin", "status"]);
    assert.match(await readUntil(arbitrary, /outside the Agent Control allowlist/u), /outside the Agent Control allowlist/u);
    await waitClose(arbitrary);

    const cross = { ...first, env: { ...first.env, WOLLIPOG_SESSION_ID: "another-session" } };
    const crossSession = launch(cross, firstIsolation, "mcp");
    assert.match(await readUntil(crossSession, /authentication failed/u), /authentication failed/u);
    await waitClose(crossSession);

    const restarted = makeSpec();
    await provision(restarted);
    const stale = launch(first, firstIsolation, "mcp");
    assert.match(await readUntil(stale, /authentication failed/u), /authentication failed/u,
      "credential from the pre-restart launch is revoked");
    await waitClose(stale);

    const currentIsolation = await isolate(restarted);
    const current = launch(restarted, currentIsolation, "cli", ["session", "list", "--json"]);
    assert.match(await readUntil(current, /"sessions":\[\]/u), /"sessions":\[\]/u);
    await waitClose(current);
    assert.ok(requests.length >= 4);
    assert.ok(requests.every((request) => request.authorization?.startsWith("Bearer wollipoga_") &&
      request.actor === first.sessionId));

    assert.equal((await wslExec(["sh", "-c", "find /tmp -maxdepth 1 -type d -name 'wlp-*' -print -quit"])).trim(), "",
      "provider/relay exit removes every per-launch socket directory");
  } finally {
    removeAgentControlFiles("wsl-real-session", host.configDir);
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
