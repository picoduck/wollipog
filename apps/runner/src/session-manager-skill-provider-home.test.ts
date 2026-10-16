import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

/** Counts references per HOME the way the lease registry does; release reports whether the last
 * reference went away. */
class CountingRegistry {
  readonly references = new Map<string, number>();
  readonly releases: string[] = [];
  /** Runs after the worker would have granted the reference, before the caller resumes. */
  afterGrant?: () => void;

  async acquireHome(home: string, _provider: string, cancellation: LeaseCancellation = {}): Promise<boolean> {
    if (cancellation.signal?.aborted || cancellation.isCurrent?.() === false) throw new Error(LEASE_WORKER_ERRORS.cancelled);
    const count = this.references.get(home) ?? 0;
    this.references.set(home, count + 1);
    this.afterGrant?.();
    return count === 0;
  }

  /** Worker-side handles not yet released or retained (the bounded pool's occupancy). */
  openHandles = 0;

  async acquireHomeReference(home: string, provider: string, cancellation: LeaseCancellation = {}) {
    const first = await this.acquireHome(home, provider, cancellation);
    this.openHandles++;
    let settled: Promise<boolean> | undefined;
    const settle = (release: boolean) => settled ??= (this.openHandles--, release ? this.releaseHome(home) : Promise.resolve(true));
    return { first, release: () => settle(true), retain: async () => { await settle(false); } };
  }

  async acquireReference(request: { env?: Record<string, string> }, cancellation: LeaseCancellation = {}) {
    const home = request.env?.HOME;
    return home ? this.acquireHomeReference(home, "claude", cancellation) : null;
  }

  /** A plain reference, kept until shutdown (the past-the-handle-budget fallback). */
  plainAcquires = 0;
  async acquire(request: { env?: Record<string, string> }, cancellation: LeaseCancellation = {}): Promise<void> {
    const home = request.env?.HOME;
    if (!home) return;
    this.plainAcquires++;
    await this.acquireHome(home, "claude", cancellation);
  }

  async releaseHome(home: string): Promise<boolean> {
    this.releases.push(home);
    const count = this.references.get(home) ?? 0;
    if (count <= 1) {
      this.references.delete(home);
      return count === 1;
    }
    this.references.set(home, count - 1);
    return false;
  }

  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-skill-provider-home-"));
  const store = new SessionStore(join(root, "sessions"));
  const home = join(root, "home");
  const meta: SessionMeta = {
    sessionId: "s1", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: { HOME: home }, context: { kind: "native" },
    agentSessionId: null, status: "idle", title: "Fixture", config: {}, tokensIn: 0,
    tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
  store.create(meta);
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => { throw new Error("fixture provider must not start"); }) as never);
  const registry = new CountingRegistry();
  const internals = manager as unknown as {
    providerHomeLeases: CountingRegistry;
    shuttingDown: boolean;
    driverProviderHomes: Map<unknown, unknown>;
  };
  internals.providerHomeLeases = registry;
  return {
    home, manager, registry, internals, meta,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a skill transaction releases exactly its own references and never a session's", async () => {
  const h = fixture();
  try {
    await h.registry.acquireHome(h.home, "claude"); // a running session's reference
    const scope = h.manager.skillProviderHomeScope();
    await scope.acquire(h.home);
    await scope.acquire(h.home);
    assert.equal(h.registry.references.get(h.home), 3);
    await scope.release();
    assert.equal(h.registry.references.get(h.home), 1, "the session keeps its reference");
    assert.deepEqual(h.registry.releases, [h.home, h.home]);
    await scope.release();
    assert.equal(h.registry.releases.length, 2, "release is idempotent");
    await assert.rejects(scope.acquire(h.home), /already released/);
  } finally { h.cleanup(); }
});

test("an idle runner's skill reconciliation leaves no provider-HOME reference behind", async () => {
  const h = fixture();
  try {
    const scope = h.manager.skillProviderHomeScope();
    await scope.acquire(h.home);
    await scope.release();
    assert.equal(h.registry.references.has(h.home), false);
  } finally { h.cleanup(); }
});

