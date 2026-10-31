import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type ProviderLoginView } from "@wollipog/protocol";
import fc from "fast-check";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";
import {
  agentsMatchingHarnessInstallationSelections,
  claudeStatusIdentity,
  codexCredentialIdentity,
  parseCodexDeviceLoginOutput,
  ProviderLoginSupervisor,
  type ProviderLoginProfileOptions,
  type ResolvedProviderLogin,
} from "./provider-login.js";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { isProviderProfileId, readProviderProfileMarker } from "./provider-profile.js";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
import { createProviderProfileLoginSettlement } from "./provider-profile-login-settlement.js";
import { AccountConfigPublicationError } from "./provider-account-config-publication.js";

test("provider sign-in only uses the saved installation in its execution context", () => {
  const system: AgentDefinition = { id: "codex", name: "Codex", command: "/usr/bin/codex",
    args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
    installation: { id: "system", path: "/usr/bin/codex", via: "path" } };
  const local: AgentDefinition = { ...system, id: "codex-local", command: "/home/u/.local/bin/codex",
    installation: { id: "local", path: "/home/u/.local/bin/codex", via: "common-dir" } };
  const selected = [{ context: { kind: "native" } as const, installationId: "local" }];
  assert.deepEqual(agentsMatchingHarnessInstallationSelections([system, local], selected).map((agent) => agent.id),
    ["codex-local"]);
  assert.deepEqual(agentsMatchingHarnessInstallationSelections([system], selected), [],
    "a missing saved installation cannot fall back to the first PATH result");
});

test("provider sign-in matches a WSL selection regardless of context field order", () => {
  const agent: AgentDefinition = { id: "codex-wsl", name: "Codex", command: "/usr/bin/codex",
    args: [], env: {}, driver: "codex-app-server", context: { distro: "Ubuntu", kind: "wsl" },
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" } };
  const choices = [{ context: { kind: "wsl" as const, distro: "Ubuntu" }, installationId: "selected" }];
  assert.deepEqual(agentsMatchingHarnessInstallationSelections([agent], choices).map((candidate) => candidate.id),
    ["codex-wsl"]);
});
import { waitForPendingKills } from "./spawn.js";

class FakeLoginChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closeObserved = false;

  close(code: number): void {
    this.closeObserved = true;
    this.emit("close", code);
  }
}

const agents: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    context: { kind: "native" },
    codexAppServer: {
      status: "supported",
      installedVersion: "0.155.1",
      appServerAvailable: true,
      transport: "stdio",
      verification: "generated-schema",
      contractFingerprint: "test-contract",
    },
  },
];

declare const __WACW_FIXTURE_ENGINE_SHA__: string;

