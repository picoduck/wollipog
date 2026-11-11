import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { buildBwrapArgs } from "./spawn.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { resolveNative } from "./discovery/resolve.js";
import { managedWorktreeGitLayout, managedWorktreeGitWritableRoots, managedWorktreeReadOnlyPaths } from "./managed-worktree-sandbox.js";
import { createPiCommandHomePrototype, piCommandHomePrototypeNamespaceUnavailable, type PiCommandHomePrototypePolicy } from "./pi-command-home-prototype.js";
import { createPiInertControlLauncher } from "./pi-inert-control-launcher.js";
import { createHash } from "node:crypto";

const nativeBwrap = process.platform === "linux" ? await resolveNative("bwrap") : null;

/** Production managed-worktree inputs, all confined to an inert repository and synthetic HOME.
 * Resolve before the namespace probe so unavailable local kernels cannot hide setup regressions. */
async function prepareTopology(root: string) {
  const worktree = join(root, "worktrees", "selected"), nativeHome = join(root, "home"),
    home = join(nativeHome, ".pi", "agent"), immutable = join(root, "immutable"), repo = join(root, "repo");
  for (const path of [home, immutable, repo]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, "auth.json"), "synthetic-only");
  writeFileSync(join(immutable, "hook.mjs"), "inert-hook");
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
  const layout = managedWorktreeGitLayout(worktree, repo);
  assert.ok(layout);
  const configPath = join(layout.worktreeGitDir, "config.worktree");
  assert.equal(existsSync(configPath), false, "Git fixture begins with no per-worktree config");
  const readOnlyPaths = managedWorktreeReadOnlyPaths(protections, true);
  assert.ok(readOnlyPaths.includes(configPath), "reserve the missing runner-owned config using production setup");
  const state = {
    driver: "pi" as const, dataDir: join(root, "state"), env: { HOME: nativeHome, PI_CODING_AGENT_DIR: home }, sessionId: "inert",
    cwd: worktree, preserveProviderHome: true, readOnlyPaths,
    protectedWorktree: { path: worktree, gitWritableRoots: managedWorktreeGitWritableRoots(worktree, protections),
      requiredReadOnlyPaths: readOnlyPaths },
  };
  // A real resolver, with only ambient provider environment replaced by synthetic fixture values.
  // Omission must retain its production refusal, rather than silently broadening the Git grant.
  const runtime = { nativeEnvironment: () => ({}), nativeHome: () => nativeHome };
  await assert.rejects(resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, runtime,
    { ...state, readOnlyPaths: [] }), /managed worktree config cannot be protected before provider launch/u);
  const resolved = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, runtime, state);
  assert.ok(resolved?.backend === "bwrap");
  assert.equal(lstatSync(configPath).isFile(), true);
  assert.equal(lstatSync(configPath).nlink, 1);
  assert.equal(realpathSync(configPath), configPath);
  assert.equal(readFileSync(configPath, "utf8"), "");
  assert.ok(resolved.readOnlyBinds?.includes(configPath));
  assert.ok(readOnlyPaths.every(path => resolved.readOnlyBinds?.includes(path)));
  assert.deepEqual(resolved.writableBinds?.find(bind => bind.source === home), { source: home, target: home });
  // Discovery preserves stable installation aliases. This strict experimental backend takes
  // canonical executable paths, so spell the same selected binary canonically in its fixture.
  // No launcher flags or writable grants change.
  const outer = { ...resolved, command: realpathSync(resolved.command) };
  const policy: PiCommandHomePrototypePolicy = { outer, providerHome: home, immutablePaths: [immutable],
    installationRoot: immutable, version: "0.85.0", configuredArgs: ["--no-extensions"],
    shell: realpathSync("/bin/sh"), nodeRuntime: realpathSync(process.execPath),
    commandEntrypoint: fileURLToPath(new URL("./pi-command-home-entrypoint.mjs", import.meta.url)) };
  // Validate the actual backend's topology inputs before a kernel skip as well. These audits
  // deliberately stand for the inert installation; they attest to no loaded Pi/runtime bytes.
  createPiCommandHomePrototype(policy, { auditInstallation: () => true, auditRuntime: () => true });
  return { worktree, home, outer, configPath, policy };
}

