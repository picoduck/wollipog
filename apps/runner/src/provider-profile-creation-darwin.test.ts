import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createManagedProviderProfileHome, managedProviderProfileRoot } from "./provider-profile-home.js";
import { runManagedProfileCreationHelper } from "./provider-home-lease-io.js";

const id = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
test("Darwin creation proves native ACL admission and descriptor preservation", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-darwin-creation-")));
  const binary = join(root, "helper"), setter = join(root, "acl-fixture");
  const clear: string[] = [];
  t.after(() => {
    // Remove only ACLs installed on these exact synthetic fixture homes, never host ACLs.
    for (const home of clear) if (existsSync(home)) execFileSync(setter, [home, "empty"]);
    rmSync(root, { recursive: true, force: true });
  });
  const compile = (source: string, out: string, flags: string[] = []) => execFileSync("/usr/bin/clang",
    ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0", ...flags, source, "-o", out]);
  compile(fileURLToPath(new URL("../native/provider-home-lease-io.c", import.meta.url)), binary,
    ["-DWOLLIPOG_PROFILE_ROOT_TEST_BARRIER", "-DWOLLIPOG_PROFILE_CREATE_DARWIN_TEST"]);
  compile(fileURLToPath(new URL("./fixtures/profile-creation-darwin-acl.c", import.meta.url)), setter);
  // Compare actual pinned baseline production code, not a rewritten approximation of its mkdirs.
  const baseline = execFileSync("git", ["show", "a8522cddd10699809e8a2cf8f0b6f9d0937e5d60:apps/runner/src/provider-profile-home.ts"], { encoding: "utf8" });
  const baselineModule = join(root, "baseline.cjs");
  buildSync({ stdin: { contents: baseline, loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", outfile: baselineModule, logLevel: "silent" });
  const old = createRequire(import.meta.url)(baselineModule) as typeof import("./provider-profile-home.js");
  assert.equal(execFileSync(binary, ["--probe"], { encoding: "utf8" }), "");
  assert.deepEqual(JSON.parse(execFileSync(binary, ["--profile-create", "--capabilities"], { encoding: "utf8" })), { version: 1, supported: true });
  const invoke = (home: string, fault?: string) => JSON.parse(execFileSync(binary, ["--profile-create", home, id], {
    encoding: "utf8", env: fault ? { WOLLIPOG_PROFILE_CREATE_DARWIN_FAULT: fault } : {},
  }));
  for (const acl of ["absent", "empty", "deny", "deny_inherit", "allow"]) {
    const baselineHome = join(root, `baseline-${acl}`); mkdirSync(baselineHome, { mode: 0o700 });
    if (acl !== "absent") { execFileSync(setter, [baselineHome, acl]); clear.push(baselineHome); }
    assert.equal(old.createManagedProviderProfileHome(old.managedProviderProfileRoot(baselineHome), id), join(baselineHome, ".agent-manager", "profiles", id));
    const home = join(root, `home-${acl}`); mkdirSync(home, { mode: 0o700 });
    if (acl !== "absent") { execFileSync(setter, [home, acl]); clear.push(home); }
    writeFileSync(join(home, "sentinel"), "preserved");
    const result = invoke(home);
    assert.deepEqual(result, acl === "allow" ? { ok: false, component: "os_home", reason: "unsupported_acl" }
      : { ok: true, component: "profile_home", reason: "created" });
    assert.equal(readFileSync(join(home, "sentinel"), "utf8"), "preserved");
    if (acl !== "allow") {
      assert.equal(invoke(home).reason, "already_exists");
      const manager = join(home, ".agent-manager"); chmodSync(manager, 0o775);
      const inspection = JSON.parse(execFileSync(binary, ["--profile-root", "inspect", home, "manager_root"], { encoding: "utf8" }));
      assert.equal(inspection.repairable, false, "creation support must not enable Darwin repair");
      assert.equal(inspection.reason, "unsupported_acl");
    }
  }
  for (const fault of ["stat", "query", "property", "entry", "unknown_flags", "deferred", "empty"]) {
    const home = join(root, `fault-${fault}`); mkdirSync(home, { mode: 0o700 });
    execFileSync(setter, [home, "deny"]); clear.push(home);
    assert.deepEqual(invoke(home, fault), fault === "empty" ? { ok: true, component: "profile_home", reason: "created" }
      : { ok: false, component: "os_home", reason: "unsupported_acl" });
    if (fault !== "empty") assert.deepEqual(readdirSync(home), [], "metadata errors never masquerade as absence or create a destination");
  }
  for (const component of ["home", "manager", "profiles", "profile"]) for (const stage of ["create-before-profile", "create-before-mkdir-profile", "create-after-profile"]) {
    if (component === "profile" && stage !== "create-after-profile") continue;
    const home = join(root, `race-${component}-${stage}`); mkdirSync(home, { mode: 0o700 });
    const manager = join(home, ".agent-manager"), profiles = join(manager, "profiles");
    mkdirSync(manager, { mode: 0o700 }); mkdirSync(profiles, { mode: 0o700 });
    const selected = component === "home" ? home : component === "manager" ? manager : component === "profiles" ? profiles : join(profiles, id);
    const moved = join(root, `moved-${component}-${stage}`);
    const child = spawn(binary, ["--profile-create", home, id], { env: { WOLLIPOG_PROFILE_ROOT_TEST_BARRIER: stage }, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const output = await new Promise<string>((resolve, reject) => {
      let data = "", replaced = false;
      child.on("error", reject);
      child.stdout.on("data", chunk => {
        data += chunk;
        if (!replaced && data.includes(`"barrier":"${stage}"`)) {
          replaced = true; renameSync(selected, moved); symlinkSync(moved, selected); child.stdin.end("1");
        }
      });
      child.on("close", code => code === 0 ? resolve(data) : reject(new Error(`Darwin fixture exited ${code}`)));
    });
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    assert.equal(result.reason, stage === "create-before-profile" ? "identity_changed" : "may_have_changed");
    const created = component === "home" ? join(moved, ".agent-manager", "profiles", id)
      : component === "manager" ? join(moved, "profiles", id) : component === "profiles" ? join(moved, id) : moved;
    assert.equal(existsSync(created), stage !== "create-before-profile", "possible creations survive renamed bindings");
  }
  const home = join(root, "alias-real"), alias = join(root, "alias"); mkdirSync(home, { mode: 0o700 }); symlinkSync(home, alias);
  const created = createManagedProviderProfileHome(managedProviderProfileRoot(alias), id, "darwin", {
    create: (canonical, identity) => runManagedProfileCreationHelper(canonical, identity, () => binary),
  });
  assert.equal(created, join(alias, ".agent-manager", "profiles", id));
});
