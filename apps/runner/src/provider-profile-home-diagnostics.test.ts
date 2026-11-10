import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createManagedProviderProfileHome, managedProviderProfileRoot } from "./provider-profile-home.js";

const id = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
for (const component of ["manager_root", "profiles_root"] as const) {
  for (const reason of ["symlink", "not_directory", "group_or_other_write"] as const) {
    test(`managed profile creation identifies ${component}/${reason} without exposing paths`, { skip: process.platform === "win32" }, (t) => {
      const home = mkdtempSync(join(tmpdir(), "wollipog-root-diagnostic-"));
      t.after(() => rmSync(home, { force: true, recursive: true }));
      const manager = join(home, ".agent-manager");
      if (component === "profiles_root") mkdirSync(manager, { mode: 0o700 });
      const target = component === "manager_root" ? manager : managedProviderProfileRoot(home);
      const sentinel = join(home, "preserved");
      writeFileSync(sentinel, "private-data");
      if (reason === "not_directory") writeFileSync(target, "private-data");
      else if (reason === "symlink") symlinkSync(home, target);
      else { mkdirSync(target); chmodSync(target, 0o775); }
      assert.throws(() => createManagedProviderProfileHome(managedProviderProfileRoot(home), id), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: "managed_profile_directory", component, reason });
        assert.ok(!error.message.includes(home));
        assert.ok(!JSON.stringify(error).includes("private-data"));
        return true;
      });
      assert.equal(readFileSync(sentinel, "utf8"), "private-data");
      assert.equal(existsSync(join(managedProviderProfileRoot(home), id)), false);
    });
  }
}

for (const mode of [0o750, 0o755]) {
  test(`diagnostics preserve admission of an existing ${mode.toString(8)} root`, { skip: process.platform === "win32" }, (t) => {
    const home = mkdtempSync(join(tmpdir(), "wollipog-root-admission-"));
    t.after(() => rmSync(home, { force: true, recursive: true }));
    const manager = join(home, ".agent-manager"); mkdirSync(manager); chmodSync(manager, mode);
    const profile = createManagedProviderProfileHome(managedProviderProfileRoot(home), id);
    assert.equal(statSync(manager).mode & 0o777, mode);
    assert.equal(statSync(profile).mode & 0o777, 0o700);
  });
}

test("an unavailable parent reports its safe component without retaining the raw filesystem cause", { skip: process.platform === "win32" }, (t) => {
  const base = mkdtempSync(join(tmpdir(), "wollipog-root-unavailable-"));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const home = join(base, "missing-home");
  assert.throws(() => createManagedProviderProfileHome(managedProviderProfileRoot(home), id), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: "managed_profile_directory", component: "manager_root", reason: "unavailable" });
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes(base));
    return true;
  });
});
