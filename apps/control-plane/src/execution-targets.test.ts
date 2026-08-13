import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerView } from "@wollipog/protocol";
import {
  executionTargetRef,
  executionTargetsForRunner,
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
  const image = `example/agent@sha256:${"e".repeat(64)}`;
  const advertised = validateRunnerContainerTargets("dev box/1", [{
    id: "runner:dev%20box%2F1:container:offline-tools",
    runnerId: "dev box/1",
    name: "builder · Offline tools",
    kind: "container",
    workspaceStrategy: "worktree",
    adapter: "container",
    boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    environment: { id: "offline-tools", revision: 1, image, setupCheckDigest: "f".repeat(64) },
    compatibleAgentIds: ["codex"],
    available: true,
  }]);
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

test("validates metered cloud targets, snapshot selection, policy refs, and handoff receipts", () => {
  const target = validateRunnerCloudTargets("dev box/1", [{
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
  }])[0]!;
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
