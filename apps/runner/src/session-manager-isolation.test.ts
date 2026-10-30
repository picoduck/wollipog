import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToControlPlane, SessionQueueHoldView } from "@wollipog/protocol";
import type {
  DriverBackgroundJob,
  DriverBackgroundTerminalJob,
  DriverBackgroundWorkEndResult,
  DriverCallbacks,
  DriverOptions,
} from "./drivers/driver.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { spawnAgent } from "./spawn.js";
import { ProviderStateCleanupJournal } from "./provider-state-reconciliation.js";
import { providerStateKey } from "./execution-isolation.js";
import { wslBwrapSessionRoot } from "./wsl-bwrap-launcher.js";
import { requestedWorktreeBoundary, setStatfsForTests } from "./worktree.js";

/** Cloud placements snapshot the session's real host worktree and launch re-proves that exact
 * coordinate before any adapter runs, so these fixtures materialize one instead of naming a path
 * that was never a worktree. */
function hostWorktree(root: string, sessionId: string): { repoPath: string; worktreePath: string } {
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  execFileSync("git", ["init", "-q", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "--allow-empty", "-m", "base"]);
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", `agent/${sessionId}`, worktreePath]);
  return { repoPath, worktreePath };
}

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
    setStatfsForTests(async () => { throw new Error("capacity preflight must not run for ordinary isolation"); });
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
    const dataDir = join(root, ".runner-data");
    let state: unknown;
    const migrations: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async (_policy, _context, _deps, options) => {
        state = options;
        return isolation;
      },
      async () => {}, async () => {},
      async (_policy, _context, _driver, _dataDir, sessionId) => { migrations.push(sessionId); },
    );
    manager.setReviewerInstallations(() => ({
      reviewerInstallationPaths: ["/reviewer-installation"], reviewerSymlinkPaths: ["/reviewer-link"],
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.deepEqual(captured?.isolation, isolation);
    assert.deepEqual(state, {
      driver: "claude-code",
      dataDir,
      env: {},
      sessionId: "s1",
      cwd: "/repo",
      additionalWritableRoots: [await requestedWorktreeBoundary("/repo", "s1", { dataDir }, false)],
      reviewerInstallationPaths: ["/reviewer-installation"],
      reviewerSymlinkPaths: ["/reviewer-link"],
    });
    assert.deepEqual(migrations, ["s1"]);
    assert.equal(store.readMeta("s1")?.providerStateVersion, 2);
    manager.shutdownAll();
  } finally {
    setStatfsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Linux managed worktree launch selects bwrap from provider mode and fails before driver construction without it", async () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "wollipog-managed-launch-isolation-"));
  const home = mkdtempSync(join(tmpdir(), "wollipog-managed-launch-home-"));
  let manager: SessionManager | undefined;
  try {
    const { repoPath, worktreePath } = hostWorktree(root, "s1");
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta(), repoPath, worktreePath, worktreeBranch: "agent/s1", env: { HOME: home },
      worktrees: [{ id: "legacy", path: worktreePath, branch: "agent/s1", source: "legacy" }],
    });
    let constructed = 0;
    let selectedMode: string | undefined;
    let migrationMode: string | undefined;
    let available = false;
    let spawnedIsolation: DriverOptions["isolation"] | undefined;
    let preservedProviderHome = false;
    const factory = (_driver: unknown, options: DriverOptions) => {
      constructed++;
      spawnedIsolation = options.isolation;
      return {
        pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
      };
    };
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, join(root, "state"), 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "provider", network: "inherit" }, async (policy, context, _deps, state) => {
        selectedMode = policy.mode;
        preservedProviderHome = state?.preserveProviderHome === true;
        return resolveExecutionIsolation(policy, context, {
          platform: "linux", uid: () => 1000, nativeEnvironment: () => ({ HOME: home }),
          resolveNative: async () => available ? {
            path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] },
          } : null,
        }, state);
      },
      async () => {}, async () => {}, async (policy) => { migrationMode = policy.mode; },
    );
    // The fixture is a disposable, registered Git worktree. Keep the launch test focused on the
    // isolation selection after the separate worktree identity proof.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.verifySelectedWorktreeBeforeLaunch = async () => true;
    assert.equal(await internals.resolveCleanupIsolation({ worktreePath }, store.readMeta("s1")), undefined,
      "frozen approved teardown retains configured provider-mode hook isolation");
    assert.equal(selectedMode, "provider", "trusted hooks must not inherit the provider-only forced bwrap policy");
    assert.equal(preservedProviderHome, false);
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.equal(selectedMode, "bwrap");
    assert.equal(migrationMode, undefined, "provider-mode history must remain in its existing provider directory");
    assert.equal(preservedProviderHome, true);
    assert.equal(constructed, 0);
    assert.equal(store.readMeta("s1")?.status, "failed");
    available = true;
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.equal(constructed, 1);
    assert.equal(spawnedIsolation?.backend, "bwrap");
    assert.equal(spawnedIsolation?.backend === "bwrap" && spawnedIsolation.preservesProviderHome, true);
    assert.ok(spawnedIsolation?.backend === "bwrap" && spawnedIsolation.writableBinds?.some((bind) =>
      bind.source === join(home, ".claude") && bind.target === bind.source));
    assert.equal(spawnedIsolation?.backend === "bwrap" && spawnedIsolation.writableBinds?.some((bind) =>
      bind.target === home), false, "the whole HOME is never made writable");
    assert.deepEqual(spawnedIsolation?.backend === "bwrap" ? spawnedIsolation.protectedWorktree?.path : undefined,
      worktreePath);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("strict Orchestrator scratch does not make its selected managed worktree writable", async () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "wollipog-orchestrator-selected-worktree-"));
  let manager: SessionManager | undefined;
  try {
    const { repoPath, worktreePath } = hostWorktree(root, "s1");
    const store = new SessionStore(join(root, "sessions"));
    const selected = {
      ...meta(), repoPath, worktreePath, worktreeBranch: "agent/s1",
      worktrees: [{ id: "legacy", path: worktreePath, branch: "agent/s1", source: "legacy" as const }],
      config: { permissionMode: "orchestrator" as const },
      orchestrator: { strictProjectIsolation: true },
    };
    store.create(selected);
    let observed: { mode: string; protectedWorktree: unknown } | undefined;
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, join(root, "state"), 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "inherit" }, async (policy, _context, _deps, state) => {
        observed = { mode: policy.mode, protectedWorktree: state?.protectedWorktree };
        return undefined;
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).resolveLaunchIsolation(store.readMeta("s1"), join(root, "scratch"));
    assert.deepEqual(observed, { mode: "bwrap", protectedWorktree: undefined });
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an adopted Pi transcript directory is writable inside the session isolation boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pi-adoption-isolation-"));
  let manager: SessionManager | undefined;
  try {
    const sessionDir = join(root, "sessions", "s1", "pi-adopted-sessions");
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta(),
      driver: "pi",
      agentId: "pi-native",
      command: "pi",
      args: ["--session-dir", sessionDir],
      adoptedProviderState: { driver: "pi", sessionDir },
    });
    let state: { additionalWritableRoots?: string[] } | undefined;
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => "pi-session",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "pi-session",
    });
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, join(root, "runner-data"), 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async (_policy, _context, _deps, options) => {
        state = options;
        return { backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "deny" };
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.ok(state?.additionalWritableRoots?.includes(sessionDir));
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt attach notices keep the live launch roots after HOME or its transcript symlink is retargeted", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-seatbelt-attach-roots-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    const dataDir = join(root, "runner-data");
    const nativeTmp = join(root, "native-tmp");
    const originalHome = join(root, "home-original");
    const retargetedHome = join(root, "home-retargeted");
    const originalTranscript = join(root, "transcript-original");
    const retargetedTranscript = join(root, "transcript-retargeted");
    const homeLink = join(root, "home-current");
    mkdirSync(repo);
    mkdirSync(dataDir);
    mkdirSync(nativeTmp);
    mkdirSync(join(originalHome, ".claude"), { recursive: true });
    mkdirSync(join(retargetedHome, ".claude", "projects", "attached"), { recursive: true });
    mkdirSync(join(originalTranscript, "attached"), { recursive: true });
    mkdirSync(join(retargetedTranscript, "attached"), { recursive: true });
    symlinkSync(originalTranscript, join(originalHome, ".claude", "projects"), "dir");
    symlinkSync(originalHome, homeLink, "dir");

    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta(), repoPath: repo, env: { HOME: homeLink } });
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
    });
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "seatbelt", network: "deny" },
      async (policy, context, _deps, state) => resolveExecutionIsolation(policy, context, {
        platform: "darwin",
        nativeHome: () => homeLink,
        nativeTmp: () => nativeTmp,
        resolveNative: async (name) => name === "sandbox-exec" ? {
          path: "/usr/bin/sandbox-exec", via: "path",
          launch: { command: "/usr/bin/sandbox-exec", args: [] },
        } : null,
      }, state),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    rmSync(homeLink);
    symlinkSync(retargetedHome, homeLink, "dir");
    const currentMeta = store.readMeta("s1");
    assert.deepEqual(
      await internals.worktreeIsolationNotice(currentMeta, join(retargetedHome, ".claude", "projects", "attached")),
      { writableNow: false, writableAtNextLaunch: true },
    );
    assert.deepEqual(
      await internals.worktreeIsolationNotice(currentMeta, join(originalTranscript, "attached")),
      { writableNow: true, writableAtNextLaunch: true },
    );

    rmSync(homeLink);
    symlinkSync(originalHome, homeLink, "dir");
    rmSync(join(originalHome, ".claude", "projects"));
    symlinkSync(retargetedTranscript, join(originalHome, ".claude", "projects"), "dir");
    assert.deepEqual(
      await internals.worktreeIsolationNotice(currentMeta, join(retargetedTranscript, "attached")),
      { writableNow: false, writableAtNextLaunch: true },
    );
    assert.deepEqual(
      await internals.worktreeIsolationNotice(currentMeta, join(originalTranscript, "attached")),
      { writableNow: true, writableAtNextLaunch: true },
    );
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt attach notices pin a symlinked additional root to its launch target", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-seatbelt-additional-root-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    const dataDir = join(root, "runner-data");
    const nativeTmp = join(root, "native-tmp");
    const originalAdditional = join(root, "additional-original");
    const retargetedAdditional = join(root, "additional-retargeted");
    const additionalLink = join(root, "additional-current");
    for (const path of [repo, dataDir, nativeTmp, originalAdditional, retargetedAdditional]) mkdirSync(path);
    symlinkSync(originalAdditional, additionalLink, "dir");

    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta(), repoPath: repo, driver: "acp" });
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
    });
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "seatbelt", network: "deny" },
      async (policy, context, _deps, state) => resolveExecutionIsolation(policy, context, {
        platform: "darwin",
        nativeHome: () => root,
        nativeTmp: () => nativeTmp,
        resolveNative: async (name) => name === "sandbox-exec" ? {
          path: "/usr/bin/sandbox-exec", via: "path",
          launch: { command: "/usr/bin/sandbox-exec", args: [] },
        } : null,
      }, state ? { ...state, additionalWritableRoots: [additionalLink] } : state),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    const liveRoots = internals.active.get("s1").seatbeltWritableRoots as string[];
    assert.ok(liveRoots.includes(originalAdditional), "the live snapshot pins the canonical launch target");
    assert.equal(liveRoots.includes(additionalLink), false, "the live snapshot does not retain the mutable alias");

    rmSync(additionalLink);
    symlinkSync(retargetedAdditional, additionalLink, "dir");
    const currentMeta = store.readMeta("s1");
    assert.deepEqual(
      await internals.worktreeIsolationNotice(currentMeta, join(additionalLink, "attached")),
      { writableNow: false, writableAtNextLaunch: true },
    );
    assert.deepEqual(
      await internals.worktreeIsolationNotice(currentMeta, join(originalAdditional, "attached")),
      { writableNow: true, writableAtNextLaunch: true },
    );
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native bwrap Orchestrator binds scratch without a writable project boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-orchestrator-bwrap-"));
  try {
    const store = new SessionStore(root);
    store.create({ ...meta(), config: { permissionMode: "orchestrator" } });
    let captured: DriverOptions | undefined;
    let isolationInput: unknown;
    const factory = (_driver: unknown, opts: DriverOptions) => {
      captured = opts;
      return {
        pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
      };
    };
    const isolation = { backend: "bwrap" as const, command: "/usr/bin/bwrap", args: [], network: "allow" as const };
    const dataDir = join(root, ".runner-data");
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "allow" }, async (_policy, _context, _deps, options) => {
        isolationInput = options;
        return isolation;
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    const scratch = join(store.sessionPath("s1"), "orchestrator-scratch");
    assert.equal(captured?.cwd, scratch);
    assert.deepEqual(captured?.isolation, isolation);
    assert.deepEqual(isolationInput, {
      driver: "claude-code", dataDir, env: { TMPDIR: scratch }, sessionId: "s1", cwd: scratch,
      orchestratorScratchOnly: true,
    });
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native v2 provider state preserves the rollback-compatible marker without re-importing retained legacy bytes", async () => {
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
    assert.equal(store.readMeta("s1")?.providerStateVersion, 2);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native v3 metadata from an interrupted build is restored to the rollback-compatible v2 marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-native-v3-"));
  try {
    const store = new SessionStore(root);
    store.create({ ...meta(), providerStateVersion: 3 });
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
    assert.equal(store.readMeta("s1")?.providerStateVersion, 2);
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
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
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

test("persisted native Claude Orchestrator refuses provider-only isolation before preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-orchestrator-provider-refusal-"));
  try {
    const store = new SessionStore(root);
    store.create({ ...meta(), config: { permissionMode: "orchestrator" } });
    let prepared = false;
    let constructed = false;
    const messages: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message), () => {}, store, "runner", undefined,
      (() => { constructed = true; throw new Error("must not construct"); }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "provider", network: "inherit" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).prepareLaunch = async () => { prepared = true; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.deepEqual({ prepared, constructed }, { prepared: false, constructed: false });
    assert.match(JSON.stringify(messages), /attested native filesystem boundary/);
    assert.equal(existsSync(join(store.sessionPath("s1"), "orchestrator-scratch")), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-mode Claude Orchestrator launches in its repository when strict isolation is disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-orchestrator-provider-"));
  try {
    const store = new SessionStore(root);
    store.create({
      ...meta(),
      config: { permissionMode: "orchestrator" },
      orchestrator: { strictProjectIsolation: false },
    });
    let captured: DriverOptions | undefined;
    let isolationInput: Record<string, unknown> | undefined;
    const factory = (_driver: unknown, opts: DriverOptions) => {
      captured = opts;
      return {
        pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
      };
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "provider", network: "inherit" }, async (_policy, _context, _deps, options) => {
        isolationInput = options as unknown as Record<string, unknown>;
        return undefined;
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.equal(captured?.cwd, store.readMeta("s1")!.repoPath);
    assert.deepEqual(captured?.orchestrator, { strictProjectIsolation: false });
    assert.equal(isolationInput?.orchestratorScratchOnly, undefined);
    assert.equal(existsSync(join(store.sessionPath("s1"), "orchestrator-scratch")), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WSL bwrap rejection precedes preparation, state migration, root resolution, and driver construction", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-wsl-isolation-fail-"));
  try {
    const store = new SessionStore(root);
    store.create({
      ...meta(),
      context: { kind: "wsl", distro: "Ubuntu" },
      repoPath: "/work/alias",
      providerStateVersion: undefined,
    });
    let prepared = 0;
    let migrated = 0;
    let resolved = 0;
    let constructed = 0;
    const messages: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message), () => {}, store, "runner", undefined,
      (() => { constructed++; throw new Error("must not construct"); }) as never,
      undefined, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" },
      async () => { resolved++; throw new Error("must not resolve paths"); },
      undefined, undefined,
      async () => { migrated++; },
    );
    // Test-only assignment proves the policy gate precedes launch discovery as well as filesystem
    // work. Production supplies this callback through the constructor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).prepareLaunch = async () => { prepared++; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.deepEqual({ prepared, migrated, resolved, constructed }, {
      prepared: 0, migrated: 0, resolved: 0, constructed: 0,
    });
    assert.match(JSON.stringify(messages), /cannot hold target-local no-follow path handles/);
    assert.equal(store.readMeta("s1")?.providerStateVersion, undefined);

    const forked = await manager.forkConversation("s1", "child", 1, "child");
    assert.equal(forked.ok, false);
    assert.match(forked.error ?? "", /cannot hold target-local no-follow path handles/);
    assert.equal(store.has("child"), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Orchestrator scratch is session-private and removed with native session state", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-orchestrator-scratch-"));
  try {
    const store = new SessionStore(root);
    const row = { ...meta(), config: { permissionMode: "orchestrator" as const } };
    store.create(row);
    const manager = new SessionManager(() => {}, () => {}, store, "runner");
    const scratch = await manager.prepareOrchestratorScratch(row);
    assert.equal(scratch, join(store.sessionPath("s1"), "orchestrator-scratch"));
    assert.equal(existsSync(scratch), true);
    writeFileSync(join(scratch, "plan.md"), "private planning state");
    store.remove("s1");
    assert.equal(existsSync(scratch), false);
    await assert.rejects(manager.prepareOrchestratorScratch(row), /session disappeared/);
    assert.equal(existsSync(store.sessionPath("s1")), false, "a delete/prepare race leaves no recreated scratch tree");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe Direct WSL uses one scratch cwd for isolation, driver construction, and session creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-wsl-authoritative-cwd-"));
  try {
    const store = new SessionStore(root);
    store.create({
      ...meta(),
      agentId: "codex-wsl",
      driver: "codex-app-server",
      command: "/usr/bin/codex",
      args: ["app-server"],
      context: { kind: "wsl", distro: "Ubuntu" },
      config: { permissionMode: "orchestrator" },
      repoPath: "/work/requested",
      providerStateVersion: 3,
    });
    let captured: DriverOptions | undefined;
    let newSessionCwd: string | undefined;
    let isolationInput: unknown;
    const ownerHash = "a".repeat(64);
    const scratch = `${wslBwrapSessionRoot(ownerHash, providerStateKey("s1"))}/scratch`;
    const safeIsolation = {
      backend: "wsl-bwrap" as const,
      distro: "Ubuntu",
      command: "/usr/local/lib/wollipog/wsl-bwrap-launcher-v1",
      args: [],
      cwd: scratch,
      network: "deny" as const,
      wslAgentControl: {
        protocolVersion: 1 as const,
        distro: "Ubuntu",
        nodeRuntime: "/usr/bin/node",
        helperPath: "/usr/local/lib/wollipog/wsl-agent-control-v1.mjs" as const,
        sessionId: "s1",
        token: "secret",
        tokenFile: "C:\\state\\s1.token",
        readyFile: "C:\\state\\s1.ready",
        cpUrl: "http://127.0.0.1:4317",
        safeLauncherProtocolVersion: 1 as const,
        bwrapRuntime: "/usr/bin/bwrap",
      },
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      ((_driver: unknown, opts: DriverOptions) => {
        captured = opts;
        return {
          pid: 1, initialize: async () => {},
          newSession: async (cwd: string) => { newSessionCwd = cwd; return "provider-1"; },
          prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
          setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
        };
      }) as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async (_policy, _context, _deps, options) => {
        isolationInput = options;
        return safeIsolation;
      },
    );
    // Production supplies this from the fresh discovery set. The seam proves that once the exact
    // launch is authorized, no pre-launch or provider path retains the untrusted requested alias.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).authorizeSafeWslLaunch = () => true;
    (manager as any).runnerOwnerHash = ownerHash;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.deepEqual(isolationInput, {
      driver: "codex-app-server", dataDir: join(root, ".runner-data"), env: { TMPDIR: scratch },
      sessionId: "s1", cwd: scratch, orchestratorScratchOnly: true, ownerHash,
    });
    assert.equal(captured?.cwd, scratch);
    assert.equal(newSessionCwd, scratch);
    assert.equal(internals.active.get("s1")?.cwd, scratch);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Direct WSL Orchestrator fails before provisioning when runner isolation is not bwrap", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-wsl-provider-refusal-"));
  try {
    const manager = new SessionManager(
      () => {}, () => {}, new SessionStore(root), "runner", undefined,
      (() => { throw new Error("must not construct provider"); }) as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "provider", network: "inherit" },
    );
    // Even a fresh exact discovery match cannot authorize an execution mode without the launcher.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).authorizeSafeWslLaunch = () => true;
    assert.throws(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).assertHostIsolationContextSupported({
        ...meta(), context: { kind: "wsl", distro: "Ubuntu" }, config: { permissionMode: "orchestrator" },
      });
    }, /target-local bwrap launcher/u);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new WSL bwrap session fails before its durable row or worktree is materialized", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-wsl-isolation-create-fail-"));
  try {
    const store = new SessionStore(root);
    let worktrees = 0;
    let constructed = 0;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => { constructed++; throw new Error("must not construct"); }) as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).createSessionWorktree = async () => {
      worktrees++;
      throw new Error("must not materialize a target-local worktree");
    };

    assert.equal(await manager.start({
      sessionId: "new-wsl", workspaceId: "repo", workspacePath: "/work/alias",
      agentId: "claude", command: "claude", args: [], env: {}, useWorktree: true,
      driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu" },
    }), false);
    assert.deepEqual({ worktrees, constructed }, { worktrees: 0, constructed: 0 });
    assert.equal(store.has("new-wsl"), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a WSL restart with a persisted container target cannot launch against another engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-container-"));
  try {
    const store = new SessionStore(root);
    const target = {
      id: "runner:runner:container:tools", runnerId: "runner", kind: "container" as const,
      workspaceStrategy: "worktree" as const, adapter: "container" as const,
      boundaries: { filesystem: "container" as const, network: "deny" as const, secrets: "none" as const, billing: "none" as const },
      environment: { id: "tools", revision: 1, image: `x@sha256:${"a".repeat(64)}`, setupCheckDigest: "b".repeat(64) },
    };
    store.create({
      ...meta(), context: { kind: "wsl", distro: "Ubuntu" },
      repoPath: "/repo-worktree", worktreePath: "/repo-worktree", executionTarget: target,
    });
    let captured: DriverOptions | undefined;
    const messages: unknown[] = [];
    const adapter = {
      backend: "container" as const, runtime: "docker" as const, command: "docker", args: [], image: target.environment.image,
      network: "deny" as const, templateId: "tools", runnerKey: "runnerkey", containerName: "wollipog-s1", hostAgentCommand: "claude", hostAgentArgs: [],
      agentCommand: "claude", agentArgs: [], verifyRuntimeIdentity: () => {},
    };
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
    internals.containerTargets = { isolation: () => adapter };
    assert.equal(await manager.start({
      sessionId: "s1", workspaceId: "repo", workspacePath: "/repo-worktree",
      agentId: "claude", command: "claude", args: [], env: {}, useWorktree: false,
      driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu" },
      // A restart may omit the immutable target; the durable row remains authoritative.
    }), true);
    assert.deepEqual(captured?.isolation, adapter);
    assert.throws(() => spawnAgent({
      command: "claude", args: [], cwd: "/repo-worktree",
      context: { kind: "wsl", distro: "Ubuntu" }, isolation: adapter,
    }), /native agent context/u);
    assert.equal(JSON.stringify(messages).includes("target-local no-follow"), false);
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
      ...meta(), ...hostWorktree(root, "s1"), executionTarget: target,
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
    assert.deepEqual(captured?.isolation, {
      ...isolation,
      sessionEnvironmentKeys: [
        "WOLLIPOG_WORKTREE_PATH",
        "WOLLIPOG_WORKTREE_BRANCH",
        "WOLLIPOG_WORKTREE_BASE_REF",
        "WOLLIPOG_PRIMARY_CHECKOUT",
        "WOLLIPOG_PORT_BLOCK_START",
        "WOLLIPOG_PORT_BLOCK_END",
        "WOLLIPOG_PORT_BLOCK_SIZE",
      ],
    });
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
      ...meta(), ...hostWorktree(root, "s1"), executionTarget: target,
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
      ...meta(), ...hostWorktree(root, "s1"), executionTarget: target,
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
      ...meta(), ...hostWorktree(root, "s1"), executionTarget: target,
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

test("startup teardown reconstructs cloud isolation from runner-private cleanup identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cleanup-cloud-reconnect-"));
  try {
    const store = new SessionStore(root);
    const target = cloudTarget();
    const isolation = {
      backend: "cloud" as const, command: "cloud-proxy", args: [], env: { CLOUD_TOKEN: "secret" },
      targetId: target.id, handoffId: "private-handoff", sessionId: "deleted-session",
      hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [],
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
    );
    let reconnectKey: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.cloudTargets = {
      isolation: (_target: unknown, _agent: string, _command: string, _args: string[],
        _sessionId: string, key: string) => {
        reconnectKey = key;
        return isolation;
      },
      prepareLaunch: async () => { throw new Error("cleanup must not allocate a new cloud handoff"); },
    };
    const receipt = {
      targetId: target.id, manifestDigest: "e".repeat(64), adapterHandoffIdHash: "f".repeat(64),
      git: { headCommit: "1".repeat(40), headTree: "2".repeat(40), workingTreeDigest: "3".repeat(64), dirty: false, untrackedFiles: 0 },
      artifacts: [], budgetUsd: 5, quotedCostUsd: 1, acceptedAt: 1_720_000_000_000,
    };
    assert.deepEqual(await internals.resolveCleanupIsolation({
      sessionId: "deleted-session",
      repoPath: "/repo",
      worktreePath: "/repo-worktree",
      context: { kind: "native" },
      execution: {
        agentId: "claude",
        driver: "claude-code",
        command: "claude",
        args: [],
        executionTarget: target,
        executionHandoff: receipt,
        cloudAdapterHandoffKey: "private-handoff",
      },
    }), isolation);
    assert.equal(reconnectKey, "private-handoff");
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

function guardProbeDriver(onConstruct: () => void) {
  return () => {
    onConstruct();
    return {
      pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
    };
  };
}

test("a native sandboxed launch hides the hook state directory and must prove its guard from inside (#1336)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-guard-mask-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    let constructed = 0;
    const isolation = { backend: "bwrap" as const, command: "/usr/bin/bwrap", args: [], network: "deny" as const };
    const states: Array<{ guardStateMask?: unknown }> = [];
    const messages: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message), () => {}, store, "runner", undefined,
      guardProbeDriver(() => { constructed++; }) as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" }, async (_policy, _context, _deps, options) => {
        states.push(options as { guardStateMask?: unknown });
        return isolation;
      },
      async () => {}, async () => {}, async () => {},
    );
    const mask = { directory: "/state/runner-hooks", readable: ["/state/runner-hooks/s1.settings.json"] };
    let verdict: { ok: true } | { ok: false; reason: string } | undefined = { ok: false, reason: "socket hidden" };
    const probed: unknown[] = [];
    manager.setGuardStateSandbox({
      mask: () => mask,
      verify: async (_meta, resolved) => { probed.push(resolved); return verdict; },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    // A guard that cannot reach the runner from inside this exact sandbox stops the launch before
    // any provider starts, with the reason on the session.
    assert.equal(await internals.launch(store.readMeta("s1")), false);
    assert.equal(constructed, 0);
    assert.deepEqual(probed, [isolation]);
    assert.equal(states[0]?.guardStateMask, mask);
    assert.match(JSON.stringify(messages), /cannot reach the runner from inside the sandbox \(socket hidden\)/u);

    verdict = { ok: true };
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.equal(constructed, 1);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idle Claude fork proves its guard before constructing the temporary provider (#1336)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-guard-fork-"));
  try {
    const { repoPath, worktreePath } = hostWorktree(root, "s1");
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta(),
      repoPath,
      worktreePath,
      worktrees: [{ id: "legacy", path: worktreePath, branch: "agent/s1", baseRef: "main", baseCommit: "main", source: "legacy" }],
      agentSessionId: "claude-source",
      status: "idle",
      turnCount: 1,
      capabilities: { supportsConversationFork: true } as never,
      forkPoints: { "1": { agentTurnId: "turn-1", tree: "0".repeat(40), baseCommit: "0".repeat(40), eventSeq: 1 } },
    });
    let constructed = 0;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, guardProbeDriver(() => { constructed++; }) as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" },
      async () => ({ backend: "bwrap" as const, command: "/usr/bin/bwrap", args: [], network: "deny" as const }),
      async () => {}, async () => {}, async () => {},
    );
    manager.setGuardStateSandbox({
      mask: () => ({ directory: "/state/runner-hooks", readable: [] }),
      verify: async () => ({ ok: false, reason: "socket hidden" }),
    });
    const forked = await manager.forkConversation("s1", "child", 1, "child");
    assert.equal(forked.ok, false);
    assert.match(forked.error ?? "", /cannot reach the runner from inside the sandbox \(socket hidden\)/u);
    assert.equal(constructed, 0, "no temporary provider starts behind a guard that was not proven");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider mode passes no hook state mask at all (#1336)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-guard-provider-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    const states: Array<{ guardStateMask?: unknown } | undefined> = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, guardProbeDriver(() => {}) as never,
      join(root, ".runner-data"), 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "provider", network: "inherit" }, async (_policy, _context, _deps, options) => {
        states.push(options as { guardStateMask?: unknown } | undefined);
        return undefined;
      },
    );
    manager.setGuardStateSandbox({
      mask: () => { throw new Error("provider mode must not ask for a mask"); },
      verify: async () => undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);
    assert.equal(states[0]?.guardStateMask, undefined);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a managed launch binds only this session's other worktrees (#3316)", async () => {
  if (process.platform !== "linux") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-managed-owned-worktrees-")));
  const home = mkdtempSync(join(tmpdir(), "wollipog-managed-owned-home-"));
  let manager: SessionManager | undefined;
  try {
    const { repoPath, worktreePath } = hostWorktree(root, "s1");
    const second = join(root, "second");
    const other = join(root, "other");
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", "stacked", second]);
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", "agent/s2", other]);
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta(), repoPath, worktreePath, worktreeBranch: "agent/s1", env: { HOME: home },
      worktrees: [
        { id: "legacy", path: worktreePath, branch: "agent/s1", source: "legacy" },
        { id: "stacked", path: second, branch: "stacked", source: "created" },
      ],
    });
    store.create({
      ...meta(), sessionId: "s2", title: "s2", repoPath, worktreePath: other, worktreeBranch: "agent/s2",
      worktrees: [{ id: "legacy", path: other, branch: "agent/s2", source: "legacy" }],
    });
    let observed: Parameters<typeof resolveExecutionIsolation>[3];
    let resolved: Awaited<ReturnType<typeof resolveExecutionIsolation>>;
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => "provider-1",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
    });
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, join(root, "state"), 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "provider", network: "inherit" }, async (policy, context, _deps, state) => {
        observed = state;
        resolved = await resolveExecutionIsolation(policy, context, {
          platform: "linux", uid: () => 1000, nativeEnvironment: () => ({ HOME: home }),
          resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] } }),
        }, state);
        return resolved;
      },
      async () => {}, async () => {}, async () => {},
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.verifySelectedWorktreeBeforeLaunch = async () => true;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.launch(store.readMeta("s1")), true);

    const common = realpathSync(join(repoPath, ".git"));
    const adminOf = (path: string) => realpathSync(join(common, "worktrees", readFileSync(join(path, ".git"), "utf8")
      .trim().split("/").at(-1)!));
    assert.equal(observed?.protectedWorktree?.gitWritableRoots.length, 4);
    assert.deepEqual(observed?.protectedWorktree?.ownedWorktrees, [{ path: second, gitAdmin: adminOf(second) }]);
    // The resolved boundary reports the same set, which is all a provider's inner sandbox may grant.
    assert.deepEqual(resolved?.backend === "bwrap" ? resolved.protectedWorktree?.ownedWorktrees : undefined,
      [{ path: second, gitAdmin: adminOf(second) }]);
    assert.ok(observed?.protectedWorktree?.requiredReadOnlyPaths.includes(join(adminOf(second), "config.worktree")));
    const mentioned = JSON.stringify(observed);
    assert.equal(mentioned.includes(other), false, "another session's worktree is never bound or named");
    assert.equal(mentioned.includes(adminOf(other)), false);

    // A rewritten link cannot claim another session's admin directory: its back-pointer disagrees.
    const foreignAdmin = adminOf(other);
    writeFileSync(join(second, ".git"), `gitdir: ${foreignAdmin}\n`);
    await internals.resolveLaunchIsolation(store.readMeta("s1"), worktreePath);
    assert.equal(observed?.protectedWorktree?.ownedWorktrees, undefined);
    // The foreign registration files may only gain read-only rules; nothing of it becomes writable.
    assert.equal(observed?.protectedWorktree?.gitWritableRoots.includes(foreignAdmin), false);
    assert.equal(JSON.stringify(observed?.additionalWritableRoots ?? []).includes(foreignAdmin), false);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/** A protected launch in a session's second worktree that also binds its first, legacy one. */
