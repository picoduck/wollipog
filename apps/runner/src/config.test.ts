import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  conductorEnabled,
  loadConfig,
  parseArgs,
  parseEnv,
  parseWorkspaceArg,
  resolveAgentEnvironment,
  resolveConfig,
  resolveWorkspacePath,
} from "./config.js";

test("conductorEnabled requires the exact runner opt-in value", () => {
  assert.equal(conductorEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(conductorEnabled({ WOLLIPOG_CONDUCTOR: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(conductorEnabled({ WOLLIPOG_CONDUCTOR: "true" } as NodeJS.ProcessEnv), false);
  assert.equal(conductorEnabled({ WOLLIPOG_CONDUCTOR: "1" } as NodeJS.ProcessEnv), true);
});

test("conductorEnabled prefers the Wollipog flag and warns only on legacy fallback", () => {
  const warnings: string[] = [];
  assert.equal(
    conductorEnabled(
      { WOLLIPOG_CONDUCTOR: "0", MAM_CONDUCTOR: "1" } as NodeJS.ProcessEnv,
      (warning) => warnings.push(warning),
    ),
    false,
  );
  assert.deepEqual(warnings, []);
  assert.equal(
    conductorEnabled({ MAM_CONDUCTOR: "1" } as NodeJS.ProcessEnv, (warning) => warnings.push(warning)),
    true,
  );
  assert.deepEqual(warnings, ["MAM_CONDUCTOR is deprecated; use WOLLIPOG_CONDUCTOR"]);
});

test("parseArgs defaults to runner.config.json (absolute)", () => {
  const { configPath } = parseArgs([]);
  assert.ok(isAbsolute(configPath));
  assert.ok(configPath.endsWith("runner.config.json"));
});

test("parseArgs handles --config <path>, --config=<path>, and -c <path>", () => {
  assert.ok(parseArgs(["--config", "a.json"]).configPath.endsWith("a.json"));
  assert.ok(parseArgs(["--config=b.json"]).configPath.endsWith("b.json"));
  assert.ok(parseArgs(["-c", "c.json"]).configPath.endsWith("c.json"));
});

test("parseArgs last flag wins", () => {
  assert.ok(parseArgs(["--config", "first.json", "-c", "second.json"]).configPath.endsWith("second.json"));
});

test("resolveWorkspacePath leaves POSIX/WSL absolute paths intact", () => {
  assert.equal(resolveWorkspacePath("/home/developer/repo"), "/home/developer/repo");
});

test("resolveWorkspacePath leaves Windows absolute paths intact (no /home mangling)", () => {
  assert.equal(resolveWorkspacePath("C:\\Users\\developer\\repo"), "C:\\Users\\developer\\repo");
  assert.equal(resolveWorkspacePath("D:/work/x"), "D:/work/x");
});

test("resolveWorkspacePath resolves genuinely-relative paths to absolute", () => {
  const out = resolveWorkspacePath("./sub/dir");
  assert.ok(isAbsolute(out), "relative path becomes absolute");
});

test("resolveConfig validates secret-free MCP definitions and resolves directory grants", () => {
  const config = resolveConfig({
    runnerId: "r",
    controlPlaneUrl: "ws://localhost",
    mcpServers: [{ type: "http", name: "docs", url: "https://mcp.example/rpc", headers: { Authorization: { fromEnv: "MCP_AUTH" } } }],
    workspaces: [{ id: "w", name: "W", path: ".", additionalDirectoryGrants: ["C:\\shared"] }],
    agents: [{ id: "a", name: "A", command: "agent", mcpServers: [{ type: "stdio", name: "local", command: "C:\\tools\\mcp.exe" }] }],
    features: { acpAdditionalDirectories: true },
  });
  assert.equal(config.features.acpAdditionalDirectories, true);
  assert.equal(config.workspaces[0]!.additionalDirectoryGrants![0], "C:\\shared");
  assert.equal(config.mcpServers?.[0]?.name, "docs");
});

test("resolveConfig fails closed on plaintext-shaped MCP credentials", () => {
  assert.throws(() => resolveConfig({
    runnerId: "r",
    controlPlaneUrl: "ws://localhost",
    mcpServers: [{ type: "http", name: "bad", url: "https://mcp.example/rpc", headers: { Authorization: "secret" as never } }],
  }), /environment reference/);
});

test("resolveConfig rejects relative additional-directory grants instead of rewriting them", () => {
  assert.throws(() => resolveConfig({
    runnerId: "r",
    controlPlaneUrl: "ws://localhost",
    workspaces: [{ id: "w", name: "W", path: ".", additionalDirectoryGrants: ["./shared"] }],
  }), /additional-directory grants must be absolute/);
});

/* ---- config-less startup: flags / env / merge ---- */

test("parseArgs reads config-less connection flags into overrides", () => {
  const { overrides } = parseArgs([
    "--runner-id", "box-1",
    "--control-plane-url", "ws://127.0.0.1:9/runner",
    "--token", "sekret",
    "--workspace", "repo:/home/me/repo",
  ]);
  assert.equal(overrides.runnerId, "box-1");
  assert.equal(overrides.controlPlaneUrl, "ws://127.0.0.1:9/runner");
  assert.equal(overrides.token, "sekret");
  assert.deepEqual(overrides.workspaces, [{ id: "repo", name: "repo", path: "/home/me/repo" }]);
});

test("parseArgs and parseEnv accept runner data/admission settings", () => {
  const parsed = parseArgs(["--data-dir", "D:\\wollipog-data", "--max-concurrent-sessions=7"]);
  assert.equal(parsed.overrides.dataDir, "D:\\wollipog-data");
  assert.equal(parsed.overrides.maxConcurrentSessions, 7);
  const env = parseEnv({ RUNNER_DATA_DIR: "/srv/wollipog", RUNNER_MAX_CONCURRENT_SESSIONS: "9" } as NodeJS.ProcessEnv);
  assert.equal(env.dataDir, "/srv/wollipog");
  assert.equal(env.maxConcurrentSessions, 9);
});

test("parseArgs supports --flag=value and repeated --workspace", () => {
  const { overrides } = parseArgs([
    "--runner-id=b2",
    "--workspace=a:/p/a",
    "--workspace", "b:/p/b",
  ]);
  assert.equal(overrides.runnerId, "b2");
  assert.deepEqual(overrides.workspaces?.map((w) => w.id), ["a", "b"]);
});

test("parseArgs ignores a leading non-flag positional (SEA exec path / script path)", () => {
  // index.ts slices argv[0] only; in normal node that leaves the script path as a leading
  // positional, which must be ignored while the flags after it still parse.
  const { overrides } = parseArgs([
    "/opt/wollipog-runner",
    "--runner-id", "b",
    "--control-plane-url", "ws://h/runner",
  ]);
  assert.equal(overrides.runnerId, "b");
  assert.equal(overrides.controlPlaneUrl, "ws://h/runner");
});

test("parseArgs --version sets showVersion", () => {
  assert.equal(parseArgs(["--version"]).showVersion, true);
  assert.equal(parseArgs(["-v"]).showVersion, true);
  assert.equal(parseArgs([]).showVersion, false);
});

test("parseWorkspaceArg splits id:path on the first colon, keeps Windows drive paths bare", () => {
  assert.deepEqual(parseWorkspaceArg("home:/home/me/x"), { id: "home", name: "home", path: "/home/me/x" });
  // A Windows drive path has no id → derive id from the basename.
  assert.deepEqual(parseWorkspaceArg("C:\\work\\proj"), { id: "proj", name: "proj", path: "C:\\work\\proj" });
  // Bare POSIX path → id from basename.
  assert.deepEqual(parseWorkspaceArg("/srv/app"), { id: "app", name: "app", path: "/srv/app" });
  assert.equal(parseWorkspaceArg(undefined), null);
});

test("parseEnv reads RUNNER_ID / CONTROL_PLANE_URL / RUNNER_TOKEN / RUNNER_WORKSPACES", () => {
  const o = parseEnv({
    RUNNER_ID: "envbox",
    CONTROL_PLANE_URL: "ws://h:1/runner",
    RUNNER_TOKEN: "t",
    RUNNER_WORKSPACES: JSON.stringify([{ id: "w", name: "w", path: "/p" }]),
  } as NodeJS.ProcessEnv);
  assert.equal(o.runnerId, "envbox");
  assert.equal(o.controlPlaneUrl, "ws://h:1/runner");
  assert.equal(o.token, "t");
  assert.deepEqual(o.workspaces, [{ id: "w", name: "w", path: "/p" }]);
});

test("parseEnv ignores malformed RUNNER_WORKSPACES", () => {
  const o = parseEnv({ RUNNER_WORKSPACES: "not json" } as NodeJS.ProcessEnv);
  assert.equal(o.workspaces, undefined);
});

test("resolveConfig: overrides win over file, defaults fill the rest", () => {
  const cfg = resolveConfig(
    { runnerId: "fromfile", controlPlaneUrl: "ws://file/runner", token: "filetok", workspaces: [], agents: [] },
    { controlPlaneUrl: "ws://override/runner" },
  );
  assert.equal(cfg.runnerId, "fromfile");
  assert.equal(cfg.controlPlaneUrl, "ws://override/runner"); // override wins
  assert.equal(cfg.token, "filetok");
});

test("agent env supports runner-local literals and fromEnv references resolved only at launch", () => {
  const config = resolveConfig({
    runnerId: "runner",
    controlPlaneUrl: "ws://localhost/runner",
    agents: [{
      id: "agent",
      name: "Agent",
      command: "agent",
      env: { LITERAL: "local-value", API_TOKEN: { fromEnv: "HOST_API_TOKEN" } },
    }],
  });
  assert.deepEqual(config.agents[0]?.env, {
    LITERAL: "local-value",
    API_TOKEN: { fromEnv: "HOST_API_TOKEN" },
  });
  assert.deepEqual(resolveAgentEnvironment(config.agents[0]!, { HOST_API_TOKEN: "secret-at-launch" }), {
    LITERAL: "local-value",
    API_TOKEN: "secret-at-launch",
  });
  assert.throws(() => resolveAgentEnvironment(config.agents[0]!, {}), /runner-local environment variable/u);
  assert.throws(() => resolveConfig({
    runnerId: "runner",
    controlPlaneUrl: "ws://localhost/runner",
    agents: [{ id: "agent", name: "Agent", command: "agent", env: { TOKEN: { fromEnv: "bad-name" } } }],
  }), /must be a string/u);
});

test("resolveConfig: config-less from overrides only, agents default to []", () => {
  const cfg = resolveConfig({}, { runnerId: "b", controlPlaneUrl: "ws://h/runner" });
  assert.equal(cfg.runnerId, "b");
  assert.equal(cfg.token, "");
  assert.deepEqual(cfg.agents, []);
});

test("resolveConfig throws when runnerId or controlPlaneUrl is missing", () => {
  assert.throws(() => resolveConfig({}, {}), /runnerId/);
  assert.throws(() => resolveConfig({}, { runnerId: "x" }), /controlPlaneUrl/);
});

test("resolveConfig defaults and validates the box process ceiling", () => {
  const cfg = resolveConfig({}, { runnerId: "x", controlPlaneUrl: "ws://x" });
  assert.equal(cfg.maxConcurrentSessions, DEFAULT_MAX_CONCURRENT_SESSIONS);
  assert.equal(DEFAULT_MAX_CONCURRENT_SESSIONS, 16);
  assert.ok(isAbsolute(cfg.dataDir));
  assert.equal(cfg.features.acpRegistry, false);
  assert.deepEqual(cfg.acpRegistryAgents, []);
  assert.deepEqual(cfg.admission, { agentLimits: {}, agentWeights: {} });
  assert.deepEqual(cfg.executionIsolation, {
    mode: "provider", network: "inherit", providerStateRetentionDays: 7, providerStateMaxBytes: 5 * 1024 ** 3,
  });
  assert.deepEqual(cfg.containerTargets, []);
  assert.throws(
    () => resolveConfig({ runnerId: "x", controlPlaneUrl: "ws://x", maxConcurrentSessions: 0 }, {}),
    /maxConcurrentSessions/,
  );
});

test("resolveConfig keeps an explicit capacity when the default changes", () => {
  const base = { runnerId: "x", controlPlaneUrl: "ws://x" };
  // An operator who pinned the old default must keep it after an upgrade.
  assert.equal(resolveConfig({ ...base, maxConcurrentSessions: 4 }, {}).maxConcurrentSessions, 4);
  assert.equal(resolveConfig({ ...base }, { maxConcurrentSessions: 1 }).maxConcurrentSessions, 1);
  // Overrides still win over an explicit file value.
  assert.equal(
    resolveConfig({ ...base, maxConcurrentSessions: 4 }, { maxConcurrentSessions: 32 }).maxConcurrentSessions,
    32,
  );
});

test("resolveConfig requires reproducible, bounded container environment templates", () => {
  const image = `example/agent@sha256:${"d".repeat(64)}`;
  const cfg = resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    containerTargets: [{
      id: "offline-tools", name: " Offline tools ", revision: 2, runtime: "docker", image,
      network: "deny", agentCommands: { codex: { command: "codex", args: ["app-server"] } },
      setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
    }],
  });
  assert.deepEqual(cfg.containerTargets[0], {
    id: "offline-tools", name: "Offline tools", revision: 2, runtime: "docker", image,
    network: "deny", agentCommands: { codex: { command: "codex", args: ["app-server"] } },
    setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
  });
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    containerTargets: [{ ...cfg.containerTargets[0]!, image: "example/agent:latest" }],
  }), /image must be pinned/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    containerTargets: [{ ...cfg.containerTargets[0]!, setupChecks: [] }],
  }), /1 to 16 setup checks/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    containerTargets: [{ ...cfg.containerTargets[0]!, agentCommands: {} }],
  }), /map 1 to 32 agent commands/);
});

