import assert from "node:assert/strict";
import test from "node:test";
import { agentAvailableForImplicitLaunch, agentAvailableForRunnerDefault, projectProviderAccountReadinessForPeer,
  type AgentDefinition } from "./index.js";

const agent: AgentDefinition = { id: "claude", name: "Claude", command: "claude", args: [], env: {},
  driver: "claude-code", available: true, authStatus: "authenticated", defaultProviderAccountId: "a",
  providerAccountReadiness: { defaultAccountId: "a", defaultAuthStatus: "unauthenticated", readyAccountIds: ["b"] } };

test("implicit readiness checks A; explicit or saved B does not rewrite A", () => {
  assert.equal(agentAvailableForImplicitLaunch(agent), false);
  assert.equal(agentAvailableForImplicitLaunch(agent, "a"), false);
  assert.equal(agentAvailableForImplicitLaunch(agent, "b"), true);
  assert.equal(agentAvailableForImplicitLaunch(agent, "missing"), false);
  assert.equal(agentAvailableForRunnerDefault(agent, [{ provider: "claude", accountId: "b", revision: 1 }]), true);
  assert.equal(agentAvailableForRunnerDefault({ ...agent, context: { kind: "wsl", distro: "Ubuntu" } },
    [{ provider: "claude", accountId: "b", revision: 1 }]), false);
  assert.equal(agent.defaultProviderAccountId, "a");
  assert.equal(agentAvailableForImplicitLaunch({ available: true }), true);
  assert.equal(agentAvailableForImplicitLaunch({ available: false }), false);
  assert.equal(agentAvailableForImplicitLaunch({ ...agent, providerAccountReadiness: null as never }), false);
});

test("old peers receive default readiness; current peers keep explicit account availability", () => {
  assert.equal(projectProviderAccountReadinessForPeer(agent, true), agent);
  const old = projectProviderAccountReadinessForPeer(agent, false);
  assert.equal(old.available, false);
  assert.equal(old.authStatus, "unauthenticated");
  assert.equal(old.providerAccountReadiness, undefined);
  assert.equal(agent.available, true);
  const claude = { ...agent, claudeCode: { status: "ready" as const,
    effortLevels: [], permissionModes: [], streamJsonInput: true, streamJsonImages: false,
    controlProtocol: true, forkSession: false, replayUserMessages: false,
    auth: { status: "authenticated" as const, billingSource: "unknown" as const } } };
  const projected = projectProviderAccountReadinessForPeer(claude, false);
  assert.equal(projected.claudeCode?.status, "unauthenticated");
  assert.equal(projected.claudeCode?.auth.status, "unauthenticated");
  assert.equal(projected.claudeCode?.failure?.code, "unauthenticated");
  assert.equal(claude.claudeCode.status, "ready", "the original aggregate observation stays intact");
});
