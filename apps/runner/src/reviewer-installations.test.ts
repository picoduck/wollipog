import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { reviewerInstallations } from "./reviewer-installations.js";
import { providerStateKey, resolveExecutionIsolation } from "./execution-isolation.js";
import { buildBwrapArgs, type BwrapSpawnIsolation } from "./spawn.js";
import { trustedPath } from "./review-trust.js";

test("inventory records configured reviewers, exact link entries and script interpreters across harnesses", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-installations-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["bin", "release", "runtime"]) mkdirSync(join(root, dir));
  const runtime = join(root, "runtime", "node");
  writeFileSync(runtime, "native fixture", { mode: 0o755 });
  const cli = join(root, "release", "cli");
  writeFileSync(cli, `#!${runtime}\n`, { mode: 0o755 });
  symlinkSync(cli, join(root, "bin", "claude"));
  const paths = reviewerInstallations([{ id: "claude", command: "claude", driver: "claude-code" }], () => join(root, "bin"), "");
  assert.deepEqual(paths.reviewerSymlinkPaths, [join(root, "bin", "claude")]);
  assert.deepEqual(new Set(paths.reviewerInstallationPaths), new Set([join(root, "release"), join(root, "runtime")]));
  assert.deepEqual(reviewerInstallations([{ id: "remote", command: cli, driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu" } }], () => "", ""), { reviewerInstallationPaths: [], reviewerSymlinkPaths: [] });
  assert.ok(!reviewerInstallations([{ id: "shell", command: "/bin/sh", driver: "claude-code" }], () => "", "").reviewerInstallationPaths.includes("/"),
    "a system directory symlink must not turn the whole filesystem into an installation overlay");
  const invalidPathEntry = join(root, "regular-file");
  writeFileSync(invalidPathEntry, "fixture");
  assert.deepEqual(reviewerInstallations([], () => "", `${invalidPathEntry}:${join(root, "bin")}`), paths,
    "spawn skips PATH entries that are not searchable directories");
  const executeOnly = join(root, "release", "execute-only");
  writeFileSync(executeOnly, "native fixture", { mode: 0o111 });
  chmodSync(executeOnly, 0o111);
  assert.deepEqual(reviewerInstallations([{ id: "unreadable", command: executeOnly, driver: "claude-code" }], () => "", ""), { reviewerInstallationPaths: [join(root, "release")], reviewerSymlinkPaths: [] },
    "an unreadable reviewer still has its directory protected without blocking unrelated providers");
});

for (const mode of ["bwrap", "seatbelt"] as const) {
  test(`${mode} protects reviewer installations after writable grants and refuses unverifiable paths`, { skip: process.platform === "win32" }, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-launch-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const installation = join(root, "installation");
    mkdirSync(installation);
    const deps = {
      platform: mode === "bwrap" ? "linux" as const : "darwin" as const,
      uid: () => 1000, nativeHome: () => root, nativeEnvironment: () => ({}), nativeTmp: () => root,
      resolveNative: async () => ({ path: "/bin/boundary", via: "path" as const, launch: { command: "/bin/boundary", args: [] } }),
    };
    const state = { driver: "acp" as const, sessionId: "s1", dataDir: root, cwd: root, env: {},
      additionalWritableRoots: [root], reviewerInstallationPaths: [installation] };
    const isolation = await resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, deps, state);
    assert.ok(isolation?.backend === mode);
    if (isolation.backend === "bwrap") {
      assert.ok(isolation.readOnlyBinds?.includes(installation));
      const args = buildBwrapArgs({ command: "agent", args: [], cwd: root }, isolation);
      assert.ok(args.lastIndexOf("--ro-bind") > args.lastIndexOf("--bind"));
    } else if (isolation.backend === "seatbelt") {
      assert.ok(isolation.readOnlyPaths?.includes(installation));
      assert.ok(isolation.profile.indexOf("(deny file-write*") > isolation.profile.indexOf("(allow file-write*"));
      assert.ok(isolation.profile.includes(`(literal "${installation}")`));
      assert.ok(isolation.profile.slice(isolation.profile.indexOf("(deny file-write-unlink")).includes(`(literal "${root}")`));
    }
    await assert.rejects(resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, {
      ...deps, isExposableEntryNative: async (path) => path !== installation,
    }, state), new RegExp(`Cannot protect reviewer installation ${installation}`));
    const child = join(installation, "cache");
    mkdirSync(child);
    await assert.rejects(resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, deps,
      { ...state, cwd: child, additionalWritableRoots: [] }), /reviewer installation .*contains a writable root/,
    "an ancestor overlay must never silently mask a writable worktree or cache");
    if (mode === "bwrap") {
      await assert.rejects(resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, deps,
        { ...state, driver: "claude-code", dataDir: installation }), /reviewer installation .*writable remapped source/);
    }
  });
}

