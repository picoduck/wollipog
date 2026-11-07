import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isUserPrivateGroup, type GroupDatabase } from "./review-private-group.js";
import { discoverReviewTools, trustedPath } from "./review-trust.js";

function database(options: { source?: string; members?: string; otherPrimary?: boolean; configured?: string; process?: string; denied?: boolean; exited?: boolean; hidden?: boolean; duplicateGroup?: boolean; initgroups?: string } = {}): GroupDatabase {
  const user = "owner:x:1000:1000::/home/owner:/bin/sh";
  return {
    read: (path) => {
      if (path === "/etc/nsswitch.conf") return `passwd: files systemd ${options.source ?? "sss"}\ngroup: files systemd ${options.source ?? "sss"}\n${options.initgroups ? `initgroups: ${options.initgroups}\n` : ""}`;
      if (path === "/proc/mounts") return `proc /proc proc rw${options.hidden ? ",hidepid=2" : ""} 0 0\n`;
      if (options.exited) throw Object.assign(new Error("no such process, read"), { code: "ESRCH" });
      if (options.denied) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return options.process ?? "node";
    },
    entries: (path) => path === "/proc" ? ["123"] : options.configured === "drop-in" ? ["domain.conf"] : [],
    exists: (path) => path === options.configured || (path === "/etc/sssd/conf.d" && options.configured === "drop-in"),
    lookup: (kind, key) => kind === "group" ? `owner:x:1000:${options.members ?? ""}${!key && options.duplicateGroup ? "\nshared:x:1000:other" : ""}`
      : key ? user : user + (options.otherPrimary ? "\nother:x:1001:1000::/home/other:/bin/sh" : ""),
  };
}

test("a user-private group is proven from passwd/group with Ubuntu's inactive sss source", () => {
  assert.equal(isUserPrivateGroup(1000, 1000, database()), true);
  assert.equal(isUserPrivateGroup(1000, 1000, database({ members: "owner" })), true);
  assert.equal(isUserPrivateGroup(1000, 2000, database()), false);
  for (const options of [{ members: "other" }, { members: "owner,other" }, { otherPrimary: true }]) {
    assert.equal(isUserPrivateGroup(1000, 1000, database(options)), false);
  }
  assert.equal(isUserPrivateGroup(1000, 1000, database({ duplicateGroup: true })), false,
    "all group entries with the same gid contribute supplementary membership");
  assert.throws(() => isUserPrivateGroup(1000, 1000, database({ initgroups: "files ldap" })), /NSS source ldap/);
});

test("a process that exits during the SSSD liveness scan counts as absent", () => {
  assert.equal(isUserPrivateGroup(1000, 1000, database({ exited: true })), true);
  assert.equal(isUserPrivateGroup(1000, 1000, database({ exited: true, members: "other" })), false);
});

test("configured or running SSSD and non-enumerable NSS sources fail closed by name", () => {
  for (const options of [
    { configured: "/etc/sssd/sssd.conf" }, { configured: "drop-in" }, { configured: "/var/lib/sss/pipes/nss" },
    { configured: "/run/sssd" }, { process: "sssd_nss" }, { process: "sssd" },
  ]) assert.throws(() => isUserPrivateGroup(1000, 1000, database(options)), /NSS source sss/);
  for (const source of ["ldap", "winbind", "nis", "unknown"]) {
    assert.throws(() => isUserPrivateGroup(1000, 1000, database({ source })), new RegExp(`NSS source ${source}`));
  }
  assert.throws(() => isUserPrivateGroup(1000, 1000, database({ denied: true })), /permission denied/);
  assert.throws(() => isUserPrivateGroup(1000, 1000, database({ hidden: true })), /NSS source sss.*hidden/);
});

test("group-writable trust accepts only proven private membership; world writes always fail", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-private-group-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755);
  const file = join(root, "reviewer");
  writeFileSync(file, "native fixture", { mode: 0o775 });
  chmodSync(file, 0o775);
  const uid = process.getuid!(), rootUid = statSync("/").uid;
  assert.equal(trustedPath(file, [], uid, rootUid, undefined, () => true), file);
  assert.throws(() => trustedPath(file, [], uid, rootUid, undefined, () => false), /reviewer is writable by its group/);
  assert.throws(() => trustedPath(file, [], uid, rootUid, undefined, () => { throw new Error("NSS source ldap"); }), /reviewer.*NSS source ldap/);
  chmodSync(file, 0o777);
  assert.throws(() => trustedPath(file, [], uid, rootUid, undefined, () => true), /writable by every user/);
});

test("Personal Machine accepts owner group writes through symlinks while preserving write boundaries", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-personal-machine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin); chmodSync(bin, 0o775);
  const target = join(root, "reviewer");
  writeFileSync(target, "native fixture"); chmodSync(target, 0o775);
  const link = join(bin, "codex"); symlinkSync(target, link);
  const uid = process.getuid!(), rootUid = statSync("/").uid;
  const unknown = () => { throw new Error("cannot enumerate local accounts"); };
  assert.throws(() => trustedPath(link, [], uid, rootUid, undefined, unknown), /writable by its group/);
  assert.equal(trustedPath(link, [], uid, rootUid, undefined, unknown, "personal_machine"), target);
  assert.throws(() => trustedPath(link, [bin], uid, rootUid, undefined, unknown, "personal_machine"), /session can write/);
  assert.throws(() => trustedPath(link, [target], uid, rootUid, undefined, unknown, "personal_machine"), /session can write/);
  chmodSync(target, 0o777);
  assert.throws(() => trustedPath(link, [], uid, rootUid, undefined, unknown, "personal_machine"), /writable by every user/);
});

test("Personal Machine policy reaches Git, forge tools and PATH script interpreters", { skip: process.platform === "win32" }, async (t) => {
  const { verifySpawnedCommand } = await import("./review-sessions.js");
  const root = mkdtempSync(join(tmpdir(), "review-personal-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); mkdirSync(bin); chmodSync(bin, 0o775);
  for (const name of ["git", "gh", "ssh", "local-interpreter"]) {
    writeFileSync(join(bin, name), "native fixture"); chmodSync(join(bin, name), 0o775);
  }
  const script = join(bin, "reviewer");
  writeFileSync(script, "#!/usr/bin/env local-interpreter\n"); chmodSync(script, 0o775);
  const uid = process.getuid!(), rootUid = statSync("/").uid;
  const env = { home: join(root, "home"), dataDir: join(root, "state"), uid, rootUid, pathEnv: bin, temporaryRoots: [] };
  assert.deepEqual(discoverReviewTools({ ...env, securityPolicy: "personal_machine" }), {
    git: join(bin, "git"), gh: join(bin, "gh"), ssh: join(bin, "ssh"),
  });
  assert.equal(verifySpawnedCommand(script, bin, [], uid, rootUid, undefined, "personal_machine"), script);
  assert.throws(() => verifySpawnedCommand(script, bin, [join(bin, "local-interpreter")], uid, rootUid, undefined, "personal_machine"), /session can write/);
  assert.throws(() => trustedPath(script, [], uid + 1, rootUid, undefined, () => true, "personal_machine"), /owned by another user/);
});
