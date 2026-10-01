import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import type { ProviderAuthRecoveryController } from "./provider-auth-recovery.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-lease-preparation-"));
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId: "s1", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: "thread", status: "input_required", title: "Fixture", config: {}, tokensIn: 0,
    tokensOut: 0, costUsd: 0, preview: null, seq: 0, createdAt: 1, updatedAt: 1,
    providerAccountId: "account", providerAccountProvider: "claude", providerCredentialHome: join(root, "home"),
    providerCredentialIdentityId: "identity", providerCredentialScopeId: "scope",
    providerAuthBlock: { version: 1, recoveryId: "recovery", credentialScopeId: "scope", detectedAt: 1,
      phase: "turn", delivery: "uncertain", canStartLogin: true, configuredCredential: false },
    pendingApproval: { kind: "authentication", requestId: "provider-auth:recovery", title: "Authentication Required",
      options: [{ optionId: "auth:login", name: "Sign In", kind: "allow_once" }] },
  };
  store.create(meta);
  const effects = { plugins: 0, preparation: 0, drivers: 0, probes: 0, logins: 0 };
  const controller: ProviderAuthRecoveryController = {
    describe: () => ({ id: "scope", provider: "claude", canStartLogin: true, configuredCredential: false }),
    revalidate: async () => { effects.probes++; return { status: "unknown" }; },
    inspect: async () => { effects.probes++; return { observation: { status: "unknown" }, emailSupported: false, email: null }; },
    startLogin: async () => { effects.logins++; return "failed"; },
    cancel: () => false,
  };
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => { effects.drivers++; throw new Error("fixture provider must not start"); }) as never,
    undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, controller);
  const internals = manager as unknown as {
    prepareLaunch: (meta: SessionMeta, cancellation?: LeaseCancellation) => Promise<void>;
    providerHomeLeases: { acquireHome(home: string, provider: string, cancellation: LeaseCancellation): Promise<boolean>;
      stopAcquisitions(): void };
    resolveProviderAuthentication(session: string, request: string, option: string): Promise<void>;
    completeProviderAuthentication(session: string, block: NonNullable<SessionMeta["providerAuthBlock"]>,
      observation: { status: "authenticated"; identityId: string }, targetOnly: boolean, option: string): Promise<void>;
    revalidateProviderAuthenticationSilently(scope: string): void;
    providerAuthRevalidations: Map<string, Promise<void>>;
  };
  const entered = deferred(), gate = deferred();
  let cancellation: LeaseCancellation | undefined;
  internals.providerHomeLeases = {
    stopAcquisitions() {},
    async acquireHome(_home, _provider, pending) {
      cancellation = pending; entered.resolve();
      await gate.promise;
      if (pending.signal?.aborted || pending.isCurrent?.() === false) throw new Error(LEASE_WORKER_ERRORS.cancelled);
      return true;
    },
  };
  // Run the actual index callback through its plugin/ownership phase. Stop at the next guard
  // preparation boundary, without booting a runner, configuring credentials, or discovering providers.
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = index.indexOf("  async (meta, cancellation) => {");
  const end = index.indexOf("    const localAgent =", start);
  assert.ok(start > 0 && end > start);
  const callback = index.slice(start, end) + "effects.preparation++; }";
  internals.prepareLaunch = vm.runInNewContext(transformSync(`(${callback})`, { loader: "ts" }).code, {
    sessions: manager, effects,
    runnerLocalAgentEnv: () => ({}), adoptedLaunchEnvironment: () => ({}),
    providerAccountEnvironment: (account: { credentialHome: string }) => ({ CLAUDE_CONFIG_DIR: account.credentialHome }),
    pluginProviderForDriver: () => "claude", inheritProviderPlugins: () => { effects.plugins++; }, log: () => {},
  }) as typeof internals.prepareLaunch;
  return { root, store, manager, internals, effects, entered, gate, cancellation: () => cancellation,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); } };
}

test("the actual plugin launch phase awaits owned HOME before inheritance and guard preparation", async () => {
  const h = fixture();
  try {
    const preparing = h.internals.prepareLaunch(h.store.readMeta("s1")!);
    await h.entered.promise;
    assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0);
    h.gate.resolve(); await preparing;
    assert.equal(h.effects.plugins, 1); assert.equal(h.effects.preparation, 1);
  } finally { h.gate.resolve(); h.cleanup(); }
});

test("refused HOME never reaches the actual plugin inheritance or guard boundary", async () => {
  const h = fixture();
  try {
    h.internals.providerHomeLeases.acquireHome = async () => { throw new Error("lease refused"); };
    await assert.rejects(h.internals.prepareLaunch(h.store.readMeta("s1")!), /lease refused/);
    assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0);
  } finally { h.cleanup(); }
});

for (const action of ["auth:cancel", "auth:dismiss"] as const) {
  test(`${action} during the plugin lease wait prevents sign-in and stale card restoration`, async () => {
    const h = fixture();
    try {
      const preparing = h.internals.resolveProviderAuthentication("s1", "provider-auth:recovery", "auth:login");
      await h.entered.promise;
      assert.equal(h.effects.logins, 0); assert.equal(h.effects.probes, 0);
      await h.internals.resolveProviderAuthentication("s1", "provider-auth:recovery", action);
      assert.equal(h.cancellation()?.signal?.aborted, true);
      h.gate.resolve(); await preparing;
      assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0);
      assert.equal(h.effects.logins, 0); assert.equal(h.effects.probes, 0);
      if (action === "auth:dismiss") {
        assert.equal(h.store.readMeta("s1")?.providerAuthBlock, undefined);
        assert.equal(h.store.readMeta("s1")?.pendingApproval, null);
      } else {
        assert.equal(h.store.readMeta("s1")?.providerAuthBlock?.loginOperationId, undefined);
      }
    } finally { h.gate.resolve(); h.cleanup(); }
  });
}

