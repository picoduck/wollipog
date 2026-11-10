import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { classifyBaseMerge, resolvedWithinConflicts } from "./review-base-merge.js";

const execFileAsync = promisify(execFile);
const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
const LINES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A repository whose pull request branch `pr` changed line b of f.txt, and whose `main` then moved. */
async function repository(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "review-base-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV })).stdout.trim();
  const write = (name: string, lines: string[]) => writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
  const commit = async (message: string) => { await git("add", "-A"); await git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  await git("init", "-q", "-b", "main");
  write("f.txt", LINES);
  write("g.txt", ["x"]);
  await commit("base");
  await git("checkout", "-qb", "pr");
  write("f.txt", LINES.map((line) => line === "b" ? "b-pr" : line));
  const reference = await commit("pull request");
  await git("checkout", "-q", "main");
  return { dir, git, write, commit, reference };
}

const classify = (dir: string, reference: string, head: string, base: string) => classifyBaseMerge(
  async (args) => (await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV })).stdout, reference, head, base);

test("a merge of the moved base that leaves the pull request's own diff unchanged is equivalent", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  write("g.txt", ["y"]);
  const base = await commit("base moves elsewhere");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-edit", "main");
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), "equivalent");
});

test("a clean merge that changes the pull request's diff, or a conflict resolved inside its hunk, is a resolution", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  write("f.txt", LINES.map((line) => line === "g" ? "g-main" : line));
  const clean = await commit("base edits another hunk of the same file");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-edit", "main");
  const merged = await git("rev-parse", "HEAD");
  assert.equal(await classify(dir, reference, merged, clean), "resolution");

  // The base then changes the pull request's own line: a conflict, resolved inside its hunk.
  await git("checkout", "-q", "main");
  write("f.txt", LINES.map((line) => line === "g" ? "g-main" : line === "b" ? "b-main" : line));
  const conflicting = await commit("base edits the same line");
  await git("checkout", "-q", "pr");
  await assert.rejects(git("merge", "-q", "--no-edit", "main"));
  write("f.txt", LINES.map((line) => line === "g" ? "g-main" : line === "b" ? "b-pr-and-main" : line));
  const resolved = await commit("merge main, resolving b");
  assert.equal(await classify(dir, merged, resolved, conflicting), "resolution");
});

test("a resolution with a change outside its conflicted hunk is an ordinary commit", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  write("f.txt", LINES.map((line) => line === "b" ? "b-main" : line));
  const base = await commit("base edits the same line");
  await git("checkout", "-q", "pr");
  await assert.rejects(git("merge", "-q", "--no-edit", "main"));
  write("f.txt", LINES.map((line) => line === "b" ? "b-resolved" : line === "f" ? "f-sneaked-in" : line));
  const head = await commit("merge main, resolving b and editing f");
  assert.equal(await classify(dir, reference, head, base), null);
});

test("a resolution that changes a conflicted file's mode or type is an ordinary commit", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  write("f.txt", LINES.map((line) => line === "b" ? "b-main" : line));
  const base = await commit("base edits the same line");
  await git("checkout", "-q", "pr");
  await assert.rejects(git("merge", "-q", "--no-edit", "main"));
  write("f.txt", LINES.map((line) => line === "b" ? "b-resolved" : line));
  await git("add", "f.txt");
  await git("update-index", "--chmod=+x", "f.txt");
  await git("commit", "-qm", "merge main, resolving b and making f executable");
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), null, "an executable bit");

  // The same conflict resolved by replacing the file with a symlink.
  await git("reset", "-q", "--hard", reference);
  await assert.rejects(git("merge", "-q", "--no-edit", "main"));
  writeFileSync(join(dir, "f.txt"), LINES.map((line) => line === "b" ? "b-resolved" : line).join("\n") + "\n");
  await git("add", "f.txt");
  const target = join(dir, "..", `${dir.split("/").at(-1)}-link-target`);
  writeFileSync(target, `${LINES.map((line) => line === "b" ? "b-resolved" : line).join("\n")}\n`);
  t.after(() => rmSync(target, { force: true }));
  // A symlink whose target text is the resolved content: the blob matches, only the type differs.
  const link = await git("hash-object", "-w", target);
  await git("update-index", "--cacheinfo", `120000,${link},f.txt`);
  await git("commit", "-qm", "merge main, resolving f into a symlink");
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), null, "a type change");
});

