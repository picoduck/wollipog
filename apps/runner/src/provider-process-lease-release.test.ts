import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentDefinition, GenerateSessionTitleMessage } from "@wollipog/protocol";
import { SESSION_NAMING_RUNNER_BUDGET_MS } from "@wollipog/protocol";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { createTestProviderAuthRecovery, type ProviderAuthRecoveryController, type ProviderProcessObserver } from "./provider-auth-recovery.js";
import { SessionManager, type LaunchPreparationCancellation } from "./session-manager.js";
import { SessionNamingExecutor } from "./session-naming.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { provenProcessTreeExit, type AgentProcess } from "./spawn.js";
import { SubscriptionUsageManager } from "./subscription-usage.js";

/** A spawned provider process; `tree` decides what its POSIX boundary proves (absent = none). */
function fakeChild(tree?: boolean | "throws"): AgentProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    ...(tree === undefined ? {} : {
      posixBoundary: {
        terminate: () => tree === "throws" ? Promise.reject(new Error("enumeration failed")) : Promise.resolve(tree),
      },
    }),
  });
  return child as unknown as AgentProcess;
}

test("only a POSIX boundary with no survivors proves a process tree gone", async () => {
  assert.equal(await provenProcessTreeExit(fakeChild(true)), true);
  assert.equal(await provenProcessTreeExit(fakeChild(false)), false, "a surviving descendant");
  assert.equal(await provenProcessTreeExit(fakeChild("throws")), false, "an unprobeable tree");
  assert.equal(await provenProcessTreeExit(fakeChild()), false, "a root exit alone is not a tree proof");
});

