import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import { providerHomeLeaseTarget, type ProviderHomeLeaseRequest } from "./provider-home-lease.js";
import { agentTuiProviderHomeEnv, SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { windowsEnvironmentForLaunch } from "./windows-conpty.js";

/** Records the exact HOME each acquisition is keyed on, through the registry's own selection. */
class RecordingRegistry {
  readonly homes: string[] = [];
  async acquireReference(request: ProviderHomeLeaseRequest) {
    const target = providerHomeLeaseTarget(request);
    if (!target) return null;
    this.homes.push(target.home);
    return { first: true, release: async () => true, retain: async () => {} };
  }
  async acquire(): Promise<void> { assert.fail("an Agent TUI acquires a settleable reference"); }
  stopAcquisitions(): void {}
}

type Provider = "claude" | "codex";
const HOME_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;

function fixture(provider: Provider, options: { account?: boolean; context?: SessionMeta["context"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-tui-provider-account-"));
  const account = join(root, "account");
  mkdirSync(account);
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId: `tui-account-${provider}`, agentId: provider, workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: provider === "claude" ? "claude-code" : "codex-app-server", command: provider, args: [],
    // Durable metadata carries no environment (`scrubLegacyAgentEnv`): what every session has now.
    env: {},
    ...(options.account === false ? {} : {
      providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: provider,
      providerCredentialHome: account,
    }),
    context: options.context ?? { kind: "native" }, agentSessionId: null, status: "idle", title: "Fixture",
    config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0,
    createdAt: 1, updatedAt: 1,
  };
  store.create(meta);
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => assert.fail("no structured provider should start")) as never, join(root, "data"));
  const registry = new RecordingRegistry();
  (manager as unknown as { providerHomeLeases: RecordingRegistry }).providerHomeLeases = registry;
  const dependencies: Parameters<typeof prepareAgentTuiLaunch>[1] = {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    // The runner-local agent environment `index.ts` resolves; it names no provider home.
    agentEnvironment: () => ({ HOME: root, AGENT_SETTING: "runner-local" }),
    provision: () => assert.fail("an ordinary TUI is not provisioned with Agent Control"),
    prepareScratch: async () => assert.fail("an ordinary TUI has no Orchestrator scratch"),
    acquireProviderHome: (prepared) => manager.acquireAgentTuiProviderHome(prepared),
    assertSessionNotDeleted: () => {},
    provisionManagedWorktreeGuard: (spec) => ({ protections: [], args: spec.args, guardActive: false }),
    permissionProfile: async () => ({ active: false, reason: "fixture" }),
  };
  return {
    root, account, store, manager, registry, dependencies,
    /** The session as the shell-open handler reads it: from the store. */
    persisted: () => store.readMeta(meta.sessionId)!,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const provider of ["claude", "codex"] as const) {
  test(`an ordinary ${provider} TUI runs in the session's provider account and leases exactly its home (#3338)`, async () => {
    const h = fixture(provider);
    try {
      const launch = await prepareAgentTuiLaunch(h.persisted(), h.dependencies);
      assert.ok(launch);
      assert.equal(launch.env?.[HOME_VARIABLE[provider]], h.account, "the TUI starts in the account's credential home");
      assert.equal(launch.env?.AGENT_SETTING, "runner-local", "the runner-local agent environment is kept");
      assert.deepEqual(h.registry.homes, [h.account], "the lease is keyed on the account's credential home");
      assert.deepEqual(h.persisted().env, {}, "the resolved environment is never persisted");
      await launch.providerHome?.settle(true);
    } finally { h.cleanup(); }
  });
}

test("an unbound TUI leases the home it actually inherits, including the runner's own provider home (#3338)", () => {
  const runnerEnv = { CLAUDE_CONFIG_DIR: "/runner/claude", CODEX_HOME: "/runner/codex", HOME: "/runner" };
  const lease = (provider: Provider, env: Record<string, string>, context: SessionMeta["context"] = { kind: "native" }) =>
    providerHomeLeaseTarget({
      driver: provider === "claude" ? "claude-code" : "codex-app-server", command: provider, context,
      env: agentTuiProviderHomeEnv({ context, env }, runnerEnv),
    })?.home;
  for (const provider of ["claude", "codex"] as const) {
    assert.equal(lease(provider, {}), `/runner/${provider}`, `${provider}: the runner's own provider home`);
    assert.equal(lease(provider, { HOME: "/agent" }), `/runner/${provider}`,
      `${provider}: an agent HOME does not override an inherited provider home`);
    assert.equal(lease(provider, { [HOME_VARIABLE[provider]]: "/account" }), "/account",
      `${provider}: the launch's own provider home wins`);
  }
  // Nothing of the runner's environment crosses into a WSL distro except the explicit launch
  // environment, and the lease still refuses a shared WSL home (#3337).
  assert.throws(() => lease("claude", {}, { kind: "wsl", distro: "Ubuntu" }), /cannot be safely owner-leased/);
  assert.deepEqual(agentTuiProviderHomeEnv({ context: { kind: "wsl", distro: "Ubuntu" }, env: { A: "1" } }, runnerEnv),
    { A: "1" });
});

test("a Windows TUI leases the provider home its ConPTY launch selects, whatever the name's case (#3338)", () => {
  const context = { kind: "native" } as const;
  const lease = (env: Record<string, string>, runnerEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
    providerHomeLeaseTarget({
      driver: "codex-app-server", command: "codex", context,
      env: agentTuiProviderHomeEnv({ context, env }, runnerEnv, platform),
    })?.home;
  const launched = (env: Record<string, string>, runnerEnv: NodeJS.ProcessEnv) =>
    windowsEnvironmentForLaunch(env, [], runnerEnv).find((entry) => /^codex_home=/i.test(entry))?.split("=")[1];
  for (const [env, runnerEnv] of [
    [{ codex_home: "/selected" }, { CODEX_HOME: "/runner" }],
    [{}, { Codex_Home: "/runner" }],
    [{ CODEX_HOME: "/selected" }, { codex_home: "/runner" }],
  ] as const) {
    const expected = launched(env, runnerEnv);
    assert.ok(expected);
    assert.equal(lease(env, runnerEnv, "win32"), expected, JSON.stringify({ env, runnerEnv }));
  }
  // POSIX names are case-sensitive: a lowercase variable is not the provider's home.
  assert.equal(lease({ codex_home: "/selected" }, { CODEX_HOME: "/runner" }, "linux"), "/runner");
});

test("an ordinary TUI without an account binding keeps the runner-local environment (#3338)", async () => {
  const h = fixture("claude", { account: false });
  try {
    const launch = await prepareAgentTuiLaunch(h.persisted(), h.dependencies);
    assert.ok(launch);
    assert.deepEqual(launch.env, { HOME: h.root, AGENT_SETTING: "runner-local" });
    assert.deepEqual(h.persisted().env, {});
    await launch.providerHome?.settle(true);
  } finally { h.cleanup(); }
});

test("a WSL session's ordinary TUI resolves its account and is refused by the shared-home lease before launch", async () => {
  const h = fixture("codex", { context: { kind: "wsl", distro: "Ubuntu" } });
  try {
    let guards = 0;
    await assert.rejects(prepareAgentTuiLaunch(h.persisted(), {
      ...h.dependencies,
      provisionManagedWorktreeGuard: (spec) => { guards++; return { protections: [], args: spec.args, guardActive: false }; },
    }), /shared codex provider home in WSL cannot be safely owner-leased/);
    assert.equal(guards, 0, "nothing is prepared after the refusal");
    assert.deepEqual(h.registry.homes, []);
    assert.deepEqual(h.persisted().env, {});
  } finally { h.cleanup(); }
});

test("an ordinary Claude TUI inherits the runner's plugins into the session's account home (#3338)",
  { skip: process.platform === "win32" }, async () => {
    const h = fixture("claude");
    try {
      // The runner user's default Claude installation, under the agent environment's HOME.
      const installPath = join(h.root, ".claude/plugins/cache/local/review/1.0.0");
      const write = (path: string, value: unknown) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(value));
      };
      write(join(installPath, ".claude-plugin/plugin.json"), { name: "review", version: "1.0.0" });
      write(join(h.root, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: {
        "review@local": [{ scope: "user", installPath, version: "1.0.0", installedAt: "2026-10-01T00:00:00.000Z",
          lastUpdated: "2026-10-01T00:00:00.000Z" }],
      } });
      write(join(h.root, ".claude/settings.json"), { enabledPlugins: { "review@local": true } });
      const launch = await prepareAgentTuiLaunch(h.persisted(), h.dependencies);
      assert.ok(launch);
      const inherited = JSON.parse(readFileSync(join(h.account, "plugins/installed_plugins.json"), "utf8"));
      assert.ok(inherited.plugins["review@local"], "the account home received the runner's plugin");
      await launch.providerHome?.settle(true);
    } finally { h.cleanup(); }
  });
