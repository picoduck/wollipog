import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTargetRef } from "@wollipog/protocol";
import { executionTargetLaunchError, validateHostExecutionTarget } from "./execution-target.js";
import type { ContainerTargetRegistry } from "./container-target.js";
import type { CloudTargetRegistry } from "./cloud-target.js";

const isolation = { mode: "bwrap" as const, network: "deny" as const };
function target(overrides: Partial<ExecutionTargetRef> = {}): ExecutionTargetRef {
  return {
    id: "runner:r1:host:worktree", runnerId: "r1", kind: "ssh", workspaceStrategy: "worktree",
    adapter: "host", boundaries: { filesystem: "worktree", network: "deny", secrets: "runner_local", billing: "agent_account" },
    ...overrides,
  };
}

test("accepts exact host targets and legacy absent targets", () => {
  assert.equal(validateHostExecutionTarget(target(), "r1", true, isolation), null);
  assert.equal(validateHostExecutionTarget(undefined, "r1", true, isolation), null);
});

test("fails closed on runner, strategy, adapter, and policy drift", () => {
  assert.match(validateHostExecutionTarget(target({ runnerId: "r2" }), "r1", true, isolation)!, /belong/);
  assert.match(validateHostExecutionTarget(target({ workspaceStrategy: "in_place" }), "r1", true, isolation)!, /strategy/);
  assert.match(validateHostExecutionTarget(target({ adapter: "cloud" }), "r1", true, isolation)!, /adapter/);
  assert.match(validateHostExecutionTarget(target({ boundaries: { ...target().boundaries, network: "inherit" } }), "r1", true, isolation)!, /stale/);
});

test("routes container validation to the configured registry without host fallback", () => {
  const container = target({
    id: "runner:r1:container:tools", kind: "container", adapter: "container",
    boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    environment: { id: "tools", revision: 1, image: `x@sha256:${"a".repeat(64)}`, setupCheckDigest: "b".repeat(64) },
  });
  const calls: unknown[][] = [];
  const registry = {
    validationError: (...args: unknown[]) => { calls.push(args); return null; },
  } as unknown as ContainerTargetRegistry;
  assert.equal(executionTargetLaunchError({
    executionTarget: container, useWorktree: true, context: { kind: "native" }, agentId: "codex",
  }, "r1", isolation, registry), null);
  assert.equal(calls.length, 1);
  assert.match(executionTargetLaunchError({
    executionTarget: container, useWorktree: true, context: { kind: "native" }, agentId: "codex",
    acpSessionContext: { additionalDirectories: ["/host/secret"] },
  }, "r1", isolation, registry)!, /do not permit ACP/);
  assert.equal(calls.length, 1, "forbidden host context fails before adapter validation");
  assert.match(executionTargetLaunchError({
    executionTarget: container, useWorktree: true, context: { kind: "native" }, agentId: "codex",
  }, "r1", isolation)!, /unsupported container/);
});

test("routes cloud budget validation and rejects handoffs on non-cloud targets", () => {
  const cloud = target({
    id: "runner:r1:cloud:metered", kind: "cloud", adapter: "cloud", workspaceStrategy: "snapshot",
    boundaries: { filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" },
    environment: { id: "metered", revision: 1, image: `x@sha256:${"c".repeat(64)}`, setupCheckDigest: "d".repeat(64) },
    policy: {
      cost: { currency: "USD", estimatedHourlyRateUsd: 1, minimumBudgetUsd: 0.5, maximumBudgetUsd: 10 },
      admission: { maxConcurrentSessions: 1, queue: "fifo" },
    },
  });
  const calls: unknown[][] = [];
  const registry = { validationError: (...args: unknown[]) => { calls.push(args); return null; } } as unknown as CloudTargetRegistry;
  assert.equal(executionTargetLaunchError({
    executionTarget: cloud, executionHandoff: { artifacts: [] }, useWorktree: true,
    context: { kind: "native" }, agentId: "codex", config: { costBudgetUsd: 5 },
  }, "r1", isolation, undefined, registry), null);
  assert.deepEqual(calls[0]?.at(-1), { costBudgetUsd: 5 });
  assert.match(executionTargetLaunchError({
    executionTarget: target(), executionHandoff: { artifacts: [] }, useWorktree: true,
    context: { kind: "native" }, agentId: "codex",
  }, "r1", isolation)!, /only for a cloud/);
});
