import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listWindowsSkillCandidates, readWindowsSkillCandidate, WINDOWS_SKILL_SNAPSHOT_HELPER } from "./windows-skill-snapshots.js";

test("the Windows snapshot helper pins handles and rejects reparse points and hard links", () => {
  assert.match(WINDOWS_SKILL_SNAPSHOT_HELPER, /FILE_FLAG_OPEN_REPARSE_POINT/u);
  assert.match(WINDOWS_SKILL_SNAPSHOT_HELPER, /FILE_SHARE_READ \| FILE_SHARE_WRITE/u);
  assert.doesNotMatch(WINDOWS_SKILL_SNAPSHOT_HELPER, /FILE_SHARE_DELETE/u);
  assert.match(WINDOWS_SKILL_SNAPSHOT_HELPER, /NumberOfLinks != 1/u);
  assert.match(WINDOWS_SKILL_SNAPSHOT_HELPER, /DirectoryGeneration/u);
});

test("native Windows discovers and reads a bounded skill without following a junction", { skip: process.platform !== "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "windows-skill-snapshot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".codex", "skills", "alpha");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "---\nname: alpha\n---\nWindows native");
  writeFileSync(join(root, "binary"), Buffer.from([0, 255]));
  const candidate = listWindowsSkillCandidates(home, [".codex/skills"])[0];
  assert.ok(candidate);
  const files = readWindowsSkillCandidate(home, { ...candidate, id: "opaque" });
  assert.equal(files.length, 2);
  assert.equal(files.find((file) => file.path === "binary")?.encoding, "base64");

  const outside = join(home, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "secret");
  symlinkSync(outside, join(home, ".codex", "skills", "linked"), "junction");
  assert.equal(listWindowsSkillCandidates(home, [".codex/skills"]).some((entry) => entry.name === "linked"), false);
});
