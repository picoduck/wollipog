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
  providerAccountDefinition,
  providerAccountEnvironment,
  selectProviderAccount,
} from "./provider-accounts.js";

const claudeAgent = {
  id: "claude", name: "Claude", command: "claude", args: [], env: {},
  driver: "claude-code" as const, context: { kind: "native" as const },
};
const codexAgent = {
  id: "codex", name: "Codex", command: "codex", args: [], env: {},
  driver: "codex-app-server" as const, context: { kind: "native" as const },
};

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

test("selectProviderAccount preserves legacy default-home behavior when no accounts are configured", () => {
  assert.equal(selectProviderAccount([], { id: "claude", driver: "claude-code" }, "claude-code"), undefined);
});

test("partial account configuration preserves the other provider's legacy harness", () => {
  assert.deepEqual(
    agentsWithoutConfiguredProviderAccounts([claudeAgent, codexAgent], [{ provider: "codex" }])
      .map((agent) => agent.id),
    ["claude"],
  );
});

test("background account work prefers an explicit default, then a native agent", () => {
  const wsl = { ...claudeAgent, id: "claude-wsl", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  assert.equal(agentForProviderAccount([wsl, claudeAgent], { id: "work", provider: "claude" })?.id, "claude");
  assert.equal(agentForProviderAccount([
    { ...wsl, defaultProviderAccountId: "work" }, claudeAgent,
  ], { id: "work", provider: "claude" })?.id, "claude-wsl");
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