async function retiredWorktreeFixture(options: {
  handoffWaitMaxMs?: number;
  /** A provider that never reports a resumable conversation id. */
  noResume?: boolean;
  /** Awaited inside each provider turn, so a test can hold one open. */
  onPrompt?: (text: string) => Promise<void> | void;
  /** Work in the legacy worktree beside a runner-created sibling that a real discard can retire:
   * it sits in the requested-worktree boundary and its head is on the remote default branch. */
  createdSibling?: boolean;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-managed-retired-worktree-")));
  const home = mkdtempSync(join(tmpdir(), "wollipog-managed-retired-home-"));
  const { repoPath, worktreePath: first } = hostWorktree(root, "s1");
  const dataDir = join(root, "state");
  const second = options.createdSibling
    ? join(await requestedWorktreeBoundary(repoPath, "s1", { dataDir }, false), "slot")
    : join(root, "second");
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", "stacked", second]);
  if (options.createdSibling) {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["-C", repoPath, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", repoPath, "push", "-q", "origin", "HEAD:refs/heads/main"]);
    execFileSync("git", ["-C", repoPath, "fetch", "-q", "origin"]);
    execFileSync("git", ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }
  const [selected, sibling] = options.createdSibling ? [first, second] : [second, first];
  const store = new SessionStore(join(root, "sessions"));
  store.create({
    ...meta(), repoPath, worktreePath: selected, worktreeBranch: options.createdSibling ? "agent/s1" : "stacked",
    env: { HOME: home },
    worktrees: [
      { id: "legacy", path: first, branch: "agent/s1", source: "legacy" },
      { id: "stacked", path: second, branch: "stacked", source: "created" },
    ],
  });
  const observed: Array<Parameters<typeof resolveExecutionIsolation>[3]> = [];
  const sent: RunnerToControlPlane[] = [];
  const live = new Map<string, DriverBackgroundJob>();
  const drivers: Array<{ prompts: string[]; disposed: boolean; endCalls: number; cb: DriverCallbacks }> = [];
  const factory = (_driver: unknown, _launch: unknown, cb: DriverCallbacks) => {
    const driver = { prompts: [] as string[], disposed: false, endCalls: 0, cb };
    drivers.push(driver);
    return {
      pid: drivers.length, initialize: async () => {}, newSession: async () => "provider-1",
      prompt: async (text: string) => {
        driver.prompts.push(text);
        await options.onPrompt?.(text);
        return "end_turn" as const;
      },
      cancel: () => {}, dispose: () => { driver.disposed = true; },
      setConfig: () => {}, resolvePermission: () => false,
      agentSessionId: () => options.noResume ? null : "provider-1",
      ...(options.handoffWaitMaxMs ? {
        handoffWaitMaxMs: options.handoffWaitMaxMs,
        endBackgroundWork: async (): Promise<DriverBackgroundWorkEndResult> => {
          driver.endCalls += 1;
          const terminalAt = Date.now();
          const jobs: DriverBackgroundTerminalJob[] = [...live.values()].map((job) => ({
            ...job, status: "killed", terminalAt, continuationRequired: false, endedByRunner: true,
          }));
          live.clear();
          if (!jobs.length) return { status: "none" };
          cb.onBackgroundWork?.({ state: null, pendingTaskIds: [], terminalJobs: jobs });
          return { status: "ended", jobs };
        },
      } : {}),
    };
  };
  const manager = new SessionManager(
    (message) => { sent.push(message); }, () => {}, store, "runner", undefined, factory as never, dataDir, 1,
    undefined, undefined, { agentLimits: {}, agentWeights: {} },
    { mode: "provider", network: "inherit" }, async (policy, context, _deps, state) => {
      observed.push(state);
      return resolveExecutionIsolation(policy, context, {
        platform: "linux", uid: () => 1000, nativeEnvironment: () => ({ HOME: home }),
        resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] } }),
      }, state);
    },
    async () => {}, async () => {}, async () => {},
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  internals.verifySelectedWorktreeBeforeLaunch = async () => true;
  assert.equal(await internals.acquireAdmission("s1"), true);
  assert.equal(await internals.launch(store.readMeta("s1")), true);
  assert.deepEqual(observed.at(-1)?.protectedWorktree?.ownedWorktrees?.map((owned) => owned.path), [sibling]);
  assert.deepEqual(internals.active.get("s1").boundOwnedWorktrees, [sibling]);
  return {
    manager, store, internals, observed, sent, live, drivers, first, second, selected, sibling,
    /** `discard_worktree` on the bound sibling, without the forge lookup a fixture cannot answer. */
    discard: (): Promise<{ removed: boolean; retirement?: { status: string; reason?: string } }> =>
      internals.runWorktreeOperation("s1", () =>
        internals.discardWorktreeLocked("s1", sibling, { refreshMergedHead: false })),
    /** The deferred retirement completes while the provider lives: the tree is removed and its row
     * forgotten through the same step a completed cleanup takes. */
    retire: async () => {
      execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", first]);
      assert.ok(await internals.forgetRemovedWorktree({
        sessionId: "s1", worktreeId: "legacy", repoPath, worktreePath: first, context: { kind: "native" },
        branch: "agent/s1", source: "legacy", worktreeRemovedAt: Date.now(),
      }));
    },
    /** The worktree vanishes without its row being forgotten. */
    remove: () => execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", first]),
    /** Let every drain the retirement scheduled run to completion. */
    settle: () => new Promise((done) => setTimeout(done, 100)),
    errors: () => store.readEvents("s1").filter((event) => event.payload.kind === "error")
      .map((event) => (event.payload as { message: string }).message),
    waitFor: async (predicate: () => boolean, message: string) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail(message);
        await new Promise((done) => setTimeout(done, 10));
      }
    },
    /** The relaunch resumes in the selected worktree, with no bind for the retired one. */
    assertRelaunched: () => {
      const relaunched = observed.at(-1);
      assert.equal(relaunched?.cwd, selected, "the relaunch resumes in the selected worktree");
      assert.equal(relaunched?.protectedWorktree?.ownedWorktrees, undefined);
      assert.equal(JSON.stringify(relaunched?.protectedWorktree ?? {}).includes(sibling), false,
        "the retired worktree is in no bind list");
      assert.equal(internals.active.get("s1").boundOwnedWorktrees, undefined);
    },
    cleanup: () => {
      manager.shutdownAll();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a session whose first worktree is retired while it works in a second relaunches there (#3402)", async () => {
  if (process.platform !== "linux") return;
  const f = await retiredWorktreeFixture();
  try {
    await f.retire();
    // The completed retirement itself hands the live provider to a rebind, before any prompt.
    await f.waitFor(() => f.drivers.length === 2 && f.internals.active.get("s1")?.client?.pid === 2,
      "the provider was not relaunched after its bound worktree was retired");
    assert.ok(f.drivers[0]!.disposed);
    f.assertRelaunched();

    f.manager.prompt("s1", "continue");
    await f.waitFor(() => f.drivers[1]!.prompts.length === 1, "the next turn did not run");
    assert.deepEqual(f.drivers[0]!.prompts, [], "the stale process never ran a turn");
    assert.equal(f.drivers.length, 2);
  } finally {
    f.cleanup();
  }
});