test("bwrap refuses a reviewer link reachable through a writable remapped source", { skip: process.platform === "win32" }, async (t) => {
  const f = linkFixture(t);
  const source = join(f.home, "state/provider-state/claude", providerStateKey("s1"), "projects");
  mkdirSync(source, { recursive: true });
  const command = join(source, "claude");
  symlinkSync(f.binary, command);
  const inventory = reviewerInstallations([{ id: "claude", command, driver: "claude-code" }], () => "", "");
  await assert.rejects(linkIsolation("bwrap", f, inventory, { driver: "claude-code" }),
    (error: Error) => error.message.includes(command) && error.message.includes(source) && error.message.includes("remapped"));
});

test("bwrap overlays an installation reached through an aliased writable grant before trusting its link", { skip: process.platform === "win32" }, async (t) => {
  const f = linkFixture(t);
  const alias = join(f.home, "dotfiles-alias");
  symlinkSync("dotfiles", alias);
  symlinkSync("claude", join(dirname(f.binary), "codex"));
  const inventory = reviewerInstallations([], () => "", dirname(f.binary));
  const isolation = await linkIsolation("bwrap", f, inventory, { additionalWritableRoots: [alias] });
  assert.ok(isolation?.backend === "bwrap");
  assert.ok(isolation.readOnlyBinds?.includes(dirname(f.binary)));
});

function linkFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-links-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  for (const part of ["dotfiles/bin", "work", "state", ".cache", ".npm", "tmp"]) mkdirSync(join(home, part), { recursive: true });
  const binary = join(home, "dotfiles/bin/claude");
  writeFileSync(binary, "native fixture", { mode: 0o755 });
  return { root, home, binary, writable: [join(home, "work"), join(home, ".cache"), join(home, ".npm")] };
}

async function linkIsolation(mode: "bwrap" | "seatbelt", f: ReturnType<typeof linkFixture>,
  inventory: ReturnType<typeof reviewerInstallations>, extra: Record<string, unknown> = {}) {
  return resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, {
    platform: mode === "bwrap" ? "linux" : "darwin", uid: () => 1000,
    nativeHome: () => f.home, nativeEnvironment: () => ({}), nativeTmp: () => join(f.home, "tmp"),
    resolveNative: async () => ({ path: "/bin/boundary", via: "path", launch: { command: "/bin/boundary", args: [] } }),
  }, { driver: "acp", sessionId: "s1", cwd: f.writable[0]!, dataDir: join(f.home, "state"), env: { HOME: f.home },
    additionalWritableRoots: f.writable.slice(1), ...inventory, ...extra });
}

