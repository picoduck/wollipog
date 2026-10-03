import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { codexLauncherBootstrap } from "./codex-plugins.js";
import { ProviderLoginSupervisor } from "./provider-login.js";
import { waitForPendingKills, type AgentProcess, type SpawnAgentOptions } from "./spawn.js";

const sessionArgs = ["-c", "plugins.review@local.enabled=false", "app-server", "--experimental"];
const pluginArgs = ["-c", "plugins.review@local.enabled=true"];
const supported: [string, string[]][] = [
  ["codex", []], ["/fixture/bin/codex", []], ["C:\\fixture\\codex.exe", []], ["codex.cmd", []],
  ["node", ["codex-entry.js"]],
  [process.execPath, ["--no-warnings", "--enable-source-maps", "--", "codex-entry.js"]],
  ["npx", ["-y", "@openai/codex"]], ["npx.cmd", ["--offline", "--", "@openai/codex@0.159.2"]],
  ["npx", ["-p", "@openai/codex@latest", "codex"]],
  ["npm", ["exec", "--yes", "--", "@openai/codex@next"]],
  ["npm", ["x", "--package=@openai/codex@0.159.2", "--", "codex"]],
  ["pnpm", ["dlx", "--silent", "@openai/codex"]],
  ["pnpm", ["dlx", "--package", "@openai/codex@latest", "codex"]],
  ["pnpx", ["--silent", "@openai/codex@0.159.2"]],
  ["pnpx", ["--package=@openai/codex", "codex"]],
  ["bun", ["x", "--bun", "@openai/codex@latest"]],
  ["bunx.exe", ["--no-install", "--silent", "@openai/codex@0.159.2"]],
  ["bunx", ["-p", "@openai/codex@next", "codex"]],
  ["yarn.cmd", ["dlx", "-q", "@openai/codex@latest"]],
  ["yarn", ["dlx", "--quiet", "--package", "@openai/codex@0.159.2", "codex"]],
  ["env", ["codex"]], ["/usr/bin/env", ["--", "/fixture/bin/codex"]],
  ["env", ["-u", "UNUSED_FIXTURE", "--unset", "OTHER_FIXTURE", "codex"]],
  ["env", ["node", "--no-warnings", "codex-entry.js"]],
  ["env", ["bunx", "--bun", "@openai/codex@latest"]],
];

const unsupported: [string, string[]][] = [
  ["/private-path/SECRET-wrapper", ["TOKEN=SECRET", "@openai/codex"]],
  ["sh", ["-c", "@openai/codex $(SECRET)"]],
  ["npx", ["--call", "@openai/codex"]], ["npm", ["exec", "@openai/codex"]],
  ["npm", ["install", "@openai/codex"]], ["pnpm", ["exec", "@openai/codex"]],
  ["bun", ["run", "@openai/codex"]], ["yarn", ["run", "@openai/codex"]],
  ["pnpx", ["--shell-mode", "@openai/codex"]], ["bunx", ["--unknown", "@openai/codex"]],
  ["npx", ["other-command", "@openai/codex"]],
  ["yarn", ["dlx", "-p", "@openai/codex", "other-command"]],
  ["bunx", ["--package=other-package", "codex", "@openai/codex"]],
  ["pnpx", ["--package"]], ["bunx", ["@openai/codex@"]],
  ["npx", ["@openai/codex@npm:other-package"]], ["bunx", ["@openai/codex@file:codex.tgz"]],
  ["npx", ["@openai/codex@."]], ["pnpx", ["@openai/codex@..\\vendor"]],
  ["npx", ["--package=@openai/codex@fixture.tgz", "codex"]],
  ["node", ["-e", "SECRET"]], ["node", ["--no-warnings"]],
  ["env", ["-i", "codex"]], ["env", ["CODEX_HOME=SECRET", "codex"]],
  ["env", ["HOME=SECRET", "codex"]], ["env", ["-u", "CODEX_HOME", "codex"]],
  ["env", ["--unset", "HOME", "codex"]], ["env", ["-u", "USERPROFILE", "codex"]],
  ["env", ["-u"]], ["env", ["env", "codex"]], ["env", ["unknown-wrapper", "codex"]],
];

class InertChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closeObserved = false;
  close(): void {
    if (this.closeObserved) return;
    this.closeObserved = true;
    this.emit("close", 1);
  }
}

