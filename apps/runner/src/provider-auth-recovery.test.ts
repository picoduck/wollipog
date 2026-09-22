import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  compareProviderAuthIdentity,
  createRunnerProviderAuthRecovery,
  createTestProviderAuthRecovery,
  describeProviderAuthIdentityMismatch,
  mergeProviderAuthIdentityEvidence,
  describeProviderCredentialScope,
} from "./provider-auth-recovery.js";
import { writeRunnerCredentialFile } from "./runner-credential-file.js";
import type { SessionMeta } from "./session-store.js";
import type { AgentProcess } from "./spawn.js";
import type { ProviderLoginSupervisor, ResolvedProviderLogin } from "./provider-login.js";

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

test("provider account homes produce independent authentication scopes without exposing their paths", () => {
  const key = "runner-local-hmac-key";
  const work = describeProviderCredentialScope(meta({
    providerAccountId: "work",
    providerAccountLabel: "Work",
    providerAccountProvider: "codex",
    providerCredentialHome: "/credentials/work",
    env: { CODEX_HOME: "/credentials/work" },
  }), key)!;
  const personal = describeProviderCredentialScope(meta({
    providerAccountId: "personal",
    providerAccountLabel: "Personal",
    providerAccountProvider: "codex",
    providerCredentialHome: "/credentials/personal",
    env: { CODEX_HOME: "/credentials/personal" },
  }), key)!;
  assert.notEqual(work.id, personal.id);
  assert.equal(work.provider, "codex");
  assert.equal(personal.provider, "codex");
  assert.doesNotMatch(`${work.id}${personal.id}`, /credentials|work|personal/);
});