test("a skill acquisition cancelled after its grant drops the granted reference", async () => {
  const h = fixture();
  try {
    let current = true;
    h.registry.afterGrant = () => { current = false; };
    await assert.rejects(
      h.manager.acquireSkillReconciliationProviderHome(h.home, { isCurrent: () => current }),
      /provider-home acquisition was cancelled/,
    );
    assert.equal(h.registry.references.has(h.home), false);
    assert.deepEqual(h.registry.releases, [h.home]);
  } finally { h.cleanup(); }
});

test("a scope that never acquired does not release a reference it does not hold", async () => {
  const h = fixture();
  try {
    await h.registry.acquireHome(h.home, "claude");
    let current = true;
    h.registry.afterGrant = () => { current = false; };
    await assert.rejects(h.manager.acquireSkillReconciliationProviderHome(h.home, { isCurrent: () => current }));
    h.registry.afterGrant = undefined;
    const scope = h.manager.skillProviderHomeScope();
    await scope.release();
    assert.equal(h.registry.references.get(h.home), 1, "only the cancelled grant was dropped");
  } finally { h.cleanup(); }
});

type LaunchHome = {
  markUnprovable(): void;
  onProcess(proof: Promise<boolean>): void;
  settle(): Promise<void>;
};
const launchHome = (h: ReturnType<typeof fixture>) =>
  (h.manager as unknown as { launchPreparationProviderHome(): LaunchHome }).launchPreparationProviderHome();

test("launch preparation releases its reference only when everything that ran under it is proven gone", async () => {
  const h = fixture();
  try {
    await h.registry.acquireHome(h.home, "claude"); // a running session's reference
    const quiet = launchHome(h), proven = launchHome(h), unproven = launchHome(h), unprovable = launchHome(h);
    for (const handle of [quiet, proven, unproven, unprovable]) {
      assert.equal(await h.manager.acquireLaunchProviderHome(h.home, { providerHome: handle }), handle,
        "the reference joins the caller's handle");
    }
    assert.equal(h.registry.references.get(h.home), 5);
    assert.equal(h.registry.openHandles, 4, "each preparation holds a handle until it is settled");
    proven.onProcess(Promise.resolve(true));
    unproven.onProcess(Promise.resolve(true));
    unproven.onProcess(Promise.resolve(false));
    unprovable.onProcess(Promise.resolve(true));
    unprovable.markUnprovable();
    for (const handle of [quiet, proven, unproven, unprovable]) await handle.settle();
    assert.equal(h.registry.references.get(h.home), 3,
      "a preparation that started nothing or only proven trees releases; an unproven tree or an unprovable step keeps it");
    assert.deepEqual(h.registry.releases, [h.home, h.home], "never the session's reference");
    assert.equal(h.registry.openHandles, 0, "every handle is settled either way");
    await quiet.settle();
    assert.equal(h.registry.releases.length, 2, "settlement is idempotent");
  } finally { h.cleanup(); }
});