test("resolveConfig validates fail-closed runner-owned execution isolation", () => {
  const cfg = resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "bwrap", network: "deny" },
  });
  assert.deepEqual(cfg.executionIsolation, {
    mode: "bwrap", network: "deny", providerStateRetentionDays: 7, providerStateMaxBytes: 5 * 1024 ** 3,
  });
  const bounded = resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "bwrap", network: "inherit", providerStateRetentionDays: 0, providerStateMaxBytes: 1024 ** 2 },
  });
  assert.equal(bounded.executionIsolation.providerStateRetentionDays, 0);
  assert.equal(bounded.executionIsolation.providerStateMaxBytes, 1024 ** 2);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "bwrap", network: "inherit", providerStateRetentionDays: -1 },
  }), /providerStateRetentionDays/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "bwrap", network: "inherit", providerStateMaxBytes: 1024 },
  }), /providerStateMaxBytes/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "provider", network: "deny" },
  }), /cannot promise runner-owned network denial/);
  assert.deepEqual(resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "seatbelt", network: "deny" },
  }).executionIsolation, {
    mode: "seatbelt", network: "deny", providerStateRetentionDays: 7, providerStateMaxBytes: 5 * 1024 ** 3,
  });
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "windows-job", network: "deny" },
  }), /cannot promise runner-owned network denial/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    executionIsolation: { mode: "unknown" as never, network: "inherit" },
  }), /mode must be/);
});