test("a bound worktree that vanishes without being forgotten is rebound before the next turn (#3402)", async () => {
  if (process.platform !== "linux") return;
  const f = await retiredWorktreeFixture();
  try {
    f.remove();
    f.manager.prompt("s1", "continue");
    await f.waitFor(() => f.drivers[1]?.prompts.length === 1, "the next turn did not run in a relaunched provider");
    assert.deepEqual(f.drivers[0]!.prompts, []);
    // Its row remains, but a launch binds only owned worktrees that still exist.
    f.assertRelaunched();
  } finally {
    f.cleanup();
  }
});

test("a retirement during a runner turn waits for the turn, then rebinds before the next one (#3402)", async () => {
  if (process.platform !== "linux") return;
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const f = await retiredWorktreeFixture({ onPrompt: (text) => text === "long turn" ? held : undefined });
  try {
    f.manager.prompt("s1", "long turn");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 1, "the first turn did not start");
    await f.retire();
    f.manager.prompt("s1", "next turn");
    await f.settle();
    assert.equal(f.drivers.length, 1, "nothing is relaunched while the runner turn runs");
    assert.equal(f.drivers[0]!.disposed, false);

    release();
    await f.waitFor(() => f.drivers[1]?.prompts.length === 1, "the next turn did not run in a relaunched provider");
    assert.deepEqual(f.drivers[0]!.prompts, ["long turn"]);
    assert.deepEqual(f.drivers[1]!.prompts, ["next turn"]);
    f.assertRelaunched();
  } finally {
    release();
    f.cleanup();
  }
});

