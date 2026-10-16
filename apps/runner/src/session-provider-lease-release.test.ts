import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

/** Without a launch-preparation env the real registry leases homedir(); the fake uses one fixed HOME. */
const FIXTURE_HOME = "/fixture/provider-home";
const leaseHome = (request: { env?: Record<string, string> }) => request.env?.HOME ?? FIXTURE_HOME;

/** Counts references per HOME like the lease registry; handles drop exactly their own reference. */
class CountingRegistry {
  readonly references = new Map<string, number>();
  openHandles = 0;
  plainAcquires = 0;

  private add(home: string): void {
    this.references.set(home, (this.references.get(home) ?? 0) + 1);
  }

  async acquire(request: { env?: Record<string, string> }): Promise<void> {
    this.plainAcquires++;
    this.add(leaseHome(request));
  }

  async acquireReference(request: { env?: Record<string, string> }, cancellation: LeaseCancellation = {}) {
    const home = leaseHome(request);
    if (cancellation.isCurrent?.() === false) throw new Error("cancelled");
    this.add(home);
    this.openHandles++;
    let settled: Promise<boolean> | undefined;
    const settle = (release: boolean) => settled ??= (() => {
      this.openHandles--;
      if (release) {
        const count = this.references.get(home) ?? 0;
        if (count <= 1) this.references.delete(home); else this.references.set(home, count - 1);
      }
      return Promise.resolve(true);
    })();
    return { first: true, release: () => settle(true), retain: async () => { await settle(false); } };
  }

  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
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

function fixture(control: Partial<FakeDriverControl> = {}) {
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
  const manager = new SessionManager(
    () => {},
    () => {},
    store,
    "runner",
    (_driver, _context, agentId) => agentId === "claude" ? { command: "claude", args: [], env: { HOME: home } } : null,
    factory as never,
    root,
  );
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
