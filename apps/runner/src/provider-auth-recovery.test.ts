import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NativeProviderAuthRecovery,
  describeProviderCredentialScope,
} from "./provider-auth-recovery.js";
import type { SessionMeta } from "./session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "session",
    agentId: "agent",
    workspaceId: null,
    repoPath: "/repo",
    worktreePath: null,
    driver: "codex",
    command: "/usr/bin/codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "thread",
    status: "idle",
    title: "session",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("credential scope unifies Codex transports but separates install, distro, and configured sources", () => {
  const key = "runner-local-hmac-key";
  const exec = describeProviderCredentialScope(meta({ driver: "codex" }), key)!;
  const appServer = describeProviderCredentialScope(meta({ driver: "codex-app-server" }), key)!;
  assert.equal(exec.id, appServer.id);
  assert.notEqual(exec.id, describeProviderCredentialScope(meta({ command: "/opt/codex" }), key)?.id);
  assert.notEqual(exec.id, describeProviderCredentialScope(meta({ context: { kind: "wsl", distro: "Ubuntu" } }), key)?.id);
  assert.notEqual(
    describeProviderCredentialScope(meta({ context: { kind: "wsl", distro: "Ubuntu" } }), key)?.id,
    describeProviderCredentialScope(meta({ context: { kind: "wsl", distro: "Debian" } }), key)?.id,
  );
  const configured = describeProviderCredentialScope(meta({ env: { OPENAI_API_KEY: "runner-secret" } }), key)!;
  assert.equal(configured.configuredCredential, true);
  assert.equal(configured.canStartLogin, false);
  assert.equal(configured.id.includes("runner-secret"), false);
});

test("Claude status derives only an opaque account identity and never returns provider output", async () => {
  const controller = new NativeProviderAuthRecovery(async (_context, command, args, options) => {
    assert.equal(command, "claude");
    assert.deepEqual(args, ["auth", "status"]);
    assert.notEqual(options.cwd, "/repo", "auth probes use a stable credential context, not a worktree");
    return {
      stdout: JSON.stringify({
        loggedIn: true,
        email: "private@example.test",
        orgId: "private-org",
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        token: "must-not-escape",
      }),
      stderr: "https://private-auth-url.example.test",
    };
  }, "runner-local-hmac-key");
  const observation = await controller.revalidate(meta({ driver: "claude-code", command: "claude" }));
  assert.equal(observation.status, "authenticated");
  assert.match(observation.identityId ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(observation).includes("private"), false);
  assert.equal(JSON.stringify(observation).includes("must-not-escape"), false);
});

test("provider denial is unauthenticated while transport and context failures remain unknown", async () => {
  const denied = new NativeProviderAuthRecovery(async () => {
    throw Object.assign(new Error("logged out"), { code: 1 });
  });
  const unavailable = new NativeProviderAuthRecovery(async () => {
    throw Object.assign(new Error("spawn failed with sensitive diagnostics"), { code: "ENOENT" });
  });
  assert.equal((await denied.revalidate(meta())).status, "unauthenticated");
  assert.equal((await unavailable.revalidate(meta())).status, "unknown");
});

test("in-app login is fail-closed for WSL, configured credentials, and remote targets", () => {
  assert.equal(describeProviderCredentialScope(meta())?.canStartLogin, false, "awaits the issue #17 provider-home lease");
  assert.equal(describeProviderCredentialScope(meta({ context: { kind: "wsl", distro: "Ubuntu" } }))?.canStartLogin, false);
  assert.equal(describeProviderCredentialScope(meta({ env: { OPENAI_API_KEY: "secret" } }))?.canStartLogin, false);
  assert.equal(describeProviderCredentialScope(meta({
    executionTarget: {
      id: "container",
      runnerId: "runner",
      kind: "container",
      workspaceStrategy: "snapshot",
      adapter: "container",
      boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "unknown" },
    },
  }))?.canStartLogin, false);
});
