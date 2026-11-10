import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("native root repair pins the inspected object and preserves contents", { skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 30_000 }, async (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-root-native-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const binary = join(fixture, "helper");
  execFileSync(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-DWOLLIPOG_PROFILE_ROOT_TEST_BARRIER",
    ...(process.platform === "linux" ? ["-static"] : []),
    fileURLToPath(new URL("../native/provider-home-lease-io.c", import.meta.url)), "-o", binary]);
  assert.equal(execFileSync(binary, ["--probe"], { encoding: "utf8" }), "");
  const leaseRoot = join(fixture, "lease-root"); mkdirSync(leaseRoot, { mode: 0o700 });
  const header = Buffer.alloc(5 + 1 + 4 + 4 + 8 + 4 + 4);
  header.write("WPLL4"); header.writeUInt32LE(process.pid, 6); header.writeUInt32LE(10, 10);
  header.writeBigUInt64LE(1024n, 14); header.writeUInt32LE(Buffer.byteLength(leaseRoot), 26);
  const snapshot = execFileSync(binary, [], { input: Buffer.concat([header, Buffer.from(leaseRoot)]) });
  assert.equal(snapshot[0], 83, "unchanged WPLL4 snapshot frame succeeds");
  assert.deepEqual(readdirSync(leaseRoot), [], "metadata repair mode does not alter the lease protocol");
  const home = join(fixture, "home"); mkdirSync(home, { mode: 0o700 });
  const manager = join(home, ".agent-manager"); mkdirSync(manager); chmodSync(manager, 0o775);
  writeFileSync(join(manager, "sentinel"), "preserve");
  const run = (operation: string, component = "manager_root", identity?: string) => JSON.parse(execFileSync(binary,
    ["--profile-root", operation, home, component, ...(identity ? [identity] : [])], { encoding: "utf8" }));
  const initial = run("inspect");
  if (process.platform === "darwin") {
    assert.equal(initial.reason, "unsupported_acl");
    assert.equal(initial.repairable, false);
    assert.equal(statSync(manager).mode & 0o777, 0o775);
    return;
  }
  assert.equal(initial.reason, "group_or_other_write");
  assert.equal(initial.repairable, true);
  assert.equal(run("repair", "manager_root", initial.identity).ok, true);
  assert.equal(statSync(manager).mode & 0o777, 0o755, "only group/other write bits are removed");
  assert.equal(readFileSync(join(manager, "sentinel"), "utf8"), "preserve");
  assert.equal(run("repair", "manager_root", initial.identity).reason, "identity_changed", "snapshot cannot be replayed");

  const profiles = join(manager, "profiles"); mkdirSync(profiles); chmodSync(profiles, 0o772);
  const profilesInspection = run("inspect", "profiles_root");
  assert.equal(profilesInspection.repairable, true);
  assert.equal(run("repair", "profiles_root", profilesInspection.identity).ok, true);
  assert.equal(statSync(profiles).mode & 0o777, 0o750);
  assert.equal(statSync(manager).mode & 0o777, 0o755);

  // Install an actual extended POSIX ACL on the synthetic root, without a setfacl dependency.
  const aclSetter = join(fixture, "set-fixture-acl");
  execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", aclSetter], { input: `
#include <sys/xattr.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <string.h>
int main(int argc, char **argv) {
  (void)argc;
  unsigned char acl[] = {2,0,0,0, 1,0,7,0,255,255,255,255, 2,0,4,0,57,48,0,0,
    4,0,5,0,255,255,255,255, 16,0,7,0,255,255,255,255, 32,0,5,0,255,255,255,255};
  uint32_t uid = (uint32_t)getuid(); memcpy(acl + 16, &uid, sizeof(uid));
  int result = setxattr(argv[1], "system.posix_acl_access", acl, sizeof(acl), 0);
  if (result) perror("fixture ACL");
  return result != 0;
}` });
  execFileSync(aclSetter, [profiles]);
  const aclInspection = run("inspect", "profiles_root");
  assert.equal(aclInspection.reason, "unsupported_acl");
  assert.equal(aclInspection.repairable, false);
  assert.equal(run("repair", "profiles_root", profilesInspection.identity).ok, false);
  assert.equal(statSync(profiles).mode & 0o777, 0o775, "ACL mask is not silently changed");

  chmodSync(manager, 0o775);
  const stale = run("inspect");
  for (const binding of ["target", "home"]) for (const boundary of ["before", "after"]) {
    const selected = binding === "home" ? home : manager;
    const moved = binding === "home" ? join(fixture, "raced-home") : join(home, "raced-original");
    const originalTarget = binding === "home" ? join(moved, ".agent-manager") : moved;
    const racing = spawn(binary, ["--profile-root", "repair", home, "manager_root", run("inspect").identity], {
      env: { WOLLIPOG_PROFILE_ROOT_TEST_BARRIER: boundary }, stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => { if (racing.exitCode === null) racing.kill("SIGKILL"); });
    const raceOutput = await new Promise<string>((resolve, reject) => {
      let output = "", replaced = false;
      racing.on("error", reject);
      racing.stdout.on("data", (chunk) => {
        output += chunk;
        if (!replaced && output.includes(`"barrier":"${boundary}"`)) {
          replaced = true;
          renameSync(selected, moved);
          symlinkSync(moved, selected);
          racing.stdin.end("1");
        }
      });
      racing.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`race fixture exited ${code}`)));
    });
    assert.equal(JSON.parse(raceOutput.trim().split("\n").at(-1)!).reason, boundary === "before" ? "identity_changed" : "may_have_changed");
    assert.equal(statSync(originalTarget).mode & 0o777, boundary === "before" ? 0o775 : 0o755);
    assert.equal(readFileSync(join(originalTarget, "sentinel"), "utf8"), "preserve");
    rmSync(selected); renameSync(moved, selected); chmodSync(manager, 0o775);
  }
  renameSync(manager, join(home, "original")); mkdirSync(manager); chmodSync(manager, 0o775);
  assert.equal(run("repair", "manager_root", stale.identity).reason, "identity_changed");
  assert.equal(statSync(manager).mode & 0o777, 0o775);
  assert.equal(statSync(join(home, "original")).mode & 0o777, 0o775);
  rmSync(manager, { recursive: true }); symlinkSync(join(home, "original"), manager);
  assert.equal(run("inspect").reason, "symlink");
  assert.equal(run("repair", "manager_root", stale.identity).reason, "symlink");
  rmSync(manager); writeFileSync(manager, "not-a-directory");
  assert.equal(run("inspect").reason, "not_directory");
  assert.equal(run("repair", "manager_root", stale.identity).reason, "not_directory");
  assert.equal(readFileSync(manager, "utf8"), "not-a-directory");
  chmodSync(home, 0o775);
  const unsafeHome = run("inspect");
  assert.equal(unsafeHome.reason, "unsafe_ancestry");
  assert.equal(unsafeHome.component, "os_home");
  chmodSync(home, 0o700);
  execFileSync(aclSetter, [home]); chmodSync(home, 0o700);
  const aclHome = run("inspect", "profiles_root");
  assert.equal(aclHome.reason, "unsupported_acl");
  assert.equal(aclHome.component, "os_home");
  // On hosts with a differently-owned OS root, exercise the actual UID guard read-only.
  // No directory under that root is opened, created, repaired or enumerated after refusal.
  if (typeof process.getuid === "function" && statSync("/").uid !== process.getuid()) {
    const wrongOwner = JSON.parse(execFileSync(binary, ["--profile-root", "inspect", "/", "manager_root"], { encoding: "utf8" }));
    assert.equal(wrongOwner.reason, "unsafe_ancestry");
  }
});
