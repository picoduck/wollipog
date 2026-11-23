import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityAppArmorFix } from "./antigravity-apparmor.js";

const PROFILE_TAIL = [
  "  userns,",
  "}",
  "EOF",
  "sudo apparmor_parser -r /etc/apparmor.d/wollipog-antigravity",
];

/** A host whose AppArmor restricts user namespaces, with `owned` naming the paths root owns
 * without group or other write access (every other path belongs to the user). */
function host(owned: string[]) {
  return {
    platform: "linux" as const,
    readFile: () => "1\n",
    stat: (path: string) => owned.includes(path) ? { uid: 0, mode: 0o40755 } : { uid: 1000, mode: 0o40755 },
  };
}

test("a root-owned agy gets a profile on its own path, which no unprivileged program can replace", () => {
  assert.equal(antigravityAppArmorFix("/usr/local/bin/agy", host(["/usr/local/bin/agy", "/usr/local/bin", "/usr/local", "/usr", "/"])), [
    "sudo tee /etc/apparmor.d/wollipog-antigravity > /dev/null <<'EOF'",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    'profile wollipog-antigravity "/usr/local/bin/agy" flags=(unconfined) {',
    ...PROFILE_TAIL,
  ].join("\n"));
});

test("an agy the user can replace is first installed as a root-owned copy, and only that copy is granted", () => {
  // A profile on a user-writable path would let any program running as the user gain user
  // namespaces by writing itself there, which is what the AppArmor restriction prevents.
  assert.equal(antigravityAppArmorFix("/home/user/.local/bin/agy", host(["/home", "/"])), [
    "sudo install -D -o root -g root -m 0755 '/home/user/.local/bin/agy' /usr/local/lib/wollipog-antigravity/agy",
    "ln -sfn /usr/local/lib/wollipog-antigravity/agy '/home/user/.local/bin/agy'",
    "sudo tee /etc/apparmor.d/wollipog-antigravity > /dev/null <<'EOF'",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    'profile wollipog-antigravity "/usr/local/lib/wollipog-antigravity/agy" flags=(unconfined) {',
    ...PROFILE_TAIL,
  ].join("\n"));
});

test("a group- or world-writable directory on the path counts as user-replaceable", () => {
  const writable = { ...host([]), stat: (path: string) => path === "/opt/shared"
    ? { uid: 0, mode: 0o40775 } : { uid: 0, mode: 0o40755 } };
  assert.match(antigravityAppArmorFix("/opt/shared/agy", writable) ?? "", /^sudo install -D/u);
});

test("no command for a Wollipog-managed copy, which updates replace in a user-owned directory", () => {
  assert.equal(antigravityAppArmorFix("/home/user/.wollipog/antigravity/generations/2026-11-21-abc/agy", host(["/home", "/"])),
    undefined);
});

test("no command where the restriction is off, unknown, or not Linux, or the path cannot be named safely", () => {
  const owned = host(["/usr/bin/agy", "/usr/bin", "/usr", "/"]);
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { ...owned, readFile: () => "0\n" }), undefined);
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { ...owned, readFile: () => { throw new Error("ENOENT"); } }), undefined);
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { ...owned, platform: "darwin" }), undefined);
  assert.equal(antigravityAppArmorFix("/usr/bin/agy", { ...owned, stat: () => { throw new Error("EACCES"); } }), undefined);
  assert.equal(antigravityAppArmorFix(undefined, owned), undefined);
  for (const path of ["agy", '/opt/a"b/agy', "/opt/a'b/agy", "/opt/a*b/agy", "/opt/a\nb/agy", "/opt/{a,b}/agy"]) {
    assert.equal(antigravityAppArmorFix(path, owned), undefined, path);
  }
});
