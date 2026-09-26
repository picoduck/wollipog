import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { AgentDefinition, ProviderLoginView } from "@wollipog/protocol";
import fc from "fast-check";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";
import {
  agentsMatchingHarnessInstallationSelections,
  claudeStatusIdentity,
  codexCredentialIdentity,
  parseCodexDeviceLoginOutput,
  ProviderLoginSupervisor,
  type ResolvedProviderLogin,
} from "./provider-login.js";

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

function fixture(options: {
  timeoutMs?: number;
  ceremonyTimeoutMs?: number;
  codexVersion?: string;
  writeFails?: boolean;
  kill?: (child: AgentProcess) => Promise<boolean>;
  probe?: ((login: ResolvedProviderLogin) => Promise<boolean>) | null;
  identify?: (login: ResolvedProviderLogin) => Promise<string | undefined>;
  releaseLease?: (directory: string) => boolean;
  credentialHomeInUse?: () => boolean;
  removalBlocker?: () => string | undefined;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-login-"));
  const configPath = join(root, "runner.config.json");
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "machine", untouched: true })}\n`);
  const children: FakeLoginChild[] = [];
  const spawns: SpawnAgentOptions[] = [];
  const updates: ProviderLoginView[][] = [];
  const releases: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const accounts: Array<{ id: string; label: string; provider: "claude" | "codex"; directory: string }> = [];
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
    acquireLease: () => true,
    releaseLease: (directory) => { releases.push(directory); return options.releaseLease?.(directory) ?? true; },
    onUpdate: (value) => updates.push(value),
    onAccountAdded: (account) => { added.push(account.id); },
    onAccountRemoved: (account) => { removed.push(account.id); },
    identify: options.identify ?? (async () => undefined),
    ...(options.credentialHomeInUse ? { credentialHomeInUse: options.credentialHomeInUse } : {}),
    ...(options.removalBlocker ? { removalBlocker: options.removalBlocker } : {}),
    timeoutMs: options.timeoutMs,
    ceremonyTimeoutMs: options.ceremonyTimeoutMs,
    spawn: ((spawnOptions: SpawnAgentOptions) => {
      spawns.push(spawnOptions);
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
    ...(options.writeFails ? { writeAccounts: (() => { throw new Error("disk full"); }) as never } : {}),
  });
  return {
    root,
    configPath,
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

test("Codex CLI compatibility output strips ANSI and accepts the current 4-5 code shape", async () => {
  const fx = fixture();
  try {
    fx.supervisor.startResolved({
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
    const operation = fx.supervisor.startResolved({
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

test("a failed new-account sign-in removes provider scratch state but keeps any credentials", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startAccount({ provider: "claude", label: "Scratch Only" });
    const scratch = fx.spawns[0]!.cwd as string;
    mkdirSync(join(scratch, "log"), { recursive: true });
    mkdirSync(join(scratch, "tmp"), { recursive: true });
    fx.supervisor.cancel(fx.supervisor.views()[0]!.operationId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(scratch), false);

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

test("completed provider sign-ins retain only the latest bounded history", async () => {
  const fx = fixture();
  try {
    for (let index = 0; index < 33; index += 1) {
      const operation = fx.supervisor.startResolved({
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
    const started = fx.supervisor.startResolved({
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
    assert.match(view.error ?? "", /already on this Machine.*discarded/i);
    assert.doesNotMatch(view.error ?? "", /Personal|dev@example\.com/u, "the card never names the account");
    assert.deepEqual(fx.accounts.map((account) => account.id), ["existing", "other"]);
    assert.equal(fx.added.length, 0);
    assert.equal(existsSync(directory), false, "the duplicate's fresh credentials are deleted");
    const saved = JSON.parse(readFileSync(fx.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.providerAccounts, undefined);
  } finally {
    fx.cleanup();
  }
});

test("a new sign-in to a different account is recorded when the existing identities differ", async () => {
  const fx = fixture({ identify: async (login) => login.accountId === "existing" ? "first" : "second" });
  try {
    fx.accounts.push({ id: "existing", label: "Personal", provider: "claude", directory: join(fx.root, "existing") });
    await fx.supervisor.startAccount({ provider: "claude", label: "Work" });
    fx.children[0]!.close(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "succeeded");
    assert.equal(fx.accounts.length, 2);
  } finally {
    fx.cleanup();
  }
});

test("removing an account forgets it and deletes the credential home Wollipog created", async () => {
  const fx = fixture();
  try {
    const directory = join(fx.root, "provider-accounts", "work-1234");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "auth.json"), "{}");
    const keep = { id: "keep", label: "Keep", provider: "claude" as const, directory: join(fx.root, "provider-accounts", "keep") };
    fx.accounts.push({ id: "work-1234", label: "Work", provider: "codex", directory }, keep);
    assert.deepEqual(await fx.supervisor.removeAccount("work-1234"), { credentialsRetained: false });
    assert.deepEqual(fx.accounts, [keep]);
    assert.deepEqual(fx.removed, ["work-1234"]);
    assert.equal(existsSync(directory), false);
    const saved = JSON.parse(readFileSync(fx.configPath, "utf8")) as { providerAccounts: Array<{ id: string }>; untouched: boolean };
    assert.deepEqual(saved.providerAccounts.map((account) => account.id), ["keep"]);
    assert.equal(saved.untouched, true);
    await assert.rejects(fx.supervisor.removeAccount("work-1234"), /not configured/i);
  } finally {
    fx.cleanup();
  }
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
    await assert.rejects(unwritable.supervisor.removeAccount("account"), /configuration could not be updated/i);
    assert.equal(unwritable.accounts.length, 1);
    assert.equal(existsSync(home), true, "credentials stay while the configuration still names the account");
    assert.deepEqual(unwritable.removed, []);
  } finally {
    unwritable.cleanup();
  }
});