test("Claude status derives only an opaque account identity and never returns provider output", async () => {
  const controller = createTestProviderAuthRecovery(async (_context, command, args, options) => {
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

test("runner auth evidence survives transport credential rotation and controller reconstruction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wollipog-auth-evidence-"));
  const results = [
    { loggedIn: true, email: "stable@example.test", orgId: "stable-org", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "stable@example.test", orgId: "stable-org", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "stable@example.test", orgId: "stable-org", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "changed@example.test", orgId: "stable-org", authMethod: "claude.ai", apiProvider: "firstParty" },
  ];
  const run = async () => ({ stdout: JSON.stringify(results.shift()!), stderr: "" });
  const session = meta({ driver: "claude-code", command: "claude" });
  const evidenceKeyFile = join(dir, "credentials", "provider-auth-evidence-hmac.key");
  try {
    writeRunnerCredentialFile(dir, "transport-token-before-rotation");
    const legacyRecorded = await createTestProviderAuthRecovery(
      run,
      "transport-token-before-rotation",
    ).revalidate(session);
    const config = { dataDir: dir, token: "transport-token-before-rotation" };
    const initialController = createRunnerProviderAuthRecovery(config, run);
    const recordedScope = initialController.describe(session);
    const recorded = await initialController.revalidate(session);
    assert.equal(legacyRecorded.identityEvidence?.version, 1);
    assert.equal(recorded.identityEvidence?.version, 2);
    const migration = compareProviderAuthIdentity(
      legacyRecorded.identityId,
      legacyRecorded.identityEvidence,
      recorded,
    );
    assert.equal(migration.matches, false,
      "legacy transport-keyed evidence must fail closed until the current account is accepted");
    assert.equal(migration.evidenceGenerationMismatch, true);
    assert.deepEqual(migration.differingFields, []);
    assert.match(describeProviderAuthIdentityMismatch(migration), /previous evidence-key generation/iu);
    assert.doesNotMatch(describeProviderAuthIdentityMismatch(migration), /email differed/iu);

    const stableKey = await readFile(evidenceKeyFile);
    const priorStable = await createTestProviderAuthRecovery(
      async () => ({
        stdout: JSON.stringify({
          loggedIn: true,
          email: "stable@example.test",
          orgId: "stable-org",
          authMethod: "claude.ai",
          apiProvider: "firstParty",
        }),
        stderr: "",
      }),
      stableKey,
    ).revalidate(session);
    assert.equal(
      compareProviderAuthIdentity(priorStable.identityId, priorStable.identityEvidence, recorded).matches,
      true,
      "an exact stable-key v1 identity upgrades to v2 without another account prompt",
    );
    const partialStable = await createTestProviderAuthRecovery(
      async () => ({
        stdout: JSON.stringify({
          loggedIn: true,
          email: "stable@example.test",
          orgId: null,
          authMethod: null,
          apiProvider: null,
        }),
        stderr: "",
      }),
      stableKey,
      {},
      2,
    ).revalidate(session);
    const partialUpgrade = compareProviderAuthIdentity(
      priorStable.identityId,
      priorStable.identityEvidence,
      partialStable,
    );
    assert.equal(partialUpgrade.matches, true,
      "a partial v2 observation can prove a stable-key v1 identity from a shared account anchor");
    assert.equal(partialUpgrade.evidenceGenerationMismatch, false);
    assert.deepEqual(
      mergeProviderAuthIdentityEvidence(priorStable.identityEvidence, partialStable.identityEvidence),
      { version: 2, fields: priorStable.identityEvidence?.fields },
      "the upgrade retains previously observed fields while adopting the current generation",
    );

    const changedAcrossUpgrade = await createTestProviderAuthRecovery(
      async () => ({
        stdout: JSON.stringify({
          loggedIn: true,
          email: "changed@example.test",
          orgId: "stable-org",
          authMethod: "claude.ai",
          apiProvider: "firstParty",
        }),
        stderr: "",
      }),
      stableKey,
      {},
      2,
    ).revalidate(session);
    const changedUpgrade = compareProviderAuthIdentity(
      priorStable.identityId,
      priorStable.identityEvidence,
      changedAcrossUpgrade,
    );
    assert.equal(changedUpgrade.matches, false);
    assert.equal(changedUpgrade.evidenceGenerationMismatch, false);
    assert.deepEqual(changedUpgrade.differingFields, ["email"]);
    assert.match(describeProviderAuthIdentityMismatch(changedUpgrade), /email differed/iu);
    const rollback = compareProviderAuthIdentity(recorded.identityId, recorded.identityEvidence, priorStable);
    assert.equal(rollback.matches, false, "rolling v2 evidence back to v1 must fail closed");
    assert.equal(rollback.evidenceGenerationMismatch, true);

    writeRunnerCredentialFile(dir, "transport-token-after-rotation");
    config.token = "transport-token-after-rotation";
    const reconstructed = createRunnerProviderAuthRecovery(config, run);
    assert.equal(reconstructed.describe(session)?.id, recordedScope?.id);
    const unchanged = await reconstructed.revalidate(session);
    assert.equal(
      compareProviderAuthIdentity(recorded.identityId, recorded.identityEvidence, unchanged).matches,
      true,
      "transport credential rotation must not change account evidence",
    );

    const changed = await reconstructed.revalidate(session);
    const mismatch = compareProviderAuthIdentity(recorded.identityId, recorded.identityEvidence, changed);
    assert.equal(mismatch.matches, false);
    assert.deepEqual(mismatch.differingFields, ["email"]);

    const key = await readFile(evidenceKeyFile);
    assert.equal(key.length, 32);
    if (process.platform !== "win32") assert.equal((await stat(evidenceKeyFile)).mode & 0o777, 0o600);
    await writeFile(evidenceKeyFile, "malformed");
    assert.throws(
      () => createRunnerProviderAuthRecovery(config, run),
      /provider authentication evidence key is malformed/,
      "a damaged key must fail closed instead of silently rotating every persisted digest",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("partial Claude account observations compare by shared redacted fields without hiding real changes", async () => {
  const results = [
    { loggedIn: true, email: "private@example.test", orgId: "private-org", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "private@example.test", authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, email: "other@example.test", authMethod: "claude.ai", apiProvider: "firstParty" },
  ];
  const controller = createTestProviderAuthRecovery(async () => ({
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
    evidenceGenerationMismatch: false,
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
    const controller = createTestProviderAuthRecovery(undefined, "runner-local-hmac-key");
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
  const controller = createTestProviderAuthRecovery(undefined, "runner-local-hmac-key", {
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
  const denied = createTestProviderAuthRecovery(async () => {
    throw Object.assign(new Error("logged out"), {
      code: 1,
      stdout: JSON.stringify({ loggedIn: false }),
    });
  });
  const unsupported = createTestProviderAuthRecovery(async () => {
    throw Object.assign(new Error("unsupported auth status"), { code: 1, stdout: "usage: claude" });
  });
  const unavailable = createTestProviderAuthRecovery(async () => {
    throw Object.assign(new Error("spawn failed with sensitive diagnostics"), { code: "ENOENT" });
  });
  assert.equal((await denied.revalidate(meta({ driver: "claude-code", command: "claude" }))).status, "unauthenticated");
  assert.equal((await unsupported.revalidate(meta({ driver: "claude-code", command: "claude" }))).status, "unknown");
  assert.equal((await denied.revalidate(meta())).status, "unknown", "Codex exit codes alone are not auth evidence");
  assert.equal((await unavailable.revalidate(meta())).status, "unknown");
});

test("in-app login requires supervised native availability and remote targets stay fail-closed", () => {
  assert.equal(describeProviderCredentialScope(meta())?.canStartLogin, false,
    "the capability is not advertised without the supervised login boundary");
  assert.equal(describeProviderCredentialScope(meta(), undefined, true)?.canStartLogin, true);
  assert.equal(describeProviderCredentialScope(
    meta({ context: { kind: "wsl", distro: "Ubuntu" } }), undefined, true,
  )?.canStartLogin, false);
  assert.equal(describeProviderCredentialScope(
    meta({ env: { OPENAI_API_KEY: "secret" } }), undefined, true,
  )?.canStartLogin, false);
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

test("Authentication Required Sign In reuses and can cancel the supervised account login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wollipog-auth-login-"));
  let started: ResolvedProviderLogin | undefined;
  let cancelledAccount: string | undefined;
  let active = false;
  let finish!: (status: "completed" | "cancelled" | "failed") => void;
  const completion = new Promise<"completed" | "cancelled" | "failed">((resolve) => { finish = resolve; });
  const supervisor = {
    startResolved(resolved: ResolvedProviderLogin) {
      if (active) throw new Error("A sign-in is already running for this account.");
      active = true;
      started = resolved;
      return {
        view: {
          operationId: "login_test",
          accountId: resolved.accountId,
          label: resolved.label,
          provider: resolved.provider,
          status: "starting" as const,
          expectsCode: false,
          startedAt: 1,
        },
        completion,
      };
    },
    cancelAccount(accountId: string) {
      cancelledAccount = accountId;
      active = false;
      finish("cancelled");
      return true;
    },
  } as unknown as ProviderLoginSupervisor;
  try {
    const controller = createRunnerProviderAuthRecovery({ dataDir: dir }, undefined, supervisor);
    const session = meta({
      driver: "codex-app-server",
      providerAccountId: "personal",
      providerAccountLabel: "Personal",
      providerAccountProvider: "codex",
      providerCredentialHome: join(dir, "personal"),
      env: { CODEX_HOME: join(dir, "personal") },
    });
    const scope = controller.describe(session)!;
    assert.equal(scope.canStartLogin, true);
    const result = controller.startLogin(session);
    await nextTask();
    assert.equal(started?.accountId, "personal");
    assert.equal(started?.sessionId, session.sessionId);
    assert.equal(started?.directory, session.env.CODEX_HOME);
    assert.equal(started?.persistAccount, false);
    assert.equal(started?.structuredCodex, true);
    assert.equal(await controller.startLogin({ ...session, sessionId: "duplicate-session" }), "failed");
    assert.equal(controller.cancel(scope.id), true);
    assert.equal(cancelledAccount, "personal");
    assert.equal(await result, "cancelled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
