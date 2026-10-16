import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import type { ProviderAuthRecoveryController, ProviderProcessObserver } from "./provider-auth-recovery.js";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { SessionManager, type LaunchPreparationCancellation } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

/** Without a launch-preparation env the real registry leases homedir(); the fake uses one fixed HOME. */
const FIXTURE_HOME = "/fixture/provider-home";
const leaseHome = (request: { env?: Record<string, string> }) => request.env?.HOME ?? FIXTURE_HOME;

/** The account HOME launch preparation takes its own reference on (#3238). Kept apart from the
 * driver's HOME here so each reference can be told apart. */
const ACCOUNT_HOME = "/fixture/account-home";

/** Counts references per HOME like the lease registry; handles drop exactly their own reference. */
class CountingRegistry {
  readonly references = new Map<string, number>();
  /** Every handle operation in order: `reference:`, `release:` or `retain:` and the HOME. */
  readonly log: string[] = [];
  openHandles = 0;
  plainAcquires = 0;
  /** Holds a release of `home` until `open` resolves; `started` once one is waiting. */
  releaseGate?: { home: string; open: Promise<void>; started: boolean };

  private add(home: string): void {
    this.references.set(home, (this.references.get(home) ?? 0) + 1);
  }

  async acquire(request: { env?: Record<string, string> }): Promise<void> {
    this.plainAcquires++;
    this.add(leaseHome(request));
  }

  async acquireReference(request: { env?: Record<string, string> }, cancellation: LeaseCancellation = {}) {
    return this.acquireHomeReference(leaseHome(request), "provider", cancellation);
  }

  async acquireHomeReference(home: string, _provider: string, cancellation: LeaseCancellation = {}) {
    if (cancellation.isCurrent?.() === false) throw new Error("cancelled");
    this.add(home);
    this.log.push(`reference:${home}`);
    this.openHandles++;
    let settled: Promise<boolean> | undefined;
    const settle = (release: boolean) => settled ??= (async () => {
      const gate = this.releaseGate;
      if (release && gate?.home === home) {
        gate.started = true;
        await gate.open;
      }
      this.openHandles--;
      this.log.push(`${release ? "release" : "retain"}:${home}`);
      if (release) {
        const count = this.references.get(home) ?? 0;
        if (count <= 1) this.references.delete(home); else this.references.set(home, count - 1);
      }
      return true;
    })();
    return { first: true, release: () => settle(true), retain: async () => { await settle(false); } };
  }

  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
}

/** A stand-in for the `index.ts` preparation adapter and the provider's auth status command. */
interface PreparationControl {
  /** Tree proofs of the auth preflight's status commands. */
  statusProofs: boolean[];
  status?: "authenticated" | "unauthenticated";
  /** The adapter ran the Codex guard's hook inventory, which it marks unprovable. */
  codexGuard?: boolean;
  /** The session is stopped while its preparation runs, so the launch goes stale. */
  stopDuringPreparation?: boolean;
}

interface FakeDriverControl {
  /** What proveProcessTreeExit answers; undefined omits the method entirely. */
  proof?: boolean;
  /** Each proveProcessTreeExit call's `terminate` flag, per constructed instance. */
  proofCalls: boolean[][];
  exits: Array<(code: number | null) => void>;
  constructions: number;
  throwOnConstruct?: boolean;
}

