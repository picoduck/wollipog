import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTargetDefinition, RunnerView } from "@wollipog/protocol";
import {
  executionTargetRef,
  executionTargetsForRunner,
  relaunchExecutionTarget,
  resolveExecutionTarget,
  validateExecutionHandoffReceipt,
  validateRunnerCloudTargets,
  validateRunnerContainerTargets,
} from "./execution-targets.js";

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "dev box/1", hostname: "builder", os: "linux", version: "1", status: "online",
    agents: [], workspaces: [], connectedAt: 1, lastSeen: 1,
    runtime: { dataDir: "/data", worktreeRoot: "/data/worktrees", maxConcurrentSessions: 4,
      executionIsolation: { mode: "bwrap", network: "deny" } },
    ...overrides,
  };
}

function containerTarget(): ExecutionTargetDefinition {
  return {
    id: "runner:dev%20box%2F1:container:offline-tools",
    runnerId: "dev box/1",
    name: "builder · Offline tools",
    kind: "container",
    workspaceStrategy: "worktree",
    adapter: "container",
    boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    environment: { id: "offline-tools", revision: 1, image: `example/agent@sha256:${"e".repeat(64)}`, setupCheckDigest: "f".repeat(64) },
    compatibleAgentIds: ["codex"],
    available: true,
  };
}

