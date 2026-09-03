import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION, type SessionLaunchSpec } from "@wollipog/protocol";
import {
  agentControlMcpConfigPath,
  agentControlTokenPath,
  agentControlReadyPath,
  markAgentControlCredentialReady,
  markAgentControlCredentialRejected,
  provisionAgentControl,
  removeAgentControlFiles,
  type AgentControlHost,
} from "./agent-control.js";

function spec(driver: SessionLaunchSpec["driver"] = "codex"): SessionLaunchSpec {
  return {
    sessionId: "s_agent",
    workspaceId: "ws",
    workspacePath: "/repo",
    agentId: "codex",
    command: "codex",
    args: [],
    env: { PROVIDER_SETTING: "kept" },
    useWorktree: false,
    executionTarget: {
      id: "native",
      runnerId: "r1",
      kind: "local",
      workspaceStrategy: "in_place",
      adapter: "host",
      boundaries: { filesystem: "host", network: "inherit", credentials: "host", lifecycle: "runner" },
    },
    driver,
    context: { kind: "native" },
  };
}

test("native sessions receive a purpose-bound token file and CLI environment without plaintext persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = {
      isSea: true,
      execPath: "/opt/wollipog-runner",
      execArgv: [],
      configDir: root,
    };
    const launch = spec();
    const registrations: Array<[string, string]> = [];
    provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      registerCredential: (id, hash) => registrations.push([id, hash]),
    }, () => {}, host);

    const tokenFile = agentControlTokenPath(root, launch.sessionId);
    const token = readFileSync(tokenFile, "utf8");
    assert.match(token, /^wollipoga_[A-Za-z0-9_-]{43}$/u);
    if (process.platform !== "win32") assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(launch.env.PROVIDER_SETTING, "kept");
    assert.equal(launch.env.WOLLIPOG_SESSION_TOKEN_FILE, tokenFile);
    assert.equal(launch.env.WOLLIPOG_SESSION_CREDENTIAL_READY_FILE, agentControlReadyPath(root, launch.sessionId));
    assert.equal(launch.env.WOLLIPOG_SESSION_ID, launch.sessionId);
    assert.equal(launch.env.WOLLIPOG_CLI, "/opt/wollipog-runner");
    assert.equal(JSON.stringify(launch).includes(token), false, "plaintext token never enters launch metadata");
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]![0], launch.sessionId);
    assert.match(registrations[0]![1], /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential acknowledgement creates an exact-hash readiness fence and rejection revokes files", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = { isSea: true, execPath: "/runner", execArgv: [], configDir: root };
    const launch = spec();
    let hash = "";
    provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      registerCredential: (_id, value) => { hash = value; },
    }, () => {}, host);
    assert.throws(() => readFileSync(agentControlReadyPath(root, launch.sessionId)));
    assert.throws(() => markAgentControlCredentialReady(root, launch.sessionId, "f".repeat(64)), /does not match/);
    markAgentControlCredentialReady(root, launch.sessionId, hash);
    assert.equal(readFileSync(agentControlReadyPath(root, launch.sessionId), "utf8"), hash);
    assert.equal(hash, createHash("sha256").update(readFileSync(agentControlTokenPath(root, launch.sessionId))).digest("hex"));

    provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      registerCredential: () => {
        assert.throws(() => readFileSync(agentControlReadyPath(root, launch.sessionId)),
          "re-registration removes a stale positive acknowledgement before sending the binding");
      },
    }, () => {}, host);
    markAgentControlCredentialRejected(root, launch.sessionId);
    assert.throws(() => readFileSync(agentControlTokenPath(root, launch.sessionId)));
    assert.throws(() => readFileSync(agentControlReadyPath(root, launch.sessionId)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude receives the general MCP config without enabling or synthesizing a conductor", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = {
      isSea: true,
      execPath: "/opt/wollipog-runner",
      execArgv: [],
      configDir: root,
    };
    const launch = spec("claude-code");
    provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
    }, () => {}, host);
    const configPath = agentControlMcpConfigPath(root, launch.sessionId);
    assert.deepEqual(launch.args, ["--mcp-config", configPath]);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.mcpServers.wollipog.command, "/opt/wollipog-runner");
    assert.deepEqual(config.mcpServers.wollipog.args, ["--agent-control-mcp"]);
    assert.equal(JSON.stringify(config).includes(readFileSync(agentControlTokenPath(root, launch.sessionId), "utf8")), false);
    assert.equal(launch.agentId, "codex", "provisioning never changes or advertises the agent identity");

    provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
    }, () => {}, host);
    assert.deepEqual(launch.args, ["--mcp-config", configPath], "resume provisioning is idempotent");
    removeAgentControlFiles(launch.sessionId, root);
    assert.throws(() => readFileSync(configPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("older control planes and non-host targets receive no general control surface", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = { isSea: true, execPath: "/runner", execArgv: [], configDir: root };
    const old = spec();
    provisionAgentControl(old, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION - 1,
    }, () => {}, host);
    assert.deepEqual(old.env, { PROVIDER_SETTING: "kept" });

    const container = spec();
    container.executionTarget = { ...container.executionTarget!, adapter: "container", kind: "container" };
    provisionAgentControl(container, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
    }, () => {}, host);
    assert.deepEqual(container.env, { PROVIDER_SETTING: "kept" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