function fixture(control: Partial<FakeDriverControl> = {}, preparation?: PreparationControl) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-provider-lease-"));
  const home = FIXTURE_HOME;
  const store = new SessionStore(join(root, "sessions"));
  const state: FakeDriverControl = { proofCalls: [], exits: [], constructions: 0, ...control };
  const factory = (_driver: unknown, _opts: unknown, callbacks: { onExit(code: number | null): void }) => {
    state.constructions++;
    if (state.throwOnConstruct) throw new Error("driver construction failed after starting");
    const calls: boolean[] = [];
    state.proofCalls.push(calls);
    state.exits.push((code) => callbacks.onExit(code));
    return {
      pid: 1,
      initialize: async () => {},
      newSession: async () => "provider-session",
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {},
      dispose: () => {},
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => "provider-session",
      ...(state.proof === undefined ? {} : {
        proveProcessTreeExit: async ({ terminate }: { terminate: boolean }) => {
          calls.push(terminate);
          return state.proof!;
        },
      }),
    };
  };
  const controller: ProviderAuthRecoveryController = {
    describe: () => ({ id: "scope", provider: "claude", canStartLogin: false, configuredCredential: false }),
    revalidate: async (_meta, observer?: ProviderProcessObserver) => {
      for (const proof of preparation?.statusProofs ?? []) observer?.onProcess(Promise.resolve(proof));
      return { status: preparation?.status ?? "authenticated" };
    },
    startLogin: async () => "failed",
    cancel: () => false,
  };
  let manager!: SessionManager;
  const prepareLaunch = async (meta: { sessionId: string }, cancellation?: LaunchPreparationCancellation) => {
    // What the adapter does for a native host launch with a credential home.
    await manager.acquireLaunchProviderHome(ACCOUNT_HOME, cancellation);
    if (preparation?.stopDuringPreparation) manager.stop(meta.sessionId);
    if (preparation?.codexGuard) cancellation?.providerHome?.markUnprovable();
  };
  const resolveLaunch = (_driver: unknown, _context: unknown, agentId: string | null | undefined) =>
    agentId === "claude" ? { command: "claude", args: [], env: { HOME: home } } : null;
  manager = preparation
    ? new SessionManager(() => {}, () => {}, store, "runner", resolveLaunch as never, factory as never, root,
      4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
      prepareLaunch as never, undefined, undefined, undefined, undefined, undefined, controller)
    : new SessionManager(() => {}, () => {}, store, "runner", resolveLaunch as never, factory as never, root);
  const registry = new CountingRegistry();
  const internals = manager as unknown as {
    providerHomeLeases: CountingRegistry;
    driverProviderHomes: Map<unknown, unknown>;
  };
  internals.providerHomeLeases = registry;
  const spec = (sessionId: string): SessionLaunchSpec => ({
    sessionId, agentId: "claude", workspaceId: "repo", workspacePath: root,
    command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
  });
  return {
    home, manager, registry, state, internals, spec,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("stopping a session whose provider proves its process tree gone releases the session's reference", async () => {
  const h = fixture({ proof: true });
  try {
    assert.equal(await h.manager.start(h.spec("s1")), true);
    assert.equal(h.registry.references.get(h.home), 1);
    assert.equal(h.registry.openHandles, 1, "the live session holds one handle");
    h.manager.stop("s1");
    await until(() => h.registry.openHandles === 0, "settlement");
    assert.equal(h.registry.references.has(h.home), false);
    assert.deepEqual(h.state.proofCalls, [[true]], "a disposed instance uses the killing proof, once");
  } finally { h.cleanup(); }
});

for (const [label, proof] of [["an unproven tree", false], ["a driver that cannot prove", undefined]] as const) {
  test(`stopping a session with ${label} keeps its reference until shutdown`, async () => {
    const h = fixture({ proof });
    try {
      assert.equal(await h.manager.start(h.spec("s1")), true);
      h.manager.stop("s1");
      await until(() => h.registry.openHandles === 0, "settlement");
      assert.equal(h.registry.references.get(h.home), 1, "the reference is retained");
    } finally { h.cleanup(); }
  });
}

test("a restart settles the replaced instance once and the replacement keeps its own reference", async () => {
  const h = fixture({ proof: true });
  try {
    assert.equal(await h.manager.start(h.spec("s1")), true);
    assert.equal(await h.manager.start(h.spec("s1")), true);
    await until(() => h.registry.openHandles === 1, "old instance settled");
    assert.equal(h.registry.references.get(h.home), 1, "only the replacement's reference remains");
    assert.deepEqual(h.state.proofCalls, [[true], []]);
  } finally { h.cleanup(); }
});

test("two sessions on one HOME each drop only their own reference", async () => {
  const h = fixture({ proof: true });
  try {
    assert.equal(await h.manager.start(h.spec("s1")), true);
    assert.equal(await h.manager.start(h.spec("s2")), true);
    assert.equal(h.registry.references.get(h.home), 2);
    h.manager.stop("s1");
    await until(() => h.registry.openHandles === 1, "first settlement");
    assert.equal(h.registry.references.get(h.home), 1, "the other session keeps the HOME");
  } finally { h.cleanup(); }
});

test("a driver construction that fails after it may have started keeps the launch reference", async () => {
  const h = fixture({ proof: true, throwOnConstruct: true });
  try {
    assert.equal(await h.manager.start(h.spec("s1")), false);
    assert.equal(h.state.constructions, 1);
    assert.equal(h.registry.references.get(h.home), 1);
    assert.equal(h.registry.openHandles, 0, "the handle is settled by retaining it");
  } finally { h.cleanup(); }
});

test("a provider that exits on its own is settled with the non-killing proof", async () => {
  const h = fixture({ proof: true });
  try {
    assert.equal(await h.manager.start(h.spec("s1")), true);
    h.state.exits[0]!(1);
    await until(() => h.registry.openHandles === 0, "settlement after exit");
    assert.deepEqual(h.state.proofCalls[0], [false], "exit never uses the killing proof");
    assert.equal(h.registry.references.has(h.home), false);
  } finally { h.cleanup(); }
});

test("launches past the session handle budget keep a plain reference until shutdown", async () => {
  const h = fixture({ proof: true });
  try {
    for (let i = 0; i < 512; i++) h.internals.driverProviderHomes.set({}, {});
    assert.equal(await h.manager.start(h.spec("s1")), true);
    assert.equal(h.registry.plainAcquires, 1);
    assert.equal(h.registry.openHandles, 0, "no handle is taken past the budget");
    h.internals.driverProviderHomes.clear();
  } finally { h.cleanup(); }
});

for (const [label, preparation, released] of [
  ["whose preflight status command is proven gone", { statusProofs: [true] }, true],
  ["whose preflight status command was not proven gone", { statusProofs: [false] }, false],
  ["whose preparation ran the Codex guard's hook inventory", { statusProofs: [true], codexGuard: true }, false],
] as const) {
  test(`a launch ${label} ${released ? "releases" : "keeps"} its preparation reference once the driver's reference holds the HOME`, async () => {
    const h = fixture({ proof: true }, { ...preparation, statusProofs: [...preparation.statusProofs] });
    try {
      assert.equal(await h.manager.start(h.spec("s1")), true);
      assert.equal(h.registry.references.has(ACCOUNT_HOME), !released);
      assert.equal(h.registry.references.get(h.home), 1, "the session keeps its own reference");
      const driverReference = h.registry.log.indexOf(`reference:${h.home}`);
      const settled = h.registry.log.indexOf(`${released ? "release" : "retain"}:${ACCOUNT_HOME}`);
      assert.ok(driverReference >= 0 && settled > driverReference,
        `the preparation settles only after the driver's reference is held: ${h.registry.log.join(", ")}`);
      assert.equal(h.registry.openHandles, 1, "only the live session's handle stays open");
    } finally { h.cleanup(); }
  });
}

test("a launch stopped while its preparation reference settles never constructs its provider", async () => {
  const h = fixture({ proof: true }, { statusProofs: [true] });
  let open!: () => void;
  h.registry.releaseGate = { home: ACCOUNT_HOME, open: new Promise<void>((resolve) => { open = resolve; }), started: false };
  try {
    const started = h.manager.start(h.spec("s1"));
    await until(() => h.registry.releaseGate!.started, "the preparation settlement to wait on the lease worker");
    assert.ok(h.registry.references.has(h.home), "the driver's reference is held while settlement waits");
    h.manager.stop("s1");
    open();
    assert.equal(await started, false);
    assert.equal(h.state.constructions, 0, "a stale launch constructs no driver after settlement");
    assert.equal(h.registry.references.has(h.home), false, "the unused driver reference is released");
    assert.equal(h.registry.references.has(ACCOUNT_HOME), false, "the preparation reference is released");
    assert.equal(h.registry.openHandles, 0);
  } finally { open(); h.cleanup(); }
});

test("a launch that goes stale during preparation releases the preparation reference", async () => {
  const h = fixture({ proof: true }, { statusProofs: [true], stopDuringPreparation: true });
  try {
    assert.equal(await h.manager.start(h.spec("s1")), false);
    assert.equal(h.state.constructions, 0);
    assert.ok(h.registry.log.includes(`reference:${ACCOUNT_HOME}`), "the preparation held a reference");
    assert.equal(h.registry.references.has(ACCOUNT_HOME), false, "nothing ran under it");
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

for (const [proof, released] of [[true, true], [false, false]] as const) {
  test(`a launch refused by its auth preflight ${released ? "releases" : "keeps"} the preparation reference for ${proof ? "a proven" : "an unproven"} status command`, async () => {
    const h = fixture({ proof: true }, { statusProofs: [proof], status: "unauthenticated" });
    try {
      assert.equal(await h.manager.start(h.spec("s1")), false);
      assert.equal(h.state.constructions, 0);
      assert.equal(h.registry.references.has(h.home), false, "no driver reference was taken");
      assert.ok(h.registry.log.includes(`reference:${ACCOUNT_HOME}`), "the preparation held a reference");
      assert.equal(h.registry.references.has(ACCOUNT_HOME), !released);
      assert.equal(h.registry.openHandles, 0, "the handle is settled either way");
    } finally { h.cleanup(); }
  });
}
