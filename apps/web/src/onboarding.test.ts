import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_EXEC_RETIRED_CONFIG_REASON, type RunnerView } from "@wollipog/protocol";
import {
  buildRunnerConfigJson,
  buildRunnerStartCommand,
  firstWorkspace,
  localRunnerReadiness,
  onboardingHealth,
  runnerHostLabel,
  RUNNER_START_COMMAND,
  RUNNER_TOKEN_FILE,
  suggestRunnerId,
  withHost,
} from "./onboarding.js";

test("buildRunnerConfigJson produces valid JSON wired to the given control plane", () => {
  const json = buildRunnerConfigJson({
    runnerId: "laptop",
    runnerWsUrl: "ws://192.168.1.20:4317/runner",
    workspace: firstWorkspace("/home/me/my-repo", ""),
  });
  const cfg = JSON.parse(json);
  assert.equal(cfg.runnerId, "laptop");
  assert.equal(cfg.controlPlaneUrl, "ws://192.168.1.20:4317/runner");
  assert.equal("token" in cfg, false, "the reusable config never contains the one-time plaintext secret");
  assert.deepEqual(cfg.workspaces, [{ id: "my-repo", name: "my-repo", path: "/home/me/my-repo" }]);
  // ships with the supported native drivers so the runner is useful immediately
  assert.deepEqual(
    cfg.agents.map((a: { driver: string }) => a.driver),
    ["claude-code", "codex-app-server", "pi"],
  );
  assert.equal(cfg.agents[1].name, "Codex App Server");
  assert.equal(cfg.agents[2].name, "Pi");
  // pretty-printed for human editing
  assert.ok(json.includes("\n  "));
  assert.equal(RUNNER_TOKEN_FILE, ".agent-manager/runner.token");
  assert.equal(RUNNER_START_COMMAND, "pnpm runner --config runner.config.json --token-file .agent-manager/runner.token");
  assert.equal(buildRunnerStartCommand(), RUNNER_START_COMMAND);
  assert.equal(
    buildRunnerStartCommand(true),
    `${RUNNER_START_COMMAND} --allow-insecure-transport`,
  );
});

test("Install Manually's first workspace is optional and named from its folder when unnamed", () => {
  assert.equal(firstWorkspace("  ", "Ignored"), null);
  assert.equal(JSON.parse(buildRunnerConfigJson({ runnerId: "laptop", runnerWsUrl: "ws://h/runner", workspace: null })).workspaces.length, 0);
  assert.deepEqual(firstWorkspace("/srv/Work Repo/", ""), { id: "work-repo", name: "Work Repo", path: "/srv/Work Repo/" });
  assert.deepEqual(firstWorkspace("C:\\code\\api", "API Server"), { id: "api-server", name: "API Server", path: "C:\\code\\api" });
});

test("a generated workspace id is never a URL dot segment, which would change its API routes", () => {
  for (const [folder, name] of [[".", ""], ["..", ""], ["./", ""], ["/srv/..", ""], ["/srv/repo", "."], ["/srv/repo", ".."]] as const) {
    const workspace = firstWorkspace(folder, name)!;
    assert.equal(workspace.id, "workspace", `${folder} ${name}`);
    const route = `/api/runners/r/workspaces/${encodeURIComponent(workspace.id)}/rename`;
    assert.equal(new URL(route, "http://localhost").pathname, route, `${folder} ${name}`);
  }
  assert.equal(firstWorkspace(".", "")!.name, "workspace", "a dot folder is not a name either");
  assert.equal(firstWorkspace("/srv/.config", "")!.id, ".config", "a name that merely starts with a dot is kept");
});

test("the host choices read in words", () => {
  assert.equal(runnerHostLabel("127.0.0.1"), "This computer (127.0.0.1)");
  assert.equal(runnerHostLabel("192.0.2.10"), "192.0.2.10 (local network)");
});

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "laptop",
    hostname: "devbox",
    os: "linux",
    version: "1.0.0",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    agentsRefreshed: true,
    ...overrides,
  };
}

test("before a credential every check waits for the person, and nothing is pending on the machine (#2992)", () => {
  const checks = onboardingHealth({ credentialAvailable: false, runnerId: "gpu-lab-01", workspaceIds: ["repo"] });
  assert.deepEqual(checks.map((check) => check.status), ["pass", "waiting", "waiting", "waiting", "waiting"]);
  assert.equal(checks.find((check) => check.id === "credentials")?.detail, "Generate the credential for gpu-lab-01.");
  assert.equal(checks.find((check) => check.id === "runner")?.detail, "Generate the credential, then start the runner.");
});

