import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type SessionLaunchSpec } from "@wollipog/protocol";
import {
  agentControlMcpConfigPath,
  agentControlTokenPath,
  agentControlReadyPath,
  markAgentControlCredentialReady,
  markAgentControlCredentialRejected,
  provisionAgentControl,
  removeAgentControlFiles,
  sweepAgentControlFiles,
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

test("retained Claude sessions shed runner-owned control state on downgrade and re-provision deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = { isSea: true, execPath: "/runner", execArgv: [], configDir: root };
    const retained = spec("claude-code");
    retained.args = ["--mcp-config", "/user/config.json", "--permission-mode", "plan"];
    const current = {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
    };
    provisionAgentControl(retained, current, () => {}, host);
    const runnerConfig = agentControlMcpConfigPath(root, retained.sessionId);
    assert.deepEqual(retained.args, [
      "--mcp-config", "/user/config.json", "--permission-mode", "plan", "--mcp-config", runnerConfig,
    ]);

    provisionAgentControl(retained, {
      ...current,
      controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl - 1,
    }, () => {}, host);
    assert.deepEqual(retained.args, ["--mcp-config", "/user/config.json", "--permission-mode", "plan"]);
    assert.deepEqual(retained.env, { PROVIDER_SETTING: "kept" });
    assert.equal(existsSync(agentControlTokenPath(root, retained.sessionId)), false);
    assert.equal(existsSync(agentControlReadyPath(root, retained.sessionId)), false);
    assert.equal(existsSync(runnerConfig), false);

    provisionAgentControl(retained, current, () => {}, host);
    assert.deepEqual(retained.args, [
      "--mcp-config", "/user/config.json", "--permission-mode", "plan", "--mcp-config", runnerConfig,
    ]);
    assert.equal(existsSync(agentControlTokenPath(root, retained.sessionId)), true);
    assert.equal(existsSync(runnerConfig), true);

    const freshOld = spec("claude-code");
    freshOld.args = ["--mcp-config", "/user/fresh.json"];
    provisionAgentControl(freshOld, {
      ...current,
      controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl - 1,
    }, () => {}, host);
    assert.deepEqual(freshOld.args, ["--mcp-config", "/user/fresh.json"]);
    assert.deepEqual(freshOld.env, { PROVIDER_SETTING: "kept" });

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

test("agent-control paths reject traversal and Windows-reserved session ids", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = { isSea: true, execPath: "/runner", execArgv: [], configDir: root };
    for (const sessionId of ["../escape", "CON", "nested/path", "trailing."]) {
      assert.throws(() => provisionAgentControl({ ...spec(), sessionId }, {
        controlPlaneUrl: "ws://127.0.0.1:4317/runner",
        controlPlaneProtocolVersion: PROTOCOL_VERSION,
      }, () => {}, host), /unsupported path characters/);
      assert.throws(() => removeAgentControlFiles(sessionId, root), /unsupported path characters/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup sweep removes final and interrupted staging files while retaining unsafe or unrelated entries", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-agent-control-"));
  try {
    const host: AgentControlHost = { isSea: true, execPath: "/runner", execArgv: [], configDir: root };
    const launch = spec("claude-code");
    let hash = "";
    provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      registerCredential: (_id, value) => { hash = value; },
    }, () => {}, host);
    markAgentControlCredentialReady(root, launch.sessionId, hash);

    const interruptedLaunch = { ...spec(), sessionId: "s_interrupted" };
    const blockedDestination = agentControlTokenPath(root, interruptedLaunch.sessionId);
    mkdirSync(blockedDestination);
    assert.throws(() => provisionAgentControl(interruptedLaunch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
    }, () => {}, host), "a failed atomic rename leaves the producer's staging file behind");
    rmSync(blockedDestination, { recursive: true });
    const interruptedNames = readdirSync(root).filter((name) => name.startsWith(".pending-"));
    assert.equal(interruptedNames.length, 1);
    const interrupted = join(root, interruptedNames[0]!);
    const malformed = [
      ".pending-0-123e4567-e89b-42d3-a456-426614174000",
      ".pending-123-not-a-uuid",
      ".pending-123-123e4567-e89b-12d3-a456-426614174000",
      ".pending-123-123e4567-e89b-42d3-c456-426614174000",
      ".pending-123-123E4567-E89B-42D3-A456-426614174000",
    ];
    for (const name of malformed) writeFileSync(join(root, name), "retain");
    const unrelated = join(root, "operator-notes.txt");
    writeFileSync(unrelated, "retain");
    const stagedDirectory = join(root, ".pending-456-123e4567-e89b-42d3-a456-426614174000");
    mkdirSync(stagedDirectory);
    const symlinkTarget = join(root, "symlink-target.txt");
    const stagedSymlink = join(root, ".pending-789-123e4567-e89b-42d3-a456-426614174000");
    writeFileSync(symlinkTarget, "retain");
    if (process.platform !== "win32") symlinkSync(symlinkTarget, stagedSymlink);

    assert.equal(sweepAgentControlFiles(root), 4);
    assert.throws(() => readFileSync(agentControlTokenPath(root, launch.sessionId)));
    assert.throws(() => readFileSync(agentControlReadyPath(root, launch.sessionId)));
    assert.throws(() => readFileSync(agentControlMcpConfigPath(root, launch.sessionId)));
    assert.equal(existsSync(interrupted), false);
    for (const name of malformed) assert.equal(readFileSync(join(root, name), "utf8"), "retain");
    assert.equal(readFileSync(unrelated, "utf8"), "retain");
    assert.equal(lstatSync(stagedDirectory).isDirectory(), true);
    if (process.platform !== "win32") assert.equal(lstatSync(stagedSymlink).isSymbolicLink(), true);
    assert.equal(readFileSync(symlinkTarget, "utf8"), "retain");
    assert.equal(sweepAgentControlFiles(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