test("resolveConfig validates provider quotas and weighted admission", () => {
  const cfg = resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    maxConcurrentSessions: 6,
    admission: {
      agentLimits: { claude: 2 },
      agentWeights: { claude: 3, codex: 2 },
    },
  });
  assert.deepEqual(cfg.admission, {
    agentLimits: { claude: 2 },
    agentWeights: { claude: 3, codex: 2 },
  });
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x", maxConcurrentSessions: 2,
    admission: { agentLimits: {}, agentWeights: { claude: 3 } },
  }), /agentWeights\.claude.*1 to 2/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    admission: { agentLimits: { "../bad": 1 }, agentWeights: {} },
  }), /invalid agent id/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    admission: { agentLimits: { claude: 0 }, agentWeights: {} },
  }), /agentLimits\.claude/);
});

test("ACP Registry discovery is feature-gated and constrained by an explicit operator allowlist", () => {
  const cfg = resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    acpRegistryAgents: ["gemini", "gemini", "opencode"],
    features: { acpAdditionalDirectories: false, acpRegistry: true },
  });
  assert.equal(cfg.features.acpRegistry, true);
  assert.deepEqual(cfg.acpRegistryAgents, ["gemini", "opencode"]);
  assert.throws(() => resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    acpRegistryAgents: ["../../bad"],
  }), /acpRegistryAgents/);
});