for (const ask of [false, true]) {
  test(`a retirement during a provider-initiated turn${ask ? " with a provider-owned ask" : ""} waits for it to settle (#3402)`, async () => {
    if (process.platform !== "linux") return;
    const f = await retiredWorktreeFixture();
    try {
      f.drivers[0]!.cb.onProviderInitiatedTurn?.("started", "provider-turn-1");
      if (ask) {
        f.drivers[0]!.cb.onEvent({
          kind: "permission_request", requestId: "provider-ask", title: "Run Command",
          options: [{ optionId: "allow", name: "Allow Once", kind: "allow_once" }],
        });
        assert.ok(f.store.readMeta("s1")?.pendingApproval);
      }
      await f.retire();
      await f.settle();
      f.manager.prompt("s1", "continue");
      await f.settle();
      assert.equal(f.drivers.length, 1, "the provider-initiated turn is never retired mid-turn");
      assert.equal(f.drivers[0]!.disposed, false);

      // It settles normally: no interruption and no further background update.
      f.drivers[0]!.cb.onProviderInitiatedTurn?.("settled", "provider-turn-1");
      await f.waitFor(() => f.drivers[1]?.prompts.length === 1, "the queued prompt was stranded");
      assert.deepEqual(f.drivers[0]!.prompts, []);
      assert.ok(f.drivers[0]!.disposed);
      f.assertRelaunched();
    } finally {
      f.cleanup();
    }
  });
}