function fixture(options: {
  nativePrivateConfig?: boolean;
  timeoutMs?: number;
  ceremonyTimeoutMs?: number;
  codexVersion?: string;
  writeFails?: boolean;
  writeError?: Error;
  spawnFails?: boolean;
  kill?: (child: AgentProcess) => Promise<boolean>;
  probe?: ((login: ResolvedProviderLogin) => Promise<boolean>) | null;
  identify?: (login: ResolvedProviderLogin) => Promise<string | undefined>;
  acquireLease?: (directory: string, provider: "claude" | "codex", cancellation?: import("./provider-home-lease-async.js").LeaseCancellation) => boolean | Promise<boolean>;
  releaseLease?: (directory: string) => boolean | Promise<boolean>;
  credentialHomeInUse?: () => boolean;
  removalBlocker?: () => string | undefined;
  serializeHomeRetirement?: <T>(work: () => Promise<T>) => Promise<T>;
  profiles?: (root: string) => ProviderLoginProfileOptions;
  platform?: NodeJS.Platform;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), options.nativePrivateConfig ? "wollipog-account-config-" : "wollipog-provider-login-")));
  const configPath = join(root, "runner.config.json");
  if (options.nativePrivateConfig) {
    assert.equal(process.platform, "win32");
    const enginePath = join(dirname(__filename), "provider-account-config-windows-fixture-engine.cjs");
    assert.equal(createHash("sha256").update(readFileSync(enginePath)).digest("hex"), __WACW_FIXTURE_ENGINE_SHA__);
    const engine = createRequire(__filename)(enginePath) as { createSyntheticFixture(path: string, mode: "private"): void };
    // Fresh synthetic config only: private owner/DACL at CREATE_NEW, never repair an existing config.
    engine.createSyntheticFixture(configPath, "private");
  }
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "machine", untouched: true })}\n`, { mode: 0o600 });
  const children: FakeLoginChild[] = [];
  const spawns: SpawnAgentOptions[] = [];
  const updates: ProviderLoginView[][] = [];
  const releases: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const accounts: Array<{ id: string; label: string; provider: "claude" | "codex"; directory: string; profileId?: string }> = [];
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root,
    configPath,
    accounts,
    agents: () => options.codexVersion
      ? agents.map((agent) => agent.id === "codex"
          ? { ...agent, codexAppServer: { ...agent.codexAppServer!, installedVersion: options.codexVersion } }
          : agent)
      : agents,
    resolveEnv: () => ({ HOME: root }),
    acquireLease: options.acquireLease ?? (() => true),
    releaseLease: (directory) => { releases.push(directory); return options.releaseLease?.(directory) ?? true; },
    onUpdate: (value) => updates.push(value),
    onAccountAdded: (account) => { added.push(account.id); },
    onAccountRemoved: (account) => { removed.push(account.id); },
    identify: options.identify ?? (async () => undefined),
    ...(options.credentialHomeInUse ? { credentialHomeInUse: options.credentialHomeInUse } : {}),
    ...(options.removalBlocker ? { removalBlocker: options.removalBlocker } : {}),
    ...(options.serializeHomeRetirement ? { serializeHomeRetirement: options.serializeHomeRetirement } : {}),
    ...(options.profiles ? { profiles: options.profiles(root) } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    timeoutMs: options.timeoutMs,
    ceremonyTimeoutMs: options.ceremonyTimeoutMs,
    spawn: ((spawnOptions: SpawnAgentOptions) => {
      spawns.push(spawnOptions);
      if (options.spawnFails) throw new Error("synthetic spawn failure");
      const child = new FakeLoginChild();
      children.push(child);
      return child as unknown as AgentProcess;
    }) as never,
    kill: (options.kill ?? (async (child: AgentProcess) => {
      const fake = child as unknown as FakeLoginChild;
      if (!fake.closeObserved) queueMicrotask(() => fake.close(1));
      return true;
    })) as never,
    ...(options.probe === null ? {} : { probe: options.probe ?? (async () => true) }),
    ...(options.writeFails || options.writeError ? { writeAccounts: (() => { throw options.writeError ?? new Error("disk full"); }) as never } : {}),
  });
  return {
    root,
    configPath,
    saveAccounts: () => writeFileSync(configPath, `${JSON.stringify({ runnerId: "machine", untouched: true, providerAccounts: accounts })}\n`, { mode: 0o600 }),
    supervisor,
    children,
    spawns,
    updates,
    releases,
    added,
    removed,
    accounts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("new Codex accounts inherit plugins installed in the user's default Codex home", async () => {
  const fx = fixture();
  try {
    const manifest = join(fx.root, ".codex/plugins/cache/local/review/local/.codex-plugin/plugin.json");
    mkdirSync(join(manifest, ".."), { recursive: true });
    writeFileSync(manifest, '{"name":"review"}');
    writeFileSync(join(fx.root, ".codex/config.toml"), '[plugins."review@local"]\nenabled = true\n');
    await fx.supervisor.startAccount({ provider: "codex", label: "Work" });
    const accountHome = fx.spawns[0]!.env!.CODEX_HOME!;
    assert.equal(existsSync(join(accountHome, "plugins/cache/local/review/local/.codex-plugin/plugin.json")), true);
    assert.ok(fx.spawns[0]!.args.includes('plugins.review@local.enabled=true'));
  } finally {
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fx.cleanup();
  }
});

test("new Claude accounts inherit user plugins without inheriting credentials or other settings", async () => {
  const fx = fixture();
  try {
    const source = join(fx.root, ".claude");
    const plugin = join(source, "plugins/cache/local/review/1.0.0");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin/plugin.json"), '{"name":"review"}');
    writeFileSync(join(source, "settings.json"), JSON.stringify({
      enabledPlugins: { "review@local": true }, env: { SECRET: "default-secret" },
    }));
    writeFileSync(join(source, ".credentials.json"), "default-credentials");
    writeFileSync(join(source, "plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "review@local": [{ scope: "user", installPath: plugin, version: "1.0.0" }],
    } }));
    await fx.supervisor.startAccount({ provider: "claude", label: "Work" });
    const accountHome = fx.spawns[0]!.env!.CLAUDE_CONFIG_DIR!;
    assert.equal(existsSync(join(accountHome, "plugins/installed_plugins.json")), true,
      "a managed Claude account must see the default home's installed plugins before sign-in");
    const installed = JSON.parse(readFileSync(join(accountHome, "plugins/installed_plugins.json"), "utf8"));
    assert.ok(existsSync(join(installed.plugins["review@local"][0].installPath, ".claude-plugin/plugin.json")));
    const settings = JSON.parse(readFileSync(join(accountHome, "settings.json"), "utf8"));
    assert.equal(settings.enabledPlugins["review@local"], true);
    assert.equal(settings.env, undefined);
    assert.equal(existsSync(join(accountHome, ".credentials.json")), false);
  } finally {
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fx.cleanup();
  }
});

async function nextRequest(child: FakeLoginChild): Promise<{
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}> {
  while (true) {
    const [chunk] = await once(child.stdin, "data");
    for (const line of String(chunk).trim().split("\n")) {
      const message = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (typeof message.id === "number" && typeof message.method === "string") return message as never;
    }
  }
}

function respond(child: FakeLoginChild, id: number, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function notify(child: FakeLoginChild, method: string, params: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function exposeStructuredCeremony(
  child: FakeLoginChild,
  loginId = "provider-login-id",
  verificationUrl = "https://auth.openai.com/device",
): Promise<void> {
  const initialize = await nextRequest(child);
  assert.equal(initialize.method, "initialize");
  respond(child, initialize.id, { userAgent: "codex-test" });
  const login = await nextRequest(child);
  assert.equal(login.method, "account/login/start");
  assert.deepEqual(login.params, { type: "chatgptDeviceCode" });
  respond(child, login.id, {
    type: "chatgptDeviceCode",
    loginId,
    verificationUrl,
    userCode: "ABCD-EFGHJ",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Claude sign-in exposes its HTTPS link, accepts one transient code, and persists the account", async () => {
  const fx = fixture();
  try {
    const started = await fx.supervisor.startAccount({ provider: "claude", label: "Work Claude" });
    assert.deepEqual(fx.spawns[0]?.args, ["auth", "login"]);
    fx.children[0]!.stdout.write("Open https://claude.ai/oauth/authorize then paste the code\n");
    const awaiting = fx.supervisor.views()[0]!;
    assert.equal(awaiting.status, "awaiting_code");
    assert.equal(awaiting.verificationUrl, "https://claude.ai/oauth/authorize");
    const stdin = once(fx.children[0]!.stdin, "data");
    fx.supervisor.submitCode(started.operationId, "one-time-response");
    assert.equal(String((await stdin)[0]), "one-time-response\n");
    fx.children[0]!.stdout.write("Still open https://claude.ai/oauth/authorize while completing\n");
    assert.equal(fx.supervisor.views()[0]?.expectsCode, false);
    assert.throws(() => fx.supervisor.submitCode(started.operationId, "second-response"), /not waiting/i);
    fx.children[0]!.close(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "succeeded");
    assert.equal(fx.supervisor.views()[0]?.verificationUrl, undefined);
    assert.equal(fx.releases.length, 1);
    assert.equal(fx.added.length, 1);
    const saved = JSON.parse(readFileSync(fx.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.untouched, true);
    assert.equal((saved.providerAccounts as unknown[]).length, 1);
  } finally {
    fx.cleanup();
  }
});

test("Codex device sign-in uses the structured ceremony and publishes the account on completion", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Work Codex" });
    assert.deepEqual(fx.spawns[0]?.args, ["app-server"]);
    const exactUrl = "https://auth.openai.com/device?audience=codex%2fdesktop";
    await exposeStructuredCeremony(fx.children[0]!, "provider-login-id", exactUrl);
    const waiting = fx.supervisor.views()[0]!;
    assert.equal(waiting.status, "waiting_for_provider");
    assert.equal(waiting.verificationUrl, exactUrl);
    assert.equal(waiting.userCode, "ABCD-EFGHJ");
    assert.equal(waiting.expectsCode, false);
    notify(fx.children[0]!, "account/updated", { authMode: "chatgpt", planType: "plus" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "waiting_for_provider");
    notify(fx.children[0]!, "account/login/completed", {
      loginId: "provider-login-id",
      success: true,
      error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "succeeded");
    assert.equal(fx.supervisor.views()[0]?.userCode, undefined);
    assert.equal(fx.accounts.length, 1);
    assert.equal(fx.added.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("Codex versions outside the verified structured-login window use the CLI compatibility path", async () => {
  const fx = fixture({ codexVersion: "0.155.0" });
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Compatibility Codex" });
    assert.deepEqual(fx.spawns[0]?.args, ["login", "--device-auth"]);
  } finally {
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fx.cleanup();
  }
});

test("cancelling structured Codex sign-in cancels the exact provider login id", async () => {
  const fx = fixture();
  try {
    const started = await fx.supervisor.startAccount({ provider: "codex", label: "Cancelled Codex" });
    const initialize = await nextRequest(fx.children[0]!);
    respond(fx.children[0]!, initialize.id, { userAgent: "codex-test" });
    const login = await nextRequest(fx.children[0]!);
    fx.supervisor.cancel(started.operationId);
    respond(fx.children[0]!, login.id, {
      type: "chatgptDeviceCode",
      loginId: "login-to-cancel",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGHJ",
    });
    const cancellation = await nextRequest(fx.children[0]!);
    assert.equal(cancellation.method, "account/login/cancel");
    assert.deepEqual(cancellation.params, { loginId: "login-to-cancel" });
    respond(fx.children[0]!, cancellation.id, {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "cancelled");
    assert.equal(fx.accounts.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("cancelling structured Codex sign-in during initialization never starts a provider login", async () => {
  const fx = fixture();
  try {
    const started = await fx.supervisor.startAccount({ provider: "codex", label: "Early Cancel" });
    const initialize = await nextRequest(fx.children[0]!);
    const laterFrames: string[] = [];
    fx.children[0]!.stdin.on("data", (chunk) => laterFrames.push(String(chunk)));
    fx.supervisor.cancel(started.operationId);
    respond(fx.children[0]!, initialize.id, { userAgent: "codex-test" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(laterFrames.some((frame) => frame.includes('"method":"account/login/start"')), false,
      "account/login/start must not be sent after cancellation");
    assert.equal(fx.supervisor.views()[0]?.status, "cancelled");
    assert.equal(fx.accounts.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("structured Codex rejection and expiration produce distinct actionable failures", async () => {
  for (const scenario of [
    { error: "access_denied", expected: /rejected/i },
    { error: "device authorization expired", expected: /expired/i },
  ]) {
    const fx = fixture();
    try {
      await fx.supervisor.startAccount({ provider: "codex", label: "Rejected Codex" });
      await exposeStructuredCeremony(fx.children[0]!);
      notify(fx.children[0]!, "account/login/completed", {
        loginId: "provider-login-id",
        success: false,
        error: scenario.error,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fx.supervisor.views()[0]?.status, "failed");
      assert.match(fx.supervisor.views()[0]?.error ?? "", scenario.expected);
      assert.equal(fx.accounts.length, 0);
    } finally {
      fx.cleanup();
    }
  }
});

test("structured Codex sign-in fails closed when the provider omits ceremony fields", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Incomplete Structured" });
    const initialize = await nextRequest(fx.children[0]!);
    respond(fx.children[0]!, initialize.id, { userAgent: "codex-test" });
    const login = await nextRequest(fx.children[0]!);
    respond(fx.children[0]!, login.id, {
      type: "chatgptDeviceCode",
      loginId: "incomplete-login",
      verificationUrl: "https://auth.openai.com/device",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "failed");
    assert.match(fx.supervisor.views()[0]?.error ?? "", /valid structured device-code ceremony/i);
  } finally {
    fx.cleanup();
  }
});

for (const interruption of ["cancel", "shutdown"] as const) test(`pending lease ${interruption} never launches a sign-in or forgets an accepted reference`, async () => {
  let grant!: (value: boolean) => void;
  let cancellation: import("./provider-home-lease-async.js").LeaseCancellation | undefined;
  const fx = fixture({ acquireLease: (_directory, _provider, current) => {
    cancellation = current; return new Promise(resolve => { grant = resolve; });
  } });
  const resolved: ResolvedProviderLogin = { accountId: "pending", label: "Pending", provider: "claude",
    directory: fx.root, command: "claude", args: [], context: { kind: "native" }, env: {}, persistAccount: false };
  try {
    const operation = fx.supervisor.startResolved(resolved);
    const rejected = assert.rejects(operation, /canceled before launch/);
    assert.equal(fx.spawns.length, 0);
    await assert.rejects(fx.supervisor.startResolved(resolved), /already running/);
    if (interruption === "cancel") assert.equal(fx.supervisor.cancelAccount(resolved.accountId), true);
    else fx.supervisor.shutdown();
    assert.equal(cancellation?.signal?.aborted, true); assert.equal(cancellation?.isCurrent?.(), false);
    // Simulate a lease which completed just before cancellation crossed the caller boundary.
    grant(true); await rejected;
    assert.equal(fx.spawns.length, 0); assert.equal(fx.releases.length, 1);
  } finally { fx.cleanup(); }
});

test("Codex CLI compatibility output strips ANSI and accepts the current 4-5 code shape", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startResolved({
      accountId: "fallback",
      label: "Fallback",
      provider: "codex",
      directory: fx.root,
      command: "codex",
      args: [],
      context: { kind: "native" },
      env: {},
      persistAccount: false,
    });
    assert.deepEqual(fx.spawns[0]?.args, ["login", "--device-auth"]);
    fx.children[0]!.stdout.write([
      "Open this link:",
      "\u001b[36mhttps://auth.openai.com/device\u001b[0m",
      "Enter this one-time code:",
      "\u001b[1mABCD-EFGHJ\u001b[0m",
      "",
    ].join("\n"));
    const waiting = fx.supervisor.views()[0]!;
    assert.equal(waiting.status, "waiting_for_provider");
    assert.equal(waiting.verificationUrl, "https://auth.openai.com/device");
    assert.equal(waiting.userCode, "ABCD-EFGHJ");
  } finally {
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fx.cleanup();
  }
});

test("Codex CLI compatibility parser preserves bounded provider-defined code groups", () => {
  const alphaNumeric = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  const group = fc.array(alphaNumeric, { minLength: 2, maxLength: 15 }).map((value) => value.join(""));
  const groupedCode = fc.array(group, { minLength: 2, maxLength: 8 }).map((value) => value.join("-"));
  const plainCode = fc.array(alphaNumeric, { minLength: 4, maxLength: 128 }).map((value) => value.join(""));
  const code = fc.oneof(groupedCode, plainCode);
  fc.assert(fc.property(code, (userCode) => {
    const parsed = parseCodexDeviceLoginOutput(
      `\u001b[36mhttps://auth.openai.com/device\u001b[0m\nEnter this one-time code:\n\u001b[1m${userCode}\u001b[0m\n`,
    );
    assert.deepEqual(parsed, {
      verificationUrl: "https://auth.openai.com/device",
      userCode,
    });
  }), { numRuns: 200 });
});

