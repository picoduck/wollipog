import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverGitSkills, discoverGitSkillsAtCommit, parseSkillGitSource, readGitSkillSnapshot } from "./skill-git.js";
const exec = promisify(execFile);

test("the production Git launcher restricts transports, disables hooks/prompts, and sanitizes failed fetches", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skill-git-launch-test-"));
  const log = join(directory, "calls.jsonl");
  const priorPath = process.env.PATH;
  t.after(async () => { process.env.PATH = priorPath; await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "git"), `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,prompt:process.env.GIT_TERMINAL_PROMPT,noSystem:process.env.GIT_CONFIG_NOSYSTEM})+'\\n');\nif(args.includes('fetch')){process.stderr.write('private-token-and-sensitive-path');process.exit(1);}\n`, { mode: 0o700 });
  process.env.PATH = `${directory}:${priorPath}`;
  await assert.rejects(discoverGitSkills(parseSkillGitSource({ url: "team/skills", ref: "main" })), (error: Error) => {
    assert.match(error.message, /Could not read the Git source/);
    assert.doesNotMatch(error.message, /private-token|sensitive-path/);
    return true;
  });
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; prompt: string; noSystem: string });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    for (const argument of ["core.hooksPath=/dev/null", "protocol.allow=never", "protocol.https.allow=always", "protocol.ssh.allow=always"]) assert.ok(call.args.includes(argument));
    assert.equal(call.prompt, "0");
    assert.equal(call.noSystem, "1");
  }
  assert.ok(calls[0]!.args.includes("--bare"));
  assert.ok(calls[0]!.args.includes("--template="));
  assert.deepEqual(calls[1]!.args.slice(-7), ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", "https://github.com/team/skills.git", "main"]);
});

test("a held commit's read uses the same hardened launcher and names the commit it couldn't read", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skill-git-held-launch-test-"));
  const log = join(directory, "calls.jsonl");
  const priorPath = process.env.PATH;
  t.after(async () => { process.env.PATH = priorPath; await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "git"), `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args})+'\\n');\nif(args.includes('fetch')){process.stderr.write('private-token-and-sensitive-path');process.exit(1);}\n`, { mode: 0o700 });
  process.env.PATH = `${directory}:${priorPath}`;
  const held = "b".repeat(40);
  await assert.rejects(discoverGitSkillsAtCommit({ ...parseSkillGitSource({ url: "team/skills", ref: "main" }), commit: held }), (error: Error) => {
    assert.equal(error.message, "Could not read held commit bbbbbbbbbbbb from the Git source. It may have been removed from the branch.");
    return true;
  });
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
  assert.equal(calls.length, 2);
  for (const argument of ["core.hooksPath=/dev/null", "protocol.allow=never"]) assert.ok(calls[1]!.args.includes(argument));
  // The held commit is fetched by hash, never the branch it was held on.
  assert.deepEqual(calls[1]!.args.slice(-7), ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", "https://github.com/team/skills.git", held]);
});

test("a snapshot that resolved to another commit is refused rather than shown as the held one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skill-git-held-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (args: string[], maxBuffer = 2 * 1024 * 1024) =>
    (await exec("git", ["-C", directory, ...args], { encoding: "buffer", maxBuffer, timeout: 10_000 })).stdout;
  await git(["init", "--template=", "."]);
  await writeFile(join(directory, "SKILL.md"), "---\nname: alpha\n---\nBody");
  await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  await git(["fetch", ".", "HEAD"]);
  const head = (await git(["rev-parse", "HEAD"])).toString("utf8").trim();
  const source = parseSkillGitSource({ url: "team/skills" });
  assert.equal((await readGitSkillSnapshot({ ...source, commit: head }, git))[0]!.commit, head);
  await assert.rejects(readGitSkillSnapshot({ ...source, commit: "c".repeat(40) }, git), /^Error: Could not read held commit cccccccccccc/);
});

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
  // A held update's review pins one full commit; the ref stays the tracked branch.
  const held = "0123456789abcdef".repeat(3).slice(0, 40);
  assert.deepEqual(parseSkillGitSource({ url: "a/b", ref: "main", commit: held }),
    { url: "https://github.com/a/b.git", ref: "main", subdirectory: "", commit: held });
  assert.equal(parseSkillGitSource({ url: "a/b", commit: "c".repeat(64) }).commit, "c".repeat(64));
  for (const commit of ["abc123", "A".repeat(40), "--upload-pack=evil", "g".repeat(40), "a".repeat(41), 42, null]) {
    assert.throws(() => parseSkillGitSource({ url: "a/b", commit }), /full commit hash/);
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