test("background work holding a retirement rebind is bounded like any worktree handoff (#3402)", async () => {
  if (process.platform !== "linux") return;
  const bound = 300;
  const f = await retiredWorktreeFixture({ handoffWaitMaxMs: bound });
  try {
    const startedAt = Date.now();
    f.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt });
    f.drivers[0]!.cb.onBackgroundWork?.({
      state: "running", pendingTaskIds: ["monitor-1"],
      jobs: [{ id: "monitor-1", launchType: "monitor", startedAt }], observedTaskIds: ["monitor-1"],
    });
    assert.equal(f.store.readMeta("s1")?.backgroundWorkState, "running");
    await f.retire();
    f.manager.prompt("s1", "continue");
    const holds = () => f.sent.filter((message) => message.type === "session_runtime_updated")
      .map((message) => (message as { snapshot: { queueHold?: SessionQueueHoldView | null } }).snapshot.queueHold);
    await f.waitFor(() => holds().some((hold) => hold?.kind === "worktree_rebind" && hold.endsAt !== undefined),
      "the waiting prompt got no bounded handoff hold");
    const hold = holds().find((candidate) => candidate?.kind === "worktree_rebind")!;
    assert.equal(hold.endsAt, hold.since + bound);
    assert.equal(hold.target, f.second);
    assert.equal(f.drivers.length, 1, "the rebind waits for the background work");

    await f.waitFor(() => f.drivers[1]?.prompts.length === 1, "the bound did not release the queued prompt");
    assert.equal(f.drivers[0]!.endCalls, 1, "the work is ended once, at the bound");
    assert.deepEqual(f.drivers[0]!.prompts, []);
    assert.equal(f.store.readMeta("s1")?.backgroundJobs?.find((job) => job.id === "monitor-1")?.terminalStatus, "killed");
    f.assertRelaunched();
  } finally {
    f.cleanup();
  }
});