test("Codex CLI compatibility parser preserves OSC-8 visible text across terminators and adjacent sequences", () => {
  fc.assert(fc.property(fc.constantFrom("\u0007", "\u001b\\"), fc.constantFrom("\u0007", "\u001b\\"),
    (openingTerminator, closingTerminator) => {
      const output = [
        `\u001b]8;;https://links.example/hidden${openingTerminator}`,
        "\u001b[36mhttps://auth.openai.com/device\u001b[0m",
        `\u001b]8;;${closingTerminator}`,
        `\u001b]0;Device Login\u001b\\`,
        "\nEnter this one-time code:\nABCD-EFGHJ\n",
      ].join("");
      assert.deepEqual(parseCodexDeviceLoginOutput(output), {
        verificationUrl: "https://auth.openai.com/device",
        userCode: "ABCD-EFGHJ",
      });
    }), { numRuns: 20 });
});

test("Codex CLI compatibility parser ignores incomplete or malformed OSC payloads", () => {
  for (const output of [
    "\u001b]8;;https://links.example/hidden",
    "\u001b]8;;https://links.example/hidden\u001b[36mhttps://auth.openai.com/device\nABCD-EFGHJ\n",
  ]) {
    assert.deepEqual(parseCodexDeviceLoginOutput(output), {});
  }
});

test("Codex CLI compatibility parser does not mistake an incomplete prompt for a device code", () => {
  assert.deepEqual(parseCodexDeviceLoginOutput(
    "https://auth.openai.com/device\nEnter this one-time code:\n",
  ), { verificationUrl: "https://auth.openai.com/device" });
  assert.deepEqual(parseCodexDeviceLoginOutput(
    "https://auth.openai.com/device\nEnter this one-time code\nABCD-EFGHJ\n",
  ), {
    verificationUrl: "https://auth.openai.com/device",
    userCode: "ABCD-EFGHJ",
  });
  assert.deepEqual(parseCodexDeviceLoginOutput(
    "https://auth.openai.com/device\nEnter this one-time code:\nABCD-EF",
  ), { verificationUrl: "https://auth.openai.com/device" });
  assert.deepEqual(parseCodexDeviceLoginOutput(
    "https://auth.openai.com/device\nEnter this one-time code:\nABCD-EFGHJ\n",
  ), {
    verificationUrl: "https://auth.openai.com/device",
    userCode: "ABCD-EFGHJ",
  });
});

test("Codex CLI compatibility parser rejects oversized URLs and whole device codes", () => {
  const encodedExpansion = `https://auth.openai.com/${"é".repeat(700)}`;
  const oversizedCode = Array.from({ length: 30 }, () => "ABCD").join("-");
  assert.deepEqual(parseCodexDeviceLoginOutput(
    `Visit ${encodedExpansion} or https://auth.openai.com/device and enter ${oversizedCode}`,
  ), { verificationUrl: "https://auth.openai.com/device" });
});

test("Codex CLI compatibility fails promptly when the ceremony is incomplete", async () => {
  const fx = fixture({ ceremonyTimeoutMs: 5 });
  try {
    const operation = await fx.supervisor.startResolved({
      accountId: "incomplete",
      label: "Incomplete",
      provider: "codex",
      directory: fx.root,
      command: "codex",
      args: [],
      context: { kind: "native" },
      env: {},
      persistAccount: false,
    });
    fx.children[0]!.stdout.write("Open https://auth.openai.com/device\u001b[0m\n");
    assert.equal(await operation.completion, "failed");
    assert.match(fx.supervisor.views()[0]?.error ?? "", /complete verification URL and device code/i);
  } finally {
    fx.cleanup();
  }
});

