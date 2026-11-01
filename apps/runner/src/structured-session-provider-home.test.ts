import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import { providerAccountEnvironment } from "./provider-accounts.js";
import { providerHomeLeaseEnv, providerHomeLeaseTarget, type ProviderHomeLeaseRequest } from "./provider-home-lease.js";
import { SessionManager, type LaunchPreparationCancellation } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { layerLaunchEnvironment } from "./spawn.js";

/** Records the exact HOME each acquisition is keyed on, through the registry's own selection. */
class RecordingRegistry {
  readonly homes: string[] = [];
  async acquireReference(request: ProviderHomeLeaseRequest) {
    const target = providerHomeLeaseTarget(request);
    if (!target) return null;
    this.homes.push(target.home);
    return { first: true, release: async () => true, retain: async () => {} };
  }
  async acquire(): Promise<void> { assert.fail("a structured launch below the handle budget takes a reference"); }
  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
}

type Provider = "claude" | "codex";
const HOME_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;
const DRIVER = { claude: "claude-code", codex: "codex-app-server" } as const;
/** A runner whose own environment names a provider home for each provider (#3858). */
const RUNNER_ENV = { CLAUDE_CONFIG_DIR: "/runner/claude", CODEX_HOME: "/runner/codex", HOME: "/runner" };

function fixture(provider: Provider, options: { launchEnv?: Record<string, string>; account?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-structured-provider-home-"));
  const store = new SessionStore(join(root, "sessions"));
  const launchEnvironments: Record<string, string>[] = [];
  const factory = (_driver: unknown, opts: { env: Record<string, string> }) => {
    launchEnvironments.push({ ...opts.env });
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
    };
  };
  const resolveLaunch = () => ({ command: provider, args: [], env: {} });
  // What the `index.ts` preparation adapter does: the runner-local agent environment (by default
  // naming no provider home), plus a bound account's credential home.
  const prepareLaunch = async (meta: SessionMeta, _cancellation?: LaunchPreparationCancellation) => {
    meta.env = { HOME: root, ...options.launchEnv };
    if (options.account) Object.assign(meta.env, providerAccountEnvironment({ provider, credentialHome: options.account }));
  };
  const manager = new SessionManager(() => {}, () => {}, store, "runner", resolveLaunch as never, factory as never, root,
    4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
    prepareLaunch as never);
  const registry = new RecordingRegistry();
  const internals = manager as unknown as { providerHomeLeases: RecordingRegistry; runnerEnvironment: NodeJS.ProcessEnv };
  internals.providerHomeLeases = registry;
  internals.runnerEnvironment = RUNNER_ENV;
  const spec: SessionLaunchSpec = {
    sessionId: `structured-${provider}`, agentId: provider, workspaceId: "repo", workspacePath: root,
    command: provider, args: [], env: {}, useWorktree: false, driver: DRIVER[provider],
  };
  return {
    manager, registry, spec, launchEnvironments,
    persistedEnv: () => store.readMeta(spec.sessionId)?.env,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const provider of ["claude", "codex"] as const) {
  test(`an unbound structured ${provider} session leases the runner's own provider home (#3858)`, async () => {
    const h = fixture(provider);
    try {
      assert.equal(await h.manager.start(h.spec), true);
      assert.deepEqual(h.registry.homes, [RUNNER_ENV[HOME_VARIABLE[provider]]],
        "the lease is keyed on the home the provider inherits, not on HOME");
      assert.equal(h.launchEnvironments[0]?.[HOME_VARIABLE[provider]], undefined,
        "the driver's launch environment is unchanged: the runner's value reaches it by inheritance");
      assert.deepEqual(h.persistedEnv(), {}, "the resolved environment is never persisted");
    } finally { h.cleanup(); }
  });

  test(`a structured ${provider} session whose launch sets its provider home leases that home (#3858)`, async () => {
    const h = fixture(provider, { launchEnv: { [HOME_VARIABLE[provider]]: "/agent/home" } });
    try {
      assert.equal(await h.manager.start(h.spec), true);
      assert.deepEqual(h.registry.homes, ["/agent/home"]);
    } finally { h.cleanup(); }
  });

  test(`a structured ${provider} session bound to an account leases exactly its credential home (#3858)`, async () => {
    const h = fixture(provider, { account: "/accounts/work" });
    try {
      assert.equal(await h.manager.start(h.spec), true);
      assert.deepEqual(h.registry.homes, ["/accounts/work"], "the runner's own provider home never wins over a binding");
      assert.equal(h.launchEnvironments[0]?.[HOME_VARIABLE[provider]], "/accounts/work");
      assert.deepEqual(h.persistedEnv(), {}, "the resolved environment is never persisted");
    } finally { h.cleanup(); }
  });
}

test("a Windows structured launch and its lease select the same provider home, whatever the name's case (#3858)", () => {
  const context = { kind: "native" } as const;
  const lease = (env: Record<string, string>, runnerEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
    providerHomeLeaseTarget({
      driver: "codex-app-server", command: "codex", context,
      env: providerHomeLeaseEnv({ context, env }, runnerEnv, platform),
    })?.home;
  /** What `spawnAgent` hands the provider on Windows: exactly one entry per case-folded name. */
  const launched = (env: Record<string, string>, runnerEnv: NodeJS.ProcessEnv) => {
    const entries = Object.entries(layerLaunchEnvironment([runnerEnv, env], "win32"))
      .filter(([key]) => key.toUpperCase() === "CODEX_HOME");
    assert.equal(entries.length, 1, "Windows would otherwise keep whichever spelling sorts first");
    return entries[0]![1];
  };
  for (const [env, runnerEnv] of [
    [{ codex_home: "/selected" }, { CODEX_HOME: "/runner" }],
    [{}, { Codex_Home: "/runner" }],
    [{ CODEX_HOME: "/selected" }, { codex_home: "/runner" }],
    [{ HOME: "/agent" }, { CODEX_HOME: "/runner" }],
  ] as const) {
    const expected = launched(env, runnerEnv);
    assert.equal(lease(env, runnerEnv, "win32"), expected, JSON.stringify({ env, runnerEnv }));
  }
  // POSIX names are case-sensitive: both spellings reach the provider and only the exact one counts.
  assert.deepEqual(layerLaunchEnvironment([{ CODEX_HOME: "/runner" }, { codex_home: "/selected" }], "linux"),
    { CODEX_HOME: "/runner", codex_home: "/selected" });
  assert.equal(lease({ codex_home: "/selected" }, { CODEX_HOME: "/runner" }, "linux"), "/runner");
});
