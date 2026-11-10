import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestProviderAuthRecovery, describeProviderCredentialScope } from "./provider-auth-recovery.js";
import type { ProviderLoginSupervisor, ResolvedProviderLogin } from "./provider-login.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "fixture", agentId: "fixture", workspaceId: null, repoPath: "/fixture",
    worktreePath: null, driver: "codex", command: "codex", args: [], env: {},
    context: { kind: "native" }, agentSessionId: "thread", status: "input_required",
    title: "Fixture", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
    pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

// Independently pinned pre-change format, including its intentionally lossy installation selector.
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function legacyScope(m: SessionMeta): string {
  return hash({ version: 1, provider: "codex",
    launch: { command: m.command, bootstrap: /(?:^|[\\/])node(?:\.exe)?$/i.test(m.command) && m.args.length ? [m.args[0]] : [] },
    placement: { context: { kind: "native" }, target: null },
    credentialHome: m.env.CODEX_HOME ?? m.env.HOME ?? "<context-default-home>",
    credentialSource: m.env.OPENAI_API_KEY ? { kind: "environment", names: ["OPENAI_API_KEY"] } : { kind: "provider-home" },
  });
}

const supported: [string, string[]][] = [
  ["codex", []], ["/fixture/codex", []], ["codex.cmd", []],
  ["node", ["codex-entry.js"]], ["node", ["--no-warnings", "--enable-source-maps", "--", "codex-entry.js"]],
  ["npx", ["-y", "@openai/codex"]], ["npx.cmd", ["--offline", "--", "@openai/codex@0.159.2"]],
  ["npm", ["exec", "--yes", "--", "@openai/codex@next"]],
  ["npm", ["x", "--package=@openai/codex@latest", "--", "codex"]],
  ["pnpm", ["dlx", "--silent", "@openai/codex"]], ["pnpx", ["--package", "@openai/codex@latest", "codex"]],
  ["bun", ["x", "--bun", "@openai/codex"]], ["bunx", ["--no-install", "@openai/codex"]],
  ["yarn", ["dlx", "--quiet", "@openai/codex"]],
  ["env", ["codex"]], ["/usr/bin/env", ["--", "node", "--no-warnings", "codex-entry.js"]],
  ["env", ["-u", "UNUSED_FIXTURE", "bunx", "@openai/codex@latest"]],
];
const unsupported: [string, string[]][] = [
  ["private-wrapper", ["SECRET"]], ["sh", ["-c", "SECRET"]], ["node", ["-e", "SECRET"]],
  ["node", ["--no-warnings"]], ["npx", ["--call", "SECRET"]], ["npm", ["exec", "@openai/codex"]],
  ["pnpm", ["exec", "@openai/codex"]], ["bun", ["run", "@openai/codex"]],
  ["yarn", ["dlx", "other-package"]], ["npx", ["@openai/codex@file:SECRET"]],
  ["env", ["HOME=SECRET", "codex"]], ["env", ["-u", "CODEX_HOME", "codex"]],
  ["env", ["env", "codex"]],
];

test("recovery captures complete validated status, inspection and supervised bootstrap for both transports", async (t) => {
  for (const [command, prefix] of supported) for (const driver of ["codex", "codex-app-server"] as const) {
    await t.test(`${command} ${prefix.join(" ")} ${driver}`, async () => {
      const calls: string[][] = [];
      const controller = createTestProviderAuthRecovery(async (_context, actualCommand, args) => {
        assert.equal(actualCommand, command); calls.push(args);
        return { stdout: "Logged in using ChatGPT", stderr: "" };
      });
      let login: ResolvedProviderLogin | undefined;
      const supervisor = { startResolved(value: ResolvedProviderLogin) {
        login = value; return { completion: Promise.resolve("cancelled" as const) };
      } } as unknown as ProviderLoginSupervisor;
      // Inject the supervisor without touching the production key store or running a process.
      Object.assign(controller, { loginSupervisor: supervisor });
      const m = meta({ command, args: [...prefix, "-m", "discard-model", "app-server"], driver,
        agentVersion: "0.155.1", providerAccountId: "fixture-account", env: { CODEX_HOME: "/fixture/account" } });
      assert.equal((await controller.revalidate(m)).status, "authenticated");
      assert.equal((await controller.inspect!(m)).observation.status, "authenticated");
      assert.deepEqual(calls, [[...prefix, "login", "status"], [...prefix, "login", "status"]]);
      assert.equal(await controller.startLogin(m), "cancelled");
      assert.deepEqual(login?.args, prefix);
      assert.equal(login?.command, command);
      assert.equal(login?.directory, "/fixture/account");
      assert.equal(login?.env, m.env);
      assert.equal(login?.accountId, "fixture-account");
      assert.equal(login?.persistAccount, false);
      assert.equal(login?.structuredCodex, driver === "codex-app-server");
    });
  }
});

test("unsupported forms keep a scope but cannot execute a status, inspection or login command", async () => {
  const controller = createTestProviderAuthRecovery(async () => { assert.fail("unsupported status executed"); });
  Object.assign(controller, { loginSupervisor: { startResolved() { assert.fail("unsupported login executed"); } } });
  for (const [command, args] of unsupported) {
    const m = meta({ command, args });
    assert.ok(controller.describe(m));
    assert.equal(controller.describe(m)?.canStartLogin, false);
    assert.deepEqual(await controller.revalidate(m), { status: "unknown" });
    assert.equal((await controller.inspect!(m)).observation.status, "unknown");
    assert.equal(await controller.startLogin(m), "failed");
  }
});