test("cancel reaps the supervised process, releases its lease, and records no account", async () => {
  const fx = fixture();
  try {
    const started = await fx.supervisor.startAccount({ provider: "claude", label: "Cancelled" });
    fx.supervisor.cancel(started.operationId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "cancelled");
    assert.equal(fx.releases.length, 1);
    assert.equal(fx.accounts.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("a failed new-account sign-in retains scratch state, ownership evidence and credentials", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startAccount({ provider: "claude", label: "Scratch Only" });
    const scratch = fx.spawns[0]!.cwd as string;
    mkdirSync(join(scratch, "log"), { recursive: true });
    mkdirSync(join(scratch, "tmp"), { recursive: true });
    fx.supervisor.cancel(fx.supervisor.views()[0]!.operationId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(join(scratch, "log")), true);
    assert.equal(existsSync(join(scratch, "tmp")), true);

    await fx.supervisor.startAccount({ provider: "claude", label: "Has Credentials" });
    const credentialed = fx.spawns[1]!.cwd as string;
    mkdirSync(credentialed, { recursive: true });
    writeFileSync(join(credentialed, ".credentials.json"), "{}");
    fx.supervisor.cancel(fx.supervisor.views().at(-1)!.operationId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(join(credentialed, ".credentials.json")), true);
  } finally {
    fx.cleanup();
  }
});

test("login settlement preserves a synthetic successor and journal at the release boundary", async (t) => {
  for (const outcome of ["success", "failure", "duplicate", "spawn failure", "cancel", "config failure"] as const) {
    await t.test(outcome, async () => {
      let releaseStarted!: () => void;
      const atRelease = new Promise<void>((resolve) => { releaseStarted = resolve; });
      let finishRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => { finishRelease = resolve; });
      const fx = fixture({
        spawnFails: outcome === "spawn failure",
        writeFails: outcome === "config failure",
        probe: async () => outcome !== "failure",
        identify: async () => outcome === "duplicate" ? "synthetic-identity" : undefined,
        releaseLease: async (directory) => {
          releaseStarted();
          await releaseGate;
          // Model a successor at the exact release boundary, without asserting an observed incident.
          writeFileSync(join(directory, "successor-state.json"), "synthetic successor\n");
          return true;
        },
      });
      const home = join(fx.root, "provider-accounts", "pending");
      const journal = join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.recovery.json");
      mkdirSync(dirname(journal), { recursive: true });
      writeFileSync(journal, "synthetic ownership evidence\n");
      if (outcome === "duplicate") {
        fx.accounts.push({ id: "existing", label: "Existing", provider: "claude", directory: join(fx.root, "existing") });
        fx.saveAccounts();
      }
      const login: ResolvedProviderLogin = { accountId: "pending", label: "Pending", provider: "claude",
        directory: home, command: "claude", args: [], context: { kind: "native" }, env: {}, persistAccount: true };
      try {
        let completion: Promise<unknown>;
        if (outcome === "spawn failure") {
          completion = assert.rejects(fx.supervisor.startResolved(login), /could not be started/u);
        } else {
          const operation = await fx.supervisor.startResolved(login);
          completion = operation.completion;
          if (outcome === "duplicate") writeFileSync(join(home, ".credentials.json"), "synthetic credentials\n");
          if (outcome === "cancel") fx.supervisor.cancel(operation.view.operationId);
          else fx.children[0]!.close(outcome === "failure" ? 1 : 0);
        }
        await atRelease;
        await assert.rejects(fx.supervisor.startResolved(login), /already running/u,
          "the account remains reserved while release is unsettled");
        finishRelease();
        await completion;
        assert.equal(readFileSync(join(home, "successor-state.json"), "utf8"), "synthetic successor\n");
        assert.equal(readFileSync(journal, "utf8"), "synthetic ownership evidence\n");
        if (outcome === "duplicate") assert.equal(readFileSync(join(home, ".credentials.json"), "utf8"), "synthetic credentials\n");
        assert.equal(fx.releases.length, 1);
        assert.equal(fx.accounts.some((account) => account.id === "pending"), outcome === "success");
      } finally {
        finishRelease();
        fx.cleanup();
      }
    });
  }
});

test("ambiguous or refused login release preserves every credential and ownership artifact", async (t) => {
  for (const release of ["refused", "throws"] as const) {
    await t.test(release, async () => {
      const fx = fixture({ probe: async () => false, releaseLease: () => {
        if (release === "throws") throw new Error("synthetic ambiguous release");
        return false;
      } });
      const home = join(fx.root, "provider-accounts", "uncertain");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "foreign-artifact"), "unproved evidence");
      try {
        const operation = await fx.supervisor.startResolved({ accountId: "uncertain", label: "Uncertain", provider: "claude",
          directory: home, command: "claude", args: [], context: { kind: "native" }, env: {}, persistAccount: true });
        fx.children[0]!.close(1);
        assert.equal(await operation.completion, "failed");
        assert.equal(readFileSync(join(home, "foreign-artifact"), "utf8"), "unproved evidence");
        assert.deepEqual(fx.accounts, []);
      } finally { fx.cleanup(); }
    });
  }
});

test("late provider output and timeout cannot revive a cancelled sign-in", async () => {
  let finishReap!: (complete: boolean) => void;
  const reap = new Promise<boolean>((resolve) => { finishReap = resolve; });
  const fx = fixture({ timeoutMs: 5, kill: async () => reap });
  try {
    const started = await fx.supervisor.startAccount({ provider: "claude", label: "Cancelled" });
    fx.children[0]!.stdout.write("Open https://claude.ai/oauth/authorize and paste the code\n");
    fx.supervisor.cancel(started.operationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    fx.children[0]!.stdout.write("Still open https://claude.ai/oauth/authorize\n");
    const cancelled = fx.supervisor.views()[0]!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.expectsCode, false);
    assert.equal(cancelled.verificationUrl, undefined);
    assert.throws(() => fx.supervisor.submitCode(started.operationId, "late-code"), /not waiting/i);
    finishReap(true);
    fx.children[0]!.close(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    finishReap?.(true);
    fx.cleanup();
  }
});

test("a failed process reap retains the provider-home lease", async () => {
  const fx = fixture({ kill: async () => false });
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Unreaped" });
    fx.children[0]!.close(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "failed");
    assert.equal(fx.releases.length, 0);
    assert.equal(await waitForPendingKills(100), false);
  } finally {
    fx.cleanup();
  }
});