test("a resolution that changes a byte outside the conflict that UTF-8 cannot represent is an ordinary commit", async (t) => {
  const { dir, git, commit } = await repository(t);
  // An invalid UTF-8 byte (0x80) outside the conflict, on both sides of the merge.
  const withByte = (lines: string[], byte: number) => Buffer.concat([Buffer.from(`${lines.join("\n")}\n`), Buffer.from([byte, 0x0a])]);
  writeFileSync(join(dir, "f.txt"), withByte(LINES.map((line) => line === "b" ? "b-main" : line), 0x80));
  const base = await commit("base edits the same line");
  await git("checkout", "-q", "pr");
  writeFileSync(join(dir, "f.txt"), withByte(LINES.map((line) => line === "b" ? "b-pr" : line), 0x80));
  const reviewed = await commit("pull request keeps the byte");
  await assert.rejects(git("merge", "-q", "--no-edit", "main"));
  // The resolution also turns 0x80 into 0x81; both decode to U+FFFD.
  writeFileSync(join(dir, "f.txt"), withByte(LINES.map((line) => line === "b" ? "b-resolved" : line), 0x81));
  const head = await commit("merge main, resolving b and changing the byte");
  assert.equal(await classify(dir, reviewed, head, base), null);
});

test("a base rename between filenames UTF-8 cannot represent never makes a merge equivalent", async (t) => {
  const { dir, git, commit } = await repository(t);
  // Two distinct paths whose names differ only in an invalid UTF-8 byte (0x80, then 0x81).
  const path = (byte: number) => Buffer.concat([Buffer.from(`${dir}/x`), Buffer.from([byte]), Buffer.from(".txt")]);
  await git("checkout", "-q", "main");
  writeFileSync(path(0x80), `${LINES.join("\n")}\n`);
  await commit("base adds the oddly named file");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-edit", "main");
  writeFileSync(path(0x80), `${LINES.map((line) => line === "c" ? "c-pr" : line).join("\n")}\n`);
  const reviewed = await commit("pull request edits the oddly named file");
  // The base renames it to the other name; a clean merge carries the edit to the new path.
  await git("checkout", "-q", "main");
  renameSync(path(0x80), path(0x81));
  const base = await commit("base renames the file");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-edit", "main");
  assert.equal(await classify(dir, reviewed, await git("rev-parse", "HEAD"), base), null);
});

test("a clean merge carrying any other change is an ordinary commit", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  write("g.txt", ["y"]);
  const base = await commit("base moves elsewhere");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-commit", "main");
  write("h.txt", ["new"]);
  const head = await commit("merge main with an extra file");
  assert.equal(await classify(dir, reference, head, base), null);
});

test("a resolution is never equivalent, whichever side it keeps", async (t) => {
  for (const [side, kept] of [["the pull request's", "b-pr"], ["the base's, dropping the pull request's change,", "b-main"]] as const) {
    const { dir, git, write, commit, reference } = await repository(t);
    write("f.txt", LINES.map((line) => line === "b" ? "b-main" : line));
    const base = await commit("base edits the same line");
    await git("checkout", "-q", "pr");
    await assert.rejects(git("merge", "-q", "--no-edit", "main"));
    write("f.txt", LINES.map((line) => line === "b" ? kept : line));
    const head = await commit("merge main, keeping one side");
    assert.equal(await classify(dir, reference, head, base), "resolution", `keeping ${side} line`);
  }
});

test("a merge hiding a change in a file with no conflict is an ordinary commit, even beside a real conflict", async (t) => {
  // A file of the pull request's own, and one only the base changed, which no merge round would scope.
  for (const [where, path] of [["the pull request's own file", "own.txt"], ["a file only the base changed", "g.txt"]] as const) {
    const { dir, git, write, commit } = await repository(t);
    await git("checkout", "-q", "pr");
    write("own.txt", ["own"]);
    const reviewed = await commit("pull request adds its own file");
    await git("checkout", "-q", "main");
    write("g.txt", ["y"]);
    write("f.txt", LINES.map((line) => line === "b" ? "b-main" : line));
    const base = await commit("base edits the same line and another file");
    await git("checkout", "-q", "pr");
    await assert.rejects(git("merge", "-q", "--no-edit", "main"));
    write("f.txt", LINES.map((line) => line === "b" ? "b-resolved" : line));
    write(path, ["hidden"]);
    const head = await commit("merge main, resolving b and editing another file");
    assert.equal(await classify(dir, reviewed, head, base), null, where);
  }
});