test("launch preparation without a handle to settle keeps its reference but frees its worker handle", async () => {
  const h = fixture();
  try {
    assert.equal(await h.manager.acquireLaunchProviderHome(h.home), null);
    const settled = launchHome(h);
    await settled.settle();
    assert.equal(await h.manager.acquireLaunchProviderHome(h.home, { providerHome: settled }), null,
      "a handle that already settled cannot adopt a later grant");
    assert.equal(h.registry.references.get(h.home), 2, "both are kept until shutdown");
    assert.equal(h.registry.releases.length, 0);
    assert.equal(h.registry.openHandles, 0, "no handle stays occupied, so repeated launches cannot exhaust the pool");
    const scope = h.manager.skillProviderHomeScope();
    await scope.acquire(h.home);
    await scope.retain();
    assert.equal(h.registry.references.get(h.home), 3, "an unfinished skill transaction keeps its reference");
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

test("launch preparation cancelled after its grant drops the reference before any write", async () => {
  const h = fixture();
  try {
    let current = true;
    h.registry.afterGrant = () => { current = false; };
    const handle = launchHome(h);
    await assert.rejects(h.manager.acquireLaunchProviderHome(h.home, { providerHome: handle, isCurrent: () => current }),
      /provider-home acquisition was cancelled/);
    await handle.settle();
    assert.equal(h.registry.references.has(h.home), false);
    assert.deepEqual(h.registry.releases, [h.home], "released exactly once");
  } finally { h.cleanup(); }
});

test("runner shutdown settles nothing for launch preparation; the global shutdown release owns it", async () => {
  const h = fixture();
  try {
    const handle = launchHome(h);
    await h.manager.acquireLaunchProviderHome(h.home, { providerHome: handle });
    h.internals.shuttingDown = true;
    await handle.settle();
    assert.equal(h.registry.references.get(h.home), 1);
    assert.equal(h.registry.releases.length, 0, "nothing is released per preparation during shutdown");
  } finally {
    h.internals.shuttingDown = false;
    h.cleanup();
  }
});

test("launch preparation handles never count against the driver handle budget", async () => {
  const h = fixture();
  try {
    for (let i = 0; i < 512; i++) h.internals.driverProviderHomes.set({}, {});
    const handle = launchHome(h);
    assert.equal(await h.manager.acquireLaunchProviderHome(h.home, { providerHome: handle }), handle);
    assert.equal(h.registry.plainAcquires, 0, "a transaction-scoped reference is a settleable handle");
    await handle.settle();
    assert.equal(h.registry.references.has(h.home), false);
    h.internals.driverProviderHomes.clear();
  } finally { h.cleanup(); }
});

/** The `index.ts` wiring of `prepareAgentTuiLaunch`, with every probe and file write stubbed. */
function tuiDependencies(
  h: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof prepareAgentTuiLaunch>[1]> = {},
): Parameters<typeof prepareAgentTuiLaunch>[1] {
  return {
    controlPlaneProtocolVersion: null,
    provision: () => {},
    acquireProviderHome: (meta) => h.manager.acquireAgentTuiProviderHome(meta),
    assertSessionNotDeleted: () => {},
    provisionManagedWorktreeGuard: (spec) => ({ protections: [], args: spec.args, guardActive: true }),
    prepareScratch: async () => h.home,
    permissionProfile: async () => ({ active: false, reason: "fixture" }),
    ...overrides,
  };
}

function codexMeta(h: ReturnType<typeof fixture>) {
  return { ...h.meta, driver: "codex-app-server" as const, command: "codex", agentId: "codex" };
}

test("each Agent TUI holds its own reference handle until it is settled", async () => {
  const h = fixture();
  try {
    const launches = [];
    for (let i = 0; i < 3; i++) launches.push(await prepareAgentTuiLaunch(h.meta, tuiDependencies(h)));
    assert.equal(h.registry.references.get(h.home), 3);
    assert.equal(h.registry.openHandles, 3, "a running TUI's reference is still settleable");
    for (const launch of launches) await launch?.providerHome?.settle(true);
    assert.equal(h.registry.references.has(h.home), false);
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

test("a Claude TUI whose process tree is proven gone releases its reference", async () => {
  const h = fixture();
  try {
    await h.registry.acquireHome(h.home, "claude"); // a running session's reference
    const launch = await prepareAgentTuiLaunch(h.meta, tuiDependencies(h));
    assert.ok(launch?.providerHome, "the launch carries its reference to the shell that runs it");
    assert.equal(h.registry.references.get(h.home), 2);
    await launch.providerHome.settle(true);
    assert.equal(h.registry.references.get(h.home), 1, "only the TUI's own reference is dropped");
    assert.deepEqual(h.registry.releases, [h.home]);
    await launch.providerHome.settle(true);
    assert.equal(h.registry.releases.length, 1, "settlement is idempotent");
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

test("an unproven or boundary-less (ConPTY, WSL) TUI keeps its reference until shutdown", async () => {
  const h = fixture();
  try {
    const launch = await prepareAgentTuiLaunch(h.meta, tuiDependencies(h));
    await launch?.providerHome?.settle(false);
    assert.equal(h.registry.references.get(h.home), 1, "the reference is retained");
    assert.equal(h.registry.releases.length, 0);
    assert.equal(h.registry.openHandles, 0, "only the worker handle is freed");
  } finally { h.cleanup(); }
});

test("a Codex TUI keeps its reference even when its own tree is proven gone", async () => {
  const h = fixture();
  try {
    const launch = await prepareAgentTuiLaunch(codexMeta(h), tuiDependencies(h));
    assert.ok(launch?.providerHome);
    await launch.providerHome.settle(true);
    assert.equal(h.registry.references.get(h.home), 1,
      "its permission-profile and hook-inventory probes ran outside any provable boundary");
    assert.equal(h.registry.releases.length, 0);
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

test("a TUI preparation that fails after the grant releases unless a probe already ran", async () => {
  const h = fixture();
  try {
    await assert.rejects(prepareAgentTuiLaunch(h.meta, tuiDependencies(h, {
      assertLaunchCurrent: () => { throw new Error("session launch changed"); },
    })), /session launch changed/);
    assert.equal(h.registry.references.has(h.home), false, "nothing was started, so the reference is dropped");
    assert.equal(h.registry.openHandles, 0);

    await assert.rejects(prepareAgentTuiLaunch(codexMeta(h), tuiDependencies(h, {
      provisionManagedWorktreeGuard: () => { throw new Error("hook inventory failed"); },
    })), /hook inventory failed/);
    assert.equal(h.registry.references.get(h.home), 1, "a Codex probe may have started, so it is kept");
    assert.equal(h.registry.openHandles, 0);

    // A Codex launch refused before any probe ran (its session was deleted meanwhile) releases.
    await assert.rejects(prepareAgentTuiLaunch(codexMeta(h), tuiDependencies(h, {
      assertSessionNotDeleted: () => { throw new Error("session is being deleted"); },
    })), /being deleted/);
    assert.equal(h.registry.references.get(h.home), 1, "only the probed launch's reference remains");
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

test("runner shutdown settles nothing for a TUI; the global shutdown release owns it", async () => {
  const h = fixture();
  try {
    const launch = await prepareAgentTuiLaunch(h.meta, tuiDependencies(h));
    h.internals.shuttingDown = true;
    await launch?.providerHome?.settle(true);
    assert.equal(h.registry.references.get(h.home), 1);
    assert.equal(h.registry.releases.length, 0, "nothing is released per TUI during shutdown");
  } finally {
    h.internals.shuttingDown = false;
    h.cleanup();
  }
});

test("Agent TUI handles share the driver handle budget and fall back to a plain reference past it", async () => {
  const h = fixture();
  try {
    for (let i = 0; i < 511; i++) h.internals.driverProviderHomes.set({}, {});
    const counted = await h.manager.acquireAgentTuiProviderHome(h.meta);
    assert.ok(counted, "the last handle below the budget");
    const fallback = await h.manager.acquireAgentTuiProviderHome(h.meta);
    assert.equal(fallback, null, "past the budget a TUI keeps a plain reference until shutdown");
    assert.equal(h.registry.plainAcquires, 1);
    assert.equal(h.registry.openHandles, 1, "no handle is taken past the budget");
    await counted.settle(true);
    assert.ok(await h.manager.acquireAgentTuiProviderHome(h.meta), "a settled TUI handle frees its budget slot");
    h.internals.driverProviderHomes.clear();
  } finally { h.cleanup(); }
});

test("an Agent TUI launch superseded after its grant drops the granted reference", async () => {
  const h = fixture();
  try {
    h.registry.afterGrant = () => { h.internals.shuttingDown = true; };
    await assert.rejects(h.manager.acquireAgentTuiProviderHome(h.meta), /Agent TUI launch changed/);
    assert.equal(h.registry.references.has(h.home), false);
  } finally {
    h.internals.shuttingDown = false;
    h.cleanup();
  }
});