test("timeout terminates the provider and publishes a bounded reason", async () => {
  const fx = fixture({ timeoutMs: 5 });
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Slow" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.supervisor.views()[0]?.status, "timed_out");
    assert.match(fx.supervisor.views()[0]?.error ?? "", /timed out/i);
    assert.equal(fx.releases.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("late provider output cannot revive a timed-out sign-in", async () => {
  let finishReap!: (complete: boolean) => void;
  const reap = new Promise<boolean>((resolve) => { finishReap = resolve; });
  const fx = fixture({ timeoutMs: 5, kill: async () => reap });
  try {
    await fx.supervisor.startAccount({ provider: "claude", label: "Timed Out" });
    fx.children[0]!.stdout.write("Open https://claude.ai/oauth/authorize and paste the code\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    fx.children[0]!.stdout.write("Still open https://claude.ai/oauth/authorize\n");
    const timedOut = fx.supervisor.views()[0]!;
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.expectsCode, false);
    assert.equal(timedOut.verificationUrl, undefined);
    finishReap(true);
    fx.children[0]!.close(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    finishReap?.(true);
    fx.cleanup();
  }
});

test("a provider stdin error fails closed without becoming an unhandled stream error", async () => {
  const fx = fixture();
  try {
    const started = await fx.supervisor.startAccount({ provider: "claude", label: "Closed Pipe" });
    fx.children[0]!.stdout.write("Open https://claude.ai/oauth/authorize and paste the code\n");
    fx.children[0]!.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failed = fx.supervisor.views()[0]!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.expectsCode, false);
    assert.equal(failed.verificationUrl, undefined);
    assert.match(failed.error ?? "", /stopped accepting/i);
    assert.throws(() => fx.supervisor.submitCode(started.operationId, "late-code"), /not waiting/i);
  } finally {
    fx.cleanup();
  }
});

test("a synchronously closed provider stdin rejects code submission and terminates the login", async () => {
  const fx = fixture();
  try {
    const started = await fx.supervisor.startAccount({ provider: "claude", label: "Ended Pipe" });
    fx.children[0]!.stdout.write("Open https://claude.ai/oauth/authorize and paste the code\n");
    fx.children[0]!.stdin.end();
    assert.throws(() => fx.supervisor.submitCode(started.operationId, "late-code"), /no longer accepting/i);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "failed");
  } finally {
    fx.cleanup();
  }
});

test("a second sign-in for the same account is rejected", async () => {
  const fx = fixture();
  try {
    const account = { id: "existing", label: "Existing", provider: "claude" as const, directory: join(fx.root, "existing") };
    fx.accounts.push(account);
    fx.saveAccounts();
    await fx.supervisor.startAccount({ accountId: account.id });
    await assert.rejects(fx.supervisor.startAccount({ accountId: account.id }), /already running/i);
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    fx.cleanup();
  }
});

test("a settled sign-in still blocks a replacement until process reaping and cleanup finish", async () => {
  let finishReap!: (complete: boolean) => void;
  const reap = new Promise<boolean>((resolve) => { finishReap = resolve; });
  const fx = fixture({ kill: async () => reap });
  try {
    const account = { id: "existing", label: "Existing", provider: "claude" as const, directory: join(fx.root, "existing") };
    fx.accounts.push(account);
    fx.saveAccounts();
    await fx.supervisor.startAccount({ accountId: account.id });
    fx.children[0]!.close(0);
    await assert.rejects(fx.supervisor.startAccount({ accountId: account.id }), /already running/i);
    finishReap(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const restarted = await fx.supervisor.startAccount({ accountId: account.id });
    fx.supervisor.cancel(restarted.operationId);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    finishReap?.(true);
    fx.cleanup();
  }
});

test("shutdown registers provider sign-in reaping with the runner-wide kill drain", async () => {
  let finishReap!: (complete: boolean) => void;
  const reap = new Promise<boolean>((resolve) => { finishReap = resolve; });
  const fx = fixture({ kill: async () => reap });
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Shutdown" });
    await exposeStructuredCeremony(fx.children[0]!, "shutdown-login-id");
    fx.supervisor.shutdown();
    assert.equal(await waitForPendingKills(5), false, "shutdown must observe the still-pending provider child");
    finishReap(true);
    assert.equal(await waitForPendingKills(100), true);
  } finally {
    finishReap?.(true);
    fx.cleanup();
  }
});

test("a settled sign-in reserves its account throughout asynchronous lease release", async () => {
  let finishRelease!: (released: boolean) => void;
  let releaseStarted = false;
  const fx = fixture({ releaseLease: () => {
    releaseStarted = true; return new Promise(resolve => { finishRelease = resolve; });
  } });
  try {
    const account = { id: "existing", label: "Existing", provider: "claude" as const, directory: join(fx.root, "existing") };
    fx.accounts.push(account);
    fx.saveAccounts();
    await fx.supervisor.startAccount({ accountId: account.id });
    fx.children[0]!.close(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(releaseStarted, true);
    await assert.rejects(fx.supervisor.startAccount({ accountId: account.id }), /already running/i);
    await assert.rejects(fx.supervisor.removeAccount(account.id), /sign-in is running/i);
    finishRelease(true); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((fx.supervisor as unknown as { active: Map<string, unknown> }).active.size, 0);
  } finally { finishRelease?.(false); fx.cleanup(); }
});

test("completed provider sign-ins retain only the latest bounded history", async () => {
  const fx = fixture();
  try {
    for (let index = 0; index < 33; index += 1) {
      const operation = await fx.supervisor.startResolved({
        accountId: `history-${index}`,
        label: `History ${index}`,
        provider: "codex",
        directory: join(fx.root, `history-${index}`),
        command: "codex",
        args: [],
        context: { kind: "native" },
        env: {},
        persistAccount: false,
      });
      fx.children[index]!.close(1);
      assert.equal(await operation.completion, "failed");
    }
    assert.equal(fx.supervisor.views().length, 32);
    assert.equal((fx.supervisor as unknown as { recent: Map<string, ProviderLoginView> }).recent.size, 32);
  } finally {
    fx.cleanup();
  }
});

test("Claude accepts structured positive auth status even when the status command exits nonzero", async () => {
  const fx = fixture({ probe: null });
  try {
    const script = join(fx.root, "provider.cjs");
    writeFileSync(script, [
      "if (process.argv.includes('status')) {",
      "  require('node:fs').writeSync(1, JSON.stringify({ loggedIn: true }));",
      "  process.exitCode = 1;",
      "}",
    ].join("\n"));
    const started = await fx.supervisor.startResolved({
      accountId: "structured-status",
      label: "Structured Status",
      provider: "claude",
      directory: fx.root,
      command: process.execPath,
      args: [script],
      context: { kind: "native" },
      env: {},
      persistAccount: false,
    });
    fx.children[0]!.close(0);
    assert.equal(await started.completion, "completed");
    assert.equal(fx.supervisor.views()[0]?.status, "succeeded");
  } finally {
    fx.cleanup();
  }
});

test("configuration write failure reports failure and does not publish the new account", async () => {
  const fx = fixture({ writeFails: true });
  try {
    await fx.supervisor.startAccount({ provider: "claude", label: "No Disk" });
    fx.children[0]!.close(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const view = fx.supervisor.views()[0]!;
    assert.equal(view.status, "failed");
    assert.match(view.error ?? "", /configuration could not be updated/i);
    assert.equal(view.failureCode, undefined, "only a duplicate account carries a failure code (#3519)");
    assert.equal(fx.accounts.length, 0);
    assert.equal(fx.added.length, 0);
    assert.equal(fx.releases.length, 1);
  } finally {
    fx.cleanup();
  }
});

function codexAuthJson(claims: Record<string, unknown>, accountId?: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `${encode({ alg: "none" })}.${encode(claims)}.signature`,
      access_token: "access",
      refresh_token: "refresh",
      ...(accountId ? { account_id: accountId } : {}),
    },
  });
}

test("provider identities compare the account, not the credential or the email's case", () => {
  const personal = claudeStatusIdentity(JSON.stringify({ loggedIn: true, email: "Dev@Example.com", orgId: "org-1" }));
  assert.equal(personal, claudeStatusIdentity(JSON.stringify({ loggedIn: true, email: "dev@example.com", orgId: "org-1" })));
  assert.notEqual(personal, claudeStatusIdentity(JSON.stringify({ loggedIn: true, email: "dev@example.com", orgId: "org-2" })),
    "one email in two organizations is two subscriptions");
  assert.equal(claudeStatusIdentity(JSON.stringify({ loggedIn: false, email: "dev@example.com" })), undefined);
  assert.equal(claudeStatusIdentity(JSON.stringify({ loggedIn: true })), undefined);

  const auth = { chatgpt_user_id: "user-1", chatgpt_account_id: "workspace-1" };
  const codex = codexCredentialIdentity(codexAuthJson({ email: "dev@example.com", "https://api.openai.com/auth": auth }));
  assert.ok(codex);
  assert.equal(codex, codexCredentialIdentity(codexAuthJson({ "https://api.openai.com/auth": auth })),
    "a refreshed token for the same user and workspace is the same account");
  assert.notEqual(codex, codexCredentialIdentity(codexAuthJson({
    "https://api.openai.com/auth": { ...auth, chatgpt_account_id: "workspace-2" },
  })));
  assert.equal(codexCredentialIdentity(JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: null })), undefined);
});

test("a new account whose label is already on the Machine is refused before sign-in starts", async () => {
  const fx = fixture();
  try {
    fx.accounts.push({ id: "work", label: "Work", provider: "claude", directory: join(fx.root, "work") });
    fx.saveAccounts();
    await assert.rejects(fx.supervisor.startAccount({ provider: "claude", label: " work " }),
      /already on this Machine.*Sign In on that account/i);
    assert.equal(fx.spawns.length, 0);
    await fx.supervisor.startAccount({ provider: "codex", label: "Work" });
    await assert.rejects(fx.supervisor.startAccount({ provider: "codex", label: "WORK" }), /already running/i,
      "a second click cannot start a parallel sign-in that would record the same account twice");
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    fx.cleanup();
  }
});

test("a new sign-in to an account already on the Machine is discarded instead of recorded twice", async () => {
  const fx = fixture({
    identify: async (login) => login.accountId === "other" ? "someone-else" : "dev@example.com",
  });
  try {
    const existing = { id: "existing", label: "Personal", provider: "claude" as const, directory: join(fx.root, "existing") };
    const other = { id: "other", label: "Team", provider: "claude" as const, directory: join(fx.root, "other") };
    fx.accounts.push(existing, other);
    await fx.supervisor.startAccount({ provider: "claude", label: "dev@example.com" });
    const directory = fx.spawns[0]!.cwd as string;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".credentials.json"), "{}");
    fx.children[0]!.close(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const view = fx.supervisor.views()[0]!;
    assert.equal(view.status, "failed");
    assert.equal(view.failureCode, "account_already_on_machine", "the dashboard decides the ending from the code (#3519)");
    assert.equal(view.error, "This Claude account is already on this Machine. The duplicate sign-in was discarded.",
      "the sentence is unchanged, for an older control plane or dashboard that still matches it");
    assert.doesNotMatch(view.error ?? "", /Personal|dev@example\.com/u, "the card never names the account");
    assert.deepEqual(fx.accounts.map((account) => account.id), ["existing", "other"]);
    assert.equal(fx.added.length, 0);
    assert.equal(readFileSync(join(directory, ".credentials.json"), "utf8"), "{}", "the unproved HOME is retained");
    const saved = JSON.parse(readFileSync(fx.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.providerAccounts, undefined);
  } finally {
    fx.cleanup();
  }
});

test("a new sign-in to a different account is recorded when the existing identities differ", async () => {
  const fx = fixture({ nativePrivateConfig: process.platform === "win32", identify: async (login) => login.accountId === "existing" ? "first" : "second" });
  try {
    fx.accounts.push({ id: "existing", label: "Personal", provider: "claude", directory: join(fx.root, "existing") });
    fx.saveAccounts();
    await fx.supervisor.startAccount({ provider: "claude", label: "Work" });
    fx.children[0]!.close(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "succeeded");
    assert.equal(fx.accounts.length, 2);
    if (process.platform === "win32") {
      const prefix=`.${basename(fx.configPath)}.account-publications-win-v1.`, names=readdirSync(dirname(fx.configPath));
      for(const slot of ["anchor","header","journal"]) assert.ok(names.includes(prefix+slot),"default Windows writer must enroll native evidence");
      assert.equal(names.includes(prefix+"guard"),false,"completed native publication releases only its owned guard");
    }
  } finally {
    fx.cleanup();
  }
});