test("ACP transport is explicitly stdio and remote-shaped config fails closed", () => {
  const cfg = resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    agents: [{ id: "gemini", name: "Gemini", command: "gemini", transport: "stdio" }],
  });
  assert.equal(cfg.agents[0]!.transport, "stdio");
  assert.equal(cfg.features.acpRemoteTransports, false);
  assert.throws(() => resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    agents: [{ id: "remote", name: "Remote", command: "ignored", transport: "websocket" as never }],
  }), /unsupported ACP transport.*use stdio/);
  assert.throws(() => resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    features: { acpAdditionalDirectories: false, acpRemoteTransports: true },
  }), /remote transports are not implemented/);
  assert.throws(() => resolveConfig({
    runnerId: "x",
    controlPlaneUrl: "ws://x",
    agents: [{ id: "native", name: "Native", command: "claude", driver: "claude-code", transport: "stdio" }],
  }), /transport only with the ACP driver/);
});

test("parseArgs reads --token-file (keeps the secret out of argv)", () => {
  assert.equal(parseArgs(["--token-file", "/run/secrets/tok"]).tokenFile, "/run/secrets/tok");
  assert.equal(parseArgs(["--token-file=/x/tok"]).tokenFile, "/x/tok");
  assert.equal(parseArgs([]).tokenFile, undefined);
});

