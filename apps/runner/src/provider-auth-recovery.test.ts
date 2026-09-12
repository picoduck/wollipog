import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  compareProviderAuthIdentity,
  describeProviderAuthIdentityMismatch,
  mergeProviderAuthIdentityEvidence,
  NativeProviderAuthRecovery,
  describeProviderCredentialScope,
} from "./provider-auth-recovery.js";
import type { SessionMeta } from "./session-store.js";
import type { AgentProcess } from "./spawn.js";

function fakeAgentProcess(): AgentProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
  }) as unknown as AgentProcess;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  assert.deepEqual(Object.keys(observation.identityEvidence?.fields ?? {}).sort(),
    ["apiProvider", "authMethod", "email", "orgId"]);
  assert.equal(JSON.stringify(observation).includes("private"), false);
  assert.equal(JSON.stringify(observation).includes("must-not-escape"), false);
});

test("partial Claude account observations compare by shared redacted fields without hiding real changes", async () => {
  const results = [
    { loggedIn: true, email: "private@example.test", orgId: "private-org", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "private@example.test", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "other@example.test", authMethod: "claude.ai", apiProvider: "firstParty" },
  ];
  const controller = new NativeProviderAuthRecovery(async () => ({
    stdout: JSON.stringify(results.shift()),
    stderr: "",
  }), "runner-local-hmac-key");
  const recorded = await controller.revalidate(meta({ driver: "claude-code", command: "claude" }));
  const partial = await controller.revalidate(meta({
    driver: "claude-code",
    command: "claude",
    env: { WOLLIPOG_SESSION_ID: "interactive-context" },
    worktreePath: "/repo/worktree",
  }));
  assert.notEqual(recorded.identityId, partial.identityId,
    "the legacy aggregate digest demonstrates why a missing field used to cause a false mismatch");
  const stable = compareProviderAuthIdentity(recorded.identityId, recorded.identityEvidence, partial);
  assert.equal(stable.matches, true);
  assert.deepEqual(stable.observedMissingFields, ["orgId"]);
  const retained = mergeProviderAuthIdentityEvidence(recorded.identityEvidence, partial.identityEvidence);
  assert.deepEqual(Object.keys(retained?.fields ?? {}).sort(), ["apiProvider", "authMethod", "email", "orgId"]);

  const changed = await controller.revalidate(meta({ driver: "claude-code", command: "claude" }));
  const mismatch = compareProviderAuthIdentity(recorded.identityId, recorded.identityEvidence, changed);
  assert.equal(mismatch.matches, false);
  assert.deepEqual(mismatch.differingFields, ["email"]);
  assert.match(describeProviderAuthIdentityMismatch(mismatch), /email differed/);
  assert.equal(describeProviderAuthIdentityMismatch(mismatch).includes("private@example.test"), false);
  assert.equal(describeProviderAuthIdentityMismatch(mismatch).includes("other@example.test"), false);
  assert.match(describeProviderAuthIdentityMismatch({
    ...mismatch,
    differingFields: [],
    expectedMissingFields: ["email", "orgId"],
    observedMissingFields: ["authMethod", "apiProvider"],
  }), /email, orgId were missing.*authMethod, apiProvider were missing/);
});

test("evidence-free mismatch guidance explains uncertainty and names available recovery actions", () => {
  const guidance = describeProviderAuthIdentityMismatch({
    matches: false,
    evidenceAvailable: false,
    differingFields: [],
    expectedMissingFields: [],
    observedMissingFields: [],
    sharedAccountFields: [],
  });

  assert.match(guidance, /cannot match the current authenticated state to the state recorded for this session/i);
  assert.match(guidance, /cannot determine whether the account changed/i);
  assert.match(guidance, /Choose Use Current Account/);
  assert.match(guidance, /choose Recheck Authentication/);
  assert.match(guidance, /Credential and account values are redacted/);
  assert.doesNotMatch(guidance, /Provider account identity mismatch/);
});