test("once a credential exists, the machine checks are pending until the runner connects", () => {
  const checks = onboardingHealth({ credentialAvailable: true, runnerId: "gpu-lab-01", workspaceIds: ["repo"] });
  assert.deepEqual(checks.map((check) => check.status), ["pass", "pass", "pending", "pending", "pending"]);
  const connection = checks.find((check) => check.id === "runner")!;
  assert.equal(connection.detail, "Waiting for gpu-lab-01 to connect…");
  assert.equal(connection.command, undefined, "the Start step already shows the command");
});

test("a blank workspace skips the workspace check, so an online runner completes without a workspace failure", () => {
  const ready = {
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server" as const,
    available: true, authStatus: "authenticated" as const,
    codexAppServer: { status: "supported" as const, appServerAvailable: true },
  };
  const before = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: [] });
  assert.equal(before.some((check) => check.id === "workspace"), false);
  const online = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: [], runner: runner({ agents: [ready] }) });
  assert.deepEqual(online.map((check) => [check.id, check.status]), [
    ["control-plane", "pass"], ["credentials", "pass"], ["runner", "pass"], ["agents", "pass"],
  ]);
});

test("an offline runner's last-known ready agents are no warning: that row waits for the runner", () => {
  const offline = runner({
    status: "offline",
    agents: [{
      id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
      available: true, authStatus: "authenticated", codexAppServer: { status: "supported", appServerAvailable: true },
    }],
  });
  const before = onboardingHealth({ credentialAvailable: false, runnerId: "laptop", workspaceIds: [], runner: offline, repair: true });
  assert.deepEqual(before.map((check) => check.status), ["waiting", "waiting"]);
  const after = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: [], runner: offline, repair: true });
  assert.deepEqual(after.map((check) => check.status), ["pending", "pending"]);
});

test("repair checks only the runner's known workspaces and reports agent problems as a warning", () => {
  const machine = runner({
    runnerId: "gpu-lab-01",
    workspaces: [{ id: "models", name: "Models", path: "/data/models" }],
    agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: false, authStatus: "unauthenticated" }],
  });
  const offline = onboardingHealth({ credentialAvailable: false, runnerId: "gpu-lab-01", workspaceIds: ["models"], runner: { ...machine, status: "offline" }, repair: true });
  assert.deepEqual(offline.map((check) => check.id), ["runner", "workspace", "agents"], "no control-plane or credential rows");
  assert.equal(offline[0]!.status, "waiting");
  assert.equal(offline[0]!.detail, "gpu-lab-01 is offline. Replace its credential, then restart it.");
  assert.equal(offline[1]!.status, "waiting");
  assert.equal(offline[2]!.status, "warning");

  const back = onboardingHealth({ credentialAvailable: true, runnerId: "gpu-lab-01", workspaceIds: ["models"], runner: machine, repair: true });
  assert.deepEqual(back.map((check) => check.status), ["pass", "pass", "warning"]);
  assert.equal(back[2]!.command, "claude auth login");
  assert.ok(back.every((check) => !/has not advertised/.test(check.detail)));
});

test("onboarding health verifies online runner, workspace, and a friendly ready agent", () => {
  const checks = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({
      workspaces: [{ id: "repo", name: "My repo", path: "/work/repo" }],
      agents: [{
        id: "codex",
        name: "Codex",
        command: "codex",
        args: [],
        env: {},
        driver: "codex-app-server",
        available: true,
        authStatus: "authenticated",
        codexAppServer: { status: "supported", appServerAvailable: true },
      }],
    }),
  });
  assert.ok(checks.every((check) => check.status === "pass"));
  assert.match(checks.find((check) => check.id === "agents")?.detail ?? "", /Codex App Server/);
});

test("onboarding health gives exact recovery commands for offline and unauthenticated agents", () => {
  const checks = onboardingHealth({
    credentialAvailable: false,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({
      status: "offline",
      agents: [{
        id: "claude",
        name: "Claude Code",
        command: "claude",
        args: [],
        env: {},
        driver: "claude-code",
        available: false,
        authStatus: "unauthenticated",
      }],
    }),
  });
  const credential = checks.find((check) => check.id === "credentials")!;
  assert.equal(credential.status, "waiting");
  assert.match(credential.detail, /Generate the credential for laptop/);
  assert.doesNotMatch(credential.detail, /CONTROL_PLANE_TOKEN|shared/i);
  assert.equal(checks.find((check) => check.id === "runner")?.status, "waiting");
  const agents = checks.find((check) => check.id === "agents")!;
  assert.equal(agents.status, "warning", "a last-known problem is a warning while the runner is offline");
  assert.equal(agents.command, "claude auth login");
});

