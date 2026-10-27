import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewerInstallationPaths } from "./reviewer-installations.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { buildBwrapArgs } from "./spawn.js";

test("inventory pins configured reviewers, symlink containers and script interpreters across harnesses", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-installations-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["bin", "release", "runtime"]) mkdirSync(join(root, dir));
  const runtime = join(root, "runtime", "node");
  writeFileSync(runtime, "native fixture", { mode: 0o755 });
  const cli = join(root, "release", "cli");
  writeFileSync(cli, `#!${runtime}\n`, { mode: 0o755 });
  symlinkSync(cli, join(root, "bin", "claude"));
  const paths = reviewerInstallationPaths([{ id: "claude", command: "claude", driver: "claude-code" }], () => join(root, "bin"), "");
  assert.deepEqual(new Set(paths), new Set([join(root, "bin"), join(root, "release"), join(root, "runtime")]));
  assert.deepEqual(reviewerInstallationPaths([{ id: "remote", command: cli, driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu" } }], () => "", ""), []);
  assert.ok(!reviewerInstallationPaths([{ id: "shell", command: "/bin/sh", driver: "claude-code" }], () => "", "").includes("/"),
    "a system directory symlink must not turn the whole filesystem into an installation overlay");
  const invalidPathEntry = join(root, "regular-file");
  writeFileSync(invalidPathEntry, "fixture");
  assert.deepEqual(new Set(reviewerInstallationPaths([], () => "", `${invalidPathEntry}:${join(root, "bin")}`)), new Set(paths),
    "spawn skips PATH entries that are not searchable directories");
  const executeOnly = join(root, "release", "execute-only");
  writeFileSync(executeOnly, "native fixture", { mode: 0o111 });
  chmodSync(executeOnly, 0o111);
  assert.deepEqual(reviewerInstallationPaths([{ id: "unreadable", command: executeOnly, driver: "claude-code" }], () => "", ""), [join(root, "release")],
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