test("parseArgs marks --config as explicit, default path is not", () => {
  assert.equal(parseArgs([]).explicitConfig, false);
  assert.equal(parseArgs(["--config", "x.json"]).explicitConfig, true);
});

test("loadConfig tolerates a MISSING DEFAULT config during config-less launch", () => {
  const missing = join(tmpdir(), `wollipog-no-such-${process.pid}.json`);
  const cfg = loadConfig(missing, { runnerId: "b", controlPlaneUrl: "ws://h/runner" }, /* explicit */ false);
  assert.equal(cfg.runnerId, "b");
});

test("loadConfig throws on a MISSING EXPLICIT config even with connection overrides", () => {
  const missing = join(tmpdir(), `wollipog-no-such-explicit-${process.pid}.json`);
  assert.throws(
    () => loadConfig(missing, { runnerId: "b", controlPlaneUrl: "ws://h/runner" }, /* explicit */ true),
    /could not read runner config/,
  );
});

test("resolveConfig validates cloud proxy targets, reference-only secrets, cost, and admission", () => {
  const cloudTarget = {
    id: "metered-tools",
    name: "Metered tools",
    revision: 1,
    adapterCommand: "cloud-proxy",
    adapterArgs: ["--profile", "team"],
    adapterEnv: { CLOUD_TOKEN: { fromEnv: "WOLLIPOG_FIXTURE_CLOUD_TOKEN" } },
    image: `registry.example/cloud/agent@sha256:${"a".repeat(64)}`,
    setupCheckDigest: "b".repeat(64),
    agentCommands: { codex: { command: "codex", args: ["app-server"] } },
    policy: { maxConcurrentSessions: 2, estimatedHourlyRateUsd: 1.5, minimumBudgetUsd: 0.5, maximumBudgetUsd: 25 },
  };
  const cfg = resolveConfig({ runnerId: "x", controlPlaneUrl: "ws://x", cloudTargets: [cloudTarget] });
  assert.deepEqual(cfg.cloudTargets[0], cloudTarget);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    cloudTargets: [{ ...cloudTarget, adapterEnv: { CLOUD_TOKEN: "plaintext" as never } }],
  }), /must be \{ fromEnv/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    cloudTargets: [{ ...cloudTarget, policy: { ...cloudTarget.policy, minimumBudgetUsd: 30 } }],
  }), /cannot exceed/);
  assert.throws(() => resolveConfig({
    runnerId: "x", controlPlaneUrl: "ws://x",
    cloudTargets: [{ ...cloudTarget, policy: { ...cloudTarget.policy, maxConcurrentSessions: 0 } }],
  }), /maxConcurrentSessions/);
});
