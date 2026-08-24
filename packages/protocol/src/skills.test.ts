import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type SkillFile,
} from "./index.js";
import { skillVersionDigest } from "./skills-digest.js";

test("skill limits stay at their contract values", () => {
  assert.equal(SKILL_MAX_FILES, 64);
  assert.equal(SKILL_MAX_TOTAL_BYTES, 2 * 1024 * 1024);
  assert.equal(SKILL_MAX_FILE_BYTES, 512 * 1024);
});

test("skill names must be lowercase directory-safe tokens with no hidden or traversal spellings", () => {
  assert.equal(validSkillName("code-review"), true);
  assert.equal(validSkillName("a"), true);
  assert.equal(validSkillName("skill.v2_beta-1"), true);
  assert.equal(validSkillName("0" + "a".repeat(63)), true);

  assert.equal(validSkillName(""), false);
  assert.equal(validSkillName("."), false);
  assert.equal(validSkillName(".."), false);
  assert.equal(validSkillName(".hidden"), false);
  assert.equal(validSkillName("-leading-dash"), false);
  assert.equal(validSkillName("_leading-underscore"), false);
  assert.equal(validSkillName("Upper-Case"), false);
  assert.equal(validSkillName("has space"), false);
  assert.equal(validSkillName("a/b"), false);
  assert.equal(validSkillName("a\\b"), false);
  assert.equal(validSkillName("0" + "a".repeat(64)), false);
});

test("skill file paths are strictly relative POSIX with bounded depth and length", () => {
  assert.equal(validSkillFilePath("SKILL.md"), true);
  assert.equal(validSkillFilePath("references/palette.md"), true);
  assert.equal(validSkillFilePath("a/b/c/d/e/f/g/h"), true);
  assert.equal(validSkillFilePath(".hidden/config"), true);
  assert.equal(validSkillFilePath("a".repeat(256)), true);

  assert.equal(validSkillFilePath(""), false);
  assert.equal(validSkillFilePath("/etc/passwd"), false);
  assert.equal(validSkillFilePath("../outside.md"), false);
  assert.equal(validSkillFilePath("docs/../../outside.md"), false);
  assert.equal(validSkillFilePath("docs/./inner.md"), false);
  assert.equal(validSkillFilePath("docs//inner.md"), false);
  assert.equal(validSkillFilePath("docs/"), false);
  assert.equal(validSkillFilePath(".."), false);
  assert.equal(validSkillFilePath("."), false);
  assert.equal(validSkillFilePath("C:/windows/system32"), false);
  assert.equal(validSkillFilePath("c:relative"), false);
  assert.equal(validSkillFilePath("docs\\inner.md"), false);
  assert.equal(validSkillFilePath("docs/inn\0er.md"), false);
  assert.equal(validSkillFilePath("docs/inn\ner.md"), false);
  assert.equal(validSkillFilePath("a/b/c/d/e/f/g/h/i"), false);
  assert.equal(validSkillFilePath("a".repeat(257)), false);
});

test("skill version digest is deterministic over file order and transport encoding", () => {
  const skillMd: SkillFile = { path: "SKILL.md", content: "# Review\n", encoding: "utf8" };
  const helper: SkillFile = { path: "scripts/run.sh", content: "echo hi\n", encoding: "utf8" };
  const helperBase64: SkillFile = {
    path: "scripts/run.sh",
    content: Buffer.from("echo hi\n", "utf8").toString("base64"),
    encoding: "base64",
  };

  const digest = skillVersionDigest([skillMd, helper]);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(skillVersionDigest([helper, skillMd]), digest);
  assert.equal(skillVersionDigest([helperBase64, skillMd]), digest);
  assert.notEqual(skillVersionDigest([skillMd]), digest);
  assert.notEqual(skillVersionDigest([{ ...skillMd, content: "# Review v2\n" }, helper]), digest);
  assert.notEqual(skillVersionDigest([{ ...skillMd, path: "README.md" }, helper]), digest);
});

test("skill version digest matches the canonical manifest JSON exactly", () => {
  const files: SkillFile[] = [
    { path: "b.txt", content: "bee", encoding: "utf8" },
    { path: "a.txt", content: Buffer.from("ayy", "utf8").toString("base64"), encoding: "base64" },
  ];
  const manifest = {
    files: [
      { path: "a.txt", sha256: createHash("sha256").update("ayy").digest("hex"), size: 3 },
      { path: "b.txt", sha256: createHash("sha256").update("bee").digest("hex"), size: 3 },
    ],
  };
  const expected = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  assert.equal(skillVersionDigest(files), expected);
});

test("skill version digest sizes count decoded bytes, not source characters", () => {
  const multibyte: SkillFile = { path: "SKILL.md", content: "héllo", encoding: "utf8" };
  const manifest = {
    files: [
      {
        path: "SKILL.md",
        sha256: createHash("sha256").update(Buffer.from("héllo", "utf8")).digest("hex"),
        size: Buffer.byteLength("héllo", "utf8"),
      },
    ],
  };
  const expected = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  assert.equal(skillVersionDigest([multibyte]), expected);
});