for (const change of ["card", "credential", "epoch", "deletion"] as const) {
  test(`authentication inspection refuses ${change} replacement during the ownership wait`, async () => {
    const h = fixture();
    try {
      const preparing = h.manager.inspectProviderAuthentication("s1", "provider-auth:recovery");
      await h.entered.promise;
      if (change === "card") h.store.patchMeta("s1", { pendingApproval: null });
      if (change === "credential") h.store.patchMeta("s1", { providerCredentialHome: join(h.root, "other") });
      if (change === "epoch") {
        (h.manager as unknown as { latestLaunchGenerations: Map<string, number> }).latestLaunchGenerations.set("s1", 99);
      }
      if (change === "deletion") {
        (h.manager as unknown as { deleted: Set<string> }).deleted.add("s1");
      }
      h.gate.resolve(); await assert.rejects(preparing, /cancelled/);
      assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0); assert.equal(h.effects.probes, 0);
    } finally { h.gate.resolve(); h.cleanup(); }
  });
}

test("account selection refuses a changed card before probing or moving its credential home", async () => {
  const h = fixture();
  try {
    (h.manager as unknown as { resolveProviderAccount: unknown }).resolveProviderAccount = () => ({
      id: "another-account", label: "Fixture", provider: "claude", credentialHome: join(h.root, "another-home"),
    });
    const selecting = h.manager.selectProviderAuthenticationAccount("s1", "provider-auth:recovery", "another-account", "account");
    await h.entered.promise;
    h.store.patchMeta("s1", { pendingApproval: null });
    h.gate.resolve();
    assert.equal((await selecting).ok, false);
    assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0); assert.equal(h.effects.probes, 0);
    assert.equal(h.store.readMeta("s1")?.providerAccountId, "account");
    assert.equal(h.store.readMeta("s1")?.providerCredentialHome, join(h.root, "home"));
  } finally { h.gate.resolve(); h.cleanup(); }
});

test("cancelled preparation does not hide an unrelated lease failure", async () => {
  const h = fixture();
  try {
    h.internals.providerHomeLeases.acquireHome = async () => {
      h.entered.resolve(); await h.gate.promise; throw new Error("independent lease refusal");
    };
    const preparing = h.internals.resolveProviderAuthentication("s1", "provider-auth:recovery", "auth:login");
    await h.entered.promise;
    await h.internals.resolveProviderAuthentication("s1", "provider-auth:recovery", "auth:cancel");
    h.gate.resolve(); await assert.rejects(preparing, /independent lease refusal/);
    assert.equal(h.effects.logins, 0); assert.equal(h.effects.plugins, 0);
  } finally { h.gate.resolve(); h.cleanup(); }
});

test("an automatic revalidation timeout cancels its exact wait and retains unknown behavior", async t => {
  const h = fixture();
  try {
    h.store.patchMeta("s1", { pendingApproval: null });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    h.internals.revalidateProviderAuthenticationSilently("scope");
    await h.entered.promise;
    const operation = h.internals.providerAuthRevalidations.get("scope")!;
    t.mock.timers.tick(20_000);
    await operation;
    assert.equal(h.cancellation()?.signal?.aborted, true);
    h.gate.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0); assert.equal(h.effects.probes, 0);
    assert.ok(h.store.readMeta("s1")?.providerAuthBlock);
  } finally { h.gate.resolve(); h.cleanup(); }
});

test("a same-scope sibling whose card changes during ownership cannot complete recovery", async () => {
  const h = fixture();
  try {
    const meta = h.store.readMeta("s1")!;
    h.store.patchMeta("s1", { providerAuthBlock: { ...meta.providerAuthBlock!, expectedIdentityId: "identity" } });
    const sibling = h.store.readMeta("s1")!;
    const completing = h.internals.completeProviderAuthentication("another-session", sibling.providerAuthBlock!,
      { status: "authenticated", identityId: "identity" }, false, "auth:revalidate");
    await h.entered.promise;
    h.store.patchMeta("s1", { pendingApproval: null,
      providerAuthBlock: { ...sibling.providerAuthBlock!, recoveryId: "replacement" } });
    h.gate.resolve(); await completing;
    assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0); assert.equal(h.effects.probes, 0);
    assert.equal(h.store.readMeta("s1")?.providerAuthBlock?.recoveryId, "replacement");
  } finally { h.gate.resolve(); h.cleanup(); }
});

test("stop during normal launch ownership prevents plugin preparation and provider construction", async () => {
  const h = fixture();
  try {
    const spec: SessionLaunchSpec = { sessionId: "s1", agentId: "claude", workspaceId: "repo",
      workspacePath: h.root, command: "claude", args: [], env: {}, driver: "claude-code", useWorktree: false,
      providerAccountId: "account" };
    // Start refreshes its account binding from the runner-local catalog, so this fixture supplies
    // the same private home and bypasses no production ownership or launch generation checks.
    (h.manager as unknown as { resolveProviderAccount: unknown }).resolveProviderAccount = () => ({
      id: "account", label: "Fixture", provider: "claude", credentialHome: join(h.root, "home"),
    });
    const launching = h.manager.start(spec);
    await h.entered.promise;
    h.manager.stop("s1"); h.gate.resolve();
    assert.equal(await launching, false);
    assert.equal(h.effects.plugins, 0); assert.equal(h.effects.preparation, 0); assert.equal(h.effects.drivers, 0);
    assert.equal(h.store.readMeta("s1")?.status, "stopped");
  } finally { h.gate.resolve(); h.cleanup(); }
});