test("Codex onboarding uses installation guidance without a universal npm command", () => {
  const update = {
    status: "managed_externally" as const, checkedAt: 1, channel: "stable" as const,
    evidenceSource: "Executable installation provenance", managedExternally: true as const,
    guidance: "Use this installation's exact manager.",
  };
  const unsupported = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: ["repo"],
    runner: runner({ agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
      driver: "codex-app-server", available: false,
      codexAppServer: { status: "unsupported", appServerAvailable: false }, update,
    }] }),
  }).find((check) => check.id === "agents")!;
  assert.equal(unsupported.command, undefined);
  assert.match(unsupported.detail, /Use this installation's exact manager/);
  assert.doesNotMatch(unsupported.detail, /npm install/);

  const missing = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: ["repo"],
    runner: runner({ agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
      driver: "codex-app-server", available: false,
      codexAppServer: { status: "unavailable", appServerAvailable: false },
    }] }),
  }).find((check) => check.id === "agents")!;
  assert.equal(missing.command, undefined);
  assert.match(missing.detail, /is unavailable or could not be launched/);
  assert.match(missing.detail, /Install Codex using a supported method/);
  assert.doesNotMatch(missing.detail, /selected installation|npm install/);
});

test("Codex onboarding suppresses an older Windows runner's unsafe update command", () => {
  const legacy = "Run `& 'C:\\Windows\\System32\\cmd.exe' '/c' 'echo' '%PATH%' 'update'` in PowerShell.";
  const machine = runner({ os: "windows", agents: [{
    id: "codex", name: "Codex", command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/c", "echo", "%PATH%"], env: {}, driver: "codex-app-server",
    context: { kind: "native" }, available: false,
    codexAppServer: { status: "unsupported", appServerAvailable: false },
    update: { status: "managed_externally", checkedAt: 1, channel: "stable",
      evidenceSource: "Executable installation provenance", managedExternally: true,
      guidance: legacy },
  }] });
  const health = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: ["repo"],
    runner: machine }).find((check) => check.id === "agents")!;
  assert.match(health.detail, /No copyable update command is available/);
  assert.doesNotMatch(health.detail, /Run `|%PATH%/);
  const readiness = localRunnerReadiness(machine);
  assert.equal(readiness.state, "needs-attention");
  assert.doesNotMatch(readiness.detail, /Run `|%PATH%/);
});

test("onboarding health waits for current discovery even when registration carries stale ready rows", () => {
  const checks = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({
      agentsRefreshed: false,
      agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
    }),
  });
  assert.equal(checks.find((check) => check.id === "agents")?.status, "pending");
});

test("onboarding health blocks baseline runner-id collisions", () => {
  const checks = onboardingHealth({ credentialAvailable: true, runnerId: "existing", workspaceIds: ["repo"], runnerIdCollision: true });
  assert.equal(checks.find((check) => check.id === "runner")?.status, "fail");
  assert.match(checks.find((check) => check.id === "runner")?.detail ?? "", /A runner named existing already exists/);
});

test("onboarding health keeps ACP auth guidance provider-neutral and configured agents honest", () => {
  const unauthenticated = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({ agents: [{ id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp", available: false, authStatus: "unauthenticated" }] }),
  });
  const issue = unauthenticated.find((check) => check.id === "agents")!;
  assert.equal(issue.command, undefined);
  assert.doesNotMatch(issue.detail, /codex/i);

  const configured = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({ agents: [{ id: "custom", name: "Custom ACP", command: "custom", args: [], env: {}, driver: "acp" }] }),
  });
  assert.equal(configured.find((check) => check.id === "agents")?.status, "fail");
  assert.match(configured.find((check) => check.id === "agents")?.detail ?? "", /unavailable/);
});

test("onboarding health requires ACP live evidence and promotes configured ACP after handshake", () => {
  const registry = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({ agents: [{ id: "registry", name: "Registry agent", command: "npx", args: [], env: {}, driver: "acp", source: "registry", available: true, authStatus: "unknown" }] }),
  });
  assert.equal(registry.find((check) => check.id === "agents")?.status, "warning");
  assert.match(registry.find((check) => check.id === "agents")?.detail ?? "", /first live initialize/);

  const initialized = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({ agents: [{
      id: "configured", name: "Configured ACP", command: "agent", args: [], env: {}, driver: "acp",
      available: true,
      authStatus: "authenticated",
      acp: { logout: false, loadSession: false, sessionList: false, sessionDelete: false, sessionResume: false, sessionClose: false },
    }] }),
  });
  assert.equal(initialized.find((check) => check.id === "agents")?.status, "pass");
});