test("a retirement rebind that cannot resume fails once and the live provider keeps serving (#3402)", async () => {
  if (process.platform !== "linux") return;
  const f = await retiredWorktreeFixture({ noResume: true });
  try {
    // A conversation exists but the provider never reported an id it could resume.
    f.manager.prompt("s1", "first");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 1 && f.store.readMeta("s1")?.status === "idle",
      "the first turn did not finish");
    await f.retire();
    await f.settle();
    f.manager.prompt("s1", "second");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 2, "the queued prompt never ran");
    f.manager.prompt("s1", "third");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 3, "a later prompt never ran");
    await f.settle();
    assert.equal(f.drivers.length, 1, "an impossible rebind is not attempted");
    const failures = f.errors().filter((message) => message.includes("cannot resume"));
    assert.equal(failures.length, 1, "the failure is reported exactly once");
    assert.match(failures[0]!, /restart the session/);
    assert.equal(f.internals.active.get("s1").pendingWorktreeRebind, undefined);
  } finally {
    f.cleanup();
  }
});

test("a retirement rebind blocked by another runner's lock fails once (#3402)", async () => {
  if (process.platform !== "linux") return;
  const f = await retiredWorktreeFixture();
  try {
    assert.equal(f.store.acquireLock("s1", "another-runner"), true);
    await f.retire();
    await f.settle();
    const lockErrors = () => f.errors().filter((message) => message.includes("driven by another dashboard"));
    assert.equal(lockErrors().length, 1);
    f.store.releaseLock("s1", "another-runner");

    f.manager.prompt("s1", "continue");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 1, "the prompt did not run on the live provider");
    await f.settle();
    assert.equal(f.drivers.length, 1, "the failed rebind is not requested again");
    assert.equal(lockErrors().length, 1, "the failure is reported exactly once");
  } finally {
    f.cleanup();
  }
});

