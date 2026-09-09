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
import { providerStateKey, resolveExecutionIsolation } from "./execution-isolation.js";
import { codexOrchestratorMcpArgs } from "./orchestrator-preset.js";
import { killTree, spawnAgent, waitForPendingKills, type AgentProcess, type WslBwrapSpawnIsolation } from "./spawn.js";
import { WSL_AGENT_CONTROL_HELPER_PATH } from "./wsl-agent-control.js";
import {
  WSL_BWRAP_LAUNCHER_PATH,
  buildWslBwrapLaunchArgs,
  buildWslBwrapPrepareArgs,
  cleanupWslBwrapSessionState,
  parseWslBwrapPreparation,
  provisionWslBwrapSessionState,
} from "./wsl-bwrap-launcher.js";

const distro = process.env.WOLLIPOG_TEST_WSL_DISTRO;
const nodeRuntime = process.env.WOLLIPOG_TEST_WSL_NODE;
const enabled = process.platform === "win32" && !!distro && !!nodeRuntime;

function wslExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("wsl.exe", ["-d", distro!, "--exec", ...args],
    { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => error
      ? reject(new Error(`${args[0]} failed: ${String(stderr || stdout)}`))
      : resolve(String(stdout))));
}

function wslOuter(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("wsl.exe", args,
    { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => error
      ? reject(new Error(`wsl.exe failed: ${String(stderr || stdout)}`))
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

async function waitBridgeClose(child: AgentProcess): Promise<void> {
  const relay = child.wslAgentControl?.relay;
  await waitClose(child);
  if (relay && relay.exitCode === null) {
    await new Promise<void>((resolve) => relay.once("close", () => resolve()));
  }
}

test("real WSL2 bridge carries CLI and MCP while adversarial routes fail closed and clean up", { skip: !enabled }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-real-"));
  const targetFixture = `/home/wollipog/wollipog-launcher-test-${process.pid}`;
  const workspace = `${targetFixture}/workspace`;
  const ownerHash = "a".repeat(64);
  const sessionKeys = [providerStateKey("wsl-real-session"), "b".repeat(64)];
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
    driver: "codex-app-server", context, wslAgentControl: { protocolVersion: 1, nodeRuntime: nodeRuntime!,
      safeLauncherProtocolVersion: 1, bwrapRuntime: "/usr/bin/bwrap" } };
  const makeSpec = (): SessionLaunchSpec => ({ sessionId: "wsl-real-session", workspaceId: null,
    workspacePath: workspace, agentId: agent.id, command: agent.command, args: [], env: {}, useWorktree: false,
    driver: agent.driver, context, config: { permissionMode: "orchestrator" } });
  const provision = async (spec: SessionLaunchSpec) => provisionAgentControl(spec, {
    controlPlaneUrl: `ws://127.0.0.1:${port}/runner`, controlPlaneProtocolVersion: PROTOCOL_VERSION,
    orchestratorAgent: agent, executionIsolationMode: "bwrap",
    registerCredentialAndWait: async (sessionId, hash) => markAgentControlCredentialReady(host.configDir, sessionId, hash),
  }, () => {}, host);
  const isolate = async (spec: SessionLaunchSpec) => await resolveExecutionIsolation(
    { mode: "bwrap", network: "deny" }, context, {}, {
      driver: spec.driver!, dataDir: root, env: spec.env, sessionId: spec.sessionId,
      cwd: workspace, ownerHash,
    },
  ) as WslBwrapSpawnIsolation;
  const launch = (spec: SessionLaunchSpec, isolation: WslBwrapSpawnIsolation, mode: "cli" | "mcp", args: string[] = []) =>
    spawnAgent({ command: nodeRuntime!, args: [WSL_AGENT_CONTROL_HELPER_PATH, mode, ...args], cwd: workspace,
      env: spec.env, context, isolation, windowsShell: false });
  const stop = async (child: AgentProcess) => {
    killTree(child);
    await waitForPendingKills(8_000);
    await waitBridgeClose(child);
  };

  try {
    await wslExec(["sh", "-c", "set -eu; rm -rf -- \"$1\"; mkdir -p -- \"$1/workspace\"", "sh", targetFixture]);
    const first = makeSpec();
    await provision(first);
    const firstIsolation = await isolate(first);
    assert.deepEqual(await codexOrchestratorMcpArgs({
      command: nodeRuntime!,
      args: ["-e", 'console.log(JSON.stringify([{name:"wollipog",enabled:true}]))'],
      env: first.env,
      context,
      isolation: firstIsolation,
    }, firstIsolation.cwd), [], "Codex MCP inventory executes through the prepared target-local launcher");

    await wslExec(["sh", "-c", "set -eu; mkdir -p -- \"$1/home\" \"$1/cwd\" \"$1/source\" \"$1/protected\"; ln -s -- \"$1/protected\" \"$1/alias\"", "sh", targetFixture]);
    await assert.rejects(() => wslExec([
      WSL_BWRAP_LAUNCHER_PATH,
      ...buildWslBwrapPrepareArgs({
        bwrap: "/usr/bin/bwrap", home: `${targetFixture}/home`, cwd: `${targetFixture}/alias`,
        ensure: [`${targetFixture}/alias/escaped`],
      }),
    ]), /cannot securely create directory|cannot securely resolve cwd/u,
    "a symlinked ancestor cannot redirect target-local directory creation");
    await wslExec(["test", "!", "-e", `${targetFixture}/protected/escaped`]);

    const cwdPreparation = parseWslBwrapPreparation(await wslExec([
      WSL_BWRAP_LAUNCHER_PATH,
      ...buildWslBwrapPrepareArgs({
        bwrap: "/usr/bin/bwrap", home: `${targetFixture}/home`, cwd: `${targetFixture}/cwd`,
      }),
    ]));
    await wslExec(["sh", "-c", "mv -- \"$1/cwd\" \"$1/cwd-original\"; mkdir -- \"$1/cwd\"", "sh", targetFixture]);
    await assert.rejects(() => wslOuter(buildWslBwrapLaunchArgs({
      distro: distro!, bwrap: "/usr/bin/bwrap", preparation: cwdPreparation, network: "deny",
      pidfile: `/tmp/wollipog-adversarial-cwd-${process.pid}.pgid`, command: "/bin/true", args: [],
    })), /cwd identity changed|outer WSL cwd identity changed/u,
    "a concurrent cwd replacement is rejected before bwrap exec");

    await wslExec(["mkdir", "--", `${targetFixture}/cwd-good`]);
    const writablePreparation = parseWslBwrapPreparation(await wslExec([
      WSL_BWRAP_LAUNCHER_PATH,
      ...buildWslBwrapPrepareArgs({
        bwrap: "/usr/bin/bwrap", home: `${targetFixture}/home`, cwd: `${targetFixture}/cwd-good`,
        binds: [{ mode: "rw", source: `${targetFixture}/source`, target: `${targetFixture}/source` }],
      }),
    ]));
    await wslOuter(buildWslBwrapLaunchArgs({
      distro: distro!, bwrap: "/usr/bin/bwrap", preparation: writablePreparation, network: "deny",
      pidfile: `/tmp/wollipog-adversarial-bind-${process.pid}.pgid`, command: "/bin/sh",
      args: ["-c", 'if printf escaped > "$2/outside" 2>/dev/null; then exit 99; fi; printf pinned > "$1/created"',
        "sh", `${targetFixture}/source`, targetFixture],
    }));
    assert.equal((await wslExec(["cat", `${targetFixture}/source/created`])).trim(), "pinned",
      "a successful launch writes only through the pinned additional writable root");

    const replacementPreparation = parseWslBwrapPreparation(await wslExec([
      WSL_BWRAP_LAUNCHER_PATH,
      ...buildWslBwrapPrepareArgs({
        bwrap: "/usr/bin/bwrap", home: `${targetFixture}/home`, cwd: `${targetFixture}/cwd-good`,
        binds: [{ mode: "rw", source: `${targetFixture}/source`, target: `${targetFixture}/source` }],
      }),
    ]));
    await wslExec(["sh", "-c", "mv -- \"$1/source\" \"$1/source-original\"; mkdir -- \"$1/source\"", "sh", targetFixture]);
    await assert.rejects(() => wslOuter(buildWslBwrapLaunchArgs({
      distro: distro!, bwrap: "/usr/bin/bwrap", preparation: replacementPreparation, network: "deny",
      pidfile: `/tmp/wollipog-adversarial-source-${process.pid}.pgid`, command: "/bin/true", args: [],
    })), /bind source identity changed/u,
    "a concurrent additional-root replacement is rejected before bwrap exec");

    const cli = launch(first, firstIsolation, "cli", ["session", "list", "--json"]);
    const cliOutput = await readUntil(cli, /"sessions":\[\]/u);
    assert.match(cliOutput, /"sessions":\[\]/u);
    await waitBridgeClose(cli);

    const mcp = launch(first, firstIsolation, "mcp");
    try {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      const mcpOutput = await readUntil(mcp, /create_session/u);
      assert.doesNotMatch(mcpOutput, /set_guardrails/u);
    } finally {
      await stop(mcp);
    }

    const arbitrary = launch(first, firstIsolation, "cli", ["admin", "status"]);
    assert.match(await readUntil(arbitrary, /outside the Agent Control allowlist/u), /outside the Agent Control allowlist/u);
    await waitBridgeClose(arbitrary);

    const cross = { ...first, env: { ...first.env, WOLLIPOG_SESSION_ID: "another-session" } };
    const crossSession = launch(cross, firstIsolation, "mcp");
    assert.match(await readUntil(crossSession, /authentication failed/u), /authentication failed/u);
    await waitBridgeClose(crossSession);

    const restarted = makeSpec();
    await provision(restarted);
    const stale = launch(first, firstIsolation, "mcp");
    assert.match(await readUntil(stale, /authentication failed/u), /authentication failed/u,
      "credential from the pre-restart launch is revoked");
    await waitBridgeClose(stale);

    const currentIsolation = await isolate(restarted);
    const current = launch(restarted, currentIsolation, "cli", ["session", "list", "--json"]);
    assert.match(await readUntil(current, /"sessions":\[\]/u), /"sessions":\[\]/u);
    await waitBridgeClose(current);
    assert.ok(requests.length >= 4);
    assert.ok(requests.every((request) => request.authorization?.startsWith("Bearer wollipoga_") &&
      request.actor === first.sessionId));

    const firstState = await provisionWslBwrapSessionState(distro!, ownerHash, sessionKeys[0]!, Number(
      (await wslExec(["id", "-u"])).trim(),
    ));
    const siblingState = await provisionWslBwrapSessionState(distro!, ownerHash, sessionKeys[1]!, Number(
      (await wslExec(["id", "-u"])).trim(),
    ));
    await wslExec(["test", "!", "-e", `${firstState.relay}/control.sock`]);
    await wslExec(["sh", "-c", 'printf keep > "$1/keep"', "sh", siblingState.provider]);
    await cleanupWslBwrapSessionState(distro!, ownerHash, sessionKeys[0]!);
    await wslExec(["test", "!", "-e", firstState.root]);
    assert.equal((await wslExec(["cat", `${siblingState.provider}/keep`])).trim(), "keep",
      "exact-session cleanup preserves an unrelated sibling state root");
  } finally {
    removeAgentControlFiles("wsl-real-session", host.configDir);
    for (const sessionKey of sessionKeys) {
      await cleanupWslBwrapSessionState(distro!, ownerHash, sessionKey).catch(() => {});
    }
    await wslExec(["rm", "-rf", "--", targetFixture]).catch(() => {});
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
