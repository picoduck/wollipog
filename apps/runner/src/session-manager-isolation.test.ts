import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverOptions } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { ProviderStateCleanupJournal } from "./provider-state-reconciliation.js";

function meta(): SessionMeta {
  return {
    sessionId: "s1", agentId: "claude", workspaceId: "repo", repoPath: "/repo", worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: null, status: "starting", title: "s1", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
}

function cloudTarget() {
  return {
    id: "runner:runner:cloud:metered", runnerId: "runner", kind: "cloud" as const,
    workspaceStrategy: "snapshot" as const, adapter: "cloud" as const,
    boundaries: { filesystem: "snapshot" as const, network: "policy" as const, secrets: "references" as const, billing: "target_metered" as const },
    environment: { id: "metered", revision: 1, image: `x@sha256:${"c".repeat(64)}`, setupCheckDigest: "d".repeat(64) },
    policy: {
      cost: { currency: "USD" as const, estimatedHourlyRateUsd: 1, minimumBudgetUsd: 0.5, maximumBudgetUsd: 10 },
      admission: { maxConcurrentSessions: 1, queue: "fifo" as const },
    },
  };
}

test("session launch passes one resolved isolation boundary to every driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-isolation-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    let captured: DriverOptions | undefined;
    const factory = (_driver: unknown, opts: DriverOptions) => {
      captured = opts;
      return {
        pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
      };
    };
    const isolation = { backend: "bwrap" as const, command: "/usr/bin/bwrap", args: [], network: "deny" as const };
    let state: unknown;
    const migrations: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async (_policy, _context, _deps, options) => {
        state = options;
        return isolation;
      },
      async () => {}, async () => {},
      async (_policy, _context, _driver, _dataDir, sessionId) => { migrations.push(sessionId); },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.deepEqual(captured?.isolation, isolation);
    assert.deepEqual(state, { driver: "claude-code", dataDir: join(root, ".runner-data"), env: {}, sessionId: "s1", cwd: "/repo" });
    assert.deepEqual(migrations, ["s1"]);
    assert.equal(store.readMeta("s1")?.providerStateVersion, 3);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native v2 provider state upgrades metadata without re-importing retained legacy bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-native-v2-"));
  try {
    const store = new SessionStore(root);
    store.create({ ...meta(), providerStateVersion: 2 });
    let migrated = false;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, undefined, undefined, undefined,
      async () => { migrated = true; },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).ensureProviderStateLayout(store.readMeta("s1"));
    assert.equal(migrated, false);
    assert.equal(store.readMeta("s1")?.providerStateVersion, 3);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict isolation resolution failure prevents driver construction", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-isolation-fail-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    let constructed = false;
    const messages: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message), () => {}, store, "runner", undefined,
      (() => { constructed = true; throw new Error("must not construct"); }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async () => { throw new Error("bwrap missing"); },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.equal(constructed, false);
    assert.match(JSON.stringify(messages), /execution isolation unavailable.*bwrap missing/);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("container sessions bypass host isolation and pass the checked container adapter to the driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-container-"));
  try {
    const store = new SessionStore(root);
    const target = {
      id: "runner:runner:container:tools", runnerId: "runner", kind: "container" as const,
      workspaceStrategy: "worktree" as const, adapter: "container" as const,
      boundaries: { filesystem: "container" as const, network: "deny" as const, secrets: "none" as const, billing: "none" as const },
      environment: { id: "tools", revision: 1, image: `x@sha256:${"a".repeat(64)}`, setupCheckDigest: "b".repeat(64) },
    };
    store.create({ ...meta(), worktreePath: "/repo-worktree", executionTarget: target });
    let captured: DriverOptions | undefined;
    const adapter = {
      backend: "container" as const, command: "docker", args: [], image: target.environment.image,
      network: "deny" as const, templateId: "tools", runnerKey: "runnerkey", containerName: "wollipog-s1", hostAgentCommand: "claude", hostAgentArgs: [],
      agentCommand: "claude", agentArgs: [],
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      ((_driver: unknown, opts: DriverOptions) => {
        captured = opts;
        return {
          pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
          prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
          setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
        };
      }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async () => { throw new Error("host isolation must not run"); },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.containerTargets = { isolation: () => adapter };
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.deepEqual(captured?.isolation, adapter);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud launch persists a content-safe receipt, keeps the reconnect key runner-local, and passes proxy isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(), worktreePath: "/repo-worktree", executionTarget: target,
      executionHandoffRequest: { artifacts: [] }, config: { costBudgetUsd: 5 },
    });
    const isolation = {
      backend: "cloud" as const, command: "cloud-proxy", args: [], env: { CLOUD_TOKEN: "secret" },
      targetId: "metered", handoffId: "private-handoff", sessionId: "s1",
      hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [],
    };
    const receipt = {
      targetId: target.id, manifestDigest: "e".repeat(64), adapterHandoffIdHash: "f".repeat(64),
      git: { headCommit: "1".repeat(40), headTree: "2".repeat(40), workingTreeDigest: "3".repeat(64), dirty: false, untrackedFiles: 0 },
      artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 1_720_000_000_000,
    };
    let captured: DriverOptions | undefined;
    const messages: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message), () => {}, store, "runner", undefined,
      ((_driver: unknown, opts: DriverOptions) => {
        captured = opts;
        return {
          pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
          prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
          setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
        };
      }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async () => { throw new Error("host isolation must not run"); },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = { prepareLaunch: async () => ({ isolation, receipt, adapterHandoffKey: "private-handoff" }) };
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.deepEqual(captured?.isolation, isolation);
    assert.deepEqual(store.readMeta("s1")?.executionHandoff, receipt);
    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, "private-handoff");
    const runtimeUpdate = messages.find((message) => (message as { type?: string }).type === "session_runtime_updated");
    assert.ok(runtimeUpdate);
    assert.equal(JSON.stringify(runtimeUpdate).includes("private-handoff"), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly prepared cloud allocation is cancelled when driver construction fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-launch-fail-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(), worktreePath: "/repo-worktree", executionTarget: target,
      executionHandoffRequest: { artifacts: [] }, config: { costBudgetUsd: 5 },
    });
    const receipt = {
      targetId: target.id, manifestDigest: "e".repeat(64), adapterHandoffIdHash: "f".repeat(64),
      git: { headCommit: "1".repeat(40), headTree: "2".repeat(40), workingTreeDigest: "3".repeat(64), dirty: false, untrackedFiles: 0 },
      artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 1_720_000_000_000,
    };
    const cancelled: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => { throw new Error("proxy executable is missing"); }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async () => { throw new Error("host isolation must not run"); },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      prepareLaunch: async () => ({
        isolation: { backend: "cloud", command: "cloud-proxy", args: [], env: {}, targetId: target.id, handoffId: "private-handoff", sessionId: "s1", hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [] },
        receipt,
        adapterHandoffKey: "private-handoff",
      }),
      cancel: async (_target: unknown, handoffKey: string) => { cancelled.push(handoffKey); },
    };
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.deepEqual(cancelled, ["private-handoff"]);
    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, undefined);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cloud allocation prepared after its session row is deleted is cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-delete-during-prepare-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(), worktreePath: "/repo-worktree", executionTarget: target,
      executionHandoffRequest: { artifacts: [] }, config: { costBudgetUsd: 5 },
    });
    const receipt = {
      targetId: target.id, manifestDigest: "e".repeat(64), adapterHandoffIdHash: "f".repeat(64),
      git: { headCommit: "1".repeat(40), headTree: "2".repeat(40), workingTreeDigest: "3".repeat(64), dirty: false, untrackedFiles: 0 },
      artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 1_720_000_000_000,
    };
    let releasePrepare!: () => void;
    let markPrepareStarted!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const prepareStarted = new Promise<void>((resolve) => { markPrepareStarted = resolve; });
    const cancelled: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => ({
        pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
      })) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      prepareLaunch: async () => {
        markPrepareStarted();
        await prepareGate;
        return {
          isolation: { backend: "cloud", command: "cloud-proxy", args: [], env: {}, targetId: target.id, handoffId: "private-handoff", sessionId: "s1", hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [] },
          receipt,
          adapterHandoffKey: "private-handoff",
        };
      },
      cancel: async (_target: unknown, handoffKey: string) => { cancelled.push(handoffKey); },
    };
    const launch = internals.launch(store.readMeta("s1"));
    await prepareStarted;
    store.remove("s1");
    releasePrepare();
    assert.equal(await launch, false);
    assert.deepEqual(cancelled, ["private-handoff"]);
    assert.equal(internals.active.has("s1"), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a superseded cloud launch does not cancel the replacement session's handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-supersede-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(), worktreePath: "/repo-worktree", executionTarget: target,
      executionHandoffRequest: { artifacts: [] }, config: { costBudgetUsd: 5 },
    });
    const receipt = {
      targetId: target.id, manifestDigest: "e".repeat(64), adapterHandoffIdHash: "f".repeat(64),
      git: { headCommit: "1".repeat(40), headTree: "2".repeat(40), workingTreeDigest: "3".repeat(64), dirty: false, untrackedFiles: 0 },
      artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 1_720_000_000_000,
    };
    let releaseInitialize!: () => void;
    let markInitializeStarted!: () => void;
    const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    const initializeStarted = new Promise<void>((resolve) => { markInitializeStarted = resolve; });
    const cancelled: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => ({
        pid: 1,
        initialize: async () => { markInitializeStarted(); await initializeGate; },
        newSession: async () => "provider-1", prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-1",
      })) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      prepareLaunch: async () => ({
        isolation: { backend: "cloud", command: "cloud-proxy", args: [], env: {}, targetId: target.id, handoffId: "private-handoff", sessionId: "s1", hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [] },
        receipt,
        adapterHandoffKey: "private-handoff",
      }),
      cancel: async (_target: unknown, handoffKey: string) => { cancelled.push(handoffKey); },
    };
    const launch = internals.launch(store.readMeta("s1"));
    await initializeStarted;
    const firstEntry = internals.active.get("s1");
    internals.active.set("s1", { ...firstEntry });
    releaseInitialize();
    assert.equal(await launch, false);
    assert.deepEqual(cancelled, []);
    assert.equal(store.has("s1"), true);
    internals.active.delete("s1");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale cloud generations preserve a shared winner key and reap a replaced key", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-generation-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(),
      worktreePath: "/repo-worktree",
      executionTarget: target,
      cloudAdapterHandoffKey: "shared-key",
    });
    const cancelled: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      cancel: async (_target: unknown, handoffKey: string) => { cancelled.push(handoffKey); },
    };
    internals.cloudHandoffOwners.set("s1", {
      targetId: target.id,
      handoffKey: "shared-key",
      launchGeneration: 2,
    });
    const sharedStale = { ...store.readMeta("s1"), cloudAdapterHandoffKey: "shared-key" };
    await internals.cancelNewCloudHandoff(sharedStale, false, "stale shared target", 1);
    assert.deepEqual(cancelled, []);
    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, "shared-key");

    store.patchMeta("s1", { cloudAdapterHandoffKey: "winner-key" });
    const replacedStale = { ...store.readMeta("s1"), cloudAdapterHandoffKey: "stale-key" };
    await internals.cancelNewCloudHandoff(replacedStale, false, "stale changed target", 1);
    assert.deepEqual(cancelled, ["stale-key"]);
    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, "winner-key");

    const winnerTarget = { ...target, id: `${target.id}:replacement` };
    store.patchMeta("s1", { executionTarget: winnerTarget, cloudAdapterHandoffKey: "reused-key" });
    internals.cloudHandoffOwners.set("s1", {
      targetId: winnerTarget.id,
      handoffKey: "reused-key",
      launchGeneration: 2,
    });
    const changedTargetSameKey = {
      ...store.readMeta("s1"),
      executionTarget: target,
      cloudAdapterHandoffKey: "reused-key",
    };
    await internals.cancelNewCloudHandoff(changedTargetSameKey, false, "changed target reused key", 1);
    assert.deepEqual(cancelled, ["stale-key", "reused-key"]);
    assert.equal(store.readMeta("s1")?.executionTarget?.id, winnerTarget.id);
    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, "reused-key");

    store.patchMeta("s1", { executionTarget: target, cloudAdapterHandoffKey: "cancelled-key" });
    internals.cloudHandoffOwners.set("s1", {
      targetId: target.id,
      handoffKey: "cancelled-key",
      launchGeneration: 3,
    });
    const cancelledSoleLaunch = { ...store.readMeta("s1") };
    await internals.cancelNewCloudHandoff(cancelledSoleLaunch, false, "sole launch cancelled", 3);
    assert.deepEqual(cancelled, ["stale-key", "reused-key", "cancelled-key"]);
    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, undefined);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale cloud prepare cannot publish over a winner that returned first", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-publish-fence-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(),
      worktreePath: "/repo-worktree",
      executionTarget: target,
      executionHandoffRequest: { artifacts: [] },
      config: { costBudgetUsd: 5 },
    });
    const cancelled: string[] = [];
    const preparedResolvers: Array<(value: any) => void> = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      prepareLaunch: async () => new Promise((resolve) => preparedResolvers.push(resolve)),
      cancel: async (_target: unknown, handoffKey: string) => { cancelled.push(handoffKey); },
    };
    const prepared = (key: string) => ({
      isolation: {
        backend: "cloud",
        command: "cloud-proxy",
        args: [],
        env: {},
        targetId: target.id,
        handoffId: key,
        sessionId: "s1",
        hostAgentCommand: "claude",
        hostAgentArgs: [],
        agentCommand: "claude",
        agentArgs: [],
      },
      receipt: {
        targetId: target.id,
        manifestDigest: "e".repeat(64),
        adapterHandoffIdHash: key === "winner-key" ? "f".repeat(64) : "a".repeat(64),
        git: {
          headCommit: "1".repeat(40),
          headTree: "2".repeat(40),
          workingTreeDigest: "3".repeat(64),
          dirty: false,
          untrackedFiles: 0,
        },
        artifacts: [],
        budgetUsd: 5,
        quotedCostUsd: 1,
        acceptedAt: 1_720_000_000_000,
      },
      adapterHandoffKey: key,
    });

    const staleMeta = { ...store.readMeta("s1") };
    const staleGeneration = internals.beginLaunchGeneration("s1");
    const stalePrepare = internals.prepareCloudIsolation(staleMeta, "/repo-worktree", staleGeneration);
    while (preparedResolvers.length < 1) await Promise.resolve();
    const winnerMeta = { ...store.readMeta("s1") };
    const winnerGeneration = internals.beginLaunchGeneration("s1");
    const winnerPrepare = internals.prepareCloudIsolation(winnerMeta, "/repo-worktree", winnerGeneration);
    while (preparedResolvers.length < 2) await Promise.resolve();

    preparedResolvers[1]!(prepared("winner-key"));
    await winnerPrepare;
    preparedResolvers[0]!(prepared("stale-key"));
    await assert.rejects(stalePrepare, /superseded/);

    assert.equal(store.readMeta("s1")?.cloudAdapterHandoffKey, "winner-key");
    assert.deepEqual(cancelled, ["stale-key"]);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete racing provider-state migration re-cleans the stale completed copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-isolation-delete-race-"));
  try {
    const store = new SessionStore(root);
    store.create({ ...meta(), worktreePath: "/repo-worktree" });
    let releaseMigration!: () => void;
    let markMigrationStarted!: () => void;
    const migrationGate = new Promise<void>((resolve) => { releaseMigration = resolve; });
    const migrationStarted = new Promise<void>((resolve) => { markMigrationStarted = resolve; });
    const removals: string[] = [];
    let migrationCalls = 0;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "inherit" },
      undefined,
      undefined,
      async (_policy, _context, _driver, _dataDir, sessionId) => { removals.push(sessionId); },
      async () => {
        migrationCalls++;
        markMigrationStarted();
        await migrationGate;
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const generation = internals.beginLaunchGeneration("s1");
    const firstMigration = internals.ensureProviderStateLayout(store.readMeta("s1"), generation);
    await migrationStarted;
    const replacementGeneration = internals.beginLaunchGeneration("s1");
    const secondMigration = internals.ensureProviderStateLayout(
      store.readMeta("s1"),
      replacementGeneration,
    );
    await Promise.resolve();
    assert.equal(migrationCalls, 1, "superseding launches share one in-flight migration");
    const deletion = manager.delete("s1");
    await Promise.resolve();
    assert.deepEqual(removals, [], "delete waits to clean until the migration settles");
    assert.deepEqual(new ProviderStateCleanupJournal(join(root, ".runner-data")).list(), [{
      sessionId: "s1",
      driver: "claude-code",
      context: { kind: "native" },
    }], "the durable cleanup intent remains while migration is gated");
    releaseMigration();
    await Promise.all([firstMigration, secondMigration, deletion]);
    assert.deepEqual(removals, ["s1"], "delete performs one final cleanup after migration");
    assert.equal(store.has("s1"), false);
    assert.equal(store.isDeleted("s1"), true);
    assert.deepEqual(new ProviderStateCleanupJournal(join(root, ".runner-data")).list(), []);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted cloud reconnect key is reused without preparing a second allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-reconnect-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({
      ...meta(), worktreePath: "/repo-worktree", executionTarget: target,
      cloudAdapterHandoffKey: "private-handoff",
      executionHandoff: {
        targetId: target.id, manifestDigest: "e".repeat(64), adapterHandoffIdHash: "f".repeat(64),
        git: { headCommit: "1".repeat(40), headTree: "2".repeat(40), workingTreeDigest: "3".repeat(64), dirty: false, untrackedFiles: 0 },
        artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 1_720_000_000_000,
      },
      config: { costBudgetUsd: 5 },
    });
    let prepares = 0;
    const isolation = { backend: "cloud" as const, command: "cloud-proxy", args: [], env: {}, targetId: target.id, handoffId: "private-handoff", sessionId: "s1", hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [] };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      isolation: () => isolation,
      prepareLaunch: async () => { prepares++; throw new Error("must not prepare twice"); },
    };
    assert.deepEqual(await internals.prepareCloudIsolation(store.readMeta("s1"), "/repo-worktree"), isolation);
    assert.equal(prepares, 0);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a stopped cloud session cancels its runner-local allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-cloud-delete-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    store.create({ ...meta(), status: "stopped", executionTarget: target, cloudAdapterHandoffKey: "private-handoff" });
    const cancelled: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).cloudTargets = {
      cancel: async (_target: unknown, handoffKey: string) => { cancelled.push(handoffKey); },
    };
    await manager.delete("s1");
    assert.deepEqual(cancelled, ["private-handoff"]);
    assert.equal(store.has("s1"), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy provider-state migration refuses to race another runner's session lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-isolation-lock-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    assert.equal(store.acquireLock("s1", "other-runner"), true);
    let migrated = false;
    let resolved = false;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => { throw new Error("must not construct"); }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async () => { resolved = true; return undefined; },
      async () => {}, async () => {}, async () => { migrated = true; },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.equal(migrated, false);
    assert.equal(resolved, false);
    assert.equal(store.readMeta("s1")?.providerStateVersion, undefined);
    assert.equal(store.ownsLock("s1", "other-runner"), true);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session deletion journals provider-state cleanup before dropping its only context row", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-isolation-cleanup-"));
  try {
    const store = new SessionStore(root);
    const value = { ...meta(), providerStateVersion: 2 as const };
    store.create(value);
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "inherit" }, undefined, undefined,
      async () => { throw new Error("WSL unavailable during delete"); },
    );
    await manager.delete("s1");
    assert.equal(store.has("s1"), false);
    assert.deepEqual(new ProviderStateCleanupJournal(join(root, ".runner-data")).list(), [{
      sessionId: "s1", driver: "claude-code", context: { kind: "native" },
    }]);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