for (const ask of [false, true]) {
  test(`a selection rebind during a provider-initiated turn${ask ? " with a provider-owned ask" : ""} waits for it to settle (#3424)`, async () => {
    if (process.platform !== "linux") return;
    const f = await retiredWorktreeFixture();
    try {
      f.drivers[0]!.cb.onProviderInitiatedTurn?.("started", "provider-turn-1");
      if (ask) {
        f.drivers[0]!.cb.onEvent({
          kind: "permission_request", requestId: "provider-ask", title: "Run Command",
          options: [{ optionId: "allow", name: "Allow Once", kind: "allow_once" }],
        });
        assert.ok(f.store.readMeta("s1")?.pendingApproval);
      }
      const requested = await f.manager.requestWorktree("s1", { baseRef: "HEAD", branch: "fix/next" });
      await f.settle();
      f.manager.prompt("s1", "continue");
      await f.settle();
      assert.equal(f.drivers.length, 1, "the provider-initiated turn is never retired mid-turn");
      assert.equal(f.drivers[0]!.disposed, false);

      // It settles normally: no interruption and no further background update.
      f.drivers[0]!.cb.onProviderInitiatedTurn?.("settled", "provider-turn-1");
      await f.waitFor(() => f.drivers[1]?.prompts.length === 1, "the queued prompt was stranded");
      assert.ok(f.drivers[0]!.disposed);
      assert.deepEqual(f.drivers[0]!.prompts, []);
      assert.equal(f.observed.at(-1)?.cwd, requested.worktree.path, "the prompt runs in the selected worktree");
    } finally {
      f.cleanup();
    }
  });
}

