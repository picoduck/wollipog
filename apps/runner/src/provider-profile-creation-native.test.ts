import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runManagedProfileCreationHelper } from "./provider-home-lease-io.js";
import { createManagedProviderProfileHome, managedProviderProfileRoot } from "./provider-profile-home.js";

const id = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
test("unvalidated creation platforms and caller-selected layouts refuse before the helper", () => {
  let calls = 0;
  const create = () => { calls++; return { ok: true as const, component: "profile_home" as const, reason: "created" as const }; };
  for (const platform of ["win32", "freebsd"] as const) {
    assert.throws(() => createManagedProviderProfileHome("/synthetic/home/.agent-manager/profiles", id, platform, { create }),
      (error: unknown) => JSON.stringify(error).includes('"reason":"unsupported_platform"'));
  }
  for (const root of ["/synthetic/arbitrary", "/synthetic/home/.agent-manager/profiles/../profiles", "relative/.agent-manager/profiles"]) {
    assert.throws(() => createManagedProviderProfileHome(root, id, "linux", { create }),
      (error: unknown) => JSON.stringify(error).includes('"reason":"unsupported_layout"'));
  }
  assert.equal(calls, 0);
});
test("fixed native profile creation preserves admission and detects pinned component substitution", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-create-native-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const binary = join(fixture, "helper");
  execFileSync("/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static", "-DWOLLIPOG_PROFILE_ROOT_TEST_BARRIER",
    fileURLToPath(new URL("../native/provider-home-lease-io.c", import.meta.url)), "-o", binary]);
  const run = (home: string, identity = id) => JSON.parse(execFileSync(binary, ["--profile-create", home, identity], { encoding: "utf8" }));
  assert.deepEqual(JSON.parse(execFileSync(binary, ["--profile-create", "--capabilities"], { encoding: "utf8" })), { version: 1, supported: true });
  const adapterHome = join(fixture, "adapter-home"); mkdirSync(adapterHome, { mode: 0o700 });
  const create = (home: string, identity: string) => runManagedProfileCreationHelper(home, identity, () => binary);
  assert.equal(createManagedProviderProfileHome(managedProviderProfileRoot(adapterHome), id, "linux", { create }), join(adapterHome, ".agent-manager", "profiles", id));
  assert.throws(() => createManagedProviderProfileHome(join(adapterHome, "arbitrary"), id, "linux", { create }), /could not be verified/u);
  const linkedHome = join(fixture, "linked-os-home"); symlinkSync(adapterHome, linkedHome);
  assert.equal(managedProviderProfileRoot(linkedHome), join(linkedHome, ".agent-manager", "profiles"), "configured spelling remains stable for account classification");
  const linkedId = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  assert.equal(createManagedProviderProfileHome(managedProviderProfileRoot(linkedHome), linkedId, "linux", { create }), join(linkedHome, ".agent-manager", "profiles", linkedId));
  assert.ok(existsSync(join(adapterHome, ".agent-manager", "profiles", linkedId)));
  const replacement = join(fixture, "replacement-home"); mkdirSync(replacement, { mode: 0o700 });
  const racedId = "8f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  assert.throws(() => createManagedProviderProfileHome(managedProviderProfileRoot(linkedHome), racedId, "linux", {
    create: (home, identity) => {
      assert.equal(home, adapterHome, "only the canonical OS home enters the no-follow helper");
      rmSync(linkedHome); symlinkSync(replacement, linkedHome);
      return create(home, identity);
    },
  }), (error: unknown) => {
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: "managed_profile_directory", component: "os_home", reason: "may_have_changed", failureReason: "identity_changed" });
    return true;
  });
  assert.ok(existsSync(join(adapterHome, ".agent-manager", "profiles", racedId)), "canonical creation is preserved after alias replacement");
  assert.deepEqual(readdirSync(replacement), [], "no creation is redirected through the alias");
  // A helper refusal remains primary even if alias verification would also fail.
  rmSync(linkedHome); symlinkSync(adapterHome, linkedHome);
  assert.throws(() => createManagedProviderProfileHome(managedProviderProfileRoot(linkedHome), racedId, "linux", {
    create: () => { rmSync(linkedHome); return { ok: false, component: "profiles_root", reason: "unsupported_acl" }; },
  }), (error: unknown) => JSON.stringify(error) === JSON.stringify({ code: "managed_profile_directory", component: "profiles_root", reason: "unsupported_acl" }));
  symlinkSync(adapterHome, linkedHome);
  const movedHome = join(fixture, "moved-adapter-home"), movedId = "9f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  assert.throws(() => createManagedProviderProfileHome(managedProviderProfileRoot(linkedHome), movedId, "linux", {
    create: (home, identity) => {
      const result = create(home, identity);
      renameSync(adapterHome, movedHome); mkdirSync(adapterHome, { mode: 0o700 });
      return result;
    },
  }), (error: unknown) => JSON.stringify(error).includes('"failureReason":"identity_changed"'));
  assert.deepEqual(readdirSync(adapterHome), [], "same-path replacement must not look unchanged merely because realpath's string matches");
  assert.ok(existsSync(join(movedHome, ".agent-manager", "profiles", movedId)), "post-helper replacement preserves the original creation");
  rmSync(adapterHome, { recursive: true }); renameSync(movedHome, adapterHome);
  // A first, definitely failed mkdir is a clean refusal. No broader mutation is attempted.
  const readOnlyHome = join(fixture, "read-only-home"); mkdirSync(readOnlyHome, { mode: 0o500 });
  const denied = run(readOnlyHome);
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    assert.deepEqual(denied, { ok: false, component: "manager_root", reason: "unavailable" });
    assert.deepEqual(readdirSync(readOnlyHome), []);
  }
  chmodSync(readOnlyHome, 0o700);
  for (const mode of [0o700, 0o750, 0o755, 0o775]) {
    const home = join(fixture, `home-${mode}`); mkdirSync(home, { mode: 0o700 });
    const manager = join(home, ".agent-manager"); mkdirSync(manager); chmodSync(manager, mode);
    writeFileSync(join(manager, "sentinel"), "preserved");
    const result = run(home);
    assert.deepEqual(result, mode === 0o775
      ? { ok: false, component: "manager_root", reason: "group_or_other_write" }
      : { ok: true, component: "profile_home", reason: "created" });
    assert.equal(statSync(manager).mode & 0o777, mode);
    assert.equal(readFileSync(join(manager, "sentinel"), "utf8"), "preserved");
    if (mode !== 0o775) {
      assert.equal(statSync(join(manager, "profiles", id)).mode & 0o777, 0o700);
      assert.equal(run(home).reason, "already_exists");
    } else assert.deepEqual(readdirSync(manager), ["sentinel"]);
  }
  const invalidHome = join(fixture, "invalid"); mkdirSync(invalidHome, { mode: 0o700 });
  for (const identity of [".", "..", "a/b", id + "/x", id.toUpperCase(), "not-a-uuid"]) {
    assert.equal(run(invalidHome, identity).reason, "unsupported_layout");
    assert.deepEqual(readdirSync(invalidHome), []);
  }
  const aclSetter = join(fixture, "set-acl");
  execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", aclSetter], { input: `