/** Evaluate binds at a canonical path, or at a link entry's canonical parent. */
function mountMode(isolation: BwrapSpawnIsolation, cwd: string, path: string): "ro" | "rw" {
  const args = buildBwrapArgs({ command: "agent", args: [], cwd }, isolation);
  let mode: "ro" | "rw" = "ro";
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--bind" && args[index] !== "--ro-bind") continue;
    const target = args[index + 2]!;
    const rel = relative(target, path);
    if (rel === "" || (rel !== ".." && !rel.startsWith("../"))) mode = args[index] === "--bind" ? "rw" : "ro";
    index += 2;
  }
  return mode;
}

for (const mode of ["bwrap", "seatbelt"] as const) {
  for (const nested of [false, true]) {
    test(`${mode} admits a ${nested ? "nested" : "dotfiles"} PATH link and retains writable siblings`, { skip: process.platform === "win32" }, async (t) => {
      const f = linkFixture(t);
      if (nested) {
        mkdirSync(join(f.home, "links"));
        symlinkSync("../dotfiles", join(f.home, "links/current"));
        symlinkSync("links/current/bin", join(f.home, "bin"));
      } else symlinkSync("dotfiles/bin", join(f.home, "bin"));
      // A PATH directory that does not resolve a reviewer is not a protection obligation.
      symlinkSync("../dotfiles/bin", join(f.home, ".cache/unrelated"));
      const inventory = reviewerInstallations([], () => "", `${join(f.home, ".cache/unrelated/missing")}:${join(f.home, "bin")}`);
      assert.deepEqual(inventory.reviewerInstallationPaths, [dirname(f.binary)]);
      assert.deepEqual(inventory.reviewerSymlinkPaths, [join(f.home, "bin"), ...(nested ? [join(f.home, "links/current")] : [])]);
      assert.equal(trustedPath(join(f.home, "bin/claude"), f.writable, process.getuid!(), statSync("/").uid), f.binary);
      const isolation = await linkIsolation(mode, f, inventory);
      assert.ok(isolation?.backend === mode);
      if (isolation.backend === "bwrap") {
        for (const path of f.writable) assert.equal(mountMode(isolation, f.writable[0]!, path), "rw", path);
        for (const path of [f.binary, ...inventory.reviewerSymlinkPaths.map(dirname)]) {
          assert.equal(mountMode(isolation, f.writable[0]!, path), "ro", path);
        }
        assert.ok(!isolation.readOnlyBinds?.includes(f.home));
      } else if (isolation.backend === "seatbelt") {
        for (const path of f.writable) assert.ok(isolation.writableRoots.includes(path));
        const denies = isolation.profile.slice(isolation.profile.indexOf("(deny file-write*"));
        for (const link of inventory.reviewerSymlinkPaths) assert.ok(denies.includes(`(literal "${link}")`));
        assert.ok(!denies.includes(`(subpath "${f.home}")`));
        assert.ok(!denies.includes(`(subpath "${join(f.home, "links")}")`));
        assert.ok(denies.includes(`(subpath "${dirname(f.binary)}")`));
        const unlinks = denies.slice(denies.indexOf("(deny file-write-unlink"));
        for (const path of [f.home, ...inventory.reviewerSymlinkPaths]) assert.ok(unlinks.includes(`(literal "${path}")`));
      }
    });
  }

  test(`${mode} refuses only reviewer-path links exposed in writable roots and names both paths`, { skip: process.platform === "win32" }, async (t) => {
    const f = linkFixture(t);
    const link = join(f.home, ".cache/bin");
    symlinkSync("../dotfiles/bin", link);
    const inventory = reviewerInstallations([], () => "", link);
    assert.throws(() => trustedPath(join(link, "claude"), f.writable, process.getuid!(), statSync("/").uid),
      (error: Error) => error.message.includes(join(f.home, ".cache")) && error.message.includes("session can write"));
    await assert.rejects(linkIsolation(mode, f, inventory),
      (error: Error) => error.message.includes(link) && error.message.includes(join(f.home, ".cache")));
    await linkIsolation(mode, f, reviewerInstallations([], () => "", join(f.home, "dotfiles/bin")));
  });

  test(`${mode} keeps a link target inside a writable root untrusted`, { skip: process.platform === "win32" }, async (t) => {
    const f = linkFixture(t);
    const target = join(f.home, ".cache/claude");
    writeFileSync(target, "planted", { mode: 0o755 });
    const command = join(f.home, "claude");
    symlinkSync(target, command);
    assert.throws(() => trustedPath(command, f.writable, process.getuid!(), statSync("/").uid),
      (error: Error) => error.message.includes(target) && error.message.includes(join(f.home, ".cache")));
    const inventory = reviewerInstallations([{ id: "claude", command, driver: "claude-code" }], () => "", "");
    await assert.rejects(linkIsolation(mode, f, inventory), /reviewer installation .*contains a writable root/);
  });

  test(`${mode} refuses a changed symlink entry instead of trusting a stale inventory`, { skip: process.platform === "win32" }, async (t) => {
    const f = linkFixture(t);
    const link = join(f.home, "bin");
    symlinkSync("dotfiles/bin", link);
    const inventory = reviewerInstallations([], () => "", link);
    rmSync(link);
    mkdirSync(link);
    await assert.rejects(linkIsolation(mode, f, inventory), /reviewer symlink .*not a symlink/);
  });

  test(`${mode} admits the dogfood installation shape, including package and system links`, { skip: process.platform === "win32" }, async (t) => {
    const f = linkFixture(t);
    for (const part of [".local/bin", ".local/share/claude/versions", ".codex/packages/standalone/releases/version/bin", ".local/opt/gh/usr/bin", ".nvm/versions/node/version/bin"]) {
      mkdirSync(join(f.home, part), { recursive: true });
    }
    const binaries = {
      claude: join(f.home, ".local/share/claude/versions/version"),
      codex: join(f.home, ".codex/packages/standalone/releases/version/bin/codex"),
      gh: join(f.home, ".local/opt/gh/usr/bin/gh"),
      node: join(f.home, ".nvm/versions/node/version/bin/node"),
      system: realpathSync("/bin/sh"),
    };
    for (const [name, path] of Object.entries(binaries)) {
      if (name === "system") continue;
      writeFileSync(path, "native fixture", { mode: 0o755 });
      if (name !== "node") symlinkSync(path, join(f.home, ".local/bin", name));
    }
    symlinkSync("releases/version", join(f.home, ".codex/packages/standalone/current"));
    rmSync(join(f.home, ".local/bin/codex"));
    symlinkSync(join(f.home, ".codex/packages/standalone/current/bin/codex"), join(f.home, ".local/bin/codex"));
    const inventory = reviewerInstallations([{ id: "system", command: "/bin/sh", driver: "claude-code" }], () => "", join(f.home, ".local/bin"));
    for (const path of [f.home, join(f.home, ".local"), join(f.home, ".local/share")]) assert.ok(!inventory.reviewerInstallationPaths.includes(path));
    const codexHome = join(f.home, ".codex");
    const isolation = await linkIsolation(mode, f, inventory, { additionalWritableRoots: [...f.writable.slice(1), codexHome] });
    assert.ok(isolation?.backend === mode);
    if (isolation.backend === "bwrap") {
      assert.ok(isolation.readOnlyBinds?.includes(join(codexHome, "packages")));
      for (const path of [...f.writable, codexHome]) assert.equal(mountMode(isolation, f.writable[0]!, path), "rw", path);
      for (const path of [...Object.values(binaries), ...inventory.reviewerSymlinkPaths.map(dirname)]) {
        assert.equal(mountMode(isolation, f.writable[0]!, path), "ro", path);
      }
    } else if (isolation.backend === "seatbelt") {
      for (const path of [...f.writable, codexHome]) assert.ok(isolation.writableRoots.includes(path));
      for (const link of inventory.reviewerSymlinkPaths) assert.ok(isolation.profile.includes(`(literal "${link}")`));
    }
  });
}
