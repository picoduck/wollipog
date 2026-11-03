import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import {
  agentForProviderAccount,
  agentsWithoutConfiguredProviderAccounts,
  bindSessionProviderAccount,
  mergeProviderAccountAuthStatus,
  providerAccountAgentContextCompatible,
  providerAccountDefinition,
  providerAccountEnvironment,
  probeProviderAccountsForDiscovery,
  projectProviderAccountDiscoveryReadiness,
  selectProviderAccount,
  selectProviderAccountForDiscovery,
  skillReconciliationProviderAccountPlan,
} from "./provider-accounts.js";
import { unavailableClaudeCode } from "./discovery/claude-code.js";

const claudeAgent = {
  id: "claude", name: "Claude", command: "claude", args: [], env: {},
  driver: "claude-code" as const, context: { kind: "native" as const },
};
const codexAgent = {
  id: "codex", name: "Codex", command: "codex", args: [], env: {},
  driver: "codex-app-server" as const, context: { kind: "native" as const },
};

test("discovery selects a usable persistent account and never falls back from an inaccessible default", () => {
  const accounts = [
    { id: "other", label: "Other", provider: "codex" as const, directory: "/profiles/other" },
    { id: "own", label: "Own", provider: "codex" as const, directory: "/profiles/own" },
  ];
  const usable = (account: { id: string }) => account.id === "own";
  assert.equal(selectProviderAccount(accounts, codexAgent, "codex-app-server", undefined, "linux")?.id, "other");
  assert.throws(() => selectProviderAccountForDiscovery(accounts, codexAgent, usable, "linux"), /not granted/,
    "discovery cannot silently skip the account an implicit launch would choose");
  assert.equal(selectProviderAccountForDiscovery(accounts, { ...codexAgent, defaultProviderAccountId: "own" }, usable, "linux")?.credentialHome, "/profiles/own");
  assert.throws(() => selectProviderAccountForDiscovery(accounts, { ...codexAgent, defaultProviderAccountId: "other" }, usable, "linux"), /not granted/);
  assert.throws(() => selectProviderAccountForDiscovery(accounts, codexAgent, () => false, "linux"), /not granted/);
  assert.equal(selectProviderAccountForDiscovery([], codexAgent, usable, "linux"), undefined, "only an account-free launch uses the legacy HOME");
});

for (const provider of ["claude", "codex"] as const) {
  test(`a signed-out default ${provider} account does not suppress another granted account's probe or readiness`, async () => {
    const accounts = [
      { id: "a", label: "Expired", provider, directory: join(tmpdir(), "fixture-account-a") },
      { id: "b", label: "Ready", provider, directory: join(tmpdir(), "fixture-account-b") },
      { id: "ungranted", label: "Ungrant", provider, directory: join(tmpdir(), "fixture-account-ungranted") },
    ];
    const agent = provider === "claude"
      ? { ...claudeAgent, available: false, authStatus: "unauthenticated" as const, defaultProviderAccountId: "a",
          claudeCode: { ...unavailableClaudeCode(), status: "unauthenticated" as const, streamJsonInput: true,
            permissionModes: ["acceptEdits", "plan"], controlProtocol: true,
            auth: { status: "unauthenticated" as const, billingSource: "unknown" as const } } }
      : { ...codexAgent, available: false, authStatus: "unauthenticated" as const, defaultProviderAccountId: "a",
          codexAppServer: { status: "supported" as const, appServerAvailable: true } };
    const observed: string[] = [];
    const statuses = await probeProviderAccountsForDiscovery({ accounts, agents: [agent],
      usable: (account) => account.id !== "ungranted", environment: () => ({ HOME: "/runner", PRIVATE_FIXTURE_KEY: "fixture" }),
      probe: async (_agent, env) => {
        const home = provider === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
        observed.push(home!);
        return home === accounts[0]!.directory ? "unauthenticated" : "authenticated";
      },
    });
    assert.deepEqual(observed.sort(), accounts.slice(0, 2).map((account) => account.directory).sort());
    assert.deepEqual([...statuses].sort(), [["a", "unauthenticated"], ["b", "authenticated"], ["ungranted", "unknown"]]);
    const projected = projectProviderAccountDiscoveryReadiness([agent], accounts, statuses, (account) => account.id !== "ungranted")[0]!;
    assert.equal(projected.available, true, "the harness remains selectable for the ready account");
    assert.equal(projected.authStatus, "authenticated");
    assert.equal(projected.defaultProviderAccountId, "a", "readiness must never rewrite the saved default");
    assert.equal(agent.available, false, "the original observation is not mutated");
    if (provider === "claude") assert.equal(projected.claudeCode?.status, "ready");
  });
}

