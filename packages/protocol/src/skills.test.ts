import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  isSkillScriptFile,
  isSkillScriptPath,
  shortenAtWordBoundary,
  validSkillFilePath,
  validSkillName,
  type SkillFile,
} from "./index.js";
import { skillVersionDigest } from "./skills-digest.js";
import {
  manualInvocationVariantFiles,
  withManualInvocationFrontmatter,
  withoutManualInvocationFrontmatter,
} from "./skill-invocation.js";

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

test("script-like skill files are recognized by mode, extension, or scripts directory", () => {
  for (const path of ["run.sh", "tools/check.py", "index.MJS", "setup.ps1", "scripts/run", "a/bin/tool", "Scripts/run", "BIN/tool"]) {
    assert.equal(isSkillScriptPath(path), true, path);
  }
  for (const path of ["SKILL.md", "reference/api.txt", "agents/openai.yaml", "scriptsfoo/run", "robin/x"]) {
    assert.equal(isSkillScriptPath(path), false, path);
  }
  assert.equal(isSkillScriptPath("tool", true), true);
});

test("script-like skill files are also recognized by shebang or native executable content", () => {
  assert.equal(isSkillScriptPath("run.lua"), true);
  for (const manifest of ["package.json", "tools/Makefile", "justfile", "Taskfile.yml"]) assert.equal(isSkillScriptPath(manifest), true, manifest);
  assert.equal(isSkillScriptPath("reference/package.json.md"), false);
  assert.equal(isSkillScriptFile({ path: "helper", encoding: "utf8", content: "#!/bin/sh\necho" }), true);
  assert.equal(isSkillScriptFile({ path: "notes", encoding: "utf8", content: "MZ is not a binary here" }), false);
  const binary = (bytes: string) => ({ path: "blob", encoding: "base64" as const, content: Buffer.from(bytes, "latin1").toString("base64") });
  assert.equal(isSkillScriptFile(binary("\x7fELF\x02\x01")), true);
  assert.equal(isSkillScriptFile(binary("MZ\x90\x00")), true);
  assert.equal(isSkillScriptFile(binary("\xcf\xfa\xed\xfe")), true);
  assert.equal(isSkillScriptFile(binary("\x89PNG\r\n")), false);
  assert.equal(isSkillScriptFile({ path: "odd", encoding: "base64", content: "%%%" }), false);
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

test("the Manual Only transform reverses only its exact injected line", () => {
  for (const source of [
    "---\nname: alpha\n---\n\nBody\n",
    "Just a body\n",
    "﻿---\r\nname: alpha\r\n---\r\nBody\r\n",
    "---\nname: alpha\nunterminated\n",
  ]) {
    const manual = withManualInvocationFrontmatter(source);
    const edited = `${manual}Edited on the machine.\n`;
    const recovered = withoutManualInvocationFrontmatter(edited);
    assert.equal(recovered, `${source}Edited on the machine.\n`);
    assert.equal(withManualInvocationFrontmatter(recovered!), edited);
  }
  // A source key the transform replaced cannot be recovered; the result round-trips without it.
  const replaced = withManualInvocationFrontmatter("---\nname: alpha\ndisable-model-invocation: false\n---\nBody\n");
  assert.equal(withoutManualInvocationFrontmatter(replaced), "---\nname: alpha\n---\nBody\n");
  // Editing the injected key itself is never silently folded into library content.
  assert.equal(withoutManualInvocationFrontmatter("---\ndisable-model-invocation: false\nname: alpha\n---\n"), null);
  assert.equal(withoutManualInvocationFrontmatter("---\nname: alpha\ndisable-model-invocation: true\n---\n"), null);

  const files: SkillFile[] = [
    { path: "SKILL.md", content: Buffer.from("---\nname: alpha\n---\n").toString("base64"), encoding: "base64" },
    { path: "notes.md", content: "Notes\n", encoding: "utf8" },
  ];
  assert.deepEqual(manualInvocationVariantFiles(files), [
    { path: "SKILL.md", content: "---\ndisable-model-invocation: true\nname: alpha\n---\n", encoding: "utf8" },
    files[1],
  ]);
});

test("shortenAtWordBoundary keeps text that fits and otherwise cuts between words with an ellipsis", () => {
  assert.equal(shortenAtWordBoundary("Short enough.", 13), "Short enough.");
  assert.equal(shortenAtWordBoundary("A request to claim, implement, or fix", 22), "A request to claim…");
  // The bound counts the ellipsis, and a cut that lands on a space keeps the whole last word.
  assert.equal(shortenAtWordBoundary("one two three", 8), "one two…");
  assert.equal([...shortenAtWordBoundary("word ".repeat(400), 1024)].length <= 1024, true);
  // A single word longer than the bound has no boundary, so it is cut inside, still marked.
  assert.equal(shortenAtWordBoundary("x".repeat(10), 5), "xxxx…");
  // Code points, not UTF-16 units, so an astral character is never split.
  assert.equal(shortenAtWordBoundary("😀😀😀 😀😀", 4), "😀😀😀…");
});