test("a second merge since the reviewed head, or a merged parent past the reported base, is an ordinary commit", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  const before = await git("rev-parse", "main");
  write("g.txt", ["y"]);
  await commit("base moves");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-edit", "main");
  const once = await git("rev-parse", "HEAD");
  assert.equal(await classify(dir, reference, once, before), null, "the merged parent is not yet on the reported base");
  await git("checkout", "-q", "main");
  write("g.txt", ["z"]);
  const base = await commit("base moves again");
  await git("checkout", "-q", "pr");
  await git("merge", "-q", "--no-edit", "main");
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), null, "two merges since the reviewed head");
  assert.equal(await classify(dir, once, await git("rev-parse", "HEAD"), base), "equivalent", "each merge alone is provable from its own reviewed head");
});

test("octopus merges, merges of other branches, merges in the other direction and commits after the merge are ordinary", async (t) => {
  const { dir, git, write, commit, reference } = await repository(t);
  write("g.txt", ["y"]);
  const base = await commit("base moves elsewhere");
  await git("checkout", "-qb", "side", reference);
  write("s.txt", ["side"]);
  const side = await commit("a side branch");
  await git("checkout", "-q", "pr");

  await git("merge", "-q", "--no-edit", "main", "side");
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), null, "an octopus merge");

  await git("reset", "-q", "--hard", reference);
  await git("merge", "-q", "--no-edit", "--no-ff", side);
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), null, "a merged parent outside the base branch");

  await git("reset", "-q", "--hard", reference);
  await git("merge", "-q", "--no-edit", "main");
  write("f.txt", LINES.map((line) => line === "b" ? "b-fixed" : line));
  const fixed = await commit("a fix after the merge");
  assert.equal(await classify(dir, reference, fixed, base), null, "a commit after the merge");

  await git("checkout", "-qb", "reverse", base);
  await git("merge", "-q", "--no-edit", reference);
  assert.equal(await classify(dir, reference, await git("rev-parse", "HEAD"), base), null, "the reviewed head is not the first parent");

  // A merge of a base commit the reviewed head already contained moves nothing.
  const stale = await git("commit-tree", `${reference}^{tree}`, "-p", reference, "-p", `${reference}~1`, "-m", "merge an old base");
  assert.equal(await classify(dir, reference, stale, base), null, "a base commit already contained");
});

test("only text inside each labelled conflict block may change", () => {
  const ours = "1".repeat(40), theirs = "2".repeat(40);
  const conflicted = `a\n<<<<<<< ${ours}\nb1\n=======\nb2\n>>>>>>> ${theirs}\nc\n<<<<<<< ${ours}\nd1\n=======\nd2\n>>>>>>> ${theirs}\ne\n`;
  assert.equal(resolvedWithinConflicts(conflicted, "a\nb\nc\nd\ne\n", ours, theirs), true);
  assert.equal(resolvedWithinConflicts(conflicted, "a\nc\ne\n", ours, theirs), true, "a block may resolve to nothing");
  assert.equal(resolvedWithinConflicts(conflicted, "a\nb\nC\nd\ne\n", ours, theirs), false, "clean text between blocks changed");
  assert.equal(resolvedWithinConflicts(conflicted, "A\nb\nc\nd\ne\n", ours, theirs), false, "clean text before the first block changed");
  assert.equal(resolvedWithinConflicts(conflicted, "a\nb\nc\nd\ne\nf\n", ours, theirs), false, "text after the last block changed");
  assert.equal(resolvedWithinConflicts("a\nb\n", "a\nb\n", ours, theirs), false, "no conflict block proves nothing");
  assert.equal(resolvedWithinConflicts(`a\n<<<<<<< ${ours}\nb\n`, "a\n", ours, theirs), false, "an unterminated block");
  assert.equal(resolvedWithinConflicts(`a\n<<<<<<< other\nb\n=======\nc\n>>>>>>> ${theirs}\n`, "a\nb\n", ours, theirs), false,
    "markers must name the exact parents");
});
