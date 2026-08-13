import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerView } from "@wollipog/protocol";
import {
  buildRunnerConfigJson,
  localRunnerReadiness,
  onboardingHealth,
  RUNNER_START_COMMAND,
  RUNNER_TOKEN_FILE,
  suggestRunnerId,
  withHost,
} from "./onboarding.js";

test("buildRunnerConfigJson produces valid JSON wired to the given control plane", () => {
  const json = buildRunnerConfigJson({
    runnerId: "laptop",
    runnerWsUrl: "ws://192.168.1.20:4317/runner",
    workspaceId: "my-repo",
    workspacePath: "/home/me/my-repo",
  });
  const cfg = JSON.parse(json);
  assert.equal(cfg.runnerId, "laptop");
  assert.equal(cfg.controlPlaneUrl, "ws://192.168.1.20:4317/runner");
  assert.equal("token" in cfg, false, "the reusable config never contains the one-time plaintext secret");
  assert.deepEqual(cfg.workspaces, [{ id: "my-repo", name: "my-repo", path: "/home/me/my-repo" }]);
  // ships with a Claude + Codex native driver so the runner is useful immediately
  assert.deepEqual(
    cfg.agents.map((a: { driver: string }) => a.driver),
    ["claude-code", "codex-app-server"],
  );
  assert.equal(cfg.agents[1].name, "Codex — Interactive");
  // pretty-printed for human editing
  assert.ok(json.includes("\n  "));
  assert.equal(RUNNER_TOKEN_FILE, ".agent-manager/runner.token");
  assert.equal(RUNNER_START_COMMAND, "pnpm runner --config runner.config.json --token-file .agent-manager/runner.token");
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

test("onboarding health stays pending until the configured runner connects", () => {
  const checks = onboardingHealth({ credentialAvailable: true, runnerId: "laptop", workspaceId: "repo" });
  assert.deepEqual(checks.map((check) => check.status), ["pass", "pass", "pending", "pending", "pending"]);
  assert.match(checks.find((check) => check.id === "credentials")?.detail ?? "", /runner\.token/);
  assert.equal(checks.find((check) => check.id === "runner")?.command, RUNNER_START_COMMAND);
});

test("onboarding health verifies online runner, workspace, and a friendly ready agent", () => {
  const checks = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
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
    workspaceId: "repo",
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
  assert.equal(credential.status, "pending");
  assert.match(credential.detail, /Generate the one-time credential for “laptop”/);
  assert.doesNotMatch(credential.detail, /CONTROL_PLANE_TOKEN|shared/i);
  assert.equal(checks.find((check) => check.id === "runner")?.status, "fail");
  assert.equal(checks.find((check) => check.id === "agents")?.command, "claude auth login");
});

test("onboarding health waits for current discovery even when registration carries stale ready rows", () => {
  const checks = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({
      agentsRefreshed: false,
      agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
    }),
  });
  assert.equal(checks.find((check) => check.id === "agents")?.status, "pending");
});

test("onboarding health blocks baseline runner-id collisions", () => {
  const checks = onboardingHealth({ credentialAvailable: true, runnerId: "existing", workspaceId: "repo", runnerIdCollision: true });
  assert.equal(checks.find((check) => check.id === "runner")?.status, "fail");
  assert.match(checks.find((check) => check.id === "runner")?.detail ?? "", /already existed/);
});

test("onboarding health keeps ACP auth guidance provider-neutral and configured agents honest", () => {
  const unauthenticated = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({ agents: [{ id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp", available: false, authStatus: "unauthenticated" }] }),
  });
  const issue = unauthenticated.find((check) => check.id === "agents")!;
  assert.equal(issue.command, undefined);
  assert.doesNotMatch(issue.detail, /codex/i);

  const configured = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({ agents: [{ id: "custom", name: "Custom ACP", command: "custom", args: [], env: {}, driver: "acp" }] }),
  });
  assert.equal(configured.find((check) => check.id === "agents")?.status, "warning");
  assert.match(configured.find((check) => check.id === "agents")?.detail ?? "", /first live initialize/);
});

test("onboarding health requires ACP live evidence and promotes configured ACP after handshake", () => {
  const registry = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({ agents: [{ id: "registry", name: "Registry agent", command: "npx", args: [], env: {}, driver: "acp", source: "registry", available: true, authStatus: "unknown" }] }),
  });
  assert.equal(registry.find((check) => check.id === "agents")?.status, "warning");
  assert.match(registry.find((check) => check.id === "agents")?.detail ?? "", /first live initialize/);

  const initialized = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({ agents: [{
      id: "configured", name: "Configured ACP", command: "agent", args: [], env: {}, driver: "acp",
      authStatus: "authenticated",
      acp: { logout: false, loadSession: false, sessionList: false, sessionDelete: false, sessionResume: false, sessionClose: false },
    }] }),
  });
  assert.equal(initialized.find((check) => check.id === "agents")?.status, "pass");
});

test("onboarding health accepts runnable Codex batch fallback and labels offline problems as last-known", () => {
  const batch = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({ agents: [{
      id: "codex-exec", name: "Codex", command: "codex", args: ["exec"], env: {}, driver: "codex", available: true,
      codexAppServer: { status: "unsupported", appServerAvailable: false },
    }] }),
  });
  assert.equal(batch.find((check) => check.id === "agents")?.status, "pass");

  const offline = onboardingHealth({
    credentialAvailable: true,
    runnerId: "laptop",
    workspaceId: "repo",
    runner: runner({ status: "offline", agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: false, authStatus: "unauthenticated" }] }),
  });
  const offlineAgent = offline.find((check) => check.id === "agents")!;
  assert.equal(offlineAgent.status, "warning");
  assert.match(offlineAgent.detail, /Last reported when this runner was online/);
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