function fixture(t: TestContext, command: string, args: string[], structured = false, provider: "codex" | "claude" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "provider-bootstrap-"));
  const directory = join(root, "account");
  mkdirSync(directory);
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex/config.toml"), '[plugins."review@local"]\nenabled = true\n');
  const agent: AgentDefinition = {
    id: "fixture", name: "Fixture", command, args, env: {}, context: { kind: "native" },
    driver: provider === "codex" ? "codex-app-server" : "claude-code",
    ...(structured ? { codexAppServer: { status: "supported" as const, installedVersion: "0.155.1",
      appServerAvailable: true, transport: "stdio" as const, verification: "generated-schema" as const,
      contractFingerprint: "inert-fixture" } } : {}),
  };
  const spawns: SpawnAgentOptions[] = [];
  const acquisitions: string[] = [];
  const releases: string[] = [];
  const children: InertChild[] = [];
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root, configPath: join(root, "unused-config.json"),
    accounts: [{ id: "fixture-account", label: "Fixture", provider, directory }],
    agents: () => [agent],
    resolveEnv: () => ({ HOME: root, CODEX_HOME: "wrong-fixture-home", OPENAI_API_KEY: "synthetic-placeholder" }),
    acquireLease: (path) => { acquisitions.push(path); return true; },
    releaseLease: (path) => { releases.push(path); return true; },
    onUpdate: () => {}, onAccountAdded: () => { assert.fail("inert fixture cannot authenticate"); },
    probe: async () => false, identify: async () => undefined,
    spawn: (options) => {
      spawns.push(options);
      const child = new InertChild();
      children.push(child);
      return child as unknown as AgentProcess;
    },
    kill: async (child) => { queueMicrotask(() => (child as unknown as InertChild).close()); return true; },
  });
  t.after(async () => {
    supervisor.shutdown();
    assert.equal(await waitForPendingKills(5_000), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, supervisor, spawns, acquisitions, releases, children };
}

test("validated bootstrap extraction retains launcher options and drops session arguments", () => {
  for (const [command, prefix] of supported) {
    const args = [...prefix, ...sessionArgs];
    assert.deepEqual(codexLauncherBootstrap(command, args), prefix, command);
    assert.deepEqual(args, [...prefix, ...sessionArgs], "input argv remains unchanged");
  }
});

test("the supervisor prepares sign-in and app-server after every recognized prefix and inherited plugins", async (t) => {
  for (const [command, prefix] of supported) {
    for (const structured of [false, true]) {
      await t.test(`${command} ${prefix.join(" ")} ${structured ? "app-server" : "sign-in"}`, async (t) => {
        const f = fixture(t, command, [...prefix, ...sessionArgs], structured);
        const view = await f.supervisor.startAccount({ accountId: "fixture-account" });
        const launched = f.spawns[0]!;
        assert.deepEqual(launched.args, [...prefix, ...pluginArgs, ...(structured ? ["app-server"] : ["login", "--device-auth"])]);
        assert.equal(launched.env!.CODEX_HOME, f.directory);
        assert.equal(launched.env!.OPENAI_API_KEY, undefined);
        assert.deepEqual(launched.scrubInheritedEnv, ["OPENAI_API_KEY"]);
        assert.equal(launched.windowsShell, false);
        assert.deepEqual(f.acquisitions, [f.directory]);
        assert.equal(view.accountId, "fixture-account");
        f.supervisor.shutdown();
        assert.equal(await waitForPendingKills(5_000), true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(f.releases, [f.directory]);
        assert.equal(f.supervisor.views()[0]!.status, "cancelled");
      });
    }
  }
});

test("unsupported bootstrap forms refuse with a fixed diagnostic before leases, spawn, or plugin mutation", async (t) => {
  for (const [command, args] of unsupported) {
    const f = fixture(t, command, args);
    await assert.rejects(f.supervisor.startAccount({ accountId: "fixture-account" }), {
      message: "Codex sign-in could not identify a supported launcher form. " +
        "Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.",
    });
    assert.deepEqual(f.acquisitions, []);
    assert.deepEqual(f.releases, []);
    assert.deepEqual(f.spawns, []);
    assert.equal(existsSync(join(f.directory, "plugins")), false);
    assert.deepEqual(f.supervisor.views(), []);
  }
});

test("Claude retains its existing direct and bare Node bootstrap behavior", async (t) => {
  for (const [command, prefix] of [["claude", []], [process.execPath, ["claude-entry.js"]]] as [string, string[]][]) {
    const f = fixture(t, command, [...prefix, "--verbose"], false, "claude");
    await f.supervisor.startAccount({ accountId: "fixture-account" });
    assert.deepEqual(f.spawns[0]!.args, [...prefix, "auth", "login"]);
  }
});

test("actual inert launchers forward supervisor sign-in, status, and app-server tails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "provider-forwarding-"));
  const previousEnv = process.env;
  // runContextCommand merges the daemon environment. Give this whole test a synthetic one so
  // neither the status child nor the injected sign-in spawn can inherit operator credentials.
  process.env = { HOME: root, ...(previousEnv.SystemRoot ? { SystemRoot: previousEnv.SystemRoot } : {}) };
  const record = join(root, "argv.jsonl");
  const entry = join(root, "receiver.cjs");
  writeFileSync(entry, `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("inert fixture: unauthenticated\\n");
process.exit(process.argv.includes("app-server") ? 1 : 0);
`);
  const cases: [string, string[]][] = [
    [process.execPath, [entry]],
    [process.execPath, ["--no-warnings", "--enable-source-maps", "--", entry]],
  ];
  if (process.platform !== "win32") {
    cases.push(["/usr/bin/env", ["-u", "UNUSED_FIXTURE", "--", process.execPath, "--no-warnings", entry]]);
    const packageShim = join(root, "npx");
    // This is a local inert argv adapter, never a real package manager. No shell, registry,
    // package download, executable discovery, authentication, or provider protocol is involved.
    writeFileSync(packageShim, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "-y" || args[1] !== "@openai/codex@0.0.0-fixture") process.exit(2);
process.argv = [process.execPath, ${JSON.stringify(entry)}, ...args.slice(2)];
require(${JSON.stringify(entry)});
`);
    chmodSync(packageShim, 0o700);
    cases.push([packageShim, ["-y", "@openai/codex@0.0.0-fixture"]]);
  }
  try {
    for (const [index, [command, prefix]] of cases.entries()) {
      for (const structured of [false, true]) {
        const directory = join(root, `account-${index}-${structured}`);
        mkdirSync(directory);
        const spawns: SpawnAgentOptions[] = [];
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let releaseCount = 0;
        const children: AgentProcess[] = [];
        const supervisor = new ProviderLoginSupervisor({
          dataDir: root, configPath: join(root, "unused-config.json"),
          accounts: [{ id: "fixture", label: "Fixture", provider: "codex", directory }],
          agents: () => [{ id: "fixture", name: "Fixture", command, args: [...prefix, ...sessionArgs],
            env: {}, driver: "codex-app-server", context: { kind: "native" },
            ...(structured ? { codexAppServer: { status: "supported", installedVersion: "0.155.1",
              appServerAvailable: true, transport: "stdio", verification: "generated-schema",
              contractFingerprint: "inert-fixture" } } : {}) }],
          resolveEnv: () => ({ HOME: root }),
          acquireLease: () => true,
          releaseLease: () => { releaseCount++; release(); return true; },
          onUpdate: () => {}, onAccountAdded: () => { assert.fail("fixture never authenticates"); },
          identify: async () => undefined,
          spawn: (options) => {
            spawns.push(options);
            const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
              stdio: ["pipe", "pipe", "pipe"], shell: false }) as AgentProcess;
            child.once("close", () => { child.closeObserved = true; });
            children.push(child);
            return child;
          },
          kill: async (child) => {
            if (!child.closeObserved) {
              const closed = once(child, "close");
              child.kill("SIGKILL");
              await closed;
            }
            return true;
          },
        });
        writeFileSync(record, "");
        try {
          await supervisor.startAccount({ accountId: "fixture" });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Inert fixture did not release its lease.")), 5_000);
            void released.then(() => { clearTimeout(timer); resolve(); });
          });
          assert.equal(await waitForPendingKills(5_000), true);
          const forwarded = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
          assert.deepEqual(forwarded, structured ? [["app-server"]] : [["login", "--device-auth"], ["login", "status"]], command);
          assert.deepEqual(spawns[0]!.args, [...prefix, ...(structured ? ["app-server"] : ["login", "--device-auth"])]);
          assert.equal(supervisor.views()[0]!.status, "failed");
          assert.equal(releaseCount, 1);
          assert.equal(existsSync(join(directory, "auth.json")), false);
          assert.ok(children.every((child) => child.closeObserved));
        } finally {
          supervisor.shutdown();
          assert.equal(await waitForPendingKills(5_000), true);
        }
      }
    }
  } finally {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