test("a selection rebind during a runner turn still waits for the turn, then rebinds (#3424)", async () => {
  if (process.platform !== "linux") return;
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const f = await retiredWorktreeFixture({ onPrompt: (text) => text === "long turn" ? held : undefined });
  try {
    f.manager.prompt("s1", "long turn");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 1, "the first turn did not start");
    const requested = await f.manager.requestWorktree("s1", { baseRef: "HEAD", branch: "fix/next" });
    f.manager.prompt("s1", "next turn");
    await f.settle();
    assert.equal(f.drivers.length, 1, "nothing is rebound while the runner turn runs");

    release();
    await f.waitFor(() => f.drivers[1]?.prompts.length === 1, "the next turn did not run in the selected worktree");
    assert.deepEqual(f.drivers[1]!.prompts, ["next turn"]);
    assert.equal(f.observed.at(-1)?.cwd, requested.worktree.path);
  } finally {
    release();
    f.cleanup();
  }
});

test("discarding a bound sibling during a runner turn defers until the turn ends (#3424)", async () => {
  if (process.platform !== "linux") return;
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const f = await retiredWorktreeFixture({
    createdSibling: true, onPrompt: (text) => text === "long turn" ? held : undefined,
  });
  try {
    f.manager.prompt("s1", "long turn");
    await f.waitFor(() => f.drivers[0]!.prompts.length === 1, "the first turn did not start");
    const result = await f.discard();
    assert.deepEqual(result.retirement, { status: "deferred", reason: "provider_active" });
    await f.settle();
    assert.ok(existsSync(join(f.sibling, ".git")), "the bound sibling stays while the turn runs");
    assert.equal(f.drivers.length, 1);

    // The turn ends; the retirement completes with no second discard, then the provider rebinds.
    release();
    await f.waitFor(() => !existsSync(f.sibling), "the deferred retirement did not complete after the turn");
    await f.waitFor(() => f.internals.active.get("s1")?.client?.pid === 2, "the provider was not rebound");
    f.assertRelaunched();
    f.manager.prompt("s1", "next turn");
    await f.waitFor(() => f.drivers[1]!.prompts.length === 1, "the next turn did not run");
  } finally {
    release();
    f.cleanup();
  }
});

test("discarding a bound sibling during a provider-initiated turn defers until it settles (#3424)", async () => {
  if (process.platform !== "linux") return;
  const f = await retiredWorktreeFixture({ createdSibling: true });
  try {
    f.drivers[0]!.cb.onProviderInitiatedTurn?.("started", "provider-turn-1");
    const result = await f.discard();
    assert.deepEqual(result.retirement, { status: "deferred", reason: "provider_active" });
    await f.settle();
    assert.ok(existsSync(join(f.sibling, ".git")), "the bound sibling stays while the turn runs");
    assert.equal(f.drivers[0]!.disposed, false);

    f.drivers[0]!.cb.onProviderInitiatedTurn?.("settled", "provider-turn-1");
    await f.waitFor(() => !existsSync(f.sibling), "the deferred retirement did not complete after settlement");
    await f.waitFor(() => f.internals.active.get("s1")?.client?.pid === 2, "the provider was not rebound");
    f.assertRelaunched();
  } finally {
    f.cleanup();
  }
});

test("discarding a bound sibling while the provider is idle removes it at once and rebinds (#3424)", async () => {
  if (process.platform !== "linux") return;
  const f = await retiredWorktreeFixture({ createdSibling: true });
  try {
    const result = await f.discard();
    assert.equal(result.removed, true);
    assert.equal(existsSync(f.sibling), false);
    await f.waitFor(() => f.internals.active.get("s1")?.client?.pid === 2, "the provider was not rebound");
    f.assertRelaunched();
  } finally {
    f.cleanup();
  }
});