test("an unsupported installation cannot probe accounts or be resurrected by stored account status", async () => {
  const agent = { ...codexAgent, available: false, codexAppServer: { status: "unsupported" as const, appServerAvailable: true } };
  const accounts = [{ id: "ready", label: "Ready", provider: "codex" as const, directory: join(tmpdir(), "fixture-account-ready") }];
  const statuses = await probeProviderAccountsForDiscovery({ accounts, agents: [agent], usable: () => true,
    environment: () => ({}), probe: async () => { throw new Error("unsupported executable must never run"); } });
  assert.equal(statuses.get("ready"), "unknown");
  assert.equal(projectProviderAccountDiscoveryReadiness([agent], accounts, new Map([["ready", "authenticated"]]), () => true)[0], agent);
});

test("account readiness remains gated when all accounts are signed out or ungranted, and account-free legacy observations stay intact", () => {
  const agent = { ...codexAgent, available: true, authStatus: "authenticated" as const,
    codexAppServer: { status: "supported" as const, appServerAvailable: true } };
  const accounts = [{ id: "a", label: "A", provider: "codex" as const, directory: join(tmpdir(), "fixture-account-a") }];
  const signedOut = projectProviderAccountDiscoveryReadiness([agent], accounts, new Map([["a", "unauthenticated"]]), () => true)[0]!;
  assert.equal(signedOut.available, false);
  assert.equal(signedOut.authStatus, "unauthenticated");
  const ungranted = projectProviderAccountDiscoveryReadiness([agent], accounts, new Map([["a", "authenticated"]]), () => false)[0]!;
  assert.equal(ungranted.available, false);
  assert.equal(ungranted.authStatus, "unknown", "a stored positive observation cannot grant access");
  assert.equal(projectProviderAccountDiscoveryReadiness([agent], [], new Map(), () => true)[0], agent);
});

test("selectProviderAccount honors an explicit account and maps only the provider credential variable", () => {
  const accounts = [
    { id: "work", label: "Work", provider: "codex" as const, directory: "/credentials/work" },
    { id: "personal", label: "Personal", provider: "codex" as const, directory: "/credentials/personal" },
  ];
  const selected = selectProviderAccount(accounts, {
    id: "codex-app",
    driver: "codex-app-server",
    defaultProviderAccountId: "work",
  }, "codex-app-server", "personal");
  assert.deepEqual(selected, {
    id: "personal",
    label: "Personal",
    provider: "codex",
    credentialHome: "/credentials/personal",
  });
  assert.deepEqual(providerAccountEnvironment(selected!), { CODEX_HOME: "/credentials/personal" });
});

test("selectProviderAccount carries a configured profile id without changing the environment", () => {
  const profileId = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  const accounts = [
    { id: "work", label: "Work", provider: "codex" as const, directory: "/credentials/work", profileId },
    { id: "personal", label: "Personal", provider: "codex" as const, directory: "/credentials/personal" },
  ];
  const work = selectProviderAccount(accounts, codexAgent, "codex-app-server", "work");
  assert.deepEqual(work, { id: "work", label: "Work", provider: "codex", credentialHome: "/credentials/work", profileId });
  assert.deepEqual(providerAccountEnvironment(work!), { CODEX_HOME: "/credentials/work" });
  const personal = selectProviderAccount(accounts, codexAgent, "codex-app-server", "personal");
  assert.equal(Object.hasOwn(personal!, "profileId"), false);
});

test("selectProviderAccount preserves legacy default-home behavior when no accounts are configured", () => {
  assert.equal(selectProviderAccount([], { id: "claude", driver: "claude-code" }, "claude-code"), undefined);
});