function cloudTarget(): ExecutionTargetDefinition {
  return {
    id: "runner:dev%20box%2F1:cloud:metered-tools",
    runnerId: "dev box/1",
    name: "builder · Metered tools",
    kind: "cloud",
    workspaceStrategy: "snapshot",
    adapter: "cloud",
    boundaries: { filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" },
    environment: {
      id: "metered-tools", revision: 2, image: `example/cloud@sha256:${"a".repeat(64)}`,
      setupCheckDigest: "b".repeat(64),
    },
    policy: {
      cost: { currency: "USD", estimatedHourlyRateUsd: 1.25, minimumBudgetUsd: 0.5, maximumBudgetUsd: 10 },
      admission: { maxConcurrentSessions: 2, queue: "fifo" },
    },
    compatibleAgentIds: ["codex"],
    available: true,
  };
}

const invalidTargetCases = [
  { guard: "identity", name: "a different runner", mutate: (target) => { target.runnerId = "another-runner"; } },
  { guard: "identity", name: "a different derived id", mutate: (target) => { target.id += "-wrong"; } },
  { guard: "placement", name: "an unsupported kind", mutate: (target) => { target.kind = "local"; } },
  { guard: "placement", name: "an unsupported adapter", mutate: (target) => { target.adapter = "host"; } },
  { guard: "placement", name: "an unsupported workspace strategy", mutate: (target) => { target.workspaceStrategy = "in_place"; } },
  { guard: "boundary", name: "an unsupported filesystem", mutate: (target) => { target.boundaries.filesystem = "unsupported" as never; } },
  { guard: "boundary", name: "an unsupported network", mutate: (target) => { target.boundaries.network = "unsupported" as never; } },
  { guard: "boundary", name: "unsupported secrets", mutate: (target) => { target.boundaries.secrets = "unsupported" as never; } },
  { guard: "boundary", name: "unsupported billing", mutate: (target) => { target.boundaries.billing = "unsupported" as never; } },
  { guard: "environment", name: "a missing template", mutate: (target) => {
    target.environment = undefined;
    // Match the identity guard's empty-template sentinel to reach environment validation.
    target.id = "";
  } },
  { guard: "environment", name: "a non-slug template id", mutate: (target) => {
    target.environment!.id = "Bad Template";
    // Keep the derived identity coherent so the environment guard must reject the slug.
    target.id = `runner:${encodeURIComponent(target.runnerId)}:${target.kind}:${encodeURIComponent(target.environment!.id)}`;
  } },
  { guard: "environment", name: "revision zero", mutate: (target) => { target.environment!.revision = 0; } },
  { guard: "environment", name: "revision above the limit", mutate: (target) => { target.environment!.revision = 1_000_001; } },
  { guard: "environment", name: "an image without a digest", mutate: (target) => { target.environment!.image = "example/agent:latest"; } },
  { guard: "environment", name: "a non-hex setup digest", mutate: (target) => { target.environment!.setupCheckDigest = "g".repeat(64); } },
  { guard: "name", name: "an empty name", mutate: (target) => { target.name = ""; } },
  { guard: "name", name: "a whitespace-only name", mutate: (target) => { target.name = " \t "; } },
  { guard: "name", name: "a name above 180 characters", mutate: (target) => { target.name = "n".repeat(181); } },
  { guard: "name", name: "a control character in the name", mutate: (target) => { target.name = "bad\0name"; } },
  { guard: "compatibility", name: "an empty agent list", mutate: (target) => { target.compatibleAgentIds = []; } },
  { guard: "compatibility", name: "more than 32 agents", mutate: (target) => {
    target.compatibleAgentIds = Array.from({ length: 33 }, (_, index) => `agent-${index}`);
  } },
  { guard: "compatibility", name: "a malformed agent id", mutate: (target) => { target.compatibleAgentIds = ["bad/agent"]; } },
  { guard: "compatibility", name: "a duplicate agent id", mutate: (target) => { target.compatibleAgentIds = ["codex", "codex"]; } },
] satisfies Array<{
  guard: "identity" | "placement" | "boundary" | "environment" | "name" | "compatibility";
  name: string;
  mutate: (target: ExecutionTargetDefinition) => void;
}>;

for (const { kind, fixture, validate } of [
  { kind: "container", fixture: containerTarget, validate: validateRunnerContainerTargets },
  { kind: "cloud", fixture: cloudTarget, validate: validateRunnerCloudTargets },
]) {
  const messages = {
    identity: new RegExp(`invalid or duplicate ${kind} target identity`),
    placement: new RegExp(`unsupported ${kind} placement semantics`),
    boundary: new RegExp(`unsupported ${kind} boundary claims`),
    environment: new RegExp(`invalid ${kind} environment template`),
    name: new RegExp(`invalid ${kind} target name`),
    compatibility: new RegExp(`invalid ${kind} agent compatibility`),
  };
  for (const { guard, name, mutate } of invalidTargetCases) {
    test(`rejects ${kind} ${guard}: ${name}`, () => {
      const target = fixture();
      mutate(target);
      assert.throws(() => validate("dev box/1", [target]), messages[guard]);
    });
  }
  test(`rejects ${kind} identity: duplicate target ids`, () => {
    assert.throws(() => validate("dev box/1", [fixture(), fixture()]), messages.identity);
  });
  test(`rejects ${kind} list: seventeen targets`, () => {
    const targets = Array.from({ length: 17 }, (_, index) => {
      const target = fixture();
      target.environment!.id = `tools-${index}`;
      target.id = `runner:dev%20box%2F1:${kind}:tools-${index}`;
      return target;
    });
    assert.throws(() => validate("dev box/1", targets), new RegExp(`too many ${kind} targets`));
  });
  test(`rejects ${kind} list: a non-array value`, () => {
    assert.throws(() => validate("dev box/1", {} as ExecutionTargetDefinition[]), new RegExp(`too many ${kind} targets`));
  });
  test(`returns no ${kind} targets for undefined`, () => {
    assert.deepEqual(validate("dev box/1", undefined), []);
  });
}

test("projects local and SSH placements independently from agent drivers", () => {
  const local = executionTargetsForRunner(runner(), false);
  const ssh = executionTargetsForRunner(runner(), true);
  assert.deepEqual(local.map((target) => [target.kind, target.workspaceStrategy]), [
    ["local", "in_place"], ["local", "worktree"],
  ]);
  assert.deepEqual(ssh.map((target) => [target.kind, target.workspaceStrategy]), [
    ["ssh", "in_place"], ["ssh", "worktree"],
  ]);
  assert.equal(local[0]!.boundaries.network, "deny");
  assert.equal(local[1]!.boundaries.filesystem, "worktree");
  assert.match(local[0]!.id, /^runner:dev%20box%2F1:host:/);
  assert.ok(!JSON.stringify(local).includes("agentId"));
});

test("resolves legacy flags and rejects cross-runner or conflicting selections", () => {
  const r = runner();
  const worktree = executionTargetsForRunner(r, false)[1]!;
  assert.equal(resolveExecutionTarget(r, false, { useWorktree: true }).target.workspaceStrategy, "worktree");
  assert.equal(resolveExecutionTarget(r, false, { executionTargetId: worktree.id }).useWorktree, true);
  assert.match(resolveExecutionTarget(r, false, { executionTargetId: "runner:other:host:worktree" }).error, /unknown/);
  assert.match(resolveExecutionTarget(r, false, { executionTargetId: worktree.id, useWorktree: false }).error, /conflicts/);
  assert.deepEqual(executionTargetRef(worktree), {
    id: worktree.id, runnerId: r.runnerId, kind: "local", workspaceStrategy: "worktree", adapter: "host",
    boundaries: worktree.boundaries,
  });
});

test("offline placements remain visible but fail closed", () => {
  const r = runner({ status: "offline" });
  const target = executionTargetsForRunner(r, false)[0]!;
  assert.equal(target.available, false);
  assert.match(resolveExecutionTarget(r, false, { executionTargetId: target.id }).error, /offline/);
});

test("validates runner-owned container templates and resolves only compatible agents", () => {
  const advertised = validateRunnerContainerTargets("dev box/1", [containerTarget()]);
  const r = runner({ executionTargets: [...executionTargetsForRunner(runner(), false), ...advertised] });
  const selected = resolveExecutionTarget(r, false, {
    executionTargetId: advertised[0]!.id, useWorktree: true, agentId: "codex",
  });
  assert.equal(selected.target.adapter, "container");
  assert.equal(selected.useWorktree, true);
  assert.match(resolveExecutionTarget(r, false, {
    executionTargetId: advertised[0]!.id, useWorktree: true, agentId: "claude",
  }).error, /does not configure/);
  assert.deepEqual(executionTargetRef(advertised[0]!).environment, advertised[0]!.environment);
  assert.throws(() => validateRunnerContainerTargets("dev box/1", [{
    ...advertised[0]!, boundaries: { ...advertised[0]!.boundaries, secrets: "runner_local" },
  }]), /boundary claims/);
});

test("target probe claims require matching target-local evidence and never trust cloud v2 status", () => {
  const common = {
    id: "runner:dev%20box%2F1:container:tools", runnerId: "dev box/1", name: "builder · Tools",
    kind: "container" as const, workspaceStrategy: "worktree" as const, adapter: "container" as const,
    boundaries: { filesystem: "container" as const, network: "deny" as const,
      secrets: "none" as const, billing: "none" as const },
    environment: { id: "tools", revision: 1, image: `example/agent@sha256:${"e".repeat(64)}`,
      setupCheckDigest: "f".repeat(64) },
    compatibleAgentIds: ["codex"], available: true,
  };
  const candidate = { agentId: "codex", id: "a".repeat(24), path: "/usr/bin/codex", version: "0.154.0",
    provenance: "container-image" as const, authentication: "authenticated" as const,
    authenticationEvidence: "codex-login-status" as const, capability: "verified" as const,
    capabilityEvidence: "codex-app-server-help" as const, available: true };
  const installed = validateRunnerContainerTargets("dev box/1", [{ ...common,
    harnessInstallations: [candidate] }])[0]!.harnessInstallations![0]!;
  assert.equal(installed.authentication, "authenticated");
  assert.equal(installed.capability, "verified");
  assert.equal(installed.authenticationEvidence, "codex-login-status");
  const legacy = validateRunnerContainerTargets("dev box/1", [{ ...common,
    harnessInstallations: [{ ...candidate, authenticationEvidence: undefined, capabilityEvidence: undefined }] }])[0]!
    .harnessInstallations![0]!;
  assert.equal(legacy.authentication, "unknown");
  assert.equal(legacy.capability, "unknown");
  const offline = validateRunnerContainerTargets("dev box/1", [{ ...common,
    harnessInstallations: [candidate] }], false)[0]!.harnessInstallations![0]!;
  assert.equal(offline.authentication, "unknown");
  assert.equal(offline.capability, "unknown");
  assert.throws(() => validateRunnerContainerTargets("dev box/1", [{ ...common,
    harnessInstallations: [{ ...candidate, authenticationEvidence: "claude-auth-status" }] }]), /invalid target harness/);
  const cloud = validateRunnerCloudTargets("dev box/1", [{
    ...common, id: "runner:dev%20box%2F1:cloud:tools", kind: "cloud", adapter: "cloud",
    workspaceStrategy: "snapshot", boundaries: { filesystem: "snapshot", network: "policy",
      secrets: "references", billing: "target_metered" },
    policy: { cost: { currency: "USD", estimatedHourlyRateUsd: 1, minimumBudgetUsd: 1,
      maximumBudgetUsd: 10 }, admission: { maxConcurrentSessions: 1, queue: "fifo" } },
    harnessInstallations: [{ ...candidate, provenance: "cloud-adapter" }],
  }])[0]!.harnessInstallations![0]!;
  assert.equal(cloud.authentication, "unknown");
  assert.equal(cloud.capability, "unknown");
});

test("validates metered cloud targets, snapshot selection, policy refs, and handoff receipts", () => {
  const target = validateRunnerCloudTargets("dev box/1", [cloudTarget()])[0]!;
  const r = runner({ executionTargets: [...executionTargetsForRunner(runner(), false), target] });
  assert.deepEqual(resolveExecutionTarget(r, false, {
    executionTargetId: target.id, useWorktree: true, agentId: "codex", agentContext: { kind: "native" },
  }), { target, useWorktree: true });
  assert.match(resolveExecutionTarget(r, false, {
    executionTargetId: target.id, useWorktree: true, agentId: "codex", agentContext: { kind: "wsl", distro: "Ubuntu" },
  }).error, /native/);
  assert.deepEqual(executionTargetRef(target).policy, target.policy);

  const ref = executionTargetRef(target);
  const receipt = validateExecutionHandoffReceipt({
    targetId: target.id,
    sourceSessionId: "source-1",
    manifestDigest: "c".repeat(64),
    adapterHandoffIdHash: "d".repeat(64),
    git: {
      headCommit: "e".repeat(40), headTree: "f".repeat(40), remoteUrlHash: "1".repeat(64),
      workingTreeDigest: "2".repeat(64), dirty: true, untrackedFiles: 1,
    },
    artifacts: [{ artifactId: "art-1", kind: "patch", sizeBytes: 12, sha256: "3".repeat(64) }],
    budgetUsd: 5,
    quotedCostUsd: 1.5,
    acceptedAt: 1_720_000_000_000,
  }, ref)!;
  assert.equal(receipt.git.dirty, true);
  assert.throws(() => validateExecutionHandoffReceipt({ ...receipt, quotedCostUsd: 6 }, ref), /invalid/);
  assert.throws(() => validateRunnerCloudTargets("dev box/1", [{
    ...target, policy: { ...target.policy!, cost: { ...target.policy!.cost, currency: "EUR" as never } },
  }]), /cost or admission/);
});

test("a relaunch follows the session's current workspace strategy across host placements", () => {
  const r = runner();
  const [inPlace, worktree] = executionTargetsForRunner(r, false).map(executionTargetRef) as [
    ReturnType<typeof executionTargetRef>, ReturnType<typeof executionTargetRef>,
  ];

  // The bug this covers: an in-place session that later gains a runner-owned session worktree keeps
  // its creation-time placement, and the pair is exactly what the runner refuses.
  assert.deepEqual(relaunchExecutionTarget(r, false, inPlace, true), { target: worktree },
    "gaining a worktree moves the relaunch onto the isolated-worktree placement");
  assert.deepEqual(relaunchExecutionTarget(r, false, worktree, false), { target: inPlace },
    "losing the worktree moves it back in place");
  assert.deepEqual(relaunchExecutionTarget(r, false, worktree, true), { target: worktree },
    "a session created with Worktree mode on keeps the exact placement it was created with");
  assert.deepEqual(relaunchExecutionTarget(r, false, inPlace, false), { target: inPlace });
  assert.deepEqual(relaunchExecutionTarget(r, false, undefined, true), { target: undefined },
    "a session launched before execution targets existed still carries none");

  // Reconciliation keeps the placement family the session was created with.
  const sshWorktree = executionTargetRef(executionTargetsForRunner(r, true)[1]!);
  assert.deepEqual(relaunchExecutionTarget(r, true, executionTargetRef(executionTargetsForRunner(r, true)[0]!), true),
    { target: sshWorktree }, "an SSH box reconciles within its own SSH placements");
});

test("a relaunch refuses rather than launching a placement that cannot express the strategy", () => {
  const container = validateRunnerContainerTargets("dev box/1", [{
    id: "runner:dev%20box%2F1:container:offline-tools",
    runnerId: "dev box/1",
    name: "builder · Offline tools",
    kind: "container",
    workspaceStrategy: "worktree",
    adapter: "container",
    boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    environment: {
      id: "offline-tools", revision: 1, image: `example/agent@sha256:${"e".repeat(64)}`,
      setupCheckDigest: "f".repeat(64),
    },
    compatibleAgentIds: ["codex"],
    available: true,
  }])[0]!;
  const withContainer = runner({ executionTargets: [...executionTargetsForRunner(runner(), false), container] });
  const containerRef = executionTargetRef(container);
  assert.deepEqual(relaunchExecutionTarget(withContainer, false, containerRef, true), { target: containerRef },
    "an isolated-by-construction target is untouched while the session still has its workspace");
  const lostWorkspace = relaunchExecutionTarget(withContainer, false, containerRef, false);
  assert.match("error" in lostWorkspace ? lostWorkspace.error : "",
    /container execution target always runs in an isolated workspace/,
    "a container session that lost its workspace is refused with guidance instead of a doomed launch");

  // A container target also advertises the `worktree` strategy, so reconciliation must not drift a
  // host session onto it.
  assert.deepEqual(relaunchExecutionTarget(withContainer, false, executionTargetRef(
    executionTargetsForRunner(runner(), false)[0]!), true),
  { target: executionTargetRef(executionTargetsForRunner(runner(), false)[1]!) },
  "a host session reconciles onto the host worktree placement, never a container one");

  const offline = runner({ status: "offline" });
  const stale = relaunchExecutionTarget(offline, false, executionTargetRef(
    executionTargetsForRunner(offline, false)[0]!), true);
  assert.match("error" in stale ? stale.error : "", /offline/,
    "an unavailable placement is reported rather than sent");
});
