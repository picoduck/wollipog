import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { AgentDefinition, ProviderLoginView } from "@wollipog/protocol";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";
import { ProviderLoginSupervisor, type ResolvedProviderLogin } from "./provider-login.js";
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
    driver: "codex",
    context: { kind: "native" },
  },
];

function fixture(options: {
  timeoutMs?: number;
  writeFails?: boolean;
  kill?: (child: AgentProcess) => Promise<boolean>;
  probe?: ((login: ResolvedProviderLogin) => Promise<boolean>) | null;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-login-"));
  const configPath = join(root, "runner.config.json");
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "machine", untouched: true })}\n`);
  const children: FakeLoginChild[] = [];
  const spawns: SpawnAgentOptions[] = [];
  const updates: ProviderLoginView[][] = [];
  const releases: string[] = [];
  const added: string[] = [];
  const accounts: Array<{ id: string; label: string; provider: "claude" | "codex"; directory: string }> = [];
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root,
    configPath,
    accounts,
    agents: () => agents,
    resolveEnv: () => ({ HOME: root }),
    acquireLease: () => true,
    releaseLease: (directory) => { releases.push(directory); return true; },
    onUpdate: (value) => updates.push(value),
    onAccountAdded: (account) => { added.push(account.id); },
    timeoutMs: options.timeoutMs,
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
    accounts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
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

test("Codex device sign-in exposes the provider link and device code while polling", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Work Codex" });
    assert.deepEqual(fx.spawns[0]?.args, ["login", "--device-auth"]);
    fx.children[0]!.stdout.write("Visit https://auth.openai.com/device and enter ABCD-EFGH\n");
    const waiting = fx.supervisor.views()[0]!;
    assert.equal(waiting.status, "waiting_for_provider");
    assert.equal(waiting.verificationUrl, "https://auth.openai.com/device");
    assert.equal(waiting.userCode, "ABCD-EFGH");
    fx.children[0]!.close(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fx.supervisor.views()[0]?.status, "succeeded");
    assert.equal(fx.supervisor.views()[0]?.userCode, undefined);
  } finally {
    fx.cleanup();
  }
});

test("provider output cannot publish an oversized serialized URL or device code", async () => {
  const fx = fixture();
  try {
    await fx.supervisor.startAccount({ provider: "codex", label: "Bounded Output" });
    const encodedExpansion = `https://auth.openai.com/${"é".repeat(700)}`;
    const oversizedCode = Array.from({ length: 30 }, () => "ABCD").join("-");
    fx.children[0]!.stdout.write(`Visit ${encodedExpansion} or https://auth.openai.com/device and enter ${oversizedCode}\n`);
    const waiting = fx.supervisor.views()[0]!;
    assert.equal(waiting.status, "waiting_for_provider");
    assert.equal(waiting.verificationUrl, "https://auth.openai.com/device");
    assert.equal(waiting.userCode, undefined);
  } finally {
    fx.supervisor.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
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
