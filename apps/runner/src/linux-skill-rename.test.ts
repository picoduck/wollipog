import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxNoReplaceRename, resolveLinuxSkillRenameHelper, stageLinuxSkillRenameHelper } from "./linux-skill-rename.js";

const linux = { skip: process.platform !== "linux" };
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "linux-skill-rename-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = join(root, "from"), to = join(root, "to");
  fs.mkdirSync(join(from, "alpha"), { recursive: true });
  fs.writeFileSync(join(from, "alpha", "SKILL.md"), "original");
  fs.mkdirSync(to);
  const fromFd = fs.openSync(from, directoryFlags), toFd = fs.openSync(to, directoryFlags);
  t.after(() => { fs.closeSync(fromFd); fs.closeSync(toFd); });
  return { root, from, to, fromFd, toFd, rename: linuxNoReplaceRename(root) };
}

test("moves an entry between the two held directories without copying it", linux, (t) => {
  const f = fixture(t);
  const before = fs.statSync(join(f.from, "alpha"));
  f.rename(f.fromFd, "alpha", f.toFd, "original");
  assert.equal(fs.existsSync(join(f.from, "alpha")), false);
  assert.equal(fs.statSync(join(f.to, "original")).ino, before.ino);
  assert.equal(fs.readFileSync(join(f.to, "original", "SKILL.md"), "utf8"), "original");
});

test("stays anchored to the held descriptors when their paths are renamed", linux, (t) => {
  const f = fixture(t);
  fs.renameSync(f.to, join(f.root, "to-moved"));
  fs.mkdirSync(f.to);
  f.rename(f.fromFd, "alpha", f.toFd, "original");
  assert.equal(fs.existsSync(join(f.root, "to-moved", "original", "SKILL.md")), true);
  assert.deepEqual(fs.readdirSync(f.to), []);
});

for (const occupant of ["empty directory", "file", "symlink"] as const) {
  test(`never replaces an existing ${occupant} at the destination`, linux, (t) => {
    const f = fixture(t);
    const destination = join(f.to, "original");
    if (occupant === "empty directory") fs.mkdirSync(destination);
    if (occupant === "file") fs.writeFileSync(destination, "keep me");
    if (occupant === "symlink") fs.symlinkSync(join(f.root, "elsewhere"), destination);
    const before = fs.lstatSync(destination);
    assert.throws(() => f.rename(f.fromFd, "alpha", f.toFd, "original"));
    assert.equal(fs.lstatSync(destination).ino, before.ino);
    assert.equal(fs.readFileSync(join(f.from, "alpha", "SKILL.md"), "utf8"), "original");
  });
}

test("refuses a missing source and names that are not single entries", linux, (t) => {
  const f = fixture(t);
  assert.throws(() => f.rename(f.fromFd, "missing", f.toFd, "original"));
  for (const name of ["", ".", "..", "alpha/SKILL.md", "../from"]) {
    assert.throws(() => f.rename(f.fromFd, name, f.toFd, "original"), name);
    assert.throws(() => f.rename(f.fromFd, "alpha", f.toFd, name), name);
  }
  assert.equal(fs.readFileSync(join(f.from, "alpha", "SKILL.md"), "utf8"), "original");
  assert.deepEqual(fs.readdirSync(f.to), []);
});

test("a source checkout compiles one private helper and reuses it", linux, (t) => {
  const f = fixture(t);
  const helper = resolveLinuxSkillRenameHelper(f.root);
  assert.equal(resolveLinuxSkillRenameHelper(f.root), helper);
  assert.equal(fs.statSync(helper).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(helper, "..")).mode & 0o777, 0o700);
  assert.ok(helper.startsWith(tmpdir()), "the temporary directory is tried first");
  assert.throws(() => resolveLinuxSkillRenameHelper(f.root, "darwin"), /requires Linux/u);
});

test("a helper that cannot run where it is staged falls back to the next root", linux, (t) => {
  const f = fixture(t);
  const noexec = join(f.root, "noexec"), data = join(f.root, "data");
  fs.mkdirSync(noexec);
  fs.mkdirSync(data);
  const real = resolveLinuxSkillRenameHelper(f.root);
  // A `noexec` mount accepts the file but refuses to run it; stand in with a copy that cannot start.
  const helper = stageLinuxSkillRenameHelper([noexec, data], (target) => {
    if (target.startsWith(noexec)) fs.writeFileSync(target, "#!/nonexistent-interpreter\n", { mode: 0o700 });
    else fs.copyFileSync(real, target);
  });
  assert.ok(helper.startsWith(data + "/"), helper);
  assert.equal(fs.statSync(join(helper, "..")).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(noexec), [], "the unusable staging directory is removed");
});

test("a helper that runs from no root refuses before anything moves", linux, (t) => {
  const f = fixture(t);
  assert.throws(() => stageLinuxSkillRenameHelper([f.root, join(f.root, "missing")], (target) => {
    fs.writeFileSync(target, "#!/nonexistent-interpreter\n", { mode: 0o700 });
  }), /cannot run/u);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["from", "to"]);
});
