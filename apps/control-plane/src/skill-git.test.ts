import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillGitSource, readGitSkillSnapshot } from "./skill-git.js";
const exec = promisify(execFile);

test("Git sources accept generic secure remotes and reject credentials, options, and traversal", () => {
  assert.deepEqual(parseSkillGitSource({ url: "team/skills" }), { url: "https://github.com/team/skills.git", ref: "HEAD", subdirectory: "" });
  assert.equal(parseSkillGitSource({ url: "git@git.example.com:team/skills.git" }).url, "ssh://git@git.example.com/team/skills.git");
  for (const url of ["file:///etc", "ext::sh -c id", "https://user:secret@example.com/x", "https://token@example.com/x", "https://example.com/x?token=secret"]) {
    assert.throws(() => parseSkillGitSource({ url }));
  }
  for (const ref of ["--upload-pack=evil", "HEAD~1", "../secret", "refs/heads/../x"]) {
    assert.throws(() => parseSkillGitSource({ url: "a/b", ref }));
  }
  for (const subdirectory of ["../x", "/x", "a//b", "a/./b", "a\\b"]) {
    assert.throws(() => parseSkillGitSource({ url: "a/b", subdirectory }));
  }
});

test("Git snapshots discover nested skills and read pinned objects, preserving binary content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skill-git-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (args: string[], maxBuffer = 2 * 1024 * 1024) =>
    (await exec("git", ["-C", directory, ...args], { encoding: "buffer", maxBuffer, timeout: 10_000 })).stdout;
  await git(["init", "--template=", "."]);
  await mkdir(join(directory, "skills/alpha"), { recursive: true });
  await writeFile(join(directory, "skills/alpha/SKILL.md"), "---\nname: alpha\n---\nOriginal instructions");
  await writeFile(join(directory, "skills/alpha/asset.bin"), Buffer.from([0, 255, 2]));
  await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  await git(["fetch", ".", "HEAD"]);
  const source = parseSkillGitSource({ url: "team/skills", subdirectory: "skills" });
  const candidates = await readGitSkillSnapshot(source, git);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.path, "skills/alpha");
  assert.equal(candidates[0]!.files.find((file) => file.path === "asset.bin")!.content, "AP8C");
  assert.equal(candidates[0]!.files.find((file) => file.path === "SKILL.md")!.encoding, "utf8");
  assert.match(candidates[0]!.commit, /^[a-f0-9]{40}$/);
  await writeFile(join(directory, "skills/alpha/SKILL.md"), "Uncommitted mutation");
  assert.equal((await readGitSkillSnapshot(source, git))[0]!.digest, candidates[0]!.digest);
  await symlink("/etc/passwd", join(directory, "skills/alpha/foreign"));
  await git(["add", "skills/alpha/foreign"]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "foreign link"]);
  await git(["fetch", ".", "HEAD"]);
  await assert.rejects(readGitSkillSnapshot(source, git), /symlinks or submodules/);
});
