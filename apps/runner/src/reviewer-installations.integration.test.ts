import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "@wollipog/test-support/bounded-child-process";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { reviewerInstallations } from "./reviewer-installations.js";
import { buildBwrapArgs } from "./spawn.js";

for (const mode of ["bwrap", "seatbelt"] as const) {
  const platform = mode === "bwrap" ? "linux" : "darwin";
  const probe = process.platform === platform ? spawnSync(mode === "bwrap" ? "bwrap" : "/usr/bin/sandbox-exec",
    mode === "bwrap" ? ["--ro-bind", "/", "/", "--", "/usr/bin/true"] : ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { encoding: "utf8", timeout: 5_000 }) : undefined;
  test(`${mode} prevents replacing nested PATH links and modifying installations while sibling grants work`, {
    skip: process.platform !== platform ? `requires ${platform}` : probe?.status !== 0 ? `${mode} unavailable: ${probe?.stderr ?? probe?.error}` : false,
  }, async (t) => {
    // Outside /tmp: bwrap deliberately replaces /tmp with a private filesystem.
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".reviewer-link-test-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    for (const dir of ["dotfiles/bin", "links", "work", "state", ".cache", ".npm", "tmp"]) mkdirSync(join(home, dir), { recursive: true });
    const binary = join(home, "dotfiles/bin/claude");
    writeFileSync(binary, "native fixture", { mode: 0o755 });
    symlinkSync("../dotfiles", join(home, "links/current"));
    symlinkSync("links/current/bin", join(home, "bin"));
    const writable = ["work", ".cache", ".npm"].map((dir) => join(home, dir));
    const inventory = reviewerInstallations([], () => "", join(home, "bin"));
    const isolation = await resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, {
      nativeHome: () => home, nativeEnvironment: () => ({}), nativeTmp: () => join(home, "tmp"),
    }, { driver: "acp", sessionId: "s1", dataDir: join(home, "state"), cwd: writable[0]!, env: { HOME: home },
      additionalWritableRoots: writable.slice(1), ...inventory });
    assert.ok(isolation?.backend === mode);
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const {join} = require('node:path');
      const home = ${JSON.stringify(home)};
      const denied = (fn) => assert.throws(fn, error => ['EROFS', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code));
      for (const path of ${JSON.stringify(inventory.reviewerSymlinkPaths)}) {
        denied(() => fs.unlinkSync(path));
        denied(() => fs.renameSync(path, path + '-moved'));
      }
      denied(() => fs.renameSync(join(home, 'links'), join(home, 'links-moved')));
      denied(() => fs.writeFileSync(${JSON.stringify(binary)}, 'tampered'));
      denied(() => fs.writeFileSync(join(home, 'bin/claude'), 'tampered'));
      for (const path of ${JSON.stringify(writable)}) fs.writeFileSync(join(path, 'allowed'), 'ok');
      assert.equal(fs.readFileSync(${JSON.stringify(binary)}, 'utf8'), 'native fixture');
      console.log('protected');
    `;
    const args = isolation.backend === "bwrap"
      ? buildBwrapArgs({ command: process.execPath, args: ["-e", script], cwd: writable[0]! }, isolation)
      : isolation.backend === "seatbelt" ? [...isolation.args, "-p", isolation.profile, process.execPath, "-e", script] : [];
    assert.equal(execFileSync(isolation.command, args, { encoding: "utf8", timeout: 15_000 }).trim(), "protected");
  });
}
