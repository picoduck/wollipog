import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityAppArmorFix } from "./antigravity-apparmor.js";

const restricted = { platform: "linux" as const, readFile: () => "1\n" };

test("AppArmor-restricted Linux hosts get the exact command that lets only agy create user namespaces", () => {
  assert.equal(antigravityAppArmorFix("/home/user/.local/bin/agy", restricted), [
    "sudo tee /etc/apparmor.d/wollipog-antigravity > /dev/null <<'EOF'",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    'profile wollipog-antigravity "/home/user/.local/bin/agy" flags=(unconfined) {',
    "  userns,",
    "}",
    "EOF",
    "sudo apparmor_parser -r /etc/apparmor.d/wollipog-antigravity",
  ].join("\n"));
});

test("a managed copy's profile names every generation, so an update keeps Auto Mode", () => {
  const fix = antigravityAppArmorFix("/home/user/.wollipog/antigravity/generations/2026-11-21-abc/agy", restricted);
  assert.match(fix ?? "", /profile wollipog-antigravity "\/home\/user\/\.wollipog\/antigravity\/generations\/\*\/agy" flags/u);
});

test("no command where the restriction is off, unknown, or not Linux, or the path cannot be named safely", () => {
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { platform: "linux", readFile: () => "0\n" }), undefined);
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { platform: "linux", readFile: () => { throw new Error("ENOENT"); } }),
    undefined);
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { ...restricted, platform: "darwin" }), undefined);
  assert.equal(antigravityAppArmorFix(undefined, restricted), undefined);
  for (const path of ["agy", '/opt/a"b/agy', "/opt/a*b/agy", "/opt/a\nb/agy", "/opt/{a,b}/agy"]) {
    assert.equal(antigravityAppArmorFix(path, restricted), undefined, path);
  }
});