test("scope and configured identity compatibility preserves exact controls and never aliases lossy legacy evidence", async () => {
  const controller = createTestProviderAuthRecovery(async () => ({ stdout: "ok", stderr: "" }));
  for (const [command, prefix] of supported) {
    const m = meta({ command, args: prefix, env: { OPENAI_API_KEY: "synthetic-placeholder" } });
    const observation = await controller.revalidate(m);
    const flags = { ...m, args: [...prefix, "-m", "different-model"], driver: "codex-app-server" as const };
    assert.equal(controller.describe(m)?.id, controller.describe(flags)?.id);
    assert.equal(observation.identityId, (await controller.revalidate(flags)).identityId);
    const oldIdentity = hash([["OPENAI_API_KEY", "synthetic-placeholder"]]);
    const unchanged = prefix.length === 0 || (command === "node" && prefix.length === 1);
    if (unchanged) {
      assert.equal(controller.describe(m)?.id, legacyScope(m));
      assert.equal(observation.identityId, oldIdentity);
    } else {
      assert.notEqual(controller.describe(m)?.id, legacyScope(m));
      assert.notEqual(observation.identityId, oldIdentity);
    }
  }
  for (const [command, a, b] of [
    ["npx", ["-y", "@openai/codex@1"], ["-y", "@openai/codex@2"]],
    ["env", ["/one/codex"], ["/two/codex"]],
    ["node", ["--no-warnings", "one.js"], ["--no-warnings", "two.js"]],
  ] as [string, string[], string[]][]) {
    const first = meta({ command, args: a, env: { OPENAI_API_KEY: "synthetic" } });
    const second = { ...first, args: b };
    assert.equal(legacyScope(first), legacyScope(second), "old format lost the distinction");
    assert.notEqual(controller.describe(first)?.id, controller.describe(second)?.id);
    assert.notEqual((await controller.revalidate(first)).identityId, (await controller.revalidate(second)).identityId);
  }
});

test("persisted incompatible blocks refuse actual production recovery actions on upgrade, rollback and mixed installations", async (t) => {
  const changed = meta({ command: "npx", args: ["-y", "@openai/codex@1"] });
  const currentScope = describeProviderCredentialScope(changed)!.id;
  const oldScope = legacyScope(changed);
  const otherScope = describeProviderCredentialScope({ ...changed, args: ["-y", "@openai/codex@2"] })!.id;
  for (const [name, persisted, live] of [
    ["upgrade", oldScope, currentScope], ["rollback", currentScope, oldScope], ["mixed", currentScope, otherScope],
  ]) for (const option of ["auth:revalidate", "auth:login", "auth:accept-current"]) {
    await t.test(`${name} ${option}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "recovery-compat-"));
      let store = new SessionStore(join(root, "sessions"));
      const m = meta({ ...changed, repoPath: root, providerCredentialScopeId: persisted,
        providerAuthBlock: { version: 1, recoveryId: "recovery", credentialScopeId: persisted!, detectedAt: 1,
          phase: "turn", delivery: "uncertain", canStartLogin: true, configuredCredential: false },
        pendingApproval: { kind: "authentication", requestId: "provider-auth:recovery", title: "Authentication Required",
          options: [{ optionId: option!, name: "Retry", kind: "allow_once" }] },
      });
      store.create(m);
      store.flush(m.sessionId);
      store = new SessionStore(join(root, "sessions"));
      const controller = createTestProviderAuthRecovery(async () => { assert.fail("scope mismatch probed"); });
      // Rollback emulates the old describe result; the production equality/action boundary is unchanged.
      if (name === "rollback") {
        controller.describe = () => ({ id: live!, provider: "codex", canStartLogin: true, configuredCredential: false });
      } else if (name === "mixed") {
        store.patchMeta(m.sessionId, { args: ["-y", "@openai/codex@2"] });
      }
      controller.startLogin = async () => { assert.fail("scope mismatch signed in"); };
      const sent: unknown[] = [];
      const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner", undefined,
        (() => { assert.fail("provider launched"); }) as never, undefined, 4, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
        undefined, undefined, undefined, undefined, undefined, undefined, controller);
      try {
        const before = store.readMeta(m.sessionId)!.providerAuthBlock;
        const internal = manager as unknown as {
          resolveProviderAuthentication(session: string, request: string, option: string): Promise<void>;
        };
        await internal.resolveProviderAuthentication(m.sessionId, "provider-auth:recovery", option!);
        assert.match(JSON.stringify(sent), /provider installation or credential context changed/);
        assert.deepEqual(store.readMeta(m.sessionId)!.providerAuthBlock, before);
        assert.equal(store.readMeta(m.sessionId)!.providerAuthBlock?.resolution, undefined);
        const inspected = await manager.inspectProviderAuthentication(m.sessionId, "provider-auth:recovery");
        assert.deepEqual(inspected, { ok: false, error: "the provider installation or credential context changed" });
      } finally {
        manager.shutdownAll(); rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