function probeMeta(): SessionMeta {
  return {
    sessionId: "probe", agentId: "claude", workspaceId: null, repoPath: "/", worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: { HOME: "/home/probe" }, context: { kind: "native" },
    agentSessionId: null, status: "idle", title: "Probe", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
}

test("an auth probe reports each status command's tree proof only after the command finished", async () => {
  const child = fakeChild(true);
  const controller = createTestProviderAuthRecovery(undefined, "runner-local-hmac-key", { spawn: () => child, kill: () => {} });
  const proofs: Promise<boolean>[] = [];
  const observation = controller.revalidate(probeMeta(), { onProcess: (proof) => proofs.push(proof) });
  assert.equal(proofs.length, 1, "the process is reported as soon as it is spawned");
  let proven: boolean | undefined;
  void proofs[0]!.then((value) => { proven = value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(proven, undefined, "no proof while the command is still running");
  (child.stdout as PassThrough).write(JSON.stringify({ loggedIn: true, email: "account@example.test" }));
  child.emit("close", 0, null);
  assert.equal((await observation).status, "authenticated");
  assert.equal(await proofs[0], true);

  const injected = createTestProviderAuthRecovery(async () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: "" }));
  const injectedProofs: Promise<boolean>[] = [];
  await injected.revalidate(probeMeta(), { onProcess: (proof) => injectedProofs.push(proof) });
  assert.deepEqual(await Promise.all(injectedProofs), [false], "an invisible runner process can never prove its tree");
});

/** Counts references per HOME like the lease registry, through exact handles. */
class CountingRegistry {
  readonly references = new Map<string, number>();
  readonly released: string[] = [];
  openHandles = 0;

  async acquireHomeReference(home: string, _provider = "skills", cancellation: LeaseCancellation = {}) {
    if (cancellation.isCurrent?.() === false) throw new Error("cancelled");
    this.references.set(home, (this.references.get(home) ?? 0) + 1);
    this.openHandles++;
    let settled: Promise<boolean> | undefined;
    const settle = (release: boolean) => settled ??= (() => {
      this.openHandles--;
      if (!release) return Promise.resolve(true);
      this.released.push(home);
      const count = this.references.get(home) ?? 0;
      if (count <= 1) this.references.delete(home); else this.references.set(home, count - 1);
      return Promise.resolve(true);
    })();
    return { first: true, release: () => settle(true), retain: async () => { await settle(false); } };
  }

  async acquireReference(request: { env?: Record<string, string> }, cancellation: LeaseCancellation = {}) {
    const home = request.env?.HOME;
    return home ? this.acquireHomeReference(home, "claude", cancellation) : null;
  }

  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
}

function claudeAgent(): AgentDefinition {
  return {
    id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code",
    context: { kind: "native" }, available: true, authStatus: "authenticated",
  };
}

function managerFixture(proofs: boolean[] = []) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-process-lease-"));
  const home = join(root, "home");
  const store = new SessionStore(join(root, "sessions"));
  const controller: ProviderAuthRecoveryController = {
    describe: () => ({ id: "scope", provider: "claude", canStartLogin: false, configuredCredential: false }),
    revalidate: async (_meta, observer?: ProviderProcessObserver) => {
      for (const proof of proofs) observer?.onProcess(Promise.resolve(proof));
      return { status: "authenticated" };
    },
    startLogin: async () => "failed",
    cancel: () => false,
  };
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => { throw new Error("fixture provider must not start"); }) as never,
    undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, controller);
  const registry = new CountingRegistry();
  (manager as unknown as { providerHomeLeases: CountingRegistry; stateDir: string }).providerHomeLeases = registry;
  return {
    home, manager, registry,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("discovery owns its effective HOME before launch and releases only on a complete process proof", async () => {
  const h = managerFixture();
  try {
    const agent = { ...claudeAgent(), driver: "acp" as const, command: "configured-adapter" };
    const first = await h.manager.prepareDiscoveryProbe(agent, { HOME: h.home });
    assert.equal(h.registry.references.get(h.home), 1, "ownership is acquired before any executable can start");
    await first.settle([Promise.resolve(true)]);
    assert.equal(h.registry.references.has(h.home), false);
    const retained = await h.manager.prepareDiscoveryProbe(agent, { HOME: h.home });
    await retained.settle([Promise.resolve(true), Promise.reject(new Error("uninspectable tree"))]);
    await retained.settle([Promise.resolve(true)]);
    assert.equal(h.registry.references.get(h.home), 1, "a failed proof retains exactly one reference");
    assert.equal(h.registry.openHandles, 0, "settlement frees the bounded handle even when retaining ownership");
  } finally { h.cleanup(); }
});

for (const [label, proofs, released] of [
  ["a proven status-command tree", [true], true],
  ["a surviving or unprobeable tree", [true, false], false],
] as const) {
  test(`an account auth probe releases its HOME reference only for ${label}`, async () => {
    const h = managerFixture([...proofs]);
    try {
      assert.equal(await h.manager.probeProviderAccountAuthentication(claudeAgent(), { HOME: h.home }), "authenticated");
      assert.equal(h.registry.references.has(h.home), !released);
      assert.equal(h.registry.openHandles, 0, "the handle is settled either way");
    } finally { h.cleanup(); }
  });
}

test("a subscription usage probe settles its reference by the trees of the processes it started", async () => {
  const h = managerFixture();
  try {
    const proven = await h.manager.prepareSubscriptionUsageProbe(claudeAgent(), { HOME: h.home }, "source-a");
    await proven.settle?.([fakeChild(true)]);
    await proven.settle?.([fakeChild(false)]);
    assert.equal(h.registry.references.has(h.home), false, "released once; a second settle is a no-op");
    const unproven = await h.manager.prepareSubscriptionUsageProbe(claudeAgent(), { HOME: h.home }, "source-b");
    await unproven.settle?.([fakeChild(true), fakeChild()]);
    assert.equal(h.registry.references.get(h.home), 1, "a tree without a boundary keeps the reference");
    const unused = await h.manager.prepareSubscriptionUsageProbe(claudeAgent(), { HOME: h.home }, "source-c");
    await unused.settle?.([]);
    assert.equal(h.registry.references.get(h.home), 1, "a probe that started nothing releases its own reference");
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

test("session naming cleanup releases its reference only after its processes' trees are proven gone", async () => {
  const h = managerFixture();
  try {
    const proven = await h.manager.prepareSessionNamingExecution(claudeAgent(), { HOME: h.home }, h.home);
    await proven.cleanup([fakeChild(true)]);
    assert.equal(h.registry.references.has(h.home), false);
    const unproven = await h.manager.prepareSessionNamingExecution(claudeAgent(), { HOME: h.home }, h.home);
    await unproven.cleanup([fakeChild(false)]);
    await unproven.cleanup([fakeChild(true)]);
    assert.equal(h.registry.references.get(h.home), 1, "a repeated cleanup cannot release a kept reference");
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});

function codexAgent(): AgentDefinition {
  return {
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
    context: { kind: "native" }, available: true, authStatus: "authenticated",
    codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio", contractFingerprint: "test" },
  };
}

test("the subscription usage manager hands the probe's spawned processes to settle", async () => {
  const settled: Array<readonly AgentProcess[]> = [];
  const child = fakeChild(true);
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [codexAgent()],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe", settle: async (children) => { settled.push(children); } }),
    publish: () => {},
    probeCodex: async (_agent, _env, _timeout, dependencies) => {
      dependencies?.onSpawn?.(child);
      dependencies?.onFinish?.(child);
      return { state: "unauthenticated", detail: "signed out" };
    },
  });
  await manager.refreshAll();
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], [child]);
});

function namingRequest(): GenerateSessionTitleMessage {
  return {
    type: "generate_session_title",
    requestId: "request-one",
    sessionId: "session-one",
    messages: [{ role: "user", text: "Fix the session naming flow" }],
    timeoutMs: SESSION_NAMING_RUNNER_BUDGET_MS,
  };
}

test("the naming executor passes every provider process it started to the authorization cleanup", async () => {
  const child = fakeChild(true);
  const cleaned: Array<readonly AgentProcess[] | undefined> = [];
  const executor = new SessionNamingExecutor({
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => {} }),
    authorize: async () => ({ cleanup: async (children) => { cleaned.push(children); } }),
    spawn: () => {
      setImmediate(() => {
        (child.stdout as PassThrough).write("Session Naming Fix");
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  const agent: AgentDefinition = {
    ...claudeAgent(),
    claudeCode: {
      status: "ready", effortLevels: [], permissionModes: ["plan"], streamJsonInput: true, streamJsonImages: true,
      controlProtocol: true, forkSession: true, replayUserMessages: true, sessionNaming: true,
      auth: { status: "authenticated", billingSource: "subscription" },
    },
  };
  const result = await executor.execute(namingRequest(), agent, {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(cleaned.length, 1);
  assert.deepEqual(cleaned[0], [child]);
});

/** A session parked on an Authentication Required card. Its auth callers run launch preparation,
 * where the `index.ts` adapter takes the account HOME's reference through the caller's handle, then
 * a status command under that reference (#3238). */
function authCallerFixture(proofs: boolean[], options: { cardChangesDuringPreparation?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-auth-caller-lease-"));
  const home = join(root, "account-home");
  const store = new SessionStore(join(root, "sessions"));
  const block = { version: 1 as const, recoveryId: "recovery", credentialScopeId: "scope", detectedAt: 1,
    phase: "turn" as const, delivery: "uncertain" as const, canStartLogin: false, configuredCredential: false,
    expectedIdentityId: "identity" };
  store.create({
    sessionId: "s1", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: "thread", status: "input_required", title: "Fixture", config: {}, tokensIn: 0,
    tokensOut: 0, costUsd: 0, preview: null, seq: 0, createdAt: 1, updatedAt: 1,
    providerAccountId: "account", providerAccountProvider: "claude", providerCredentialHome: home,
    providerCredentialIdentityId: "identity", providerCredentialScopeId: "scope", providerAuthBlock: block,
    pendingApproval: { kind: "authentication", requestId: "provider-auth:recovery", title: "Authentication Required",
      options: [{ optionId: "auth:revalidate", name: "Recheck", kind: "allow_once" }] },
  });
  const statusCommands: string[] = [];
  const report = (observer?: ProviderProcessObserver) => {
    for (const proof of proofs) observer?.onProcess(Promise.resolve(proof));
  };
  const controller: ProviderAuthRecoveryController = {
    describe: () => ({ id: "scope", provider: "claude", canStartLogin: false, configuredCredential: false }),
    revalidate: async (_meta, observer) => {
      statusCommands.push("revalidate");
      report(observer);
      return { status: "authenticated" };
    },
    inspect: async (_meta, observer) => {
      statusCommands.push("inspect");
      report(observer);
      return { observation: { status: "authenticated" }, emailSupported: true, email: "account@example.test" };
    },
    startLogin: async () => "failed",
    cancel: () => false,
  };
  let manager!: SessionManager;
  const prepareLaunch = async (_meta: SessionMeta, cancellation?: LaunchPreparationCancellation) => {
    await manager.acquireLaunchProviderHome(home, cancellation);
    if (options.cardChangesDuringPreparation) {
      store.patchMeta("s1", { pendingApproval: null, providerAuthBlock: { ...block, recoveryId: "replacement" } });
    }
  };
  manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => { throw new Error("fixture provider must not start"); }) as never,
    undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, [], prepareLaunch, undefined, undefined, undefined, undefined, undefined, controller);
  const registry = new CountingRegistry();
  const internals = manager as unknown as {
    providerHomeLeases: CountingRegistry;
    resolveProviderAuthentication(session: string, request: string, option: string): Promise<void>;
    revalidateProviderAuthenticationSilently(scope: string): void;
    providerAuthRevalidations: Map<string, Promise<void>>;
    completeProviderAuthentication(session: string, block: NonNullable<SessionMeta["providerAuthBlock"]>,
      observation: { status: "authenticated"; identityId: string }, targetOnly: boolean, option: string): Promise<void>;
  };
  internals.providerHomeLeases = registry;
  return {
    home, store, block, manager, internals, registry, statusCommands,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const [label, proofs, released] of [
  ["a proven status-command tree", [true], true],
  ["a surviving or unprobeable tree", [true, false], false],
] as const) {
  test(`authentication inspection settles its preparation reference with its status command: released only for ${label}`, async () => {
    const h = authCallerFixture([...proofs]);
    try {
      const inspected = await h.manager.inspectProviderAuthentication("s1", "provider-auth:recovery");
      assert.equal(inspected.ok, true);
      assert.deepEqual(h.statusCommands, ["inspect"]);
      assert.equal(h.registry.references.has(h.home), !released);
      assert.equal(h.registry.openHandles, 0, "the handle is settled either way");
    } finally { h.cleanup(); }
  });

  test(`an explicit authentication recheck settles its preparation reference: released only for ${label}`, async () => {
    const h = authCallerFixture([...proofs]);
    try {
      await h.internals.resolveProviderAuthentication("s1", "provider-auth:recovery", "auth:revalidate");
      assert.deepEqual(h.statusCommands, ["revalidate"]);
      assert.equal(h.registry.references.has(h.home), !released);
      assert.equal(h.registry.openHandles, 0);
    } finally { h.cleanup(); }
  });

  test(`a silent authentication revalidation settles its preparation reference: released only for ${label}`, async () => {
    const h = authCallerFixture([...proofs]);
    try {
      h.store.patchMeta("s1", { pendingApproval: null });
      h.internals.revalidateProviderAuthenticationSilently("scope");
      await h.internals.providerAuthRevalidations.get("scope");
      assert.deepEqual(h.statusCommands, ["revalidate"]);
      assert.equal(h.registry.references.has(h.home), !released);
      assert.equal(h.registry.openHandles, 0);
    } finally { h.cleanup(); }
  });
}

test("a same-scope sibling's recovery preparation releases its reference when nothing ran under it", async () => {
  const h = authCallerFixture([], { cardChangesDuringPreparation: true });
  try {
    await h.internals.completeProviderAuthentication("another-session", h.block,
      { status: "authenticated", identityId: "identity" }, false, "auth:revalidate");
    assert.deepEqual(h.statusCommands, []);
    assert.equal(h.registry.references.has(h.home), false);
    assert.deepEqual(h.registry.released, [h.home]);
    assert.equal(h.registry.openHandles, 0);
  } finally { h.cleanup(); }
});
