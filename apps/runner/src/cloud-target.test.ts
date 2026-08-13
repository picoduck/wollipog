import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { RunnerCloudTarget } from "./config.js";
import { CloudTargetRegistry, cloudTargetId, type CloudTargetDeps } from "./cloud-target.js";

const image = `registry.example/cloud/agent@sha256:${"a".repeat(64)}`;
const target: RunnerCloudTarget = {
  id: "metered-tools",
  name: "Metered tools",
  revision: 4,
  adapterCommand: "fixture-cloud",
  adapterArgs: ["--fixture"],
  adapterEnv: {},
  image,
  setupCheckDigest: "b".repeat(64),
  agentCommands: { codex: { command: "codex", args: ["app-server"] } },
  policy: {
    maxConcurrentSessions: 2,
    estimatedHourlyRateUsd: 1.25,
    minimumBudgetUsd: 0.5,
    maximumBudgetUsd: 20,
  },
};

function fixture(overrides: Partial<CloudTargetDeps> = {}) {
  const adapterCalls: string[][] = [];
  const adapterEnvironments: Array<Record<string, string>> = [];
  const deps: CloudTargetDeps = {
    resolveAdapter: async () => ({ path: "/fixture/cloud", via: "path", launch: { command: "/fixture/cloud", args: [] } }),
    resolveGit: async () => ({ path: "/usr/bin/git", via: "path", launch: { command: "/usr/bin/git", args: [] } }),
    runGit: async (_file, args) => {
      const operation = args.slice(args.indexOf("-C") + 2);
      if (operation[0] === "rev-parse" && operation[1] === "HEAD") return { code: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      if (operation[0] === "rev-parse" && operation[1] === "HEAD^{tree}") return { code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
      if (operation[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (operation[0] === "diff") return { code: 0, stdout: "diff --git a/x b/x\n", stderr: "" };
      if (operation[0] === "config") return { code: 0, stdout: "https://example.invalid/private/repo.git\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected git operation" };
    },
    runAdapter: async (_file, args, opts) => {
      adapterCalls.push(args);
      adapterEnvironments.push(opts.env);
      if (args.includes("inspect")) {
        return { code: 0, stderr: "", stdout: JSON.stringify({
          protocolVersion: 1,
          targetId: target.id,
          revision: target.revision,
          image,
          setupCheckDigest: target.setupCheckDigest,
          available: true,
        }) };
      }
      if (args.includes("cancel")) return { code: 0, stderr: "", stdout: "" };
      const encoded = args[args.indexOf("--manifest") + 1]!;
      const manifest = Buffer.from(encoded, "base64url").toString("utf8");
      return { code: 0, stderr: "", stdout: JSON.stringify({
        protocolVersion: 1,
        targetId: target.id,
        handoffId: "fixture-" + "handoff-1",
        manifestDigest: createHash("sha256").update(manifest).digest("hex"),
        quotedCostUsd: 1.75,
      }) };
    },
    now: () => 1_720_000_000_000,
    ...overrides,
  };
  return { deps, adapterCalls, adapterEnvironments };
}

test("cloud registry advertises exact environment, boundaries, policy, and deterministic handoff receipt", async () => {
  const { deps, adapterCalls } = fixture();
  const registry = new CloudTargetRegistry("runner / one", "host.example", [target], deps);
  await registry.initialize();
  const definition = registry.definitions()[0]!;
  assert.equal(definition.id, cloudTargetId("runner / one", target.id));
  assert.equal(definition.available, true);
  assert.deepEqual(definition.boundaries, {
    filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered",
  });
  assert.deepEqual(definition.policy, {
    cost: { currency: "USD", estimatedHourlyRateUsd: 1.25, minimumBudgetUsd: 0.5, maximumBudgetUsd: 20 },
    admission: { maxConcurrentSessions: 2, queue: "fifo" },
  });
  const ref = {
    id: definition.id, runnerId: definition.runnerId, kind: definition.kind,
    workspaceStrategy: definition.workspaceStrategy, adapter: definition.adapter,
    boundaries: definition.boundaries, environment: definition.environment, policy: definition.policy,
  };
  assert.equal(registry.validationError(ref, true, { kind: "native" }, "codex", { costBudgetUsd: 5 }), null);
  assert.match(registry.validationError(ref, true, { kind: "native" }, "codex", { costBudgetUsd: 50 })!, /cost budget/);

  const launch = await registry.prepareLaunch({
    target: ref,
    agentId: "codex",
    hostAgentCommand: "C:\\host\\codex.cmd",
    hostAgentArgs: ["--host-only"],
    sessionId: "session-1",
    sourceSessionId: "source-1",
    sourcePath: "C:\\worktrees\\source-1",
    artifacts: [{ artifactId: "art-1", kind: "patch", sizeBytes: 12, sha256: "e".repeat(64) }],
    budgetUsd: 5,
  });
  assert.equal(launch.adapterHandoffKey, "fixture-" + "handoff-1");
  assert.equal(launch.receipt.targetId, definition.id);
  assert.equal(launch.receipt.quotedCostUsd, 1.75);
  assert.equal(launch.receipt.git.headCommit, "c".repeat(40));
  assert.equal(launch.receipt.git.remoteUrlHash, createHash("sha256").update("https://example.invalid/private/repo.git").digest("hex"));
  assert.doesNotMatch(JSON.stringify(launch.receipt), /example\.invalid|worktrees|fixture-handoff-1/);
  const prepare = adapterCalls.find((args) => args.includes("prepare"))!;
  assert.equal(prepare[prepare.indexOf("--source") + 1], "C:\\worktrees\\source-1");
  assert.equal(prepare[prepare.indexOf("--idempotency-key") + 1], launch.receipt.manifestDigest);
  assert.deepEqual(launch.isolation.agentArgs, ["app-server"]);
  await registry.cancel(ref, launch.adapterHandoffKey);
  assert.equal(adapterCalls.filter((args) => args.includes("cancel")).length, 1);
});

test("cloud adapter boundary scrubs prefix-only current and legacy environment names", async () => {
  const oldCurrent = process.env.WOLLIPOG_PLAIN;
  const oldLegacy = process.env.MAM_PLAIN;
  process.env.WOLLIPOG_PLAIN = "current-daemon-value";
  process.env.MAM_PLAIN = "legacy-daemon-value";
  try {
    const { deps, adapterEnvironments } = fixture();
    const registry = new CloudTargetRegistry("runner", "host", [target], deps);
    await registry.initialize();
    assert.ok(adapterEnvironments.length > 0, "adapter inspection crossed the environment boundary");
    for (const env of adapterEnvironments) {
      assert.equal(env.WOLLIPOG_PLAIN, undefined);
      assert.equal(env.MAM_PLAIN, undefined);
    }
  } finally {
    if (oldCurrent === undefined) delete process.env.WOLLIPOG_PLAIN;
    else process.env.WOLLIPOG_PLAIN = oldCurrent;
    if (oldLegacy === undefined) delete process.env.MAM_PLAIN;
    else process.env.MAM_PLAIN = oldLegacy;
  }
});

test("cloud registry keeps missing or malformed adapters visible but unavailable", async () => {
  const missingFixture = fixture({ resolveAdapter: async () => null });
  const missing = new CloudTargetRegistry("runner", "host", [target], missingFixture.deps);
  await missing.initialize();
  assert.equal(missing.definitions()[0]!.available, false);
  assert.match(missing.definitions()[0]!.unavailableReason!, /not installed/);

  const malformedFixture = fixture({
    runAdapter: async () => ({ code: 0, stdout: JSON.stringify({ available: true }), stderr: "" }),
  });
  const malformed = new CloudTargetRegistry("runner", "host", [target], malformedFixture.deps);
  await malformed.initialize();
  assert.equal(malformed.definitions()[0]!.available, false);
  assert.match(malformed.definitions()[0]!.unavailableReason!, /did not match/);

  const missingReference = new CloudTargetRegistry(
    "runner",
    "host",
    [{ ...target, adapterEnv: { CLOUD_TOKEN: { fromEnv: `WOLLIPOG_MISSING_CLOUD_TOKEN_${process.pid}` } } }],
    fixture().deps,
  );
  await missingReference.initialize();
  assert.equal(missingReference.definitions()[0]!.available, false);
  assert.match(missingReference.definitions()[0]!.unavailableReason!, /environment 'CLOUD_TOKEN' is unavailable/);
});

test("cloud target names are bounded and an over-budget adapter quote fails closed", async () => {
  let cancelCalls = 0;
  const overBudgetFixture = fixture({
    runAdapter: async (_file, args) => {
      if (args.includes("inspect")) return { code: 0, stderr: "", stdout: JSON.stringify({
        protocolVersion: 1, targetId: target.id, revision: target.revision, image,
        setupCheckDigest: target.setupCheckDigest, available: true,
      }) };
      if (args.includes("cancel")) {
        cancelCalls++;
        return { code: 0, stderr: "", stdout: "" };
      }
      const manifest = Buffer.from(args[args.indexOf("--manifest") + 1]!, "base64url").toString("utf8");
      return { code: 0, stderr: "", stdout: JSON.stringify({
        protocolVersion: 1, targetId: target.id, handoffId: "fixture-handoff-2",
        manifestDigest: createHash("sha256").update(manifest).digest("hex"), quotedCostUsd: 6,
      }) };
    },
  });
  const registry = new CloudTargetRegistry(
    "runner",
    "h".repeat(150),
    [{ ...target, name: "n".repeat(150) }],
    overBudgetFixture.deps,
  );
  await registry.initialize();
  const definition = registry.definitions()[0]!;
  assert.equal(definition.name.length, 180);
  const ref = { ...definition };
  await assert.rejects(() => registry.prepareLaunch({
    target: ref, agentId: "codex", hostAgentCommand: "codex", hostAgentArgs: [], sessionId: "s",
    sourcePath: "C:\\source", artifacts: [], budgetUsd: 5,
  }), /rejected or malformed/);
  assert.equal(cancelCalls, 1, "an accepted adapter allocation is cancelled when its quote exceeds policy");
  await assert.rejects(() => registry.prepareLaunch({
    target: ref, agentId: "codex", hostAgentCommand: "codex", hostAgentArgs: [], sessionId: "s",
    sourcePath: "C:\\source",
    artifacts: [{ artifactId: "artifact", kind: "unknown" as never, sizeBytes: 1, sha256: "a".repeat(64) }],
    budgetUsd: 5,
  }), /invalid artifact provenance/);
});