test("removing an account forgets it while truthfully reporting its credential HOME retained", async () => {
  const fx = fixture({ nativePrivateConfig: process.platform === "win32" });
  try {
    const directory = join(fx.root, "provider-accounts", "work-1234");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "auth.json"), "{}");
    const keep = { id: "keep", label: "Keep", provider: "claude" as const, directory: join(fx.root, "provider-accounts", "keep") };
    fx.accounts.push({ id: "work-1234", label: "Work", provider: "codex", directory }, keep);
    fx.saveAccounts();
    assert.deepEqual(await fx.supervisor.removeAccount("work-1234"), { credentialsRetained: true });
    assert.deepEqual(fx.accounts, [keep]);
    assert.deepEqual(fx.removed, ["work-1234"]);
    assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "{}");
    const saved = JSON.parse(readFileSync(fx.configPath, "utf8")) as { providerAccounts: Array<{ id: string }>; untouched: boolean };
    assert.deepEqual(saved.providerAccounts.map((account) => account.id), ["keep"]);
    assert.equal(saved.untouched, true);
    if (process.platform === "win32") {
      const prefix=`.${basename(fx.configPath)}.account-publications-win-v1.`, names=readdirSync(dirname(fx.configPath));
      for(const slot of ["anchor","header","journal"]) assert.ok(names.includes(prefix+slot),"default Windows writer must enroll native evidence");
      assert.equal(names.includes(prefix+"guard"),false,"completed native publication releases only its owned guard");
    }
    await assert.rejects(fx.supervisor.removeAccount("work-1234"), /not configured/i);
  } finally {
    fx.cleanup();
  }
});

test("removed-account settlement still waits for the running skill transaction without deleting its HOME", async () => {
  let openQueue!: () => void;
  const skillTransaction = new Promise<void>((resolve) => { openQueue = resolve; });
  const acquired: string[] = [];
  const fx = fixture({
    acquireLease: (directory) => { acquired.push(directory); return true; },
    serializeHomeRetirement: (work) => skillTransaction.then(work),
  });
  try {
    const home = join(fx.root, "provider-accounts", "account");
    mkdirSync(home, { recursive: true });
    fx.accounts.push({ id: "account", label: "Account", provider: "claude", directory: home });
    fx.saveAccounts();
    const removing = fx.supervisor.removeAccount("account");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(acquired, [], "no ownership proof is attempted inside a skill transaction");
    assert.equal(existsSync(home), true);
    openQueue();
    assert.deepEqual(await removing, { credentialsRetained: true });
    assert.deepEqual(acquired, [], "retention needs no new HOME lease");
    assert.equal(existsSync(home), true);
  } finally {
    fx.cleanup();
  }
});

test("a legacy grant-retirement verdict cannot delete a successor or consume another local reference", async () => {
  const fx = fixture({ acquireLease: () => { throw new Error("retention must not acquire another reference"); } });
  const home = join(fx.root, "provider-accounts", "account");
  const original = `${home}-original`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "ownership-evidence"), "original synthetic journal");
  fx.accounts.push({ id: "account", label: "Account", provider: "claude", directory: home });
  fx.saveAccounts();
  let retired = false;
  try {
    assert.deepEqual(await fx.supervisor.removeAccount("account", { retireCredentialHome: async () => {
      retired = true;
      renameSync(home, original);
      mkdirSync(home);
      writeFileSync(join(home, "auth.json"), "synthetic successor credentials");
      return true;
    } }), { credentialsRetained: true });
    assert.equal(retired, true, "grant retirement still settles under the existing callback contract");
    assert.equal(readFileSync(join(home, "auth.json"), "utf8"), "synthetic successor credentials");
    assert.equal(readFileSync(join(original, "ownership-evidence"), "utf8"), "original synthetic journal");
    assert.deepEqual(fx.releases, [], "account retention does not consume any login/session reference");
  } finally { fx.cleanup(); }
});

test("removing an account keeps credentials that a session, another process, or the operator owns", async () => {
  for (const [name, options, directory] of [
    ["bound session", { credentialHomeInUse: () => true }, "provider-accounts/bound"],
    ["held lease", { releaseLease: () => false }, "provider-accounts/held"],
    ["operator home", {}, "operator-claude-home"],
  ] as const) {
    const fx = fixture(options);
    try {
      const home = join(fx.root, directory);
      mkdirSync(home, { recursive: true });
      fx.accounts.push({ id: "account", label: "Account", provider: "claude", directory: home });
      fx.saveAccounts();
      assert.deepEqual(await fx.supervisor.removeAccount("account"), { credentialsRetained: true }, name);
      assert.equal(fx.accounts.length, 0, name);
      assert.equal(existsSync(home), true, name);
    } finally {
      fx.cleanup();
    }
  }
});

test("removing an account is refused while it signs in, while an agent defaults to it, or if the config cannot change", async () => {
  const directory = (root: string) => join(root, "provider-accounts", "account");
  const signingIn = fixture();
  try {
    signingIn.accounts.push({ id: "account", label: "Account", provider: "claude", directory: directory(signingIn.root) });
    signingIn.saveAccounts();
    await signingIn.supervisor.startAccount({ accountId: "account" });
    await assert.rejects(signingIn.supervisor.removeAccount("account"), /sign-in is running/i);
    assert.equal(signingIn.accounts.length, 1);
    signingIn.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    signingIn.cleanup();
  }
  const defaulted = fixture({ removalBlocker: () => "Agent 'claude' uses this account as its default." });
  try {
    defaulted.accounts.push({ id: "account", label: "Account", provider: "claude", directory: directory(defaulted.root) });
    defaulted.saveAccounts();
    await assert.rejects(defaulted.supervisor.removeAccount("account"), /uses this account as its default/i);
    assert.equal(defaulted.accounts.length, 1);
  } finally {
    defaulted.cleanup();
  }
  const unwritable = fixture({ writeFails: true });
  try {
    const home = directory(unwritable.root);
    mkdirSync(home, { recursive: true });
    unwritable.accounts.push({ id: "account", label: "Account", provider: "claude", directory: home });
    unwritable.saveAccounts();
    await assert.rejects(unwritable.supervisor.removeAccount("account"), /configuration could not be updated/i);
    assert.equal(unwritable.accounts.length, 1);
    assert.equal(existsSync(home), true, "credentials stay while the configuration still names the account");
    assert.deepEqual(unwritable.removed, []);
  } finally {
    unwritable.cleanup();
  }
});

const posixOnly = { skip: process.platform === "win32" };
const INSTANCE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

async function eventually(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), what);
}

function entries(directory: string): string[] {
  try { return readdirSync(directory); } catch { return []; }
}

/** A supervisor wired like the runner (#3239): the real lease worker, a v225 control plane's grants,
 * and managed profiles created under `<root>/home/.agent-manager/profiles`. */
function profileFixture(t: TestContext, options: Parameters<typeof fixture>[0] & { create?: ProviderLoginProfileOptions["create"] } = {}) {
  const state: { grants?: ProviderProfileGrants; registry?: AsyncProviderHomeLeaseRegistry } = {};
  const settled: Array<Parameters<ProviderLoginProfileOptions["settle"]>[0]> = [];
  let profileRoot!: string;
  const fx = fixture({
    ...options,
    acquireLease: (directory, provider, cancellation) => state.registry!.acquireHome(directory, provider, cancellation),
    releaseLease: (directory) => state.registry!.releaseHome(directory),
    profiles: (root) => ({
      root: profileRoot = join(root, "home", ".agent-manager", "profiles"),
      create: options.create ?? (async (home, provider, profileId, grantId) => {
        await state.registry!.createProfile(home, provider, profileId, grantId);
        state.grants!.recordCreated(profileId, grantId);
      }),
      settle: async (input) => {
        await createProviderProfileLoginSettlement({
          settleCreated: (profileId, grantId, recorded) => state.grants!.settleCreated(profileId, grantId, recorded),
          revoke: (home, provider, profileId, grantId) => state.registry!.revokeProfileGrant(home, provider, profileId, grantId),
          log: () => {},
        })(input);
        settled.push(input);
      },
    }),
  });
  mkdirSync(join(fx.root, "home"));
  const grants = state.grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => fx.accounts });
  state.registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: INSTANCE,
    profileAccess: () => grants.access(), expectedProfileIdForHome: (home) => grants.expectedProfileIdForHome(home) });
  grants.synchronize(PROTOCOL_VERSION, []);
  t.after(async () => { await state.registry!.close(); fx.cleanup(); });
  return { fx, grants, registry: state.registry, settled, root: profileRoot };
}