test("WSL agents do not inherit a host-path account without an explicit or configured binding", () => {
  const accounts = [
    { id: "work", label: "Work", provider: "claude" as const, directory: "C:\\credentials\\work" },
  ];
  const wsl = {
    id: "claude-wsl", driver: "claude-code" as const,
    context: { kind: "wsl" as const, distro: "Ubuntu" },
  };
  assert.equal(selectProviderAccount(accounts, wsl, "claude-code"), undefined);
  assert.equal(selectProviderAccount(accounts, undefined, "claude-code"), undefined);
  assert.throws(
    () => selectProviderAccount(accounts, wsl, "claude-code", "work", "win32"),
    /provider account 'work' is incompatible with the selected WSL execution context/,
  );
  assert.throws(
    () => selectProviderAccount(
      accounts,
      { ...wsl, defaultProviderAccountId: "work" },
      "claude-code",
      undefined,
      "win32",
    ),
    /provider account 'work' is incompatible with the selected WSL execution context/,
  );
});

test("foreground account selection rejects mixed contexts without exposing credential homes", () => {
  const accounts = [
    { id: "host", label: "Host", provider: "codex" as const, directory: "C:\\credentials\\host-secret" },
    { id: "wsl", label: "WSL", provider: "codex" as const, directory: "/home/operator/secret-codex" },
  ];
  const native = { ...codexAgent, defaultProviderAccountId: "wsl" };
  const wsl = {
    ...codexAgent,
    id: "codex-wsl",
    context: { kind: "wsl" as const, distro: "Ubuntu" },
    defaultProviderAccountId: "host",
  };

  for (const select of [
    () => selectProviderAccount(accounts, native, "codex-app-server", "wsl", "win32"),
    () => selectProviderAccount(accounts, native, "codex-app-server", undefined, "win32"),
    () => selectProviderAccount(
      [accounts[1]!],
      { ...native, defaultProviderAccountId: undefined },
      "codex-app-server",
      undefined,
      "win32",
    ),
  ]) {
    assert.throws(select, (error: unknown) => {
      assert.equal(
        (error as Error).message,
        "provider account 'wsl' is incompatible with the selected native execution context",
      );
      assert.doesNotMatch((error as Error).message, /secret-codex|\/home\/operator/);
      return true;
    });
  }
  for (const select of [
    () => selectProviderAccount(accounts, wsl, "codex-app-server", "host", "win32"),
    () => selectProviderAccount(accounts, wsl, "codex-app-server", undefined, "win32"),
  ]) {
    assert.throws(select, (error: unknown) => {
      assert.equal(
        (error as Error).message,
        "provider account 'host' is incompatible with the selected WSL execution context",
      );
      assert.doesNotMatch((error as Error).message, /host-secret|credentials/);
      return true;
    });
  }
});

test("foreground account selection preserves compatible native and WSL environments", () => {
  const accounts = [
    { id: "wsl", label: "WSL", provider: "codex" as const, directory: "/home/operator/.codex-work" },
    { id: "host", label: "Host", provider: "codex" as const, directory: "C:\\credentials\\work" },
  ];
  const native = { ...codexAgent, defaultProviderAccountId: "host" };
  const wsl = {
    ...codexAgent,
    id: "codex-wsl",
    context: { kind: "wsl" as const, distro: "Ubuntu" },
    defaultProviderAccountId: "wsl",
  };

  const explicitNative = selectProviderAccount(accounts, native, "codex-app-server", "host", "win32");
  const defaultNative = selectProviderAccount(accounts, native, "codex-app-server", undefined, "win32");
  const explicitWsl = selectProviderAccount(accounts, wsl, "codex-app-server", "wsl", "win32");
  const defaultWsl = selectProviderAccount(accounts, wsl, "codex-app-server", undefined, "win32");
  assert.deepEqual(providerAccountEnvironment(explicitNative!), { CODEX_HOME: "C:\\credentials\\work" });
  assert.deepEqual(providerAccountEnvironment(defaultNative!), { CODEX_HOME: "C:\\credentials\\work" });
  assert.deepEqual(providerAccountEnvironment(explicitWsl!), { CODEX_HOME: "/home/operator/.codex-work" });
  assert.deepEqual(providerAccountEnvironment(defaultWsl!), { CODEX_HOME: "/home/operator/.codex-work" });
  assert.equal(
    selectProviderAccount(accounts, { ...native, defaultProviderAccountId: undefined }, "codex-app-server", undefined, "win32")?.id,
    "host",
    "implicit native selection skips the earlier WSL-local account",
  );
});

