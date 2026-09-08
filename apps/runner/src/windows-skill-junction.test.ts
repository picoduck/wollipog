import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { replaceWindowsSkillJunction, WINDOWS_SKILL_JUNCTION_HELPER } from "./windows-skill-junction.js";

test("the Windows junction helper opens the reparse point and verifies its old target", () => {
  assert.match(WINDOWS_SKILL_JUNCTION_HELPER, /FILE_FLAG_OPEN_REPARSE_POINT/u);
  assert.match(WINDOWS_SKILL_JUNCTION_HELPER, /FSCTL_GET_REPARSE_POINT/u);
  assert.match(WINDOWS_SKILL_JUNCTION_HELPER, /FSCTL_SET_REPARSE_POINT/u);
  assert.match(WINDOWS_SKILL_JUNCTION_HELPER, /GetFullPathNameW/u);
  assert.match(WINDOWS_SKILL_JUNCTION_HELPER, /OpenPath\(path\)/u);
  assert.doesNotMatch(WINDOWS_SKILL_JUNCTION_HELPER, /Path\.GetFullPath/u);
  assert.match(WINDOWS_SKILL_JUNCTION_HELPER, /OrdinalIgnoreCase/u);
  assert.doesNotMatch(WINDOWS_SKILL_JUNCTION_HELPER, /Remove-Item|Directory\.Delete/u);
});

test("native Windows atomically retargets a verified directory junction", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-junction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  const link = join(root, "managed");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, link, "junction");
  replaceWindowsSkillJunction(link, first, second);
  assert.equal(resolve(readlinkSync(link)), resolve(second));
  assert.throws(() => replaceWindowsSkillJunction(link, first, first));
  assert.equal(resolve(readlinkSync(link)), resolve(second));
});