test("uncertain account publication retains the marker without false settlement or revived CP access", posixOnly, async t => {
  for (const publication of ["unknown", "committed"] as const) {
    for (const revoked of [false, true]) {
      const p = profileFixture(t, { writeError: new AccountConfigPublicationError(publication, "IO") });
      await p.fx.supervisor.startAccount({ provider: "claude", label: "Retained", profileGrantId: GRANT });
      const home = p.fx.spawns[0]!.cwd as string;
      writeFileSync(join(home, ".credentials.json"), "synthetic credentials");
      // Registration/revocation during sign-in must remain effective after an uncertain write.
      if (revoked) p.grants.synchronize(PROTOCOL_VERSION, []);
      p.fx.children[0]!.close(0);
      await eventually(() => p.fx.supervisor.views()[0]?.status === "failed" && p.fx.releases.length === 1, "uncertain publication settles the login");
      assert.match(p.fx.supervisor.views()[0]?.error ?? "", /publication is unknown|was published/u);
      assert.equal(p.settled.length, 1);
      assert.equal(p.settled[0]?.recorded, "unknown", "neither true nor false recording is claimed");
      assert.deepEqual(p.fx.accounts, []);
      assert.deepEqual(p.fx.added, []);
      assert.deepEqual(p.grants.access().activeProfileIds, []);
      const marker = readProviderProfileMarker(home);
      assert.deepEqual(marker.state === "present" && marker.marker.grants.map(grant => grant.grantId), [GRANT]);
      assert.equal(readFileSync(join(home, ".credentials.json"), "utf8"), "synthetic credentials");
    }
  }
});

test("uncertain removal never retires grants, deletes credentials or reports account removal", posixOnly, async () => {
  const fx = fixture({ writeError: new AccountConfigPublicationError("unknown", "IO") });
  try {
    const home = join(fx.root, "retained"); mkdirSync(home);
    const account = { id: "retained", label: "Retained", provider: "claude" as const, directory: home };
    fx.accounts.push(account); fx.saveAccounts();
    writeFileSync(join(home, "auth.json"), "synthetic credentials");
    let retired = false;
    await assert.rejects(fx.supervisor.removeAccount(account.id, { retireCredentialHome: async () => { retired = true; return true; } }),
      (error: unknown) => error instanceof AccountConfigPublicationError && error.publication === "unknown");
    assert.deepEqual(fx.accounts, [account]); assert.deepEqual(fx.removed, []); assert.equal(retired, false);
    assert.equal(readFileSync(join(home, "auth.json"), "utf8"), "synthetic credentials");
  } finally { fx.cleanup(); }
});

test("Add Account with this control plane's grant creates a managed profile HOME whose marker grants it", posixOnly, async (t) => {
  const p = profileFixture(t);
  const started = await p.fx.supervisor.startAccount({ provider: "claude", label: "Work", profileGrantId: GRANT });
  const home = p.fx.spawns[0]!.cwd as string;
  const profileId = basename(home);
  assert.equal(dirname(home), p.root, "the HOME is at the SSH-account-level root, outside the runner's data directory");
  assert.ok(isProviderProfileId(profileId), "named by a fresh profile id");
  for (const directory of [dirname(p.root), p.root, home]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700, `${directory} is private`);
  }
  const read = readProviderProfileMarker(home);
  assert.equal(read.state, "present");
  assert.equal(read.state === "present" && read.marker.profileId, profileId);
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => [grant.controlPlaneInstanceId, grant.grantId]),
    [[INSTANCE, GRANT]], "the marker grants exactly this control plane");
  assert.deepEqual(p.grants.access().activeProfileIds, [profileId], "the sign-in may use its HOME");

  writeFileSync(join(home, ".credentials.json"), "{}");
  p.fx.children[0]!.close(0);
  await eventually(() => p.settled.length === 1 && p.fx.supervisor.views()[0]?.status === "succeeded", "the sign-in completes");
  assert.deepEqual(p.fx.accounts, [{ id: started.accountId, label: "Work", provider: "claude", directory: home, profileId }]);
  const saved = JSON.parse(readFileSync(p.fx.configPath, "utf8")) as { providerAccounts: Array<{ directory: string; profileId?: string }> };
  assert.deepEqual(saved.providerAccounts.map((account) => [account.directory, account.profileId]), [[home, profileId]],
    "the configuration records the profile id");
  assert.equal(p.settled[0]?.recorded, true);
  assert.deepEqual(p.grants.accountProfile(p.fx.accounts[0]!), { id: profileId, access: "granted" },
    "the account report carries the profile, which completes the control plane's pending grant");
  assert.equal(existsSync(join(p.fx.root, "provider-accounts")), false, "nothing is created under the data directory");
});

test("profile settlement does not claim an externally moved HOME was removed", posixOnly, async () => {
  let moved!: string;
  const settled: Array<Parameters<ProviderLoginProfileOptions["settle"]>[0]> = [];
  const fx = fixture({
    probe: async () => false,
    releaseLease: (home) => { moved = `${home}-moved`; renameSync(home, moved); return true; },
    profiles: (root) => ({ root: join(root, "home", ".agent-manager", "profiles"),
      create: async () => {}, settle: async (input) => { settled.push(input); } }),
  });
  mkdirSync(join(fx.root, "home"));
  try {
    await fx.supervisor.startAccount({ provider: "claude", label: "Moved", profileGrantId: GRANT });
    const home = fx.spawns[0]!.cwd as string;
    writeFileSync(join(home, ".credentials.json"), "synthetic credentials");
    fx.children[0]!.close(1);
    await eventually(() => settled.length === 1, "the moved profile settles");
    assert.equal(existsSync(home), false);
    assert.equal(readFileSync(join(moved, ".credentials.json"), "utf8"), "synthetic credentials");
    assert.equal(settled[0]?.homeRemoved, false, "only proved removal may claim homeRemoved");
    assert.equal(settled[0]?.recorded, false);
  } finally { fx.cleanup(); }
});

test("without a grant, or on Windows, Add Account keeps today's HOME and writes no marker", posixOnly, async (t) => {
  const p = profileFixture(t);
  await p.fx.supervisor.startAccount({ provider: "claude", label: "Legacy" });
  const home = p.fx.spawns[0]!.cwd as string;
  assert.equal(dirname(home), join(p.fx.root, "provider-accounts"));
  assert.equal(readProviderProfileMarker(home).state, "absent");
  assert.equal(existsSync(p.root), false, "no managed profile root is created");
  p.fx.children[0]!.close(0);
  await eventually(() => p.fx.supervisor.views()[0]?.status === "succeeded", "the legacy sign-in completes");
  assert.equal(p.fx.accounts[0]?.profileId, undefined);
  assert.deepEqual(p.settled, []);

  const windows = profileFixture(t, { platform: "win32" });
  await windows.fx.supervisor.startAccount({ provider: "claude", label: "Windows", profileGrantId: GRANT });
  assert.equal(dirname(windows.fx.spawns[0]!.cwd as string), join(windows.fx.root, "provider-accounts"),
    "a marker cannot be verified on Windows, so the grant is ignored");
  assert.equal(existsSync(windows.root), false);
  windows.fx.supervisor.cancel(windows.fx.supervisor.views()[0]!.operationId);
  await eventually(() => windows.fx.releases.length === 1, "the Windows sign-in settles");

  await assert.rejects(p.fx.supervisor.startAccount({ provider: "claude", label: "Bad", profileGrantId: "not-a-grant" }), /grant is invalid/u);
});

