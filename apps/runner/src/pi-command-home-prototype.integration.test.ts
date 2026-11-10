import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { buildBwrapArgs, type BwrapSpawnIsolation } from "./spawn.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { managedWorktreeGitWritableRoots, managedWorktreeReadOnlyPaths } from "./managed-worktree-sandbox.js";
import { piCommandHomePrototypeNamespaceUnavailable, type PiCommandHomePrototypePolicy } from "./pi-command-home-prototype.js";

test("installed pinned Pi SDK factory invokes the prototype operations without any provider or command process", {
  skip: process.env.WOLLIPOG_TEST_PI_CODE_ROOT ? false : "UNAVAILABLE: supply an audited installed Pi code root; no package is downloaded",
  timeout: 15_000,
}, () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-sdk-contract-")));
  try {
    const fixture = fileURLToPath(new URL("./fixtures/pi-command-home-sdk-contract.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fixture,
      new URL("./pi-command-home-prototype.ts", import.meta.url).href, process.env.WOLLIPOG_TEST_PI_CODE_ROOT!, root], {
      encoding: "utf8", timeout: 10_000, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PINNED_PI_SDK_OPERATIONS_CONTRACT: passed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inert provider keeps refresh/config/transcripts while operations commands lose credential-home writes in nested topology", {
  skip: process.platform !== "linux" ? "UNAVAILABLE: prototype requires native Linux" : false,
  timeout: 45_000,
}, async t => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-command-conformance-")));
  try {
    const worktree = join(root, "worktree"), nativeHome = join(root, "home"),
      home = join(nativeHome, ".pi", "agent"), immutable = join(root, "immutable");
    for (const path of [home, immutable]) mkdirSync(path, { recursive: true });
    writeFileSync(join(home, "auth.json"), "synthetic-only");
    writeFileSync(join(immutable, "hook.mjs"), "inert-hook");
    const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--unshare-pid", "--", "/bin/true"], { encoding: "utf8", timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("UNAVAILABLE: bubblewrap is not installed"); return;
    }
    if (probe.status !== 0 && piCommandHomePrototypeNamespaceUnavailable(probe.stderr ?? "")) {
      t.skip("UNAVAILABLE: host refuses the outer namespace; no write-denial conformance established"); return;
    }
    assert.equal(probe.status, 0, probe.stderr);
    const repo = join(root, "repo"); mkdirSync(repo);
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 5_000,
        env: { PATH: "/usr/bin:/bin", HOME: nativeHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repo, "tracked"), "inert"); git(["add", "tracked"]);
    git(["-c", "user.name=Inert", "-c", "user.email=inert@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    git(["worktree", "add", "--quiet", "-b", "prototype", worktree]);
    symlinkSync(home, join(worktree, "home-alias"));
    const protections = [{ worktreePath: worktree, repoPath: repo }];
    const readOnlyPaths = managedWorktreeReadOnlyPaths(protections);
    const resolved = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
      driver: "pi", dataDir: join(root, "state"), env: { HOME: nativeHome }, sessionId: "inert",
      cwd: worktree, preserveProviderHome: true,
      protectedWorktree: { path: worktree, gitWritableRoots: managedWorktreeGitWritableRoots(worktree, protections),
        requiredReadOnlyPaths: readOnlyPaths },
    });
    assert.ok(resolved?.backend === "bwrap");
    const outer: BwrapSpawnIsolation = resolved;
    const policy: PiCommandHomePrototypePolicy = { outer, providerHome: home, immutablePaths: [immutable],
      installationRoot: immutable, version: "0.85.0", configuredArgs: ["--no-extensions"],
      shell: realpathSync("/bin/sh"), nodeRuntime: realpathSync(process.execPath),
      commandEntrypoint: fileURLToPath(new URL("./pi-command-home-entrypoint.mjs", import.meta.url)) };
    const fixture = fileURLToPath(new URL("./fixtures/pi-command-home-provider.mjs", import.meta.url));
    const moduleUrl = new URL("./pi-command-home-prototype.ts", import.meta.url).href;
    const args = buildBwrapArgs({ command: process.execPath, cwd: worktree,
      args: ["--import", import.meta.resolve("tsx"), fixture, moduleUrl, JSON.stringify(policy)] }, outer);
    const result = spawnSync(outer.command, args, { encoding: "utf8", timeout: 35_000,
      env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    if (result.stdout.includes("PI_COMMAND_HOME_UNAVAILABLE")) {
      t.skip("UNAVAILABLE: inner namespace refused; no write-denial conformance established"); return;
    }
    assert.match(result.stdout, /PI_COMMAND_HOME_SYNTHETIC_CONFORMANCE: passed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