test("inert production resolver reserves and pins managed Git config before any namespace availability test", {
  skip: process.platform !== "linux" ? "UNAVAILABLE: fixture requires native Linux" :
    !nativeBwrap ? "UNAVAILABLE: production discovery cannot resolve bubblewrap" : false,
}, async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-managed-config-")));
  try { await prepareTopology(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("fixed inert MCP helper loses HOME writes and descendants while the actual outer provider keeps refresh/config", {
  skip: process.platform !== "linux" ? "UNAVAILABLE: prototype requires native Linux" : false, timeout: 60_000,
}, async t => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-inert-control-os-")));
  try {
    if (!nativeBwrap) { t.skip("UNAVAILABLE: production discovery cannot resolve bubblewrap"); return; }
    const { outer, worktree, home, policy } = await prepareTopology(root);
    const mcp = fileURLToPath(new URL("./fixtures/pi-inert-control-helper.mjs", import.meta.url));
    // Exercise the new constructor before any kernel skip, including the real entrypoint pin and
    // source/target grant checks. The installation/runtime audits are explicitly inert fixtures.
    createPiInertControlLauncher({ commandPolicy: policy, controlEntrypoint: fileURLToPath(new URL("./pi-inert-control-entrypoint.mjs", import.meta.url)),
      mcpEntrypoint: mcp, mcpEntrypointSha256: createHash("sha256").update(readFileSync(mcp)).digest("hex"), imports: [], transportEnvironment: {} },
    { auditInstallation: () => true, auditRuntime: () => true });
    const probe = spawnSync(outer.command, [...outer.args, "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--unshare-pid", "--", "/bin/true"], { encoding: "utf8", timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    if (probe.status !== 0 && piCommandHomePrototypeNamespaceUnavailable(probe.stderr ?? "")) {
      t.skip("UNAVAILABLE: host refuses outer namespace; no fixed-helper OS conformance established"); return;
    }
    assert.equal(probe.status, 0, probe.stderr);
    const fixture = fileURLToPath(new URL("./fixtures/pi-inert-control-provider.mjs", import.meta.url));
    const moduleUrl = new URL("./pi-inert-control-launcher.ts", import.meta.url).href;
    const args = buildBwrapArgs({ command: process.execPath, cwd: worktree,
      args: ["--import", import.meta.resolve("tsx"), fixture, moduleUrl, JSON.stringify(policy)] }, outer);
    const result = spawnSync(outer.command, args, { encoding: "utf8", timeout: 50_000,
      env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PI_INERT_CONTROL_OUTER_WRITES: passed/u);
    if (result.stdout.includes("PI_INERT_CONTROL_UNAVAILABLE")) { t.skip("UNAVAILABLE: inner namespace refused; no fixed-helper OS conformance established"); return; }
    assert.match(result.stdout, /PI_INERT_CONTROL_OS_CONFORMANCE: passed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    if (!nativeBwrap) { t.skip("UNAVAILABLE: production discovery cannot resolve bubblewrap"); return; }
    const { worktree, home, outer, configPath, policy } = await prepareTopology(root);
    const outerArgs = buildBwrapArgs({ command: "/bin/true", args: [], cwd: worktree }, outer);
    assert.ok(outerArgs.some((value, index, args) => value === "--ro-bind" && args[index + 1] === configPath),
      "the actual outer launch pins the reserved config read-only");
    const probe = spawnSync(outer.command, [...outer.args, "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--unshare-pid", "--", "/bin/true"], { encoding: "utf8", timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("UNAVAILABLE: bubblewrap is not installed"); return;
    }
    if (probe.status !== 0 && piCommandHomePrototypeNamespaceUnavailable(probe.stderr ?? "")) {
      t.skip("UNAVAILABLE: host refuses the outer namespace; no write-denial conformance established"); return;
    }
    assert.equal(probe.status, 0, probe.stderr);
    const fixture = fileURLToPath(new URL("./fixtures/pi-command-home-provider.mjs", import.meta.url));
    const moduleUrl = new URL("./pi-command-home-prototype.ts", import.meta.url).href;
    const args = buildBwrapArgs({ command: process.execPath, cwd: worktree,
      args: ["--import", import.meta.resolve("tsx"), fixture, moduleUrl, JSON.stringify(policy)] }, outer);
    const result = spawnSync(outer.command, args, { encoding: "utf8", timeout: 35_000,
      env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PI_COMMAND_HOME_OUTER_CONFIG: passed/u,
      "the outer Git config check must pass even when the nested namespace is unavailable");
    if (result.stdout.includes("PI_COMMAND_HOME_UNAVAILABLE")) {
      t.skip("UNAVAILABLE: inner namespace refused; no write-denial conformance established"); return;
    }
    assert.match(result.stdout, /PI_COMMAND_HOME_SYNTHETIC_CONFORMANCE: passed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