test("a cancelled or failed managed-profile sign-in retains its HOME and stops using its grant", posixOnly, async (t) => {
  const p = profileFixture(t, { probe: async () => false });
  await p.fx.supervisor.startAccount({ provider: "claude", label: "Cancelled", profileGrantId: GRANT });
  const cancelled = p.fx.spawns[0]!.cwd as string;
  mkdirSync(join(cancelled, "log"));
  p.fx.supervisor.cancel(p.fx.supervisor.views()[0]!.operationId);
  await eventually(() => p.settled.length === 1, "the cancelled sign-in settles");
  assert.equal(existsSync(join(cancelled, "log")), true, "scratch and ownership evidence survive");
  assert.deepEqual(p.settled[0], { home: cancelled, provider: "claude", profileId: basename(cancelled), grantId: GRANT,
    recorded: false, homeRemoved: false });
  const cancelledMarker = readProviderProfileMarker(cancelled);
  assert.deepEqual(cancelledMarker.state === "present" && cancelledMarker.marker.grants, []);
  assert.deepEqual(p.grants.access().activeProfileIds, []);
  assert.deepEqual(p.fx.accounts, []);

  await p.fx.supervisor.startAccount({ provider: "claude", label: "Failed", profileGrantId: GRANT });
  const failed = p.fx.spawns[1]!.cwd as string;
  p.fx.children[1]!.close(1);
  await eventually(() => p.settled.length === 2, "the failed sign-in settles");
  assert.equal(existsSync(failed), true);
  assert.equal(p.settled[1]?.homeRemoved, false);
  assert.equal(p.settled[1]?.recorded, false);

  // A provider that already wrote credentials keeps them for inspection, but the marker no longer grants anyone.
  await p.fx.supervisor.startAccount({ provider: "claude", label: "Credentialed", profileGrantId: GRANT });
  const kept = p.fx.spawns[2]!.cwd as string;
  writeFileSync(join(kept, ".credentials.json"), "{}");
  p.fx.children[2]!.close(1);
  await eventually(() => p.settled.length === 3, "the credentialed sign-in settles");
  assert.equal(existsSync(join(kept, ".credentials.json")), true);
  assert.equal(p.settled[2]?.homeRemoved, false);
  const read = readProviderProfileMarker(kept);
  assert.deepEqual(read.state === "present" && read.marker.grants, [], "the discarded grant is dropped under the HOME's lease");
  assert.deepEqual(p.grants.access().activeProfileIds, []);
});

test("a duplicate sign-in's managed profile HOME is retained while its grant is dropped", posixOnly, async (t) => {
  const p = profileFixture(t, { identify: async () => "same-person" });
  const existing = join(p.fx.root, "existing");
  mkdirSync(existing);
  p.fx.accounts.push({ id: "existing", label: "Personal", provider: "claude", directory: existing });
  p.fx.saveAccounts();
  await p.fx.supervisor.startAccount({ provider: "claude", label: "Again", profileGrantId: GRANT });
  const home = p.fx.spawns[0]!.cwd as string;
  writeFileSync(join(home, ".credentials.json"), "{}");
  p.fx.children[0]!.close(0);
  await eventually(() => p.settled.length === 1, "the duplicate sign-in settles");
  assert.match(p.fx.supervisor.views()[0]?.error ?? "", /already on this Machine/u);
  assert.equal(readFileSync(join(home, ".credentials.json"), "utf8"), "{}");
  assert.equal(p.settled[0]?.homeRemoved, false);
  const read = readProviderProfileMarker(home);
  assert.deepEqual(read.state === "present" && read.marker.grants, []);
  assert.equal(p.settled[0]?.recorded, false);
  assert.deepEqual(p.fx.accounts.map((account) => account.id), ["existing"]);
});

test("a managed profile that cannot be created starts no sign-in and preserves its unproved HOME", posixOnly, async (t) => {
  const refused = profileFixture(t, { create: async () => { throw new Error("marker refused"); } });
  await assert.rejects(refused.fx.supervisor.startAccount({ provider: "claude", label: "Refused", profileGrantId: GRANT }),
    /provider profile could not be created: marker refused/u);
  assert.equal(refused.fx.spawns.length, 0);
  assert.equal(entries(refused.root).length, 1, "failed creation does not prove the HOME can be removed");
  assert.equal(refused.settled[0]?.recorded, false);

  // A linked `.agent-manager` is not a private directory, so nothing is created through it.
  const linked = profileFixture(t);
  const elsewhere = join(linked.fx.root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, dirname(linked.root));
  await assert.rejects(linked.fx.supervisor.startAccount({ provider: "claude", label: "Linked", profileGrantId: GRANT }),
    /not a private directory/u);
  assert.equal(linked.fx.spawns.length, 0);
  assert.deepEqual(entries(elsewhere), []);
});

test("a managed Add Account refused before it takes its lease retains the HOME it created", posixOnly, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const p = profileFixture(t, {
    create: async (home, provider, profileId, grantId) => {
      await gate;
      await p.registry.createProfile(home, provider, profileId, grantId);
      p.grants.recordCreated(profileId, grantId);
    },
  });
  const starting = p.fx.supervisor.startAccount({ provider: "claude", label: "Work", profileGrantId: GRANT });
  await eventually(() => entries(p.root).length === 1, "the managed HOME exists while its profile is created");
  // The supervisor stops while the profile is being created: the start is refused before any lease.
  p.fx.supervisor.shutdown();
  release();
  await assert.rejects(starting, /supervisor has stopped/u);
  assert.equal(entries(p.root).length, 1, "the refused start retains its HOME and ownership evidence");
  assert.equal(p.fx.spawns.length, 0, "and starts no process");
  await eventually(() => p.settled.length === 1, "the created profile is settled as unrecorded");
});

test("an overlapping managed Add Account with the same label is refused before it creates a HOME or starts a sign-in", posixOnly, async (t) => {
  // Each profile creation waits for the test: true creates the marker, false refuses it.
  const gates: Array<(create: boolean) => void> = [];
  const created: string[] = [];
  const p = profileFixture(t, {
    create: async (home, provider, profileId, grantId) => {
      created.push(home);
      if (!await new Promise<boolean>((resolve) => gates.push(resolve))) throw new Error("marker refused");
      await p.registry.createProfile(home, provider, profileId, grantId);
      p.grants.recordCreated(profileId, grantId);
    },
  });
  const first = p.fx.supervisor.startAccount({ provider: "claude", label: "Work", profileGrantId: GRANT });
  assert.equal(created.length, 1, "the first Add Account is creating its profile");
  const overlapping = p.fx.supervisor.startAccount({ provider: "claude", label: "  WORK ", profileGrantId: GRANT });
  // Checked before awaiting the refusal: an admitted request would wait on its own creation gate.
  assert.equal(created.length, 1, "the overlapping request creates no profile");
  await assert.rejects(overlapping, /A sign-in for an account with this label is already running\./u);
  assert.equal(entries(p.root).length, 1, "and no second HOME");
  assert.equal(p.fx.spawns.length, 0, "and starts no process");

  gates.shift()!(true);
  const view = await first;
  assert.equal(p.fx.spawns.length, 1, "the first sign-in starts once its profile exists");
  assert.equal(p.fx.spawns[0]!.cwd, join(p.root, entries(p.root)[0]!));
  await assert.rejects(p.fx.supervisor.startAccount({ provider: "claude", label: "work", profileGrantId: GRANT }),
    /already running/u, "the running sign-in keeps the label");
  writeFileSync(join(p.fx.spawns[0]!.cwd as string, ".credentials.json"), "{}");
  p.fx.children[0]!.close(0);
  await eventually(() => p.settled.length === 1 && p.fx.supervisor.views()[0]?.status === "succeeded", "the first sign-in completes");
  assert.deepEqual(p.fx.accounts.map((account) => [account.id, account.label]), [[view.accountId, "Work"]]);

  // A creation that fails releases the reservation; the same label may be added again afterwards.
  const failing = p.fx.supervisor.startAccount({ provider: "claude", label: "Retry", profileGrantId: GRANT });
  const duplicate = p.fx.supervisor.startAccount({ provider: "claude", label: "retry", profileGrantId: GRANT });
  assert.equal(created.length, 2, "only the first Retry creates a profile");
  await assert.rejects(duplicate, /already running/u);
  gates.shift()!(false);
  await assert.rejects(failing, /provider profile could not be created: marker refused/u);
  assert.equal(p.fx.spawns.length, 1);
  const retry = p.fx.supervisor.startAccount({ provider: "claude", label: "retry", profileGrantId: GRANT });
  assert.equal(created.length, 3, "the label is free again once the failed start released it");
  gates.shift()!(true);
  await retry;
  assert.equal(p.fx.spawns.length, 2);
  p.fx.supervisor.cancel(p.fx.supervisor.views().at(-1)!.operationId);
  await eventually(() => p.settled.length === 3, "the retried sign-in settles");
});
