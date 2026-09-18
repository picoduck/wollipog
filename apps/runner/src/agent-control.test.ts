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
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type AgentDefinition, type SessionLaunchSpec } from "@wollipog/protocol";
import {
  agentControlMcpConfigPath,
  agentControlTokenPath,
  agentControlReadyPath,
  markAgentControlCredentialReady,
  markAgentControlCredentialRejected,
  piAgentControlExtensionPath,
  provisionAgentControl,
  removeAgentControlFiles,
  sweepAgentControlFiles,
  wslAgentControlLaunch,
  type AgentControlHost,
} from "./agent-control.js";
import { CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION } from "./orchestrator-preset.js";
import { PI_ORCHESTRATOR_PRESET_TOOLS_ENV, PI_SECURITY_REQUEST_NONCE_ENV } from "./pi-agent-control-extension.js";

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

test("orchestrator provisioning restricts native tools and refuses unsupported launch boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-orchestrator-control-"));
  try {
    const host: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux",
    };
    const control = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "bwrap" as const,
      orchestratorProjectPaths: ["/other-project", "C:\\other-project"] };
    for (const driver of ["codex", "claude-code"] as const) {
      const launch = spec(driver);
      launch.config = { permissionMode: "orchestrator" };
      provisionAgentControl(launch, control, () => {}, host);
      const args = [...launch.args];
      assert.equal(launch.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
      provisionAgentControl(launch, control, () => {}, host);
      assert.deepEqual(launch.args, args, "resume is idempotent");
      assert.ok(launch.args.includes(driver === "codex" ? "--strict-config" : "--strict-mcp-config"));
      if (driver === "claude-code") {
        assert.deepEqual(launch.args.flatMap((arg, index) => arg === "--add-dir" ? [launch.args[index + 1]] : []),
          ["/other-project", "/repo"]);
      }
    }
    const acp = spec("acp");
    acp.command = "npx";
    acp.args = ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`];
    acp.config = { permissionMode: "orchestrator" };
    acp.acpSessionContext = {
      additionalDirectories: ["/ambient"],
      mcpServers: [{ type: "stdio", name: "ambient", command: "ambient", args: [] }],
    };
    const acpAgent: AgentDefinition = {
      id: acp.agentId,
      name: "Claude Agent",
      command: acp.command,
      args: [...acp.args],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
    };
    provisionAgentControl(acp, { ...control, orchestratorAgent: acpAgent }, () => {}, host);
    assert.deepEqual(acp.args, acpAgent.args);
    assert.deepEqual(acp.acpSessionContext?.additionalDirectories, ["/other-project", "/repo"]);
    assert.deepEqual(acp.acpSessionContext?.mcpServers?.map((server) => server.name), ["wollipog"]);
    const acpMcp = acp.acpSessionContext?.mcpServers?.[0];
    assert.equal(acpMcp?.type, "stdio");
    if (acpMcp?.type === "stdio") {
      assert.equal(acpMcp.command, "/opt/runner");
      assert.deepEqual(acpMcp.args, ["--agent-control-mcp"]);
      assert.deepEqual(acpMcp.env?.WOLLIPOG_SESSION_TOKEN_FILE, { fromEnv: "WOLLIPOG_SESSION_TOKEN_FILE" });
    }

    const windows = spec("claude-code");
    windows.sessionId = "s_windows_refused";
    windows.workspacePath = "C:\\repo";
    windows.config = { permissionMode: "orchestrator" };
    assert.throws(() => provisionAgentControl(windows, control, () => {}, { ...host, platform: "win32" }),
      /attested native filesystem boundary/);
    assert.equal(existsSync(agentControlTokenPath(root, windows.sessionId)), false);

    const generic = spec("acp");
    generic.sessionId = "s_generic_acp";
    generic.config = { permissionMode: "orchestrator" };
    assert.throws(() => provisionAgentControl(generic, {
      ...control,
      registerCredential: () => assert.fail("unsupported ACP must fail before credential minting"),
    }, () => {}, host), /exact audited/);
    assert.equal(existsSync(agentControlTokenPath(root, generic.sessionId)), false);

    const old = spec("codex");
    old.config = { permissionMode: "orchestrator" };
    assert.throws(() => provisionAgentControl(old, { ...control,
      controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionOrchestration - 1,
    }, () => {}, host), /supported native/);

    const wsl = spec("acp");
    wsl.sessionId = "s_wsl";
    wsl.config = { permissionMode: "orchestrator" };
    wsl.context = { kind: "wsl", distro: "Ubuntu" };
    const container = spec("acp");
    container.sessionId = "s_container";
    container.config = { permissionMode: "orchestrator" };
    container.executionTarget = { ...container.executionTarget!, adapter: "container", kind: "container" };
    const cloud = spec("acp");
    cloud.sessionId = "s_cloud";
    cloud.config = { permissionMode: "orchestrator" };
    cloud.executionTarget = { ...cloud.executionTarget!, adapter: "cloud", kind: "cloud" };
    for (const launch of [wsl, container, cloud]) {
      assert.throws(() => provisionAgentControl(launch, control, () => {}, host), /supported native/);
      assert.equal(existsSync(agentControlTokenPath(root, launch.sessionId)), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovery-verified Pi receives a private Agent Control extension and strict Orchestrator flags", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pi-agent-control-"));
  try {
    const host: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux",
    };
    const control = {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "bwrap" as const,
    };
    const ordinary = spec("pi");
    ordinary.agentId = "pi";
    ordinary.command = "pi";
    const piAgent: AgentDefinition = {
      id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi",
      context: { kind: "native" }, piAgentControl: { protocolVersion: 1 },
    };
    provisionAgentControl(ordinary, { ...control, orchestratorAgent: piAgent }, () => {}, host);
    const extension = piAgentControlExtensionPath(root, ordinary.sessionId);
    if (process.platform !== "win32") assert.equal(statSync(extension).mode & 0o777, 0o600);
    assert.match(readFileSync(extension, "utf8"), /registerTool/);
    assert.equal(ordinary.args[ordinary.args.indexOf("--extension") + 1], extension);
    assert.equal(ordinary.env.WOLLIPOG_PI_AGENT_CONTROL_COMMAND, "/opt/runner");
    assert.deepEqual(JSON.parse(ordinary.env.WOLLIPOG_PI_AGENT_CONTROL_ARGS!), ["--agent-control-mcp"]);
    assert.match(ordinary.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE ?? "", /^[A-Za-z0-9_-]{32}$/u);
    assert.match(ordinary.env[PI_SECURITY_REQUEST_NONCE_ENV] ?? "", /^[A-Za-z0-9_-]{32}$/u);
    provisionAgentControl(ordinary, { ...control,
      orchestratorAgent: { ...piAgent, piAgentControl: undefined },
    }, () => {}, host);
    assert.equal(ordinary.env.WOLLIPOG_CLI, "/opt/runner");
    assert.equal(ordinary.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE, undefined);
    assert.equal(ordinary.env[PI_SECURITY_REQUEST_NONCE_ENV], undefined);
    assert.equal(ordinary.args.includes("--extension"), false);
    assert.equal(existsSync(extension), false, "lost attestation removes the stale runner-owned extension");

    const ordinaryUnverified = spec("pi");
    ordinaryUnverified.sessionId = "s_unverified_ordinary_pi";
    ordinaryUnverified.agentId = "pi";
    ordinaryUnverified.command = "pi";
    provisionAgentControl(ordinaryUnverified, { ...control,
      orchestratorAgent: { ...piAgent, piAgentControl: undefined },
    }, () => {}, host);
    assert.equal(ordinaryUnverified.env.WOLLIPOG_CLI, "/opt/runner");
    assert.equal(existsSync(agentControlTokenPath(root, ordinaryUnverified.sessionId)), true);
    assert.equal(ordinaryUnverified.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE, undefined);
    assert.equal(ordinaryUnverified.args.includes("--extension"), false);

    const orchestrator = spec("pi");
    orchestrator.sessionId = "s_pi_orchestrator";
    orchestrator.agentId = "pi";
    orchestrator.command = "pi";
    orchestrator.config = { permissionMode: "orchestrator" };
    provisionAgentControl(orchestrator, { ...control, orchestratorAgent: piAgent }, () => {}, host);
    const args = [...orchestrator.args];
    provisionAgentControl(orchestrator, { ...control, orchestratorAgent: piAgent }, () => {}, host);
    assert.deepEqual(orchestrator.args, args, "Pi resume replaces rather than stacks controlled flags");
    assert.ok(orchestrator.args.includes("--no-extensions"));
    assert.equal(orchestrator.args[orchestrator.args.indexOf("--exclude-tools") + 1], "bash,edit,write");
    assert.equal(orchestrator.args.filter((arg) => arg === "--extension").length, 1);

    const unverified = spec("pi");
    unverified.sessionId = "s_unverified_pi";
    unverified.agentId = "pi";
    unverified.command = "pi";
    unverified.config = { permissionMode: "orchestrator" };
    assert.throws(() => provisionAgentControl(unverified, { ...control,
      orchestratorAgent: { ...piAgent, piAgentControl: undefined },
    }, () => {}, host), /discovery-verified Pi extension bridge/);
    assert.equal(existsSync(agentControlTokenPath(root, unverified.sessionId)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a non-strict Pi Orchestrator launches as a normal session plus only the Orchestrator instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pi-additive-"));
  try {
    const host: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux",
    };
    const control = {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "bwrap" as const,
    };
    // Deliberately narrowing user flags: the additive contract must preserve every one of them.
    const userArgs = ["--no-skills", "--exclude-tools", "write", "--append-system-prompt", "Be terse."];
    const piAgent: AgentDefinition = {
      id: "pi", name: "Pi", command: "pi", args: [...userArgs], env: {}, driver: "pi",
      context: { kind: "native" }, piAgentControl: { protocolVersion: 1 },
    };
    const build = (sessionId: string, extra: Partial<SessionLaunchSpec>): SessionLaunchSpec => {
      const s = spec("pi");
      s.sessionId = sessionId;
      s.agentId = "pi";
      s.command = "pi";
      s.args = [...userArgs];
      return Object.assign(s, extra);
    };
    const normalized = (s: SessionLaunchSpec) => s.args.map((arg) =>
      arg === piAgentControlExtensionPath(root, s.sessionId) ? "<extension>" : arg);

    const ordinary = build("s_pi_normal", { config: { permissionMode: "default" } });
    provisionAgentControl(ordinary, { ...control, orchestratorAgent: piAgent }, () => {}, host);

    const additive = build("s_pi_additive", {
      config: { permissionMode: "default" },
      orchestrator: { strictProjectIsolation: false },
    });
    provisionAgentControl(additive, { ...control, orchestratorAgent: piAgent }, () => {}, host);

    // The two launches differ by exactly the Orchestrator instructions.
    assert.deepEqual(normalized(additive).slice(0, normalized(ordinary).length), normalized(ordinary),
      "the additive Pi launch extends the ordinary one without rewriting it");
    const extra = normalized(additive).slice(normalized(ordinary).length);
    assert.equal(extra.length, 2);
    assert.equal(extra[0], "--append-system-prompt");
    assert.match(extra[1]!, /^You are running with the Wollipog Orchestrator role/);
    assert.match(extra[1]!, /Strict Project Isolation is disabled/);

    // Every user flag survives, and none of the coupled preset's restrictions appear.
    assert.equal(additive.args[additive.args.indexOf("--exclude-tools") + 1], "write",
      "the user's own tool denylist is untouched");
    assert.ok(additive.args.includes("--no-skills"));
    for (const forbidden of ["--no-extensions", "--no-prompt-templates", "--no-context-files", "--tools"]) {
      assert.equal(additive.args.includes(forbidden), false, `${forbidden} would narrow the ordinary launch`);
    }
    assert.equal(additive.args.filter((arg) => arg === "--append-system-prompt").length, 2,
      "Pi accumulates appends, so the user's own is kept alongside the runner's");

    // The orchestration tool catalog is selected by the role marker; the preset's tool
    // re-activation marker must NOT be set, or it would re-enable tools the user excluded.
    assert.equal(additive.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
    assert.equal(additive.env[PI_ORCHESTRATOR_PRESET_TOOLS_ENV], undefined,
      "the additive role never force-activates tools the user's launch removed");
    assert.equal(ordinary.env.WOLLIPOG_PERMISSION_PRESET, undefined);
    assert.equal(additive.args[additive.args.indexOf("--extension") + 1],
      piAgentControlExtensionPath(root, additive.sessionId), "the Wollipog tool bridge is still loaded");

    // The coupled preset still restricts the launch and sets the tool re-activation marker. It
    // replaces Pi's whole controlled surface, so its identity check compares against the
    // preset-stripped baseline and a catalog carrying those flags cannot use it at all.
    const plainAgent: AgentDefinition = { ...piAgent, args: [] };
    const preset = build("s_pi_preset", {
      args: [],
      config: { permissionMode: "orchestrator" },
      orchestrator: { strictProjectIsolation: true },
    });
    provisionAgentControl(preset, { ...control, orchestratorAgent: plainAgent }, () => {}, host);
    assert.equal(preset.env[PI_ORCHESTRATOR_PRESET_TOOLS_ENV], "1");
    assert.ok(preset.args.includes("--no-extensions"));
    assert.equal(preset.args[preset.args.indexOf("--exclude-tools") + 1], "bash,edit,write");

    // Re-provisioning is idempotent: resume must not stack the instructions.
    const before = [...additive.args];
    provisionAgentControl(additive, { ...control, orchestratorAgent: piAgent }, () => {}, host);
    assert.deepEqual(additive.args, before, "Pi resume replaces rather than stacks the additive flags");

    // A stale preset marker left in the launch environment never survives into an additive or
    // ordinary launch: provisioning clears it before re-establishing the markers this shape needs.
    const stale = build("s_pi_stale_marker", {
      config: { permissionMode: "default" },
      orchestrator: { strictProjectIsolation: false },
    });
    stale.env[PI_ORCHESTRATOR_PRESET_TOOLS_ENV] = "1";
    provisionAgentControl(stale, { ...control, orchestratorAgent: piAgent }, () => {}, host);
    assert.equal(stale.env[PI_ORCHESTRATOR_PRESET_TOOLS_ENV], undefined);
    const staleOrdinary = build("s_pi_stale_ordinary", { config: { permissionMode: "default" } });
    staleOrdinary.env[PI_ORCHESTRATOR_PRESET_TOOLS_ENV] = "1";
    provisionAgentControl(staleOrdinary, { ...control, orchestratorAgent: piAgent }, () => {}, host);
    assert.equal(staleOrdinary.env[PI_ORCHESTRATOR_PRESET_TOOLS_ENV], undefined);

    // Strict Project Isolation still requires the coupled preset.
    assert.throws(() => provisionAgentControl(build("s_pi_strict", {
      config: { permissionMode: "default" }, orchestrator: { strictProjectIsolation: true },
    }), { ...control, orchestratorAgent: piAgent }, () => {}, host),
      /Strict Project Isolation requires the Orchestrator preset/);

    // An older control plane cannot request the additive Pi shape.
    assert.throws(() => provisionAgentControl(build("s_pi_old", {
      config: { permissionMode: "default" }, orchestrator: { strictProjectIsolation: false },
    }), {
      ...control,
      controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditivePi - 1,
      orchestratorAgent: piAgent,
    }, () => {}, host), /protocol-v163 control plane/);

    // The verified bridge is still required for the additive shape.
    assert.throws(() => provisionAgentControl(build("s_pi_nobridge", {
      config: { permissionMode: "default" }, orchestrator: { strictProjectIsolation: false },
    }), { ...control, orchestratorAgent: { ...piAgent, piAgentControl: undefined } }, () => {}, host),
      /discovery-verified Pi extension bridge/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an additive ACP Orchestrator is refused rather than launched with unaudited provider permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-additive-"));
  try {
    const host: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux",
    };
    const acp = spec("acp");
    acp.sessionId = "s_acp_additive";
    acp.command = "npx";
    acp.args = [`@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION}`];
    acp.config = { permissionMode: "default" };
    acp.orchestrator = { strictProjectIsolation: false };
    // ACP has no entry in ORCHESTRATOR_ADDITIVE_CAPABILITY, so the additive branch refuses first.
    assert.throws(() => provisionAgentControl(acp, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "bwrap",
    }, () => {}, host), /native Claude Code, Codex, and Pi Orchestrators/);
    assert.equal(existsSync(agentControlTokenPath(root, acp.sessionId)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verified Direct WSL rotates credentials and provisions only the target-local helper and launcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-agent-control-"));
  try {
    const installs: string[] = [];
    let helperFinished = false;
    const host: AgentControlHost = { isSea: true, execPath: "C:\\runner.exe", execArgv: [], configDir: root,
      installWslHelper: async (distro) => {
        helperFinished = false;
        installs.push(`helper:${distro}`);
        await Promise.resolve();
        helperFinished = true;
      },
      installWslLauncher: async (distro) => {
        assert.equal(helperFinished, true, "shared root-owned install directory is initialized serially");
        installs.push(`launcher:${distro}`);
      } };
    const launch = spec("codex-app-server");
    launch.context = { kind: "wsl", distro: "Ubuntu-24.04" };
    launch.config = { permissionMode: "orchestrator" };
    const agent: AgentDefinition = { id: launch.agentId, name: "Codex WSL", command: launch.command,
      args: [], env: {}, driver: "codex-app-server", context: launch.context,
      wslAgentControl: { protocolVersion: 1, nodeRuntime: "/usr/bin/node",
        safeLauncherProtocolVersion: 1, bwrapRuntime: "/usr/bin/bwrap" } };
    const hashes: string[] = [];
    const control = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "bwrap" as const,
      orchestratorAgent: agent, registerCredentialAndWait: async (_id: string, hash: string) => {
        hashes.push(hash);
        markAgentControlCredentialReady(root, launch.sessionId, hash);
      } };
    await provisionAgentControl(launch, control, () => {}, host);
    const first = wslAgentControlLaunch(launch.sessionId)!;
    assert.equal(first.distro, "Ubuntu-24.04");
    assert.equal(first.nodeRuntime, "/usr/bin/node");
    assert.equal(first.tokenFile, agentControlTokenPath(root, launch.sessionId));
    assert.equal(JSON.stringify(launch).includes(first.token), false, "credential stays out of launch metadata");
    assert.equal(launch.env.WOLLIPOG_CLI, "/usr/bin/node");
    assert.match(launch.env.WOLLIPOG_CLI_ARGS, /wsl-agent-control-v1\.mjs/u);
    assert.ok(launch.args.some((arg) => arg.includes('"WOLLIPOG_AGENT_CONTROL_SOCKET" = "/tmp/wollipog-agent-control/control.sock"')),
      "Codex MCP receives the private socket explicitly instead of relying on ambient inheritance");
    assert.ok(launch.args.includes("--strict-config"));

    const unsupported = { ...spec("codex-app-server"), sessionId: "s_provider_mode", context: launch.context,
      config: { permissionMode: "orchestrator" as const } };
    await assert.rejects(async () => provisionAgentControl(unsupported, {
      ...control, executionIsolationMode: "provider", orchestratorAgent: { ...agent, id: unsupported.agentId },
    }, () => {}, host), /verified Direct WSL bridge/u);
    assert.equal(wslAgentControlLaunch(unsupported.sessionId), undefined);
    assert.equal(existsSync(agentControlTokenPath(root, unsupported.sessionId)), false,
      "unsupported isolation fails before credential or target-local provisioning");

    await provisionAgentControl(launch, control, () => {}, host);
    const second = wslAgentControlLaunch(launch.sessionId)!;
    assert.notEqual(second.token, first.token, "every WSL provider restart rotates the credential");
    assert.notEqual(hashes[1], hashes[0]);
    assert.deepEqual(installs, ["helper:Ubuntu-24.04", "launcher:Ubuntu-24.04",
      "helper:Ubuntu-24.04", "launcher:Ubuntu-24.04"]);
    removeAgentControlFiles(launch.sessionId, root);
    assert.equal(wslAgentControlLaunch(launch.sessionId), undefined);

    const missing = { ...spec("codex-app-server"), sessionId: "s_missing_distro", context: launch.context,
      config: { permissionMode: "orchestrator" as const } };
    await assert.rejects(async () => provisionAgentControl(missing, {
      ...control,
      orchestratorAgent: { ...agent, id: missing.agentId },
      registerCredentialAndWait: async (sessionId, hash) => markAgentControlCredentialReady(root, sessionId, hash),
    }, () => {}, { ...host, installWslHelper: async () => { throw new Error("distro disappeared"); } }),
    /distro disappeared/);
    assert.equal(wslAgentControlLaunch(missing.sessionId), undefined);
    assert.equal(existsSync(agentControlTokenPath(root, missing.sessionId)), false,
      "failed creation after distro removal revokes the rotated credential");

    const generic = { ...spec("acp"), context: launch.context, config: { permissionMode: "orchestrator" as const } };
    await assert.rejects(async () => provisionAgentControl(generic, { ...control, orchestratorAgent: { ...agent, driver: "acp" } }, () => {}, host), /supported native harness or verified Direct WSL/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("Claude receives the general MCP config without changing the agent identity", () => {
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

test("a non-strict Codex Orchestrator launches as a normal session plus Wollipog's server and instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-additive-codex-orchestrator-"));
  try {
    const host: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux",
    };
    const control = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider" as const, orchestratorProjectPaths: ["/other-project"] };
    // Everything a user may have configured for an ordinary Codex session, including their own
    // MCP server, their own developer instructions, and an explicitly enabled feature.
    const userArgs = [
      "-c", "model_reasoning_effort=high", "--enable", "apps",
      "-c", 'mcp_servers.mine={ "command" = "/mine" }',
      "-c", 'developer_instructions="my own instructions"',
    ];
    for (const driver of ["codex", "codex-app-server"] as const) {
      for (const permissionMode of ["read-only", "on-request", "danger-full-access", "auto-review"]) {
        const normal = spec(driver);
        normal.sessionId = `s_normal_${driver.replace(/-/gu, "_")}`;
        normal.args = [...userArgs];
        normal.config = { permissionMode };
        provisionAgentControl(normal, control, () => {}, host);
        assert.deepEqual(normal.args, userArgs, "a normal Codex session receives no launch arguments");
        assert.equal(normal.env.WOLLIPOG_PERMISSION_PRESET, undefined);

        const orchestrator = spec(driver);
        orchestrator.sessionId = `s_orch_${driver.replace(/-/gu, "_")}`;
        orchestrator.args = [...userArgs];
        // Every mode the installation advertises for a normal session is accepted unchanged.
        orchestrator.config = { permissionMode };
        orchestrator.orchestrator = { strictProjectIsolation: false };
        provisionAgentControl(orchestrator, control, () => {}, host);
        const args = [...orchestrator.args];
        assert.deepEqual(args.slice(0, userArgs.length), userArgs,
          "apps, plugins, hooks, and configured MCP servers survive untouched");
        const added = args.slice(userArgs.length);
        assert.equal(added.length, 4, `${driver}/${permissionMode} adds only two settings`);
        assert.match(added[1]!, /^mcp_servers\.wollipog=/);
        assert.match(added[3]!, /^developer_instructions="You are running with the Wollipog Orchestrator role/);
        assert.equal(orchestrator.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator",
          "the campaign tools are exposed on Wollipog's own server");
        assert.equal(existsSync(agentControlMcpConfigPath(root, orchestrator.sessionId)), false,
          "Codex needs no runner-written MCP config file beside the user's own");
        provisionAgentControl(orchestrator, control, () => {}, host);
        assert.deepEqual(orchestrator.args, args, "resume is idempotent");
      }
    }

    // Strict Project Isolation and a pre-existing preset session both keep the coupled launch.
    const strict = spec("codex");
    strict.sessionId = "s_codex_strict_independent";
    strict.config = { permissionMode: "on-request" };
    strict.orchestrator = { strictProjectIsolation: true };
    assert.throws(() => provisionAgentControl(strict, control, () => {}, host),
      /Strict Project Isolation requires the Orchestrator preset/);
    const legacy = spec("codex");
    legacy.sessionId = "s_codex_legacy_preset";
    legacy.args = [...userArgs];
    legacy.config = { permissionMode: "orchestrator" };
    legacy.orchestrator = { strictProjectIsolation: false };
    provisionAgentControl(legacy, control, () => {}, host);
    assert.ok(legacy.args.includes("--strict-config"), "an existing Codex Orchestrator keeps the preset");
    assert.ok(legacy.args.includes("--disable"));
    assert.ok(legacy.args.some((arg) => arg.startsWith("sandbox_mode=")));
    assert.ok(legacy.args.some((arg) => arg.startsWith("approval_policy=")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an Orchestrator with independent provider permissions keeps the ordinary Claude launch and gains only additive tools", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-additive-orchestrator-control-"));
  try {
    const host: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux",
    };
    const control = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider" as const, orchestratorProjectPaths: ["/other-project"] };
    const launch = spec("claude-code");
    launch.args = ["--mcp-config", "/home/user/mcp.json", "--add-dir", "/home/user/notes", "--allowedTools", "Bash(npm test:*)"];
    launch.config = { permissionMode: "acceptEdits" };
    launch.orchestrator = { strictProjectIsolation: false };
    provisionAgentControl(launch, control, () => {}, host);
    const args = [...launch.args];
    assert.equal(launch.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator", "the MCP surface still exposes campaign tools");
    for (const flag of ["--strict-mcp-config", "--tools", "--permission-mode", "--disallowedTools",
      "--setting-sources", "--settings", "--disable-slash-commands"]) {
      assert.equal(args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), false, `${flag} is never injected`);
    }
    for (const kept of ["/home/user/mcp.json", "/home/user/notes", "Bash(npm test:*)"]) {
      assert.ok(args.includes(kept), `user configuration ${kept} survives`);
    }
    const mcpConfig = agentControlMcpConfigPath(root, launch.sessionId);
    assert.ok(args.includes(mcpConfig), "the general Wollipog MCP config sits beside the user's servers");
    const config = JSON.parse(readFileSync(mcpConfig, "utf8"));
    assert.equal(config.mcpServers.wollipog.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
    assert.deepEqual(args.flatMap((arg, index) => arg === "--allowedTools" ? [args[index + 1]] : []),
      ["Bash(npm test:*)", "mcp__wollipog__*"], "only Wollipog's own tools are pre-authorized");
    assert.deepEqual(args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : []),
      ["/home/user/notes", "/other-project", "/repo"]);
    const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
    assert.match(prompt, /^You are running with the Wollipog Orchestrator role/);
    assert.match(prompt, /Strict Project Isolation is disabled/);
    provisionAgentControl(launch, control, () => {}, host);
    assert.deepEqual(launch.args, args, "resume is idempotent");

    const strict = spec("claude-code");
    strict.sessionId = "s_strict_independent";
    strict.config = { permissionMode: "acceptEdits" };
    strict.orchestrator = { strictProjectIsolation: true };
    assert.throws(() => provisionAgentControl(strict, control, () => {}, host),
      /Strict Project Isolation requires the Orchestrator preset/);
    // Pi gained the additive shape in v163 (#1294), so it is no longer refused for its harness —
    // but it still requires the discovery-verified bridge that enforces its permission mode.
    const pi = spec("pi");
    pi.sessionId = "s_pi_independent";
    pi.config = { permissionMode: "on-request" };
    pi.orchestrator = { strictProjectIsolation: false };
    assert.throws(() => provisionAgentControl(pi, control, () => {}, host),
      /discovery-verified Pi extension bridge/);
    // ACP has no additive shape at all: its provider permission contract is unaudited.
    const acp = spec("acp");
    acp.sessionId = "s_acp_independent";
    acp.config = { permissionMode: "default" };
    acp.orchestrator = { strictProjectIsolation: false };
    assert.throws(() => provisionAgentControl(acp, control, () => {}, host),
      /native Claude Code, Codex, and Pi Orchestrators/);
    const outdated = spec("claude-code");
    outdated.sessionId = "s_outdated_control_plane";
    outdated.config = { permissionMode: "acceptEdits" };
    outdated.orchestrator = { strictProjectIsolation: false };
    assert.throws(() => provisionAgentControl(outdated, {
      ...control, controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveRole - 1,
    }, () => {}, host), /protocol-v160/);
    const outdatedCodex = spec("codex");
    outdatedCodex.sessionId = "s_codex_outdated_control_plane";
    outdatedCodex.config = { permissionMode: "on-request" };
    outdatedCodex.orchestrator = { strictProjectIsolation: false };
    assert.throws(() => provisionAgentControl(outdatedCodex, {
      ...control, controlPlaneProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex - 1,
    }, () => {}, host), /protocol-v162/);
    for (const refused of [strict, pi, acp, outdated, outdatedCodex]) {
      assert.equal(existsSync(agentControlTokenPath(root, refused.sessionId)), false, "refusal precedes credential minting");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an additive Codex Orchestrator refuses a launch that already claims the reserved wollipog MCP name", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-additive-codex-collision-"));
  try {
    const host: AgentControlHost = { isSea: true, execPath: "/opt/runner", execArgv: [], configDir: root, platform: "linux" };
    const launch = spec("codex-app-server");
    launch.sessionId = "s_codex_collision";
    launch.args = ["-c", 'mcp_servers.wollipog={ command = "my-server", args = [] }'];
    launch.config = { permissionMode: "on-request" };
    launch.orchestrator = { strictProjectIsolation: false };
    assert.throws(() => provisionAgentControl(launch, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider" as const,
    }, () => {}, host), /reserved for Wollipog/);
    assert.deepEqual(launch.args, ["-c", 'mcp_servers.wollipog={ command = "my-server", args = [] }'],
      "the user's server is reported, never silently removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