test("partial account configuration preserves the other provider's legacy harness", () => {
  assert.deepEqual(
    agentsWithoutConfiguredProviderAccounts([claudeAgent, codexAgent], [{ provider: "codex" }])
      .map((agent) => agent.id),
    ["claude"],
  );
});

test("skill reconciliation keeps account homes active while older peers receive unscoped rows", () => {
  const accounts = [
    { id: "work", label: "Work", provider: "codex" as const, directory: "/credentials/work" },
    { id: "personal", label: "Personal", provider: "codex" as const, directory: "/credentials/personal" },
  ];
  const legacy = skillReconciliationProviderAccountPlan([claudeAgent, codexAgent], accounts, false);
  assert.deepEqual(legacy.baseAgents.map((agent) => agent.id), ["claude"]);
  assert.deepEqual(legacy.accountScopes.map(({ account, providerAccountId }) => [
    account.directory,
    providerAccountId,
  ]), [
    ["/credentials/work", undefined],
    ["/credentials/personal", undefined],
  ]);

  const scoped = skillReconciliationProviderAccountPlan([claudeAgent, codexAgent], accounts, true);
  assert.deepEqual(scoped.accountScopes.map(({ providerAccountId }) => providerAccountId), [
    "work",
    "personal",
  ]);
});

test("background account work selects only a context compatible with the credential home", () => {
  const wsl = { ...claudeAgent, id: "claude-wsl", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const hostAccount = { id: "work", provider: "claude" as const, directory: "C:\\credentials\\work" };
  assert.equal(providerAccountAgentContextCompatible(hostAccount, claudeAgent, "win32"), true);
  assert.equal(providerAccountAgentContextCompatible(hostAccount, wsl, "win32"), false);
  assert.equal(agentForProviderAccount([wsl, claudeAgent], hostAccount, undefined, "win32")?.id, "claude");
  assert.equal(agentForProviderAccount([
    { ...wsl, defaultProviderAccountId: "work" }, claudeAgent,
  ], hostAccount, undefined, "win32")?.id, "claude",
  "an explicit WSL default cannot pull a host credential path across contexts");
  assert.equal(agentForProviderAccount([wsl], hostAccount, undefined, "win32"), undefined);
});

test("background account work supports unambiguous and explicit WSL-local homes", () => {
  const ubuntu = { ...claudeAgent, id: "claude-ubuntu", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const debian = { ...claudeAgent, id: "claude-debian", context: { kind: "wsl" as const, distro: "Debian" } };
  const account = { id: "work", provider: "claude" as const, directory: "/home/operator/.claude-work" };
  assert.equal(agentForProviderAccount([ubuntu], account, undefined, "win32")?.id, "claude-ubuntu");
  assert.equal(agentForProviderAccount([ubuntu, debian], account, undefined, "win32"), undefined,
    "a POSIX path alone cannot identify one of several WSL distributions");
  assert.equal(agentForProviderAccount([
    ubuntu, { ...debian, defaultProviderAccountId: "work" },
  ], account, undefined, "win32")?.id, "claude-debian");
  assert.equal(agentForProviderAccount([ubuntu], account, undefined, "linux"), undefined,
    "a non-Windows runner never treats WSL as a local credential context");
  assert.equal(agentForProviderAccount([claudeAgent], account, undefined, "linux")?.id, "claude");
});

test("account probes prefer an available native harness over a retired configured entry", () => {
  const retired = { ...codexAgent, id: "codex-native", driver: "codex" as const, available: false };
  const working = { ...codexAgent, id: "codex-app", available: true };
  const account = { id: "work", provider: "codex" as const, directory: "/credentials/work" };
  assert.equal(agentForProviderAccount([retired, working], account)?.id, "codex-app");
  assert.equal(agentForProviderAccount([retired, working], { id: "work", provider: "codex" })?.id, "codex-app");
  assert.equal(agentForProviderAccount([retired], account)?.id, "codex-native",
    "retain an unavailable result when no working native alternative exists");
  assert.equal(agentForProviderAccount([retired, working], account, ["codex"])?.id, "codex-native",
    "an available alternative must still satisfy the caller's driver restriction");
});

test("available native alternatives preserve explicit account defaults and WSL ambiguity", () => {
  const native = { ...codexAgent, available: true };
  const account = { id: "work", provider: "codex" as const, directory: "/credentials/work" };
  const ubuntu = { ...codexAgent, id: "ubuntu", available: false, context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const debian = { ...codexAgent, id: "debian", available: true, context: { kind: "wsl" as const, distro: "Debian" } };
  assert.equal(agentForProviderAccount([
    { ...ubuntu, defaultProviderAccountId: "work" }, native,
  ], account, undefined, "win32")?.id, "ubuntu", "do not switch away from an explicit credential context");
  assert.equal(agentForProviderAccount([ubuntu, debian], account, undefined, "win32"), undefined,
    "availability does not prove which distro owns a POSIX credential path");
  assert.equal(agentForProviderAccount([
    { ...codexAgent, id: "explicit", available: false, defaultProviderAccountId: "work" }, native,
  ], account)?.id, "explicit", "retain the explicit configured preference");
});

test("secret-free account definitions retain legacy target-context selection", () => {
  const first = { ...claudeAgent, id: "claude-ubuntu", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const second = { ...claudeAgent, id: "claude-debian", context: { kind: "wsl" as const, distro: "Debian" } };
  assert.equal(agentForProviderAccount(
    [first, second],
    { id: "work", provider: "claude" },
    undefined,
    "win32",
  )?.id, "claude-ubuntu");
});

test("account login observations are isolated to each credential home", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-accounts-"));
  const signedIn = join(root, "signed-in");
  const signedOut = join(root, "signed-out");
  mkdirSync(signedIn);
  mkdirSync(signedOut);
  writeFileSync(join(signedIn, "auth.json"), "{}");
  assert.equal(providerAccountDefinition({ id: "a", label: "A", provider: "codex", directory: signedIn }).authStatus, "authenticated");
  assert.equal(providerAccountDefinition({ id: "b", label: "B", provider: "codex", directory: signedOut }).authStatus, "unauthenticated");
  assert.equal(mergeProviderAccountAuthStatus(
    { id: "b", label: "B", provider: "codex", directory: signedOut },
    "unknown",
  ), "unauthenticated");
  assert.equal(providerAccountDefinition({
    id: "wsl", label: "WSL", provider: "codex", directory: "/home/operator/.codex-work",
  }, "win32").authStatus, "unknown", "the Windows host cannot inspect an in-distro marker");
});

test("a persisted session keeps its exact credential home across runner config changes", () => {
  const prior = {
    providerAccountId: "work",
    providerAccountLabel: "Work",
    providerAccountProvider: "codex",
    providerCredentialHome: "/old/codex-home",
  } as never;
  const spec: SessionLaunchSpec = {
    sessionId: "session-1",
    workspaceId: "workspace",
    workspacePath: "/repo",
    agentId: "codex",
    command: "codex",
    args: [],
    env: {},
    useWorktree: false,
    driver: "codex-app-server",
    providerAccountId: "work",
  };
  const binding = bindSessionProviderAccount(prior, spec, () => ({
    id: "work",
    label: "Work",
    provider: "codex",
    credentialHome: "/new/codex-home",
  }));
  assert.equal(binding?.credentialHome, "/old/codex-home");
});

test("a legacy persisted session stays on its original default home after accounts are configured", () => {
  const prior = { sessionId: "session-legacy" } as never;
  const spec = {
    sessionId: "session-legacy", driver: "codex-app-server",
  } as SessionLaunchSpec;
  assert.equal(bindSessionProviderAccount(prior, spec, () => ({
    id: "work", label: "Work", provider: "codex", credentialHome: "/accounts/work",
  })), undefined);
});

test("container and cloud launches never bind runner-local provider accounts", () => {
  const prior = {
    providerAccountId: "work",
    providerAccountLabel: "Work",
    providerAccountProvider: "codex",
    providerCredentialHome: "/old/codex-home",
  } as never;
  for (const adapter of ["container", "cloud"] as const) {
    const spec = {
      sessionId: `session-${adapter}`,
      workspaceId: "workspace",
      workspacePath: "/repo",
      agentId: "codex",
      command: "codex",
      args: [],
      env: {},
      useWorktree: false,
      driver: "codex-app-server",
      providerAccountId: "work",
      executionTarget: { adapter },
    } as unknown as SessionLaunchSpec;
    assert.equal(bindSessionProviderAccount(prior, spec, () => ({
      id: "work",
      label: "Work",
      provider: "codex",
      credentialHome: "/new/codex-home",
    })), undefined);
  }
});