#include <sys/xattr.h>
#include <stdint.h>
#include <unistd.h>
#include <string.h>
int main(int argc, char **argv) {
  (void)argc;
  unsigned char acl[] = {2,0,0,0, 1,0,7,0,255,255,255,255, 2,0,4,0,57,48,0,0,
    4,0,5,0,255,255,255,255, 16,0,5,0,255,255,255,255, 32,0,5,0,255,255,255,255};
  uint32_t uid = (uint32_t)getuid(); memcpy(acl + 16, &uid, sizeof(uid));
  return setxattr(argv[1], argv[2], acl, sizeof(acl), 0) != 0;
}` });
  for (const component of ["os_home", "manager_root", "profiles_root"] as const) {
    for (const acl of ["system.posix_acl_access", "system.posix_acl_default"]) {
      const home = join(fixture, `acl-${component}-${acl}`); mkdirSync(home, { mode: 0o700 });
      const manager = join(home, ".agent-manager"); mkdirSync(manager, { mode: 0o700 });
      const profiles = join(manager, "profiles"); mkdirSync(profiles, { mode: 0o700 });
      const target = component === "os_home" ? home : component === "manager_root" ? manager : profiles;
      writeFileSync(join(target, "sentinel"), "preserved");
      execFileSync(aclSetter, [target, acl]);
      assert.deepEqual(run(home), { ok: false, component, reason: "unsupported_acl" });
      assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "preserved");
      assert.equal(existsSync(join(profiles, id)), false);
    }
  }
  for (const component of ["manager_root", "profiles_root"]) for (const kind of ["symlink", "not_directory"]) {
    const home = join(fixture, `refuse-${component}-${kind}`); mkdirSync(home, { mode: 0o700 });
    const manager = join(home, ".agent-manager");
    if (component === "profiles_root") mkdirSync(manager, { mode: 0o700 });
    const target = component === "manager_root" ? manager : join(manager, "profiles");
    if (kind === "symlink") symlinkSync(fixture, target); else writeFileSync(target, "preserved");
    assert.deepEqual(run(home), { ok: false, component, reason: kind });
  }
  if (typeof process.getuid === "function" && statSync("/").uid !== process.getuid())
    assert.deepEqual(run("/"), { ok: false, component: "os_home", reason: "wrong_owner" });
  for (const component of ["os_home", "manager_root", "profiles_root", "profile_home"] as const) {
    for (const boundary of ["before", "between", "after"] as const) {
      const home = join(fixture, `race-${component}-${boundary}`); mkdirSync(home, { mode: 0o700 });
      const manager = join(home, ".agent-manager"); mkdirSync(manager, { mode: 0o700 });
      const profiles = join(manager, "profiles"); mkdirSync(profiles, { mode: 0o700 });
      const selected = component === "os_home" ? home : component === "manager_root" ? manager : component === "profiles_root" ? profiles : join(profiles, id);
      // The before barrier is immediately before the final mkdir; the after barrier has pinned
      // the created directory. Neither barrier exists in packaged builds.
      const stage = boundary === "before" ? "create-before-profile" : boundary === "between" ? "create-before-mkdir-profile" : "create-after-profile";
      if (component === "profile_home" && boundary !== "after") continue;
      const moved = join(fixture, `moved-${component}-${boundary}`);
      const child = spawn(binary, ["--profile-create", home, id], { env: { WOLLIPOG_PROFILE_ROOT_TEST_BARRIER: stage }, stdio: ["pipe", "pipe", "pipe"] });
      t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
      const result = await new Promise<string>((resolve, reject) => {
        let output = "", replaced = false;
        child.on("error", reject);
        child.stdout.on("data", chunk => {
          output += chunk;
          if (!replaced && output.includes(`"barrier":"${stage}"`)) {
            replaced = true; renameSync(selected, moved); symlinkSync(moved, selected); child.stdin.end("1");
          }
        });
        child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`creation fixture exited ${code}`)));
      });
      const outcome = JSON.parse(result.trim().split("\n").at(-1)!);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, boundary === "before" ? "identity_changed" : "may_have_changed");
      if (boundary !== "before") assert.equal(outcome.failureReason, "identity_changed", "preserve the primary failure while reporting uncertainty");
      const created = component === "os_home" ? join(moved, ".agent-manager", "profiles", id)
        : component === "manager_root" ? join(moved, "profiles", id) : component === "profiles_root" ? join(moved, id) : moved;
      assert.equal(existsSync(created), boundary !== "before", "rename during the check/mkdir gap may create in the old parent; report uncertainty and preserve it");
    }
  }
  for (const component of ["manager", "profiles"]) {
    const home = join(fixture, `partial-${component}`); mkdirSync(home, { mode: 0o700 });
    const manager = join(home, ".agent-manager");
    if (component === "profiles") mkdirSync(manager, { mode: 0o700 });
    const selected = component === "manager" ? manager : join(manager, "profiles");
    const moved = join(fixture, `partial-moved-${component}`);
    const stage = `create-after-${component}`;
    const child = spawn(binary, ["--profile-create", home, id], { env: { WOLLIPOG_PROFILE_ROOT_TEST_BARRIER: stage }, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const outcome = await new Promise<string>((resolve, reject) => {
      let output = "", replaced = false;
      child.on("error", reject);
      child.stdout.on("data", chunk => {
        output += chunk;
        if (!replaced && output.includes(`"barrier":"${stage}"`)) {
          replaced = true; renameSync(selected, moved); symlinkSync(moved, selected); child.stdin.end("1");
        }
      });
      child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`partial fixture exited ${code}`)));
    });
    assert.equal(JSON.parse(outcome.trim().split("\n").at(-1)!).reason, "may_have_changed");
    assert.deepEqual(readdirSync(moved), [], "partial creation is preserved without writing through the replacement");
  }
});

test("mixed helpers and lost creation responses fail safely without retry or fallback", { skip: process.platform !== "linux" }, t => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-create-adapter-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const mode of ["old", "malformed", "lost", "safe-refusal", "inconsistent", "recursive"]) {
    const binary = join(fixture, mode), marker = join(fixture, `${mode}-called`);
    execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", binary], { input: `
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe")) return 0;
  if (${JSON.stringify(mode)}[0] == 'o') return 1;
  if (argc == 3) { puts("{\\\"version\\\":1,\\\"supported\\\":true}"); return 0; }
  FILE *file = fopen(${JSON.stringify(marker)}, "a"); fputs("called\\n", file); fclose(file);
  if (${JSON.stringify(mode)}[0] == 'l') return 1;
  if (${JSON.stringify(mode)}[0] == 'm') { puts("raw sensitive path text"); return 0; }
  if (${JSON.stringify(mode)}[0] == 'i') { puts("{\\\"ok\\\":false,\\\"component\\\":\\\"profile_home\\\",\\\"reason\\\":\\\"unavailable\\\",\\\"failureReason\\\":\\\"identity_changed\\\"}"); return 0; }
  if (${JSON.stringify(mode)}[0] == 'r') { puts("{\\\"ok\\\":false,\\\"component\\\":\\\"profile_home\\\",\\\"reason\\\":\\\"may_have_changed\\\",\\\"failureReason\\\":\\\"may_have_changed\\\"}"); return 0; }
  puts("{\\\"ok\\\":false,\\\"component\\\":\\\"profiles_root\\\",\\\"reason\\\":\\\"unsupported_acl\\\",\\\"raw\\\":\\\"secret\\\"}"); return 0;
}` });
    assert.equal(execFileSync(binary, ["--probe"], { encoding: "utf8" }), "");
    const result = runManagedProfileCreationHelper(fixture, id, () => binary);
    assert.deepEqual(result, mode === "old" ? { ok: false, component: "profile_home", reason: "unsupported_helper" }
      : mode === "safe-refusal" ? { ok: false, component: "profiles_root", reason: "unsupported_acl" }
      : { ok: false, component: "profile_home", reason: "may_have_changed" });
    assert.equal(existsSync(marker), mode !== "old", "old helpers refuse before a creation request");
    if (existsSync(marker)) assert.equal(readFileSync(marker, "utf8"), "called\n", "a failed creation is never retried");
  }
});