test("onboarding health never counts Codex exec as ready and labels offline problems as last-known", () => {
  const exec = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({ agents: [{
      id: "codex-exec", name: "Codex", command: "codex", args: ["exec"], env: {}, driver: "codex", available: true,
      codexAppServer: { status: "unsupported", appServerAvailable: false },
    }] }),
  });
  const execCheck = exec.find((check) => check.id === "agents")!;
  assert.equal(execCheck.status, "fail", "the retired exec driver is not a working agent (#3259)");
  assert.equal(execCheck.detail, CODEX_EXEC_RETIRED_CONFIG_REASON);

  const offline = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceIds: ["repo"],
    runner: runner({ status: "offline", agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: false, authStatus: "unauthenticated" }] }),
  });
  const offlineAgent = offline.find((check) => check.id === "agents")!;
  assert.equal(offlineAgent.status, "warning");
  assert.match(offlineAgent.detail, /Last reported when this runner was online/);
});

test("discovery's restart-only exec row does not make Codex ready when App Server's check failed", () => {
  const message = "Wollipog couldn't check this Codex installation in time. Rediscover to try again.";
  const codexAppServer = {
    status: "unsupported" as const,
    appServerAvailable: false,
    failure: { code: "probe_timeout" as const, message, retryable: true },
  };
  const agents: RunnerView["agents"] = [
    {
      id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
      source: "discovered", available: false, authStatus: "authenticated", codexAppServer,
    },
    {
      id: "codex-exec", name: "Codex (Non-Interactive)", command: "codex", args: [], env: {}, driver: "codex",
      source: "discovered", available: true, authStatus: "authenticated", codexAppServer,
    },
  ];
  const readiness = localRunnerReadiness(runner({ agents }));
  assert.equal(readiness.state, "needs-attention");
  assert.equal(readiness.detail, message, "a failed check is fixed by rediscovering, not by an upgrade");
  assert.deepEqual(readiness.agentLabels, ["Codex App Server"]);

  const health = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceIds: ["repo"], runner: runner({ agents }) });
  const check = health.find((item) => item.id === "agents")!;
  assert.equal(check.status, "fail");
  assert.equal(check.detail, message);
});

test("local runner readiness moves from startup through discovery to agent-ready", () => {
  assert.equal(localRunnerReadiness(undefined).state, "starting");
  assert.equal(localRunnerReadiness(runner({ agentsRefreshed: false })).state, "discovering");
  const readiness = localRunnerReadiness(runner({
    agents: [{
      id: "codex",
      name: "Codex",
      command: "codex",
      args: [],
      env: {},
      driver: "codex-app-server",
      available: true,
      authStatus: "authenticated",
      codexAppServer: { status: "supported", appServerAvailable: true },
    }],
  }));
  assert.equal(readiness.state, "ready");
  assert.deepEqual(readiness.agentLabels, ["Codex App Server"]);
});

test("local runner readiness names discovered agents that still need attention", () => {
  const readiness = localRunnerReadiness(runner({
    agents: [{
      id: "claude-code",
      name: "Claude Code",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      available: false,
      authStatus: "unauthenticated",
    }],
  }));
  assert.equal(readiness.state, "needs-attention");
  assert.deepEqual(readiness.agentLabels, ["Claude Code Native"]);
  assert.match(readiness.detail, /not signed in/);
});

test("suggestRunnerId avoids collisions", () => {
  assert.equal(suggestRunnerId([]), "runner");
  assert.equal(suggestRunnerId(["runner"]), "runner-2");
  assert.equal(suggestRunnerId(["runner", "runner-2"]), "runner-3");
  assert.equal(suggestRunnerId(["a", "b"], "mac"), "mac");
});

test("withHost swaps the hostname but keeps scheme/port/path", () => {
  assert.equal(withHost("ws://127.0.0.1:4317/runner", "192.168.1.20"), "ws://192.168.1.20:4317/runner");
  assert.equal(withHost("ws://127.0.0.1:4317/runner", "10.0.0.5"), "ws://10.0.0.5:4317/runner");
  // malformed input is returned unchanged rather than throwing
  assert.equal(withHost("not a url", "x"), "not a url");
});