test("identity comparison exhaustively rejects every shared field change and requires a matching account anchor", () => {
  const fields = ["email", "orgId", "authMethod", "apiProvider"] as const;
  for (let expectedMask = 0; expectedMask < 16; expectedMask += 1) {
    for (let observedMask = 0; observedMask < 16; observedMask += 1) {
      const sharedMask = expectedMask & observedMask;
      for (let changedMask = 0; changedMask < 16; changedMask += 1) {
        const expectedFields = Object.fromEntries(fields.flatMap((field, index) =>
          expectedMask & (1 << index) ? [[field, `${field}:same`]] : []));
        const observedFields = Object.fromEntries(fields.flatMap((field, index) =>
          observedMask & (1 << index)
            ? [[field, changedMask & (1 << index) ? `${field}:changed` : `${field}:same`]]
            : []));
        const comparison = compareProviderAuthIdentity(
          "expected-aggregate",
          { version: 1, fields: expectedFields },
          { status: "authenticated", identityId: "observed-aggregate", identityEvidence: { version: 1, fields: observedFields } },
        );
        const hasSharedDifference = fields.some((_, index) =>
          (sharedMask & (1 << index)) !== 0 && (changedMask & (1 << index)) !== 0);
        const hasMatchingAccountAnchor = [0, 1].some((index) =>
          (sharedMask & (1 << index)) !== 0 && (changedMask & (1 << index)) === 0);
        assert.equal(comparison.matches, !hasSharedDifference && hasMatchingAccountAnchor,
          `expected=${expectedMask.toString(2)} observed=${observedMask.toString(2)} changed=${changedMask.toString(2)}`);
      }
    }
  }
});

test("production auth probe spawn scrubs daemon-only credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wollipog-auth-probe-"));
  const script = join(dir, "probe.mjs");
  const prior = process.env.ANTHROPIC_API_KEY;
  try {
    await writeFile(script, [
      "const loggedIn = !process.env.ANTHROPIC_API_KEY;",
      "process.stdout.write(JSON.stringify({ loggedIn, email: loggedIn ? 'account@example.test' : null }));",
    ].join("\n"), { mode: 0o600 });
    process.env.ANTHROPIC_API_KEY = "daemon-only-secret";
    const controller = new NativeProviderAuthRecovery(undefined, "runner-local-hmac-key");
    const observation = await controller.revalidate(meta({
      driver: "claude-code",
      command: process.execPath,
      args: [script],
    }));
    assert.equal(observation.status, "authenticated");
    assert.match(observation.identityId ?? "", /^[a-f0-9]{64}$/);
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider auth probe drains the final status payload after process exit", async () => {
  const child = fakeAgentProcess();
  const controller = new NativeProviderAuthRecovery(undefined, "runner-local-hmac-key", {
    spawn: () => child,
    kill: () => {},
  });
  const observation = controller.revalidate(meta({ driver: "claude-code", command: "claude" }));
  let settled = false;
  void observation.then(() => { settled = true; }, () => { settled = true; });
  child.emit("exit", 0, null);
  await nextTask();
  assert.equal(settled, false, "exit must not resolve before provider stdout closes");
  child.stdout.write(JSON.stringify({ loggedIn: true, email: "account@example.test" }));
  child.emit("close", 0, null);
  assert.equal((await observation).status, "authenticated");
});

test("only structured provider denial is unauthenticated while exit and context failures remain unknown", async () => {
  const denied = new NativeProviderAuthRecovery(async () => {
    throw Object.assign(new Error("logged out"), {
      code: 1,
      stdout: JSON.stringify({ loggedIn: false }),
    });
  });
  const unsupported = new NativeProviderAuthRecovery(async () => {
    throw Object.assign(new Error("unsupported auth status"), { code: 1, stdout: "usage: claude" });
  });
  const unavailable = new NativeProviderAuthRecovery(async () => {
    throw Object.assign(new Error("spawn failed with sensitive diagnostics"), { code: "ENOENT" });
  });
  assert.equal((await denied.revalidate(meta({ driver: "claude-code", command: "claude" }))).status, "unauthenticated");
  assert.equal((await unsupported.revalidate(meta({ driver: "claude-code", command: "claude" }))).status, "unknown");
  assert.equal((await denied.revalidate(meta())).status, "unknown", "Codex exit codes alone are not auth evidence");
  assert.equal((await unavailable.revalidate(meta())).status, "unknown");
});

test("in-app login is fail-closed and remote targets do not claim runner-owned recovery", () => {
  assert.equal(describeProviderCredentialScope(meta())?.canStartLogin, false,
    "login still needs exact-isolation lease acquisition and child supervision");
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
  })), null);
});
