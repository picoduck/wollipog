import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { createRunnerProviderAuthRecovery, type ProviderAuthRecoveryController } from "./provider-auth-recovery.js";
import { providerAccountEnvironment } from "./provider-accounts.js";
import { providerHomeLeaseTarget, type ProviderHomeLeaseRequest } from "./provider-home-lease.js";
import { ProviderLoginSupervisor } from "./provider-login.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import type { SpawnAgentOptions } from "./spawn.js";

type Provider = "claude" | "codex";
const HOME_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;
const DRIVER = { claude: "claude-code", codex: "codex-app-server" } as const;
/** A runner whose own environment names a provider home for each provider (#3903). */
const RUNNER_ENV = { CLAUDE_CONFIG_DIR: "/runner/claude", CODEX_HOME: "/runner/codex", HOME: "/runner" };

function sessionMeta(provider: Provider, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: `recovery-${provider}`, agentId: provider, workspaceId: null, repoPath: "/repo", worktreePath: null,
    driver: provider === "claude" ? "claude-code" : "codex", command: provider, args: [], env: { HOME: "/agent" },
    context: { kind: "native" }, agentSessionId: "thread", status: "input_required", title: "Recovery", config: {},
    tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

/** The recovery sign-in through the real login supervisor, whose lease records the HOME it is keyed
 * on. The provider command is never started: the recording spawn refuses after the lease. */
async function recoverySignIn(provider: Provider, meta: SessionMeta) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-recovery-sign-in-home-"));
  const leased: string[] = [];
  const released: string[] = [];
  const spawned: SpawnAgentOptions[] = [];
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root, configPath: join(root, "config.json"), accounts: [], agents: () => [], resolveEnv: () => ({}),
    acquireLease: (directory, leaseProvider) => {
      assert.equal(leaseProvider, provider);
      leased.push(directory);
      return true;
    },
    releaseLease: (directory) => { released.push(directory); return true; },
    onUpdate: () => {}, onAccountAdded: () => {},
    spawn: (options) => { spawned.push(options); throw new Error("fixture sign-in must not start"); },
  });
  try {
    const controller = createRunnerProviderAuthRecovery({ dataDir: root }, undefined, supervisor);
    (controller as unknown as { runnerEnvironment: NodeJS.ProcessEnv }).runnerEnvironment = RUNNER_ENV;
    assert.equal(controller.describe(meta)?.canStartLogin, true);
    assert.equal(await controller.startLogin(meta), "failed");
    assert.deepEqual(released, leased, "the refused start releases exactly the HOME it leased");
    return { leased, spawned };
  } finally {
    supervisor.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const provider of ["claude", "codex"] as const) {
  const variable = HOME_VARIABLE[provider];

  test(`an unbound ${provider} recovery sign-in leases the runner's own provider home (#3903)`, async () => {
    const meta = sessionMeta(provider);
    const { leased, spawned } = await recoverySignIn(provider, meta);
    assert.deepEqual(leased, [RUNNER_ENV[variable]], "the lease is keyed on the home the sign-in inherits, not on HOME");
    assert.equal(spawned[0]?.cwd, RUNNER_ENV[variable]);
    assert.deepEqual(spawned[0]?.env, { HOME: "/agent" },
      "the sign-in's environment is unchanged: the runner's value reaches it by inheritance");
    assert.deepEqual(meta.env, { HOME: "/agent" }, "the resolved environment is never written back");
  });

  test(`a ${provider} recovery sign-in whose launch sets its provider home leases that home (#3903)`, async () => {
    const { leased } = await recoverySignIn(provider, sessionMeta(provider, { env: { HOME: "/agent", [variable]: "/agent/home" } }));
    assert.deepEqual(leased, ["/agent/home"]);
  });

  test(`a ${provider} recovery sign-in bound to an account leases exactly its credential home (#3903)`, async () => {
    const home = mkdtempSync(join(tmpdir(), "wollipog-recovery-account-"));
    try {
      const { leased } = await recoverySignIn(provider, sessionMeta(provider, {
        providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: provider, providerCredentialHome: home,
        env: { HOME: "/agent", ...providerAccountEnvironment({ provider, credentialHome: home }) },
      }));
      assert.deepEqual(leased, [home], "the runner's own provider home never wins over a binding");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

/** Records the exact HOME each acquisition is keyed on, through the registry's own selection. */
class RecordingRegistry {
  readonly homes: string[] = [];
  async acquireReference(request: ProviderHomeLeaseRequest) {
    const target = providerHomeLeaseTarget(request);
    if (!target) return null;
    this.homes.push(target.home);
    return { first: true, release: async () => true, retain: async () => {} };
  }
  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
}

function agent(provider: Provider): AgentDefinition {
  return {
    id: provider, name: provider, command: provider, args: [], env: {}, driver: DRIVER[provider],
    context: { kind: "native" }, available: true, authStatus: "authenticated",
  };
}

function managerFixture(provider: Provider) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-non-launch-provider-home-"));
  const store = new SessionStore(join(root, "sessions"));
  const controller: ProviderAuthRecoveryController = {
    describe: () => ({ id: "scope", provider, canStartLogin: false, configuredCredential: false }),
    revalidate: async () => ({ status: "authenticated" }),
    startLogin: async () => "failed",
    cancel: () => false,
  };
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => { throw new Error("fixture provider must not start"); }) as never,
    root, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, controller);
  const registry = new RecordingRegistry();
  const internals = manager as unknown as { providerHomeLeases: RecordingRegistry; runnerEnvironment: NodeJS.ProcessEnv };
  internals.providerHomeLeases = registry;
  internals.runnerEnvironment = RUNNER_ENV;
  return { root, manager, registry, cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); } };
}

/** Each non-launch path that leases a provider HOME for a process spawned beneath the runner's own
 * environment, run once with the environment it is handed. */
const PATHS: Record<string, (h: ReturnType<typeof managerFixture>, provider: Provider, env: Record<string, string>) => Promise<unknown>> = {
  "a provider-account auth probe": (h, provider, env) => h.manager.probeProviderAccountAuthentication(agent(provider), env),
  "a discovery probe": async (h, provider, env) => (await h.manager.prepareDiscoveryProbe(agent(provider), env)).settle([]),
  "a subscription usage probe": async (h, provider, env) =>
    (await h.manager.prepareSubscriptionUsageProbe(agent(provider), env, "source")).settle?.([]),
  "a session naming helper": async (h, provider, env) =>
    (await h.manager.prepareSessionNamingExecution(agent(provider), env, h.root)).cleanup([]),
};

test("a discovery probe without any provider home leases the HOME it inherits, not the platform default", async () => {
  const h = managerFixture("claude");
  try {
    (h.manager as unknown as { runnerEnvironment: NodeJS.ProcessEnv }).runnerEnvironment = { HOME: "/runner/inherited" };
    await (await h.manager.prepareDiscoveryProbe(agent("claude"), {})).settle([]);
    await (await h.manager.prepareDiscoveryProbe({ ...agent("claude"), driver: "acp" }, {})).settle([]);
    assert.deepEqual(h.registry.homes, ["/runner/inherited", "/runner/inherited"],
      "on Windows `os.homedir()` reads USERPROFILE, which can differ from the inherited HOME");
  } finally { h.cleanup(); }
});

for (const [path, run] of Object.entries(PATHS)) {
  for (const provider of ["claude", "codex"] as const) {
    const variable = HOME_VARIABLE[provider];
    test(`${path} for ${provider} leases the home its process uses (#3903)`, async () => {
      const h = managerFixture(provider);
      try {
        await run(h, provider, { HOME: "/agent" });
        await run(h, provider, { HOME: "/agent", [variable]: "/agent/home" });
        await run(h, provider, { HOME: "/agent", ...providerAccountEnvironment({ provider, credentialHome: "/accounts/work" }) });
        assert.deepEqual(h.registry.homes, [RUNNER_ENV[variable], "/agent/home", "/accounts/work"],
          "the runner's home without a launch value; the launch's or the account's value wins");
      } finally { h.cleanup(); }
    });
  }
}
